# NetTrace Viewer

A Visual Studio Code extension for viewing .nettrace files with object allocation analysis.

## Features

- **Custom Editor for .nettrace files**: Open .nettrace files directly in VS Code with a visual interface
- **Object Allocation Analysis**: View allocation statistics by type including:
  - Type name
  - Allocation count
  - Total memory allocated
  - Average allocation size
- **Interactive Table**: 
  - Sort by any column
  - Filter by type name
  - Search through allocations
- **Trace Information**: View trace metadata including:
  - Trace timestamp
  - Process ID
  - Pointer size (32/64-bit)

## Usage

### Opening .nettrace Files

1. Simply open any `.nettrace` file in VS Code - the extension will automatically display it using the custom viewer
2. Or use the command palette: `Ctrl+Shift+P` → "NetTrace: Open NetTrace File"

### Collecting .nettrace Files

To collect a .nettrace file with GC allocation events:

```bash
# Collect allocation events (GC keyword with verbose level)
dotnet-trace collect --providers Microsoft-Windows-DotNETRuntime:0x1:5 -- dotnet run

# Or attach to a running process
dotnet-trace collect --providers Microsoft-Windows-DotNETRuntime:0x1:5 -p <PID>
```

For allocation tracking with the GCAllocationTick event, use keyword `0x1` (GC events).

### Understanding the Data

- **Type Name**: The fully qualified .NET type name
- **Count**: Number of allocations for this type
- **Total Size**: Cumulative memory allocated for this type
- **Avg Size**: Average size per allocation

## Requirements

- Visual Studio Code 1.106.1 or later
- .nettrace files collected with GC allocation events enabled

## Known Limitations

- Stack traces are parsed but not yet displayed in the UI (future feature)
- Large trace files (>100MB) may take a few seconds to parse
- Some older .nettrace format versions may not be fully supported

## Release Notes

### 0.0.1

Initial release:
- Basic .nettrace file parsing
- Object allocation display with sorting and filtering
- Custom editor integration

## License

MIT
