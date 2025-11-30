/**
 * NetTrace file format parser
 * Based on PerfView's EventPipeEventSource implementation
 * 
 * FastSerialization format structure:
 * - "Nettrace" magic (8 bytes)
 * - Serialization header: length-prefixed "!FastSerialization.1" string
 * - Stream of objects with format:
 *   - Tag byte (NullReference=1, BeginPrivateObject=5, Blob=6, EndObject=2)
 *   - Object type index (varint for BeginPrivateObject)
 *   - For new types: version (int32), minReaderVersion (int32), typeNameLen (int32), typeName (ascii)
 *   - Blob data (length-prefixed)
 *   - EndObject tag
 * 
 * Block types: Trace, MetadataBlock, EventBlock, StackBlock, SPBlock
 */

export interface TraceInfo {
    syncTimeUTC: Date;
    syncTimeTicks: bigint;
    tickFrequency: bigint;
    pointerSize: number;
    processId?: number;
    numberOfProcessors?: number;
    cpuSamplingRate?: number;
    commandLine?: string;
}

export interface EventMetadata {
    metadataId: number;
    providerName: string;
    eventId: number;
    eventName: string;
    keywords: bigint;
    version: number;
    level: number;
    opcode: number;
    fields: FieldMetadata[];
}

export interface FieldMetadata {
    name: string;
    typeCode: number;
}

export interface AllocationInfo {
    typeName: string;
    count: number;
    totalSize: bigint;
    sourceMethod?: string;
    allocations: AllocationEvent[];
}

export interface AllocationEvent {
    typeName: string;
    size: bigint;
    timestamp: bigint;
    stackTrace?: string[];
}

export interface StackInfo {
    stackId: number;
    addresses: bigint[];
}

export interface ParseResult {
    traceInfo: TraceInfo | null;
    metadata: Map<number, EventMetadata>;
    allocations: Map<string, AllocationInfo>;
    events: TraceEvent[];
    stacks: Map<number, StackInfo>;
    errors: string[];
    debugInfo?: {
        totalEvents: number;
        allocationEvents: number;
        providers: string[];
    };
}

export interface TraceEvent {
    metadataId: number;
    threadId: bigint;
    timestamp: bigint;
    stackId: number;
    payload: Buffer;
}

// FastSerialization tags from PerfView
enum SerializationTag {
    Error = 0,
    NullReference = 1,
    EndObject = 2,
    BeginObject = 4,
    BeginPrivateObject = 5,
    Blob = 6,
}

// Known provider names
const DOTNET_RUNTIME_PROVIDER = 'Microsoft-Windows-DotNETRuntime';

// Event IDs for GC allocation events
const GC_ALLOCATION_TICK_EVENT_ID = 10;

class BufferReader {
    private buffer: Buffer;
    private _offset: number;
    private debug: boolean;

    constructor(buffer: Buffer, offset: number = 0, debug: boolean = false) {
        this.buffer = buffer;
        this._offset = offset;
        this.debug = debug;
    }

    get offset(): number {
        return this._offset;
    }

    set offset(value: number) {
        this._offset = value;
    }

    get remaining(): number {
        return this.buffer.length - this._offset;
    }

    getBuffer(): Buffer {
        return this.buffer;
    }

    hasBytes(count: number): boolean {
        return this._offset + count <= this.buffer.length;
    }

    readByte(): number {
        if (!this.hasBytes(1)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        return this.buffer[this._offset++];
    }

    peekByte(): number {
        if (!this.hasBytes(1)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        return this.buffer[this._offset];
    }

    readInt16LE(): number {
        if (!this.hasBytes(2)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        const val = this.buffer.readInt16LE(this._offset);
        this._offset += 2;
        return val;
    }

    readUInt16LE(): number {
        if (!this.hasBytes(2)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        const val = this.buffer.readUInt16LE(this._offset);
        this._offset += 2;
        return val;
    }

    readInt32LE(): number {
        if (!this.hasBytes(4)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        const val = this.buffer.readInt32LE(this._offset);
        this._offset += 4;
        return val;
    }

    readUInt32LE(): number {
        if (!this.hasBytes(4)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        const val = this.buffer.readUInt32LE(this._offset);
        this._offset += 4;
        return val;
    }

    readInt64LE(): bigint {
        if (!this.hasBytes(8)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        const val = this.buffer.readBigInt64LE(this._offset);
        this._offset += 8;
        return val;
    }

    readUInt64LE(): bigint {
        if (!this.hasBytes(8)) {
            throw new Error(`End of buffer at offset ${this._offset}`);
        }
        const val = this.buffer.readBigUInt64LE(this._offset);
        this._offset += 8;
        return val;
    }

    readBytes(count: number): Buffer {
        if (!this.hasBytes(count)) {
            throw new Error(`End of buffer at offset ${this._offset}, need ${count} bytes`);
        }
        const val = this.buffer.slice(this._offset, this._offset + count);
        this._offset += count;
        return val;
    }

    readVarUInt(): number {
        let result = 0;
        let shift = 0;
        let b: number;
        do {
            if (!this.hasBytes(1)) {
                throw new Error('End of buffer reading varint');
            }
            b = this.readByte();
            result |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0 && shift < 35);
        return result >>> 0;
    }

    readVarInt64(): bigint {
        let result = BigInt(0);
        let shift = BigInt(0);
        let b: number;
        do {
            if (!this.hasBytes(1)) {
                throw new Error('End of buffer reading varint64');
            }
            b = this.readByte();
            result |= BigInt(b & 0x7f) << shift;
            shift += BigInt(7);
        } while ((b & 0x80) !== 0 && shift < BigInt(70));
        return result;
    }

    // Read null-terminated UTF-16LE string
    readNullTerminatedUTF16(): string {
        const chars: number[] = [];
        while (this.hasBytes(2)) {
            const code = this.readUInt16LE();
            if (code === 0) {
                break;
            }
            chars.push(code);
        }
        return String.fromCharCode(...chars);
    }

    // Read ASCII string of given length
    readAsciiString(length: number): string {
        if (!this.hasBytes(length)) {
            throw new Error(`End of buffer reading string of length ${length}`);
        }
        const str = this.buffer.toString('ascii', this._offset, this._offset + length);
        this._offset += length;
        return str;
    }

    skip(count: number): void {
        if (count > 0) {
            this._offset = Math.min(this._offset + count, this.buffer.length);
        }
    }

    align(boundary: number): void {
        const mod = this._offset % boundary;
        if (mod !== 0) {
            this.skip(boundary - mod);
        }
    }

    // Create a sub-reader for a slice of the buffer
    subReader(length: number): BufferReader {
        const subBuf = this.readBytes(length);
        return new BufferReader(subBuf, 0, this.debug);
    }
}

// Type registry for FastSerialization
interface TypeInfo {
    typeIndex: number;
    version: number;
    minReaderVersion: number;
    typeName: string;
}

export class NetTraceParser {
    private buffer: Buffer;
    private reader: BufferReader;
    private metadata: Map<number, EventMetadata> = new Map();
    private stacks: Map<number, StackInfo> = new Map();
    private pointerSize: number = 8;
    private processId: number = 0;
    private errors: string[] = [];
    private typeRegistry: Map<number, TypeInfo> = new Map();
    private nextTypeIndex: number = 0;
    private fileVersion: number = 4; // Default to v4
    private debug: boolean = false;
    
    // Debug counters
    private debugInfo = {
        totalEvents: 0,
        allocationEvents: 0,
        providers: new Set<string>(),
        metadataBlocks: 0,
        eventBlocks: 0,
    };

    constructor(buffer: Buffer, debug: boolean = false) {
        this.buffer = buffer;
        this.reader = new BufferReader(buffer);
        this.debug = debug;
    }

    parse(): ParseResult {
        const result: ParseResult = {
            traceInfo: null,
            metadata: new Map(),
            allocations: new Map(),
            events: [],
            stacks: new Map(),
            errors: []
        };

        try {
            // Validate magic header "Nettrace"
            if (this.buffer.length < 32) {
                throw new Error('File too small to be a valid .nettrace file');
            }

            const magic = this.buffer.toString('utf8', 0, 8);
            if (magic !== 'Nettrace') {
                throw new Error('Invalid file: missing Nettrace magic header');
            }

            this.reader.offset = 8;

            // Read serialization header: length-prefixed string "!FastSerialization.1"
            const headerLength = this.reader.readInt32LE();
            const headerString = this.reader.readAsciiString(headerLength);
            
            if (!headerString.startsWith('!FastSerialization.1')) {
                throw new Error(`Invalid serialization header: ${headerString}`);
            }

            if (this.debug) {
                console.log(`Serialization header: ${headerString}`);
                console.log(`Starting object parsing at offset ${this.reader.offset}`);
            }

            // Parse the stream of serialized objects
            this.parseObjectStream(result);

            result.metadata = this.metadata;
            result.stacks = this.stacks;
            result.errors = this.errors;
            
            result.debugInfo = {
                totalEvents: this.debugInfo.totalEvents,
                allocationEvents: this.debugInfo.allocationEvents,
                providers: Array.from(this.debugInfo.providers)
            };

        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Parse error: ${errMsg}`);
        }

        return result;
    }

    private parseObjectStream(result: ParseResult): void {
        let objectCount = 0;
        const maxObjects = 10000000;

        while (this.reader.remaining > 0 && objectCount < maxObjects) {
            objectCount++;

            try {
                const tag = this.reader.readByte() as SerializationTag;

                switch (tag) {
                    case SerializationTag.NullReference:
                        // Just a separator/marker, continue
                        break;

                    case SerializationTag.EndObject:
                        // End of object, continue
                        break;

                    case SerializationTag.BeginPrivateObject:
                        this.parseBeginPrivateObject(result);
                        break;

                    case SerializationTag.Blob:
                        // Shouldn't see blob outside object context, skip
                        const size = this.reader.readVarUInt();
                        this.reader.skip(size);
                        break;

                    default:
                        // Unknown tag, try to continue
                        if (this.debug) {
                            console.log(`Unknown tag ${tag} at offset ${this.reader.offset - 1}`);
                        }
                        break;
                }
            } catch (err) {
                if (this.reader.remaining < 10) {
                    break;
                }
                // Try to continue on error
            }
        }
        
        if (this.debug) {
            console.log(`Parsed ${objectCount} objects`);
            console.log(`Metadata blocks: ${this.debugInfo.metadataBlocks}, Event blocks: ${this.debugInfo.eventBlocks}`);
            console.log(`Total events: ${this.debugInfo.totalEvents}, Allocation events: ${this.debugInfo.allocationEvents}`);
            console.log(`Providers: ${Array.from(this.debugInfo.providers).join(', ')}`);
        }
    }

    private parseBeginPrivateObject(result: ParseResult): void {
        // After BeginPrivateObject tag:
        // - TypeIndex (varint) - if we've seen this type before
        // - OR for new types:
        //   - NullReference tag (1)
        //   - Version (int32)
        //   - MinReaderVersion (int32)  
        //   - TypeNameLength (int32)
        //   - TypeName (ascii bytes)

        const startOffset = this.reader.offset;
        
        // Check if next byte is NullReference (new type definition)
        const nextByte = this.reader.peekByte();
        
        let typeInfo: TypeInfo;
        
        if (nextByte === SerializationTag.NullReference) {
            // New type definition
            this.reader.readByte(); // consume NullReference
            
            const version = this.reader.readInt32LE();
            const minReaderVersion = this.reader.readInt32LE();
            const typeNameLength = this.reader.readInt32LE();
            const typeName = this.reader.readAsciiString(typeNameLength);
            
            typeInfo = {
                typeIndex: this.nextTypeIndex++,
                version,
                minReaderVersion,
                typeName
            };
            this.typeRegistry.set(typeInfo.typeIndex, typeInfo);
            
            if (this.debug) {
                console.log(`New type[${typeInfo.typeIndex}]: ${typeName} v${version} at offset ${startOffset}`);
            }
        } else {
            // Reference to existing type
            const typeIndex = this.reader.readVarUInt();
            typeInfo = this.typeRegistry.get(typeIndex)!;
            
            if (!typeInfo) {
                this.errors.push(`Unknown type index: ${typeIndex}`);
                return;
            }
        }

        // Now we should see either EndObject or Blob
        this.parseObjectContent(typeInfo, result);
    }

    private parseObjectContent(typeInfo: TypeInfo, result: ParseResult): void {
        // Read tags until EndObject
        while (this.reader.remaining > 0) {
            const tag = this.reader.readByte() as SerializationTag;
            
            if (tag === SerializationTag.EndObject) {
                break;
            }
            
            if (tag === SerializationTag.Blob) {
                const blobSize = this.reader.readVarUInt();
                
                if (blobSize > 0 && this.reader.hasBytes(blobSize)) {
                    const blobData = this.reader.readBytes(blobSize);
                    this.processBlob(typeInfo, blobData, result);
                }
            } else if (tag === SerializationTag.NullReference) {
                // Skip null references
                continue;
            } else if (tag === SerializationTag.BeginPrivateObject) {
                // Nested object - recurse
                this.parseBeginPrivateObject(result);
            } else {
                // Unknown tag in object
                if (this.debug) {
                    console.log(`Unknown tag ${tag} in object ${typeInfo.typeName}`);
                }
            }
        }
    }

    private processBlob(typeInfo: TypeInfo, data: Buffer, result: ParseResult): void {
        const typeName = typeInfo.typeName;
        
        if (this.debug && data.length > 0) {
            console.log(`Processing ${typeName} blob, size=${data.length}`);
        }
        
        try {
            switch (typeName) {
                case 'Trace':
                    result.traceInfo = this.parseTraceBlob(data);
                    break;
                case 'MetadataBlock':
                    this.debugInfo.metadataBlocks++;
                    this.parseMetadataBlock(data);
                    break;
                case 'EventBlock':
                    this.debugInfo.eventBlocks++;
                    this.parseEventBlock(data, result);
                    break;
                case 'StackBlock':
                    this.parseStackBlock(data);
                    break;
                case 'SPBlock':
                    // Sequence point block - ignore for now
                    break;
                default:
                    if (this.debug) {
                        console.log(`Unknown block type: ${typeName}`);
                    }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.errors.push(`Error processing ${typeName}: ${errMsg}`);
        }
    }

    private parseTraceBlob(data: Buffer): TraceInfo {
        const reader = new BufferReader(data);
        
        // SYSTEMTIME structure (8 x int16 = 16 bytes)
        const year = reader.readInt16LE();
        const month = reader.readInt16LE();
        reader.readInt16LE(); // dayOfWeek
        const day = reader.readInt16LE();
        const hour = reader.readInt16LE();
        const minute = reader.readInt16LE();
        const second = reader.readInt16LE();
        const millisecond = reader.readInt16LE();

        const syncTimeUTC = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
        const syncTimeTicks = reader.readInt64LE();
        const tickFrequency = reader.readInt64LE();
        this.pointerSize = reader.readInt32LE();
        this.processId = reader.readInt32LE();
        const numberOfProcessors = reader.readInt32LE();
        const cpuSamplingRate = reader.readInt32LE();

        if (this.debug) {
            console.log(`Trace: time=${syncTimeUTC.toISOString()}, pointerSize=${this.pointerSize}, pid=${this.processId}`);
        }

        return {
            syncTimeUTC,
            syncTimeTicks,
            tickFrequency,
            pointerSize: this.pointerSize,
            processId: this.processId,
            numberOfProcessors,
            cpuSamplingRate
        };
    }

    private parseMetadataBlock(data: Buffer): void {
        const reader = new BufferReader(data);
        
        // Block header: headerSize (int16) + flags (int16)
        const headerSize = reader.readInt16LE();
        const flags = reader.readInt16LE();
        
        // Skip remaining header bytes
        if (headerSize > 4) {
            reader.skip(headerSize - 4);
        }

        if (this.debug) {
            console.log(`MetadataBlock: headerSize=${headerSize}, flags=${flags}, remaining=${reader.remaining}`);
        }

        // Parse metadata events (each one defines an event type)
        while (reader.remaining > 0) {
            try {
                this.parseMetadataEvent(reader);
            } catch (err) {
                if (this.debug) {
                    console.log(`Error parsing metadata event: ${err}`);
                }
                break;
            }
        }
    }

    private parseMetadataEvent(reader: BufferReader): void {
        // Based on PerfView's ReadEventHeader for metadata
        // In V3-V5, metadata is stored as special events where the payload IS the metadata
        
        // Event header for metadata (compressed or uncompressed depends on flags)
        // For V4+, first we read the flags byte
        
        const eventFlags = reader.readByte();
        
        // The flags indicate which fields are present
        let metadataId: number;
        
        // MetadataId is always present for metadata events
        metadataId = reader.readVarUInt();
        
        if (eventFlags & 0x02) {
            // Sequence and capture thread info present
            reader.readVarUInt(); // sequenceNumber delta
            reader.readVarInt64(); // captureThreadId
            reader.readVarUInt(); // processorNumber
        }
        
        if (eventFlags & 0x04) {
            // ThreadId present
            reader.readVarInt64();
        }
        
        if (eventFlags & 0x08) {
            // StackId present
            reader.readVarUInt();
        }
        
        // Timestamp delta is always present
        reader.readVarInt64(); // timestampDelta
        
        if (eventFlags & 0x10) {
            // ActivityId present
            reader.skip(16);
        }
        
        if (eventFlags & 0x20) {
            // RelatedActivityId present  
            reader.skip(16);
        }
        
        let payloadSize: number;
        if (eventFlags & 0x80) {
            // PayloadSize present
            payloadSize = reader.readVarUInt();
        } else {
            // No payload
            payloadSize = 0;
        }
        
        if (payloadSize <= 0 || !reader.hasBytes(payloadSize)) {
            return;
        }
        
        // The payload IS the metadata definition
        const payloadReader = reader.subReader(payloadSize);
        this.parseMetadataPayload(metadataId, payloadReader);
    }

    private parseMetadataPayload(metadataId: number, reader: BufferReader): void {
        // Metadata payload format (V3-V5):
        // - MetadataId (int32) - same as the one we already read
        // - ProviderName (null-terminated UTF16)
        // - EventId (int32)
        // - EventName (null-terminated UTF16)
        // - Keywords (int64)
        // - Version (int32)
        // - Level (int32)
        // - FieldCount (int32)
        // - Fields: [TypeCode (int32), FieldName (null-terminated UTF16)]...
        
        try {
            const payloadMetadataId = reader.readInt32LE();
            const providerName = reader.readNullTerminatedUTF16();
            const eventId = reader.readInt32LE();
            const eventName = reader.readNullTerminatedUTF16();
            const keywords = reader.readInt64LE();
            const version = reader.readInt32LE();
            const level = reader.readInt32LE();
            
            this.debugInfo.providers.add(providerName);
            
            // Read fields
            const fields: FieldMetadata[] = [];
            if (reader.remaining >= 4) {
                const fieldCount = reader.readInt32LE();
                
                for (let i = 0; i < fieldCount && reader.remaining > 4; i++) {
                    const typeCode = reader.readInt32LE();
                    // For array types (19), read element type
                    if (typeCode === 19 && reader.remaining >= 4) {
                        reader.readInt32LE();
                    }
                    const fieldName = reader.readNullTerminatedUTF16();
                    fields.push({ name: fieldName, typeCode });
                }
            }

            const metadata: EventMetadata = {
                metadataId: payloadMetadataId,
                providerName,
                eventId,
                eventName,
                keywords,
                version,
                level,
                opcode: 0,
                fields
            };

            this.metadata.set(payloadMetadataId, metadata);
            
            if (this.debug) {
                console.log(`Metadata[${payloadMetadataId}]: ${providerName}/${eventName} (id=${eventId})`);
            }
        } catch (err) {
            // Metadata parsing failed - continue
            if (this.debug) {
                console.log(`Failed to parse metadata payload: ${err}`);
            }
        }
    }

    private parseEventBlock(data: Buffer, result: ParseResult): void {
        const reader = new BufferReader(data);
        
        // Block header
        const headerSize = reader.readInt16LE();
        const flags = reader.readInt16LE();
        
        // Timestamps
        const minTimestamp = reader.readInt64LE();
        const maxTimestamp = reader.readInt64LE();
        
        // Skip remaining header
        if (headerSize > 20) {
            reader.skip(headerSize - 20);
        }

        const compressed = (flags & 1) !== 0;
        
        if (this.debug) {
            console.log(`EventBlock: headerSize=${headerSize}, flags=${flags}, compressed=${compressed}, remaining=${reader.remaining}`);
        }

        this.parseEvents(reader, result, compressed);
    }

    private parseEvents(reader: BufferReader, result: ParseResult, compressed: boolean): void {
        // State for header compression
        let prevMetadataId = 0;
        let prevSequenceNumber = 0;
        let prevCaptureThreadId = BigInt(0);
        let prevThreadId = BigInt(0);
        let prevStackId = 0;
        let prevTimestamp = BigInt(0);
        let prevPayloadSize = 0;

        while (reader.remaining > 0) {
            try {
                if (compressed) {
                    const eventFlags = reader.readByte();
                    
                    // Bit 0: MetadataId present
                    let metadataId: number;
                    if (eventFlags & 0x01) {
                        metadataId = reader.readVarUInt();
                    } else {
                        metadataId = prevMetadataId;
                    }

                    // Bit 1: Sequence/CaptureThread/Processor present
                    if (eventFlags & 0x02) {
                        reader.readVarUInt(); // sequenceDelta
                        reader.readVarInt64(); // captureThreadId
                        reader.readVarUInt(); // processorNumber
                    }

                    // Bit 2: ThreadId present
                    let threadId: bigint;
                    if (eventFlags & 0x04) {
                        threadId = reader.readVarInt64();
                    } else {
                        threadId = prevThreadId;
                    }

                    // Bit 3: StackId present
                    let stackId: number;
                    if (eventFlags & 0x08) {
                        stackId = reader.readVarUInt();
                    } else {
                        stackId = prevStackId;
                    }

                    // Timestamp delta always present
                    const timestampDelta = reader.readVarInt64();
                    const timestamp = prevTimestamp + timestampDelta;

                    // Bit 4: ActivityId present
                    if (eventFlags & 0x10) {
                        reader.skip(16);
                    }
                    
                    // Bit 5: RelatedActivityId present
                    if (eventFlags & 0x20) {
                        reader.skip(16);
                    }

                    // Bit 7: PayloadSize present
                    let payloadSize: number;
                    if (eventFlags & 0x80) {
                        payloadSize = reader.readVarUInt();
                    } else {
                        payloadSize = prevPayloadSize;
                    }

                    if (payloadSize > 0 && reader.hasBytes(payloadSize)) {
                        const payload = reader.readBytes(payloadSize);
                        this.processEvent(metadataId, threadId, timestamp, stackId, payload, result);
                    }

                    // Update state for next event
                    prevMetadataId = metadataId;
                    prevThreadId = threadId;
                    prevStackId = stackId;
                    prevTimestamp = timestamp;
                    prevPayloadSize = payloadSize;
                } else {
                    // Uncompressed format (V3 and earlier or when flags say uncompressed)
                    if (!reader.hasBytes(4)) break;
                    
                    const eventSize = reader.readUInt32LE();
                    if (eventSize === 0 || !reader.hasBytes(eventSize)) break;

                    const startOffset = reader.offset;
                    
                    const metadataIdWithFlags = reader.readUInt32LE();
                    const metadataId = metadataIdWithFlags & 0x7FFFFFFF;
                    reader.readUInt32LE(); // sequenceNumber
                    const threadId = reader.readUInt64LE();
                    reader.readUInt64LE(); // captureThreadId
                    reader.readUInt32LE(); // processorNumber
                    const stackId = reader.readUInt32LE();
                    const timestamp = reader.readUInt64LE();
                    reader.skip(32); // activityId + relatedActivityId
                    const payloadSize = reader.readUInt32LE();

                    if (payloadSize > 0 && reader.hasBytes(payloadSize)) {
                        const payload = reader.readBytes(payloadSize);
                        this.processEvent(metadataId, threadId, timestamp, stackId, payload, result);
                    }

                    // Align to 4-byte boundary
                    const consumed = reader.offset - startOffset;
                    const padding = (4 - (consumed % 4)) % 4;
                    if (padding > 0) reader.skip(padding);
                }
            } catch (err) {
                // Error parsing event - stop
                break;
            }
        }
    }

    private processEvent(metadataId: number, threadId: bigint, timestamp: bigint,
                         stackId: number, payload: Buffer, result: ParseResult): void {
        this.debugInfo.totalEvents++;
        
        const meta = this.metadata.get(metadataId);
        
        if (meta) {
            // Check for GCAllocationTick event (Event ID 10 from CLR provider)
            if (meta.providerName === DOTNET_RUNTIME_PROVIDER && 
                meta.eventId === GC_ALLOCATION_TICK_EVENT_ID) {
                this.debugInfo.allocationEvents++;
                this.parseAllocationEvent(payload, timestamp, stackId, result);
            }
        }
    }

    private parseAllocationEvent(payload: Buffer, timestamp: bigint, stackId: number,
                                  result: ParseResult): void {
        if (payload.length < 10) return;

        try {
            const reader = new BufferReader(payload);

            // GCAllocationTick event format (varies by version):
            // V1: AllocationAmount (UInt32), AllocationKind (UInt32), TypeName (string)
            // V2: adds ClrInstanceID (UInt16)
            // V3: adds TypeID (UInt64), HeapIndex (UInt32)
            // V4: adds Address (UInt64), ObjectSize (UInt64)
            
            const allocationAmount = reader.readUInt32LE();
            const allocationKind = reader.readUInt32LE();
            reader.readUInt16LE(); // clrInstanceId

            let allocSize = BigInt(allocationAmount);
            
            // Try to read extended fields
            if (reader.remaining >= 8) {
                // allocationAmount64 (more accurate)
                allocSize = reader.readUInt64LE();
            }

            // Skip TypeID (pointer size)
            if (reader.remaining >= this.pointerSize) {
                reader.skip(this.pointerSize);
            }

            // Read TypeName (null-terminated UTF16)
            let typeName = reader.readNullTerminatedUTF16();
            if (!typeName || typeName.length === 0) {
                typeName = '<unknown>';
            }

            this.addAllocation(result, typeName, allocSize, timestamp, stackId);
        } catch (err) {
            // Allocation parsing failed
            if (this.debug) {
                console.log(`Failed to parse allocation event: ${err}`);
            }
        }
    }

    private addAllocation(result: ParseResult, typeName: string, size: bigint, 
                          timestamp: bigint, stackId: number): void {
        let allocInfo = result.allocations.get(typeName);
        if (!allocInfo) {
            allocInfo = {
                typeName,
                count: 0,
                totalSize: BigInt(0),
                allocations: []
            };
            result.allocations.set(typeName, allocInfo);
        }

        allocInfo.count++;
        allocInfo.totalSize += size;
        
        // Get stack trace if available
        let stackTrace: string[] | undefined;
        const stack = this.stacks.get(stackId);
        if (stack) {
            stackTrace = stack.addresses.map(addr => `0x${addr.toString(16)}`);
        }

        allocInfo.allocations.push({
            typeName,
            size,
            timestamp,
            stackTrace
        });
    }

    private parseStackBlock(data: Buffer): void {
        const reader = new BufferReader(data);

        try {
            const firstId = reader.readUInt32LE();
            const count = reader.readUInt32LE();

            if (this.debug) {
                console.log(`StackBlock: firstId=${firstId}, count=${count}`);
            }

            let currentId = firstId;
            for (let i = 0; i < count && reader.remaining >= 4; i++) {
                const stackSize = reader.readUInt32LE();
                
                if (stackSize === 0 || !reader.hasBytes(stackSize)) break;

                const addresses: bigint[] = [];
                const numAddrs = Math.floor(stackSize / this.pointerSize);

                for (let j = 0; j < numAddrs && reader.hasBytes(this.pointerSize); j++) {
                    if (this.pointerSize === 8) {
                        addresses.push(reader.readUInt64LE());
                    } else {
                        addresses.push(BigInt(reader.readUInt32LE()));
                    }
                }

                this.stacks.set(currentId, { stackId: currentId, addresses });
                currentId++;
            }
        } catch (err) {
            // Stack block parsing failed
        }
    }
}

// Alias for backward compatibility
export class NetTraceFullParser extends NetTraceParser {}
