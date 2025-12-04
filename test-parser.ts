/**
 * Debug script to test nettrace parser
 * Run with: npx ts-node test-parser.ts /path/to/file.nettrace
 */

import * as fs from 'fs';
import { NetTraceFullParser } from './src/nettraceParser';

const filePath = process.argv[2] || '/Users/sebastienros/tmp/dotnet_20251129_162608.nettrace';

if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
}

console.log(`Parsing: ${filePath}`);
console.log(`File size: ${fs.statSync(filePath).size} bytes`);
console.log('---');

const buffer = fs.readFileSync(filePath);
const parser = new NetTraceFullParser(buffer, true); // Enable debug mode
const result = parser.parse();

console.log('\n=== RESULTS ===');
console.log(`Trace Info: ${result.traceInfo ? 'OK' : 'MISSING'}`);
if (result.traceInfo) {
    console.log(`  Time: ${result.traceInfo.syncTimeUTC.toISOString()}`);
    console.log(`  Pointer Size: ${result.traceInfo.pointerSize}`);
    console.log(`  Process ID: ${result.traceInfo.processId}`);
}

console.log(`\nMetadata entries: ${result.metadata.size}`);
result.metadata.forEach((meta, id) => {
    console.log(`  [${id}] ${meta.providerName}/${meta.eventName} (id=${meta.eventId})`);
});

console.log(`\nProviders found: ${result.debugInfo?.providers?.join(', ') || 'none'}`);
console.log(`Total events processed: ${result.debugInfo?.totalEvents || 0}`);
console.log(`Allocation events: ${result.debugInfo?.allocationEvents || 0}`);

console.log(`\nAllocations: ${result.allocations.size} unique types`);
if (result.allocations.size > 0) {
    // Sort by total size descending
    const sorted = Array.from(result.allocations.values())
        .sort((a, b) => Number(b.totalSize - a.totalSize))
        .slice(0, 20);
    
    console.log('\nTop 20 allocations by size:');
    for (const alloc of sorted) {
        console.log(`  ${alloc.typeName}: ${alloc.count} allocations, ${alloc.totalSize} bytes`);
    }
}

console.log(`\nMethods: ${result.methods.size}`);
console.log(`Method Profiles: ${result.methodProfiles.size}`);
console.log(`Allocation Samples (stacks with allocations): ${result.allocationSamples.size}`);

if (result.methodProfiles.size > 0) {
    // Sort by exclusive count descending
    const sorted = Array.from(result.methodProfiles.values())
        .sort((a, b) => b.exclusiveCount - a.exclusiveCount)
        .slice(0, 20);
    
    console.log('\nTop 20 methods by exclusive samples:');
    for (const profile of sorted) {
        console.log(`  ${profile.methodName}: excl=${profile.exclusiveCount}, incl=${profile.inclusiveCount}`);
    }
}

console.log(`\nStacks: ${result.stacks.size}`);
console.log(`Errors: ${result.errors.length}`);
for (const err of result.errors) {
    console.log(`  - ${err}`);
}
