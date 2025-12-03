/**
 * Test script to run the nettrace parser
 */

import * as fs from 'fs';
import * as path from 'path';
import { NetTraceParser } from './src/nettraceParser';

const testFile = path.join(__dirname, 'application.12-03-12-52-16.nettrace');

console.log(`Testing parser on: ${testFile}`);

if (!fs.existsSync(testFile)) {
    console.error('Test file not found!');
    process.exit(1);
}

const buffer = fs.readFileSync(testFile);
console.log(`File size: ${buffer.length} bytes`);

const parser = new NetTraceParser(buffer, true);
const result = parser.parse();

console.log('\n=== PARSE RESULT ===');
console.log('TraceInfo:', result.traceInfo);
console.log('Metadata entries:', result.metadata.size);
console.log('Events parsed:', result.events.length);
console.log('Stacks:', result.stacks.size);
console.log('Errors:', result.errors);
console.log('Debug info:', result.debugInfo);

// List some metadata
console.log('\n=== METADATA ===');
for (const [id, meta] of Array.from(result.metadata.entries()).slice(0, 10)) {
    console.log(`  [${id}] ${meta.providerName}/${meta.eventName} (event ID ${meta.eventId})`);
}

// Check for GCAllocationTick events (Event ID 10)
console.log('\n=== ALLOCATION-RELATED EVENTS ===');
let hasAllocationEvents = false;
for (const [id, meta] of result.metadata.entries()) {
    if (meta.providerName === 'Microsoft-Windows-DotNETRuntime' && meta.eventId === 10) {
        hasAllocationEvents = true;
        console.log(`  [${id}] event ID ${meta.eventId}: ${meta.eventName || 'GCAllocationTick'}`);
    }
}
if (!hasAllocationEvents) {
    console.log('  No GCAllocationTick events (Event ID 10) found in this trace.');
    console.log('  Make sure the trace was captured with allocation tracking enabled.');
}

// List allocations if any
console.log('\n=== ALLOCATIONS ===');
for (const [typeName, alloc] of Array.from(result.allocations.entries()).slice(0, 10)) {
    console.log(`  ${typeName}: count=${alloc.count}, totalSize=${alloc.totalSize}`);
}
