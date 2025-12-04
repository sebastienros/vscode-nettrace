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

export interface MethodInfo {
    methodId: bigint;
    moduleId: bigint;
    methodStartAddress: bigint;
    methodSize: number;
    methodToken: number;
    methodFlags: number;
    methodNamespace: string;
    methodName: string;
    methodSignature: string;
}

export interface MethodProfile {
    methodName: string;           // Full method name (namespace.class.method)
    inclusiveCount: number;       // Samples where this method is on stack (any position)
    exclusiveCount: number;       // Samples where this method is at top of stack
    inclusiveTimeMs: number;      // Estimated inclusive time
    exclusiveTimeMs: number;      // Estimated exclusive time
}

export interface ParseResult {
    traceInfo: TraceInfo | null;
    metadata: Map<number, EventMetadata>;
    allocations: Map<string, AllocationInfo>;
    events: TraceEvent[];
    stacks: Map<number, StackInfo>;
    methods: Map<bigint, MethodInfo>;       // methodId -> MethodInfo
    methodsByAddress: Map<bigint, MethodInfo>; // address range lookup
    methodProfiles: Map<string, MethodProfile>; // methodName -> profile
    allocationSamples: Map<number, { count: number; size: bigint; types: Map<string, { count: number; size: bigint }> }>; // stackId -> allocation count/size/types
    typeStackDistribution: Map<string, Map<number, { count: number; size: bigint }>>; // typeName -> stackId -> count/size
    errors: string[];
    debugInfo: {
        totalEvents: number;
        allocationEvents: number;
        providers: string[];
        eventCounts: Map<string, number>; // provider/eventId -> count
        samplingIntervalMs: number;
    };
}

export interface TraceEvent {
    metadataId: number;
    threadId: bigint;
    timestamp: bigint;
    stackId: number;
    payload: Buffer;
}

// FastSerialization tags from PerfView (src/FastSerialization/FastSerialization.cs)
enum SerializationTag {
    Error = 0,
    NullReference = 1,
    ObjectReference = 2,
    ForwardReference = 3,
    BeginObject = 4,
    BeginPrivateObject = 5,
    EndObject = 6,
    ForwardDefinition = 7,
    Byte = 8,
    Int16 = 9,
    Int32 = 10,
    Int64 = 11,
    SkipRegion = 12,
    String = 13,
    Blob = 14,
}

// Known provider names
const DOTNET_RUNTIME_PROVIDER = 'Microsoft-Windows-DotNETRuntime';
const DOTNET_RUNTIME_RUNDOWN_PROVIDER = 'Microsoft-Windows-DotNETRuntimeRundown';
const SAMPLE_PROFILER_PROVIDER = 'Microsoft-DotNETCore-SampleProfiler';

// Event IDs for GC allocation events
const GC_ALLOCATION_TICK_EVENT_ID = 10;

// Event IDs for method load events (from CLR ETW provider)
const METHOD_LOAD_VERBOSE_EVENT_ID = 143;
const METHOD_JITTING_STARTED_EVENT_ID = 145;
// Rundown events have same format
const METHOD_DC_END_VERBOSE_EVENT_ID = 144;  // MethodDCEndVerbose - same format as MethodLoadVerbose

// Event IDs for SampleProfiler
const THREAD_SAMPLE_EVENT_ID = 0;  // SampleProfiler uses event ID 0 for thread samples

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

    // Unsigned varint64 (same encoding as readVarInt64, just different interpretation)
    readVarUInt64(): bigint {
        let result = BigInt(0);
        let shift = BigInt(0);
        let b: number;
        do {
            if (!this.hasBytes(1)) {
                throw new Error('End of buffer reading varuint64');
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
        eventCountsByMetadataId: new Map<number, number>(),
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
            methods: new Map(),
            methodsByAddress: new Map(),
            methodProfiles: new Map(),
            allocationSamples: new Map(),
            typeStackDistribution: new Map(),
            errors: [],
            debugInfo: {
                totalEvents: 0,
                allocationEvents: 0,
                providers: [],
                eventCounts: new Map(),
                samplingIntervalMs: 1  // Default 1ms, updated from actual trace
            }
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
            
            // Compute method profiles from CPU samples
            this.computeMethodProfiles(result);
            
            // Build event counts by provider/eventName
            const eventCounts = new Map<string, number>();
            for (const [metadataId, count] of this.debugInfo.eventCountsByMetadataId) {
                const meta = this.metadata.get(metadataId);
                if (meta) {
                    const key = `${meta.providerName}:${meta.eventId}`;
                    eventCounts.set(key, (eventCounts.get(key) || 0) + count);
                }
            }
            
            result.debugInfo = {
                totalEvents: this.debugInfo.totalEvents,
                allocationEvents: this.debugInfo.allocationEvents,
                providers: Array.from(this.debugInfo.providers),
                eventCounts,
                samplingIntervalMs: 1  // TODO: Extract from trace if available
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
                        // Blob at top level (shouldn't normally happen), skip it
                        if (this.reader.hasBytes(4)) {
                            const size = this.reader.readInt32LE();
                            if (size > 0 && size <= this.reader.remaining) {
                                this.reader.skip(size);
                            }
                        }
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
        // The type reference is itself serialized. It can be:
        // - BeginPrivateObject + NullReference + type definition (for new types)
        // - BeginPrivateObject + varint type index (for previously seen types)
        // - Just a varint type index directly (older format)
        
        const startOffset = this.reader.offset;
        
        // Check if next byte is BeginPrivateObject (type reference is an object)
        const nextByte = this.reader.peekByte();
        
        let typeInfo: TypeInfo;
        
        if (nextByte === SerializationTag.BeginPrivateObject) {
            // Type reference is serialized as an object
            this.reader.readByte(); // consume BeginPrivateObject
            
            const typeRefByte = this.reader.peekByte();
            
            if (typeRefByte === SerializationTag.NullReference) {
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
                // Reference to existing type (varint index)
                const typeIndex = this.reader.readVarUInt();
                typeInfo = this.typeRegistry.get(typeIndex)!;
                
                if (!typeInfo) {
                    this.errors.push(`Unknown type index: ${typeIndex}`);
                    // Skip to find EndObject and try to continue
                    this.skipToEndObject();
                    return;
                }
            }
            
            // After type reference object, there should be EndObject for the type ref
            if (this.reader.hasBytes(1) && this.reader.peekByte() === SerializationTag.EndObject) {
                this.reader.readByte(); // consume EndObject of type reference
            }
        } else if (nextByte === SerializationTag.NullReference) {
            // Old format: NullReference directly after BeginPrivateObject means new type
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
            // Direct varint type index
            const typeIndex = this.reader.readVarUInt();
            typeInfo = this.typeRegistry.get(typeIndex)!;
            
            if (!typeInfo) {
                this.errors.push(`Unknown type index: ${typeIndex}`);
                return;
            }
        }

        // Now we should parse the object payload directly (no Blob tag in nettrace format)
        this.parseObjectPayload(typeInfo, result);
    }

    private skipToEndObject(): void {
        // Try to find the next EndObject tag to recover from errors
        let depth = 1;
        while (this.reader.remaining > 0 && depth > 0) {
            const tag = this.reader.readByte();
            if (tag === SerializationTag.EndObject) {
                depth--;
            } else if (tag === SerializationTag.BeginPrivateObject || tag === SerializationTag.BeginObject) {
                depth++;
            } else if (tag === SerializationTag.Blob) {
                // Skip blob content using 4-byte size
                if (this.reader.remaining >= 4) {
                    const size = this.reader.readInt32LE();
                    if (size > 0 && size < this.reader.remaining) {
                        this.reader.skip(size);
                    }
                }
            }
        }
    }

    private parseObjectPayload(typeInfo: TypeInfo, result: ParseResult): void {
        const typeName = typeInfo.typeName;
        const startOffset = this.reader.offset;
        
        try {
            if (typeName === 'Trace') {
                // Trace object: payload is directly serialized fields
                // SYSTEMTIME(16) + syncTimeTicks(8) + tickFreq(8) + pointerSize(4) + 
                // processId(4) + numProcessors(4) + cpuSamplingRate(4) = 48 bytes
                if (this.reader.hasBytes(48)) {
                    const data = this.reader.readBytes(48);
                    result.traceInfo = this.parseTraceBlob(data);
                }
                // After Trace payload, there should be EndObject tag
                this.skipToNextObject();
                return;
            }
            
            // For block types (MetadataBlock, EventBlock, StackBlock, SPBlock):
            // BlockSize (int) + alignment padding + header + content
            if (typeName === 'MetadataBlock' || typeName === 'EventBlock' || 
                typeName === 'StackBlock' || typeName === 'SPBlock') {
                
                if (!this.reader.hasBytes(4)) {
                    return;
                }
                
                // Read BlockSize
                const blockSize = this.reader.readInt32LE();
                
                if (blockSize <= 0 || blockSize > 100000000) {
                    if (this.debug) {
                        console.log(`Invalid block size ${blockSize} for ${typeName} at offset ${startOffset}`);
                    }
                    this.reader.offset = startOffset; // Back up
                    this.skipToNextObject();
                    return;
                }
                
                // Calculate alignment padding to reach 4-byte file alignment
                const currentPos = this.reader.offset;
                const alignPad = (4 - (currentPos & 3)) & 3;
                
                if (this.debug) {
                    console.log(`${typeName}: blockSize=${blockSize}, offset=${currentPos}, alignPad=${alignPad}`);
                }
                
                this.reader.skip(alignPad);
                
                // Now read the block content
                if (!this.reader.hasBytes(blockSize)) {
                    if (this.debug) {
                        console.log(`Not enough bytes for block: need ${blockSize}, have ${this.reader.remaining}`);
                    }
                    this.skipToNextObject();
                    return;
                }
                
                const blockData = this.reader.readBytes(blockSize);
                this.processBlock(typeInfo, blockData, result);
                
                // After block content, there should be EndObject tag
                this.skipToNextObject();
                return;
            }
            
            // Unknown object type - try to skip to EndObject
            if (this.debug) {
                console.log(`Unknown object type: ${typeName} at offset ${startOffset}`);
            }
            this.skipToNextObject();
            
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.errors.push(`Error parsing ${typeName}: ${errMsg}`);
            this.skipToNextObject();
        }
    }
    
    private skipToNextObject(): void {
        // Skip bytes until we find EndObject or BeginPrivateObject
        while (this.reader.remaining > 0) {
            const byte = this.reader.peekByte();
            if (byte === SerializationTag.EndObject) {
                this.reader.readByte(); // consume EndObject
                return;
            }
            if (byte === SerializationTag.BeginPrivateObject) {
                return; // Let main loop handle next object
            }
            this.reader.readByte(); // skip unknown byte
        }
    }

    private processBlock(typeInfo: TypeInfo, data: Buffer, result: ParseResult): void {
        const typeName = typeInfo.typeName;
        
        if (this.debug && data.length > 0) {
            console.log(`Processing ${typeName} block, size=${data.length}`);
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
        
        // Block header: headerSize (int16) + flags (int16) + additional header data
        // headerSize includes the headerSize field itself
        const headerSize = reader.readInt16LE();
        const flags = reader.readInt16LE();
        
        // Skip remaining header bytes (we've read 4 bytes: headerSize + flags)
        if (headerSize > 4) {
            reader.skip(headerSize - 4);
        }

        const compressed = (flags & 1) !== 0;
        
        if (this.debug) {
            console.log(`MetadataBlock: headerSize=${headerSize}, flags=${flags}, compressed=${compressed}, remaining=${reader.remaining}`);
        }

        // Parse metadata events (each one defines an event type)
        // Use a persistent header state object like PerfView does (passed by ref)
        const headerState = {
            metadataId: 0,
            sequenceNumber: 0,
            captureThreadId: BigInt(0),
            threadId: BigInt(0),
            stackId: 0,
            timestamp: BigInt(0),
            payloadSize: 0
        };
        
        while (reader.remaining > 0) {
            try {
                this.parseMetadataEvent(reader, compressed, headerState);
            } catch (err) {
                if (this.debug) {
                    console.log(`Error parsing metadata event: ${err}`);
                }
                break;
            }
        }
    }

    private parseMetadataEvent(reader: BufferReader, compressed: boolean, state: {
        metadataId: number;
        sequenceNumber: number;
        captureThreadId: bigint;
        threadId: bigint;
        stackId: number;
        timestamp: bigint;
        payloadSize: number;
    }): void {
        // Based on PerfView's ReadEventHeader and ReadFromFormatV4
        // In V3-V5, metadata is stored as special events where the payload IS the metadata
        
        if (!compressed) {
            // Uncompressed format (LayoutV4):
            // EventSize (int), MetadataId (int), SequenceNumber (int), ThreadId (long), 
            // CaptureThreadId (long), ProcNumber (int), StackId (int), Timestamp (long),
            // ActivityId (GUID), RelatedActivityId (GUID), PayloadSize (int)
            // Total: 4+4+4+8+8+4+4+8+16+16+4 = 80 bytes header
            
            reader.readInt32LE(); // eventSize
            state.metadataId = reader.readInt32LE() & 0x7FFFFFFF; // low 31 bits
            state.sequenceNumber = reader.readInt32LE();
            state.threadId = reader.readInt64LE();
            state.captureThreadId = reader.readInt64LE();
            reader.readInt32LE(); // procNumber
            state.stackId = reader.readInt32LE();
            state.timestamp = reader.readInt64LE();
            reader.skip(16); // activityId
            reader.skip(16); // relatedActivityId
            state.payloadSize = reader.readInt32LE();
            
            if (state.payloadSize > 0 && reader.hasBytes(state.payloadSize)) {
                const payloadReader = reader.subReader(state.payloadSize);
                this.parseMetadataPayload(payloadReader);
            }
            
            return;
        }
        
        // Compressed format - matches PerfView's ReadFromFormatV4 with useHeaderCompression=true
        const flags = reader.readByte();
        
        if (this.debug) {
            console.log(`  MetadataEvent: flags=0x${flags.toString(16).padStart(2, '0')}, offset=${reader.offset - 1}`);
        }
        
        // Bit 0 (0x01): MetadataId present
        if (flags & 0x01) {
            state.metadataId = reader.readVarUInt();
        }
        
        // Bit 1 (0x02): CaptureThreadAndSequence present
        if (flags & 0x02) {
            const seqDelta = reader.readVarUInt();
            state.sequenceNumber += seqDelta + 1;
            state.captureThreadId = reader.readVarInt64();
            reader.readVarUInt(); // processorNumber (ignored)
        } else {
            // If metadataId != 0, increment sequence number
            if (state.metadataId !== 0) {
                state.sequenceNumber++;
            }
        }
        
        // Bit 2 (0x04): ThreadId present
        if (flags & 0x04) {
            state.threadId = reader.readVarInt64();
        }
        
        // Bit 3 (0x08): StackId present
        if (flags & 0x08) {
            state.stackId = reader.readVarUInt();
        }
        
        // Timestamp delta is ALWAYS read (not optional)
        const timestampDelta = reader.readVarUInt64();
        state.timestamp += timestampDelta;
        
        // Bit 4 (0x10): ActivityId present
        if (flags & 0x10) {
            reader.skip(16);
        }
        
        // Bit 5 (0x20): RelatedActivityId present  
        if (flags & 0x20) {
            reader.skip(16);
        }
        
        // Bit 6 (0x40): Sorted flag - just a flag, no data
        // (we ignore this)
        
        // Bit 7 (0x80): DataLength (PayloadSize) present
        if (flags & 0x80) {
            state.payloadSize = reader.readVarUInt();
        }
        // If not present, reuse previous payloadSize
        
        if (this.debug) {
            console.log(`    metadataId=${state.metadataId}, payloadSize=${state.payloadSize}`);
        }
        
        if (state.payloadSize > 0 && reader.hasBytes(state.payloadSize)) {
            const payloadReader = reader.subReader(state.payloadSize);
            this.parseMetadataPayload(payloadReader);
        }
    }

    private parseMetadataPayload(reader: BufferReader): void {
        // Metadata payload format (V3-V5) from PerfView ReadMetadataHeaderV3ToV5:
        // - MetadataId (int32) - the actual metadata ID is in the payload
        // - ProviderName (null-terminated UTF16)
        // - EventId (int32)
        // - EventName (null-terminated UTF16)
        // - Keywords (int64)
        // - Version (int32)
        // - Level (int32)
        // - FieldCount (int32)
        // - Fields: [TypeCode (int32), FieldName (null-terminated UTF16)]...
        
        try {
            if (this.debug) {
                const buf = reader.getBuffer();
                const hex = buf.slice(0, Math.min(64, buf.length)).toString('hex');
                console.log(`Metadata payload (${buf.length} bytes): ${hex}`);
            }
            
            const payloadMetadataId = reader.readInt32LE();
            const providerName = reader.readNullTerminatedUTF16();
            
            if (this.debug) {
                console.log(`  MetadataId=${payloadMetadataId}, provider="${providerName}", offset now=${reader.offset}`);
            }
            
            const eventId = reader.readInt32LE();
            const eventName = reader.readNullTerminatedUTF16();
            
            if (this.debug) {
                console.log(`  EventId=${eventId}, eventName="${eventName}", offset now=${reader.offset}`);
            }
            
            const keywords = reader.readInt64LE();
            const version = reader.readInt32LE();
            const level = reader.readInt32LE();
            
            this.debugInfo.providers.add(providerName);
            
            // Read fields
            const fields: FieldMetadata[] = [];
            if (reader.remaining >= 4) {
                const fieldCount = reader.readInt32LE();
                
                if (this.debug) {
                    console.log(`  keywords=${keywords}, version=${version}, level=${level}, fieldCount=${fieldCount}`);
                }
                
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

                    // Timestamp delta always present (unsigned)
                    const timestampDelta = reader.readVarUInt64();
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
                    if (!reader.hasBytes(4)) { break; }
                    
                    const eventSize = reader.readUInt32LE();
                    if (eventSize === 0 || !reader.hasBytes(eventSize)) { break; }

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
                    if (padding > 0) { reader.skip(padding); }
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
        
        // Track event counts by metadataId
        this.debugInfo.eventCountsByMetadataId.set(
            metadataId, 
            (this.debugInfo.eventCountsByMetadataId.get(metadataId) || 0) + 1
        );
        
        const meta = this.metadata.get(metadataId);
        
        if (meta) {
            // Check for GCAllocationTick event (Event ID 10 from CLR provider)
            if (meta.providerName === DOTNET_RUNTIME_PROVIDER) {
                if (meta.eventId === GC_ALLOCATION_TICK_EVENT_ID) {
                    this.debugInfo.allocationEvents++;
                    this.parseAllocationEvent(payload, timestamp, stackId, result);
                } else if (meta.eventId === METHOD_LOAD_VERBOSE_EVENT_ID) {
                    this.parseMethodLoadVerboseEvent(payload, result);
                } else if (meta.eventId === METHOD_JITTING_STARTED_EVENT_ID) {
                    this.parseMethodJittingStartedEvent(payload, result);
                }
            }
            
            // Handle Rundown provider method events (MethodDCEndVerbose has same format)
            if (meta.providerName === DOTNET_RUNTIME_RUNDOWN_PROVIDER) {
                if (meta.eventId === METHOD_DC_END_VERBOSE_EVENT_ID) {
                    this.parseMethodLoadVerboseEvent(payload, result);
                }
            }
            
            // Track CPU samples from SampleProfiler
            if (meta.providerName === SAMPLE_PROFILER_PROVIDER) {
                this.processCpuSample(stackId, timestamp, result);
            }
        }
    }

    private parseMethodLoadVerboseEvent(payload: Buffer, result: ParseResult): void {
        // MethodLoadVerbose event payload (Event ID 143):
        // MethodID: UInt64, ModuleID: UInt64, MethodStartAddress: UInt64, MethodSize: UInt32,
        // MethodToken: UInt32, MethodFlags: UInt32, MethodNamespace: string, MethodName: string,
        // MethodSignature: string, ClrInstanceID: UInt16
        try {
            const reader = new BufferReader(payload);
            
            const methodId = reader.readUInt64LE();
            const moduleId = reader.readUInt64LE();
            const methodStartAddress = reader.readUInt64LE();
            const methodSize = reader.readUInt32LE();
            const methodToken = reader.readUInt32LE();
            const methodFlags = reader.readUInt32LE();
            const methodNamespace = reader.readNullTerminatedUTF16();
            const methodName = reader.readNullTerminatedUTF16();
            const methodSignature = reader.readNullTerminatedUTF16();
            
            const methodInfo: MethodInfo = {
                methodId,
                moduleId,
                methodStartAddress,
                methodSize,
                methodToken,
                methodFlags,
                methodNamespace,
                methodName,
                methodSignature
            };
            
            result.methods.set(methodId, methodInfo);
            result.methodsByAddress.set(methodStartAddress, methodInfo);
            
            if (this.debug) {
                console.log(`  Method loaded: ${methodNamespace}.${methodName} at 0x${methodStartAddress.toString(16)}`);
            }
        } catch (err) {
            // Method load parsing failed
            if (this.debug) {
                console.log(`Failed to parse MethodLoadVerbose event: ${err}`);
            }
        }
    }
    
    private parseMethodJittingStartedEvent(payload: Buffer, result: ParseResult): void {
        // MethodJittingStarted event payload (Event ID 145):
        // MethodID: UInt64, ModuleID: UInt64, MethodToken: UInt32, MethodILSize: UInt32,
        // MethodNamespace: string, MethodName: string, MethodSignature: string, ClrInstanceID: UInt16
        try {
            const reader = new BufferReader(payload);
            
            const methodId = reader.readUInt64LE();
            const moduleId = reader.readUInt64LE();
            const methodToken = reader.readUInt32LE();
            reader.readUInt32LE(); // methodILSize
            const methodNamespace = reader.readNullTerminatedUTF16();
            const methodName = reader.readNullTerminatedUTF16();
            const methodSignature = reader.readNullTerminatedUTF16();
            
            // Only add if we don't have it from MethodLoadVerbose (which has more info)
            if (!result.methods.has(methodId)) {
                const methodInfo: MethodInfo = {
                    methodId,
                    moduleId,
                    methodStartAddress: BigInt(0),
                    methodSize: 0,
                    methodToken,
                    methodFlags: 0,
                    methodNamespace,
                    methodName,
                    methodSignature
                };
                
                result.methods.set(methodId, methodInfo);
            }
        } catch (err) {
            // Method jitting parsing failed
            if (this.debug) {
                console.log(`Failed to parse MethodJittingStarted event: ${err}`);
            }
        }
    }
    
    private cpuSamples: Map<number, number> = new Map();  // stackId -> sample count
    
    private processCpuSample(stackId: number, timestamp: bigint, result: ParseResult): void {
        // Each sample from SampleProfiler represents one CPU sample at this stack
        if (stackId > 0) {
            this.cpuSamples.set(stackId, (this.cpuSamples.get(stackId) || 0) + 1);
        }
    }
    
    private computeMethodProfiles(result: ParseResult): void {
        // Build a sorted list of method addresses for binary search lookup
        const methodAddresses: Array<{ address: bigint, endAddress: bigint, method: MethodInfo }> = [];
        for (const method of result.methods.values()) {
            if (method.methodStartAddress > 0) {
                methodAddresses.push({
                    address: method.methodStartAddress,
                    endAddress: method.methodStartAddress + BigInt(method.methodSize),
                    method
                });
            }
        }
        methodAddresses.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
        
        // Function to find method by address
        const findMethodByAddress = (addr: bigint): MethodInfo | undefined => {
            // Binary search for the method containing this address
            let left = 0;
            let right = methodAddresses.length - 1;
            while (left <= right) {
                const mid = Math.floor((left + right) / 2);
                const entry = methodAddresses[mid];
                if (addr >= entry.address && addr < entry.endAddress) {
                    return entry.method;
                } else if (addr < entry.address) {
                    right = mid - 1;
                } else {
                    left = mid + 1;
                }
            }
            return undefined;
        };
        
        // Create a helper to get full method name
        const getMethodFullName = (method: MethodInfo): string => {
            if (method.methodNamespace) {
                return `${method.methodNamespace}.${method.methodName}`;
            }
            return method.methodName || `Method_0x${method.methodStartAddress.toString(16)}`;
        };
        
        // Aggregate samples across all stacks
        const inclusiveCounts = new Map<string, number>();
        const exclusiveCounts = new Map<string, number>();
        let totalSamples = 0;
        
        for (const [stackId, sampleCount] of this.cpuSamples) {
            const stack = this.stacks.get(stackId);
            if (!stack || stack.addresses.length === 0) {
                continue;
            }
            
            totalSamples += sampleCount;
            
            // Track which methods we've seen in this stack to avoid double-counting inclusive
            const seenMethods = new Set<string>();
            
            for (let i = 0; i < stack.addresses.length; i++) {
                const addr = stack.addresses[i];
                const method = findMethodByAddress(addr);
                
                if (method) {
                    const fullName = getMethodFullName(method);
                    
                    // Exclusive count: only the top of stack (first address in our array)
                    if (i === 0) {
                        exclusiveCounts.set(fullName, (exclusiveCounts.get(fullName) || 0) + sampleCount);
                    }
                    
                    // Inclusive count: all methods on stack, but only count each once per sample
                    if (!seenMethods.has(fullName)) {
                        seenMethods.add(fullName);
                        inclusiveCounts.set(fullName, (inclusiveCounts.get(fullName) || 0) + sampleCount);
                    }
                } else {
                    // Unknown method - use address as name
                    const addrName = `<unknown> 0x${addr.toString(16)}`;
                    
                    if (i === 0) {
                        exclusiveCounts.set(addrName, (exclusiveCounts.get(addrName) || 0) + sampleCount);
                    }
                    if (!seenMethods.has(addrName)) {
                        seenMethods.add(addrName);
                        inclusiveCounts.set(addrName, (inclusiveCounts.get(addrName) || 0) + sampleCount);
                    }
                }
            }
        }
        
        // Compute time estimates based on sample count and sampling interval
        // Default interval is 1ms for SampleProfiler
        const samplingIntervalMs = 1;
        
        // Build MethodProfile objects
        const allMethods = new Set([...inclusiveCounts.keys(), ...exclusiveCounts.keys()]);
        for (const methodName of allMethods) {
            const inclusiveCount = inclusiveCounts.get(methodName) || 0;
            const exclusiveCount = exclusiveCounts.get(methodName) || 0;
            
            result.methodProfiles.set(methodName, {
                methodName,
                inclusiveCount,
                exclusiveCount,
                inclusiveTimeMs: inclusiveCount * samplingIntervalMs,
                exclusiveTimeMs: exclusiveCount * samplingIntervalMs
            });
        }
        
        if (this.debug) {
            console.log(`Computed profiles for ${result.methodProfiles.size} methods from ${totalSamples} samples`);
        }
    }

    private parseAllocationEvent(payload: Buffer, timestamp: bigint, stackId: number,
                                  result: ParseResult): void {
        if (payload.length < 10) { return; }

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
        
        // Track allocation samples by stack for flame graph
        if (stackId > 0) {
            const existing = result.allocationSamples.get(stackId);
            if (existing) {
                existing.count++;
                existing.size += size;
                // Track type distribution per stack
                const typeInfo = existing.types.get(typeName);
                if (typeInfo) {
                    typeInfo.count++;
                    typeInfo.size += size;
                } else {
                    existing.types.set(typeName, { count: 1, size });
                }
            } else {
                const types = new Map<string, { count: number; size: bigint }>();
                types.set(typeName, { count: 1, size });
                result.allocationSamples.set(stackId, { count: 1, size, types });
            }
            
            // Track stack distribution per type (reverse mapping for drill-down)
            let typeStacks = result.typeStackDistribution.get(typeName);
            if (!typeStacks) {
                typeStacks = new Map();
                result.typeStackDistribution.set(typeName, typeStacks);
            }
            const stackData = typeStacks.get(stackId);
            if (stackData) {
                stackData.count++;
                stackData.size += size;
            } else {
                typeStacks.set(stackId, { count: 1, size });
            }
        }
        
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
                
                if (stackSize === 0 || !reader.hasBytes(stackSize)) { break; }

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
