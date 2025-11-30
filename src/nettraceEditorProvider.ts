import * as vscode from 'vscode';
import { NetTraceFullParser, ParseResult, AllocationInfo } from './nettraceParser';

/**
 * Custom document for .nettrace files
 */
class NetTraceDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;
    private _parseResult: ParseResult | null = null;
    private _disposed = false;

    constructor(uri: vscode.Uri) {
        this.uri = uri;
    }

    async load(): Promise<void> {
        const data = await vscode.workspace.fs.readFile(this.uri);
        const buffer = Buffer.from(data);
        const parser = new NetTraceFullParser(buffer);
        this._parseResult = parser.parse();
    }

    get parseResult(): ParseResult | null {
        return this._parseResult;
    }

    dispose(): void {
        this._disposed = true;
    }
}

/**
 * Custom editor provider for .nettrace files
 */
export class NetTraceEditorProvider implements vscode.CustomReadonlyEditorProvider<NetTraceDocument> {
    public static readonly viewType = 'nettraceViewer.nettraceEditor';

    private static readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<NetTraceDocument>>();
    public static readonly onDidChangeCustomDocument = NetTraceEditorProvider._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<NetTraceDocument> {
        const document = new NetTraceDocument(uri);
        await document.load();
        return document;
    }

    async resolveCustomEditor(
        document: NetTraceDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'refresh':
                        document.load().then(() => {
                            webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);
                        });
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private getHtmlForWebview(webview: vscode.Webview, document: NetTraceDocument): string {
        const result = document.parseResult;
        
        // Prepare allocation data
        let allocationsHtml = '';
        let totalAllocations = 0;
        let totalMemory = BigInt(0);
        let sortedAllocations: AllocationInfo[] = [];

        if (result && result.allocations.size > 0) {
            sortedAllocations = Array.from(result.allocations.values())
                .sort((a, b) => {
                    // Sort by total size descending
                    if (b.totalSize > a.totalSize) return 1;
                    if (b.totalSize < a.totalSize) return -1;
                    return b.count - a.count;
                });

            for (const alloc of sortedAllocations) {
                totalAllocations += alloc.count;
                totalMemory += alloc.totalSize;
            }

            allocationsHtml = sortedAllocations.map((alloc, index) => `
                <tr class="allocation-row" data-index="${index}">
                    <td class="type-name">${escapeHtml(alloc.typeName)}</td>
                    <td class="count">${alloc.count.toLocaleString()}</td>
                    <td class="size">${formatBytes(alloc.totalSize)}</td>
                    <td class="avg-size">${formatBytes(alloc.count > 0 ? alloc.totalSize / BigInt(alloc.count) : BigInt(0))}</td>
                </tr>
            `).join('');
        }

        // Prepare trace info
        let traceInfoHtml = '<p>No trace information available</p>';
        if (result?.traceInfo) {
            traceInfoHtml = `
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">Trace Time:</span>
                        <span class="info-value">${result.traceInfo.syncTimeUTC.toLocaleString()}</span>
                    </div>
                    ${result.traceInfo.processId ? `
                    <div class="info-item">
                        <span class="info-label">Process ID:</span>
                        <span class="info-value">${result.traceInfo.processId}</span>
                    </div>
                    ` : ''}
                    <div class="info-item">
                        <span class="info-label">Pointer Size:</span>
                        <span class="info-value">${result.traceInfo.pointerSize * 8}-bit</span>
                    </div>
                </div>
            `;
        }

        // Prepare errors
        let errorsHtml = '';
        if (result?.errors && result.errors.length > 0) {
            errorsHtml = `
                <div class="errors-section">
                    <h3>⚠️ Parsing Notes</h3>
                    <ul>
                        ${result.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <title>NetTrace Viewer</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --header-bg: var(--vscode-sideBarSectionHeader-background);
            --border-color: var(--vscode-panel-border);
            --hover-bg: var(--vscode-list-hoverBackground);
            --selected-bg: var(--vscode-list-activeSelectionBackground);
            --accent-color: var(--vscode-textLink-foreground);
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text-color);
            background-color: var(--bg-color);
            margin: 0;
            padding: 20px;
            line-height: 1.5;
        }

        h1, h2, h3 {
            margin-top: 0;
            color: var(--text-color);
        }

        h1 {
            font-size: 1.5em;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-color);
        }

        .summary-cards {
            display: flex;
            gap: 20px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .summary-card {
            background: var(--header-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 15px 20px;
            min-width: 150px;
        }

        .summary-card .label {
            font-size: 0.85em;
            opacity: 0.8;
            margin-bottom: 5px;
        }

        .summary-card .value {
            font-size: 1.5em;
            font-weight: 600;
            color: var(--accent-color);
        }

        .section {
            margin-bottom: 30px;
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 10px;
        }

        .info-item {
            display: flex;
            gap: 10px;
        }

        .info-label {
            font-weight: 600;
            opacity: 0.8;
        }

        .search-box {
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--bg-color);
            color: var(--text-color);
            font-size: 0.9em;
            width: 250px;
        }

        .search-box:focus {
            outline: 1px solid var(--accent-color);
            border-color: var(--accent-color);
        }

        .table-container {
            overflow-x: auto;
            border: 1px solid var(--border-color);
            border-radius: 6px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9em;
        }

        th, td {
            padding: 10px 15px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        th {
            background: var(--header-bg);
            font-weight: 600;
            position: sticky;
            top: 0;
            cursor: pointer;
            user-select: none;
        }

        th:hover {
            background: var(--hover-bg);
        }

        th.sorted-asc::after {
            content: ' ▲';
            font-size: 0.8em;
        }

        th.sorted-desc::after {
            content: ' ▼';
            font-size: 0.8em;
        }

        tr:hover {
            background: var(--hover-bg);
        }

        tr:last-child td {
            border-bottom: none;
        }

        .type-name {
            font-family: var(--vscode-editor-font-family), monospace;
            word-break: break-all;
            max-width: 500px;
        }

        .count, .size, .avg-size {
            text-align: right;
            font-family: var(--vscode-editor-font-family), monospace;
            white-space: nowrap;
        }

        .errors-section {
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 20px;
        }

        .errors-section h3 {
            margin-bottom: 10px;
            color: var(--vscode-inputValidation-warningForeground);
        }

        .errors-section ul {
            margin: 0;
            padding-left: 20px;
        }

        .no-data {
            text-align: center;
            padding: 40px;
            opacity: 0.6;
        }

        .hidden {
            display: none;
        }

        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .file-name {
            opacity: 0.7;
            font-size: 0.9em;
            font-weight: normal;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>
            📊 NetTrace Viewer
            <span class="file-name">${escapeHtml(document.uri.fsPath.split('/').pop() || '')}</span>
        </h1>
        <button onclick="refresh()">↻ Refresh</button>
    </div>

    ${errorsHtml}

    <div class="section">
        <h2>Trace Information</h2>
        ${traceInfoHtml}
    </div>

    <div class="summary-cards">
        <div class="summary-card">
            <div class="label">Unique Types</div>
            <div class="value">${sortedAllocations.length.toLocaleString()}</div>
        </div>
        <div class="summary-card">
            <div class="label">Total Allocations</div>
            <div class="value">${totalAllocations.toLocaleString()}</div>
        </div>
        <div class="summary-card">
            <div class="label">Total Memory</div>
            <div class="value">${formatBytes(totalMemory)}</div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">
            <h2>Object Allocations</h2>
            <input type="text" class="search-box" id="searchBox" placeholder="Filter by type name..." oninput="filterTable()">
        </div>
        
        ${sortedAllocations.length > 0 ? `
        <div class="table-container">
            <table id="allocationsTable">
                <thead>
                    <tr>
                        <th data-column="type" onclick="sortTable('type')">Type Name</th>
                        <th data-column="count" onclick="sortTable('count')" class="sorted-desc">Count</th>
                        <th data-column="size" onclick="sortTable('size')">Total Size</th>
                        <th data-column="avg" onclick="sortTable('avg')">Avg Size</th>
                    </tr>
                </thead>
                <tbody id="allocationsBody">
                    ${allocationsHtml}
                </tbody>
            </table>
        </div>
        ` : `
        <div class="no-data">
            <p>No allocation data found in this trace file.</p>
            <p>Make sure the trace was collected with GC allocation events enabled.</p>
            <p>Use: <code>dotnet-trace collect --providers Microsoft-Windows-DotNETRuntime:0x1:5</code></p>
        </div>
        `}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        const allocations = ${JSON.stringify(sortedAllocations.map(a => ({
            typeName: a.typeName,
            count: a.count,
            totalSize: a.totalSize.toString(),
            avgSize: a.count > 0 ? (a.totalSize / BigInt(a.count)).toString() : '0'
        })))};

        let currentSort = { column: 'size', descending: true };

        function filterTable() {
            const searchTerm = document.getElementById('searchBox').value.toLowerCase();
            const rows = document.querySelectorAll('#allocationsBody tr');
            
            rows.forEach((row, index) => {
                const typeName = allocations[index].typeName.toLowerCase();
                row.classList.toggle('hidden', !typeName.includes(searchTerm));
            });
        }

        function sortTable(column) {
            const descending = currentSort.column === column ? !currentSort.descending : true;
            currentSort = { column, descending };

            // Update header classes
            document.querySelectorAll('th').forEach(th => {
                th.classList.remove('sorted-asc', 'sorted-desc');
                if (th.dataset.column === column) {
                    th.classList.add(descending ? 'sorted-desc' : 'sorted-asc');
                }
            });

            // Sort allocations
            const sorted = [...allocations].sort((a, b) => {
                let cmp = 0;
                switch (column) {
                    case 'type':
                        cmp = a.typeName.localeCompare(b.typeName);
                        break;
                    case 'count':
                        cmp = a.count - b.count;
                        break;
                    case 'size':
                        cmp = BigInt(a.totalSize) > BigInt(b.totalSize) ? 1 : 
                              BigInt(a.totalSize) < BigInt(b.totalSize) ? -1 : 0;
                        break;
                    case 'avg':
                        cmp = BigInt(a.avgSize) > BigInt(b.avgSize) ? 1 :
                              BigInt(a.avgSize) < BigInt(b.avgSize) ? -1 : 0;
                        break;
                }
                return descending ? -cmp : cmp;
            });

            // Rebuild table
            const tbody = document.getElementById('allocationsBody');
            tbody.innerHTML = sorted.map((alloc, index) => \`
                <tr class="allocation-row" data-index="\${index}">
                    <td class="type-name">\${escapeHtml(alloc.typeName)}</td>
                    <td class="count">\${Number(alloc.count).toLocaleString()}</td>
                    <td class="size">\${formatBytes(BigInt(alloc.totalSize))}</td>
                    <td class="avg-size">\${formatBytes(BigInt(alloc.avgSize))}</td>
                </tr>
            \`).join('');

            // Reapply filter
            filterTable();
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function formatBytes(bytes) {
            const bigBytes = BigInt(bytes);
            if (bigBytes === 0n) return '0 B';
            
            const k = 1024n;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            
            let i = 0;
            let value = bigBytes;
            while (value >= k && i < sizes.length - 1) {
                value = value / k;
                i++;
            }
            
            if (i === 0) {
                return bigBytes.toString() + ' B';
            }
            
            // Calculate with more precision
            const divisor = k ** BigInt(i);
            const wholePart = bigBytes / divisor;
            const remainder = bigBytes % divisor;
            const decimal = Number(remainder) / Number(divisor);
            
            const finalValue = Number(wholePart) + decimal;
            return finalValue.toFixed(2) + ' ' + sizes[i];
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
    </script>
</body>
</html>`;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatBytes(bytes: bigint): string {
    if (bytes === BigInt(0)) return '0 B';
    
    const k = BigInt(1024);
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    
    let i = 0;
    let value = bytes;
    while (value >= k && i < sizes.length - 1) {
        value = value / k;
        i++;
    }
    
    if (i === 0) {
        return bytes.toString() + ' B';
    }
    
    // Calculate with more precision
    const divisor = k ** BigInt(i);
    const wholePart = bytes / divisor;
    const remainder = bytes % divisor;
    const decimal = Number(remainder) / Number(divisor);
    
    const finalValue = Number(wholePart) + decimal;
    return finalValue.toFixed(2) + ' ' + sizes[i];
}
