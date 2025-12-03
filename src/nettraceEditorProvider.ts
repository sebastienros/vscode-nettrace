import * as vscode from 'vscode';
import { NetTraceFullParser, ParseResult, AllocationInfo, MethodProfile } from './nettraceParser';

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
                    if (b.totalSize > a.totalSize) { return 1; }
                    if (b.totalSize < a.totalSize) { return -1; }
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
        const totalEvents = result?.debugInfo?.totalEvents || 0;
        const providers = result?.debugInfo?.providers || [];
        const eventCounts = result?.debugInfo?.eventCounts;
        const stackCount = result?.stacks?.size || 0;
        const methodCount = result?.methods?.size || 0;

        // Prepare method profiling data
        let sortedProfiles: MethodProfile[] = [];
        const methodProfiles = result?.methodProfiles;
        
        if (methodProfiles && methodProfiles.size > 0) {
            sortedProfiles = Array.from(methodProfiles.values())
                .sort((a, b) => b.exclusiveCount - a.exclusiveCount);
        }

        // Build event statistics by provider
        const providerStats: Map<string, { events: { eventId: number; count: number }[]; total: number }> = new Map();
        if (eventCounts) {
            for (const [key, count] of eventCounts) {
                const [provider, eventIdStr] = key.split(':');
                const eventId = parseInt(eventIdStr, 10);
                
                if (!providerStats.has(provider)) {
                    providerStats.set(provider, { events: [], total: 0 });
                }
                const stats = providerStats.get(provider)!;
                stats.events.push({ eventId, count });
                stats.total += count;
            }
            
            for (const stats of providerStats.values()) {
                stats.events.sort((a, b) => b.count - a.count);
            }
        }
        
        const sortedProviders = Array.from(providerStats.entries())
            .sort((a, b) => b[1].total - a[1].total);

        // Prepare flame graph data
        const flameGraphData = this.buildFlameGraphData(result);

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
            --tab-active-bg: var(--vscode-tab-activeBackground);
            --tab-inactive-bg: var(--vscode-tab-inactiveBackground);
        }

        * { box-sizing: border-box; }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text-color);
            background-color: var(--bg-color);
            margin: 0;
            padding: 0;
            line-height: 1.5;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        h1, h2, h3 { margin-top: 0; color: var(--text-color); }
        h1 { font-size: 1.5em; margin-bottom: 0; display: flex; align-items: center; gap: 10px; }
        h2 { font-size: 1.2em; margin-bottom: 15px; }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
        }

        .file-name { opacity: 0.7; font-size: 0.9em; font-weight: normal; }

        /* Tab styles */
        .tab-bar {
            display: flex;
            gap: 0;
            background: var(--tab-inactive-bg);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
        }

        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border: none;
            background: transparent;
            color: var(--text-color);
            opacity: 0.7;
            font-size: 0.9em;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }

        .tab:hover { opacity: 1; background: var(--hover-bg); }
        .tab.active {
            opacity: 1;
            background: var(--tab-active-bg);
            border-bottom-color: var(--accent-color);
        }

        .tab-content {
            display: none;
            padding: 20px;
            overflow-y: auto;
            flex: 1;
        }

        .tab-content.active { display: block; }

        /* Summary cards */
        .summary-cards {
            display: flex;
            gap: 20px;
            margin-bottom: 25px;
            flex-wrap: wrap;
        }

        .summary-card {
            background: var(--header-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 15px 20px;
            min-width: 150px;
        }

        .summary-card .label { font-size: 0.85em; opacity: 0.8; margin-bottom: 5px; }
        .summary-card .value { font-size: 1.5em; font-weight: 600; color: var(--accent-color); }

        .section { margin-bottom: 30px; }
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
            margin-bottom: 20px;
        }

        .info-item { display: flex; gap: 10px; }
        .info-label { font-weight: 600; opacity: 0.8; }

        .search-box {
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--bg-color);
            color: var(--text-color);
            font-size: 0.9em;
            width: 250px;
        }

        .search-box:focus { outline: 1px solid var(--accent-color); border-color: var(--accent-color); }

        .table-container {
            overflow-x: auto;
            border: 1px solid var(--border-color);
            border-radius: 6px;
        }

        table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
        th, td { padding: 10px 15px; text-align: left; border-bottom: 1px solid var(--border-color); }
        th {
            background: var(--header-bg);
            font-weight: 600;
            position: sticky;
            top: 0;
            cursor: pointer;
            user-select: none;
        }
        th:hover { background: var(--hover-bg); }
        th.sorted-asc::after { content: ' ▲'; font-size: 0.8em; }
        th.sorted-desc::after { content: ' ▼'; font-size: 0.8em; }
        tr:hover { background: var(--hover-bg); }
        tr:last-child td { border-bottom: none; }

        .type-name, .method-name {
            font-family: var(--vscode-editor-font-family), monospace;
            word-break: break-all;
            max-width: 500px;
        }

        .method-name { font-size: 0.85em; max-width: 600px; }

        .count, .size, .avg-size, .time {
            text-align: right;
            font-family: var(--vscode-editor-font-family), monospace;
            white-space: nowrap;
        }

        .no-data { text-align: center; padding: 40px; opacity: 0.6; }
        .subtitle { opacity: 0.7; margin-bottom: 15px; }

        .provider-stats {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 15px;
        }

        .provider-card {
            background: var(--header-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 15px;
        }

        .provider-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-color);
        }

        .provider-name { font-weight: 600; font-size: 0.9em; word-break: break-all; }
        .provider-count { color: var(--accent-color); font-weight: 600; white-space: nowrap; margin-left: 10px; }
        .event-list { font-size: 0.85em; }
        .event-row { display: flex; justify-content: space-between; padding: 3px 0; }
        .event-row.more { opacity: 0.6; font-style: italic; }
        .event-id { font-family: var(--vscode-editor-font-family), monospace; }
        .event-count { font-family: var(--vscode-editor-font-family), monospace; opacity: 0.8; }

        .hidden { display: none; }

        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }

        /* Flame graph styles */
        .flame-graph-container {
            width: 100%;
            overflow-x: auto;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background: var(--header-bg);
        }

        .flame-graph {
            min-width: 100%;
            min-height: 400px;
        }

        .flame-node {
            position: absolute;
            height: 20px;
            border-radius: 2px;
            font-size: 11px;
            line-height: 20px;
            padding: 0 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            cursor: pointer;
            border: 1px solid rgba(0,0,0,0.1);
        }

        .flame-node:hover {
            filter: brightness(1.2);
            z-index: 10;
        }

        .flame-tooltip {
            position: fixed;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 12px;
            z-index: 1000;
            pointer-events: none;
            max-width: 500px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }

        .flame-tooltip .method { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
        .flame-tooltip .stats { opacity: 0.8; }

        /* Stack view styles */
        .stack-list { max-height: 600px; overflow-y: auto; }
        .stack-item {
            background: var(--header-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            margin-bottom: 10px;
            overflow: hidden;
        }
        .stack-header {
            padding: 10px 15px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .stack-header:hover { background: var(--hover-bg); }
        .stack-id { font-weight: 600; }
        .stack-count { color: var(--accent-color); font-size: 0.9em; }
        .stack-frames {
            display: none;
            padding: 10px 15px;
            border-top: 1px solid var(--border-color);
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 0.85em;
        }
        .stack-frames.expanded { display: block; }
        .stack-frame {
            padding: 3px 0;
            padding-left: 20px;
            border-left: 2px solid var(--accent-color);
            margin-left: 10px;
        }
        .stack-frame:hover { background: var(--hover-bg); }
    </style>
</head>
<body>
    <div class="header">
        <h1>
            📊 NetTrace Viewer
            <span class="file-name">${escapeHtml(document.uri.fsPath.split(/[/\\]/).pop() || '')}</span>
        </h1>
        <button onclick="refresh()">↻ Refresh</button>
    </div>

    <div class="tab-bar">
        <button class="tab active" onclick="switchTab('summary')">Summary</button>
        <button class="tab" onclick="switchTab('allocations')">Allocations</button>
        <button class="tab" onclick="switchTab('stacks')">Stacks</button>
        <button class="tab" onclick="switchTab('flamegraph')">Flame Graph</button>
    </div>

    <!-- Summary Tab -->
    <div id="tab-summary" class="tab-content active">
        <div class="summary-cards">
            <div class="summary-card">
                <div class="label">Total Events</div>
                <div class="value">${totalEvents.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <div class="label">Event Providers</div>
                <div class="value">${providers.length}</div>
            </div>
            <div class="summary-card">
                <div class="label">Stack Samples</div>
                <div class="value">${stackCount.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <div class="label">Methods</div>
                <div class="value">${methodCount.toLocaleString()}</div>
            </div>
            ${sortedAllocations.length > 0 ? `
            <div class="summary-card">
                <div class="label">Allocations</div>
                <div class="value">${totalAllocations.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <div class="label">Memory Allocated</div>
                <div class="value">${formatBytes(totalMemory)}</div>
            </div>
            ` : ''}
        </div>

        <div class="section">
            <h2>Trace Information</h2>
            <div class="info-grid">
                ${result?.traceInfo ? `
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
                ` : '<p>No trace information available</p>'}
            </div>
        </div>

        ${sortedProviders.length > 0 ? `
        <div class="section">
            <h2>Event Providers</h2>
            <div class="provider-stats">
                ${sortedProviders.map(([provider, stats]) => `
                    <div class="provider-card">
                        <div class="provider-header">
                            <span class="provider-name">${escapeHtml(provider)}</span>
                            <span class="provider-count">${stats.total.toLocaleString()} events</span>
                        </div>
                        <div class="event-list">
                            ${stats.events.slice(0, 5).map(e => `
                                <div class="event-row">
                                    <span class="event-id">Event ${e.eventId}</span>
                                    <span class="event-count">${e.count.toLocaleString()}</span>
                                </div>
                            `).join('')}
                            ${stats.events.length > 5 ? `<div class="event-row more">... and ${stats.events.length - 5} more</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}

        ${sortedProfiles.length > 0 ? `
        <div class="section">
            <div class="section-header">
                <h2>Hot Methods (Top 20)</h2>
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Method Name</th>
                            <th>Exclusive</th>
                            <th>Inclusive</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sortedProfiles.slice(0, 20).map(p => `
                            <tr>
                                <td class="method-name">${escapeHtml(p.methodName)}</td>
                                <td class="count">${p.exclusiveCount.toLocaleString()}</td>
                                <td class="count">${p.inclusiveCount.toLocaleString()}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        ` : ''}
    </div>

    <!-- Allocations Tab -->
    <div id="tab-allocations" class="tab-content">
        <div class="section-header">
            <h2>Object Allocations</h2>
            <input type="text" class="search-box" id="searchBox" placeholder="Filter by type name..." oninput="filterTable()">
        </div>
        
        ${sortedAllocations.length > 0 ? `
        <div class="summary-cards" style="margin-bottom: 20px;">
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
        <div class="table-container">
            <table id="allocationsTable">
                <thead>
                    <tr>
                        <th data-column="type" onclick="sortTable('type')">Type Name</th>
                        <th data-column="count" onclick="sortTable('count')">Count</th>
                        <th data-column="size" onclick="sortTable('size')" class="sorted-desc">Total Size</th>
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

    <!-- Stacks Tab -->
    <div id="tab-stacks" class="tab-content">
        <div class="section-header">
            <h2>CPU Profiling</h2>
            <input type="text" class="search-box" id="methodSearchBox" placeholder="Filter by method name..." oninput="filterMethodTable()">
        </div>
        
        ${sortedProfiles.length > 0 ? `
        <p class="subtitle">
            ${sortedProfiles.length.toLocaleString()} methods profiled from ${stackCount.toLocaleString()} stack samples
        </p>
        <div class="table-container">
            <table id="methodsTable">
                <thead>
                    <tr>
                        <th data-column="name" onclick="sortMethodTable('name')">Method Name</th>
                        <th data-column="exclusive" onclick="sortMethodTable('exclusive')" class="sorted-desc">Exclusive</th>
                        <th data-column="exclusiveTime" onclick="sortMethodTable('exclusiveTime')">Excl. Time</th>
                        <th data-column="inclusive" onclick="sortMethodTable('inclusive')">Inclusive</th>
                        <th data-column="inclusiveTime" onclick="sortMethodTable('inclusiveTime')">Incl. Time</th>
                    </tr>
                </thead>
                <tbody id="methodsBody">
                    ${sortedProfiles.slice(0, 100).map((profile, index) => `
                        <tr class="method-row" data-index="${index}">
                            <td class="method-name">${escapeHtml(profile.methodName)}</td>
                            <td class="count">${profile.exclusiveCount.toLocaleString()}</td>
                            <td class="time">${formatTime(profile.exclusiveTimeMs)}</td>
                            <td class="count">${profile.inclusiveCount.toLocaleString()}</td>
                            <td class="time">${formatTime(profile.inclusiveTimeMs)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ` : `
        <div class="no-data">
            <p>No CPU profiling data available.</p>
            <p>Make sure the trace includes SampleProfiler events.</p>
        </div>
        `}
    </div>

    <!-- Flame Graph Tab -->
    <div id="tab-flamegraph" class="tab-content">
        <h2>Flame Graph</h2>
        ${flameGraphData.length > 0 ? `
        <p class="subtitle">Click on a frame to zoom in. Click outside to reset.</p>
        <div class="flame-graph-container">
            <div id="flameGraph" class="flame-graph" style="position: relative;"></div>
        </div>
        <div id="flameTooltip" class="flame-tooltip" style="display: none;"></div>
        ` : `
        <div class="no-data">
            <p>No stack data available for flame graph.</p>
            <p>Make sure the trace includes SampleProfiler events with stack traces.</p>
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

        const methodProfiles = ${JSON.stringify(sortedProfiles.slice(0, 100).map(p => ({
            methodName: p.methodName,
            exclusiveCount: p.exclusiveCount,
            exclusiveTimeMs: p.exclusiveTimeMs,
            inclusiveCount: p.inclusiveCount,
            inclusiveTimeMs: p.inclusiveTimeMs
        })))};

        const flameGraphData = ${JSON.stringify(flameGraphData)};

        let currentSort = { column: 'size', descending: true };
        let currentMethodSort = { column: 'exclusive', descending: true };

        // Tab switching
        function switchTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            document.querySelector(\`.tab[onclick="switchTab('\${tabId}')"]\`).classList.add('active');
            document.getElementById('tab-' + tabId).classList.add('active');

            if (tabId === 'flamegraph' && flameGraphData.length > 0) {
                renderFlameGraph();
            }
        }

        function filterTable() {
            const searchBox = document.getElementById('searchBox');
            if (!searchBox) return;
            const searchTerm = searchBox.value.toLowerCase();
            const rows = document.querySelectorAll('#allocationsBody tr');
            
            rows.forEach((row, index) => {
                if (allocations[index]) {
                    const typeName = allocations[index].typeName.toLowerCase();
                    row.classList.toggle('hidden', !typeName.includes(searchTerm));
                }
            });
        }

        function sortTable(column) {
            const descending = currentSort.column === column ? !currentSort.descending : true;
            currentSort = { column, descending };

            document.querySelectorAll('#allocationsTable th').forEach(th => {
                th.classList.remove('sorted-asc', 'sorted-desc');
                if (th.dataset.column === column) {
                    th.classList.add(descending ? 'sorted-desc' : 'sorted-asc');
                }
            });

            const sorted = [...allocations].sort((a, b) => {
                let cmp = 0;
                switch (column) {
                    case 'type': cmp = a.typeName.localeCompare(b.typeName); break;
                    case 'count': cmp = a.count - b.count; break;
                    case 'size': cmp = BigInt(a.totalSize) > BigInt(b.totalSize) ? 1 : BigInt(a.totalSize) < BigInt(b.totalSize) ? -1 : 0; break;
                    case 'avg': cmp = BigInt(a.avgSize) > BigInt(b.avgSize) ? 1 : BigInt(a.avgSize) < BigInt(b.avgSize) ? -1 : 0; break;
                }
                return descending ? -cmp : cmp;
            });

            const tbody = document.getElementById('allocationsBody');
            if (tbody) {
                tbody.innerHTML = sorted.map((alloc, index) => \`
                    <tr class="allocation-row" data-index="\${index}">
                        <td class="type-name">\${escapeHtml(alloc.typeName)}</td>
                        <td class="count">\${Number(alloc.count).toLocaleString()}</td>
                        <td class="size">\${formatBytes(BigInt(alloc.totalSize))}</td>
                        <td class="avg-size">\${formatBytes(BigInt(alloc.avgSize))}</td>
                    </tr>
                \`).join('');
                filterTable();
            }
        }

        function filterMethodTable() {
            const searchBox = document.getElementById('methodSearchBox');
            if (!searchBox) return;
            const searchTerm = searchBox.value.toLowerCase();
            const rows = document.querySelectorAll('#methodsBody tr');
            
            rows.forEach((row, index) => {
                if (methodProfiles[index]) {
                    const methodName = methodProfiles[index].methodName.toLowerCase();
                    row.classList.toggle('hidden', !methodName.includes(searchTerm));
                }
            });
        }

        function sortMethodTable(column) {
            const descending = currentMethodSort.column === column ? !currentMethodSort.descending : true;
            currentMethodSort = { column, descending };

            document.querySelectorAll('#methodsTable th').forEach(th => {
                th.classList.remove('sorted-asc', 'sorted-desc');
                if (th.dataset.column === column) {
                    th.classList.add(descending ? 'sorted-desc' : 'sorted-asc');
                }
            });

            const sorted = [...methodProfiles].sort((a, b) => {
                let cmp = 0;
                switch (column) {
                    case 'name': cmp = a.methodName.localeCompare(b.methodName); break;
                    case 'exclusive': cmp = a.exclusiveCount - b.exclusiveCount; break;
                    case 'exclusiveTime': cmp = a.exclusiveTimeMs - b.exclusiveTimeMs; break;
                    case 'inclusive': cmp = a.inclusiveCount - b.inclusiveCount; break;
                    case 'inclusiveTime': cmp = a.inclusiveTimeMs - b.inclusiveTimeMs; break;
                }
                return descending ? -cmp : cmp;
            });

            const tbody = document.getElementById('methodsBody');
            if (tbody) {
                tbody.innerHTML = sorted.map((profile, index) => \`
                    <tr class="method-row" data-index="\${index}">
                        <td class="method-name">\${escapeHtml(profile.methodName)}</td>
                        <td class="count">\${profile.exclusiveCount.toLocaleString()}</td>
                        <td class="time">\${formatTime(profile.exclusiveTimeMs)}</td>
                        <td class="count">\${profile.inclusiveCount.toLocaleString()}</td>
                        <td class="time">\${formatTime(profile.inclusiveTimeMs)}</td>
                    </tr>
                \`).join('');
                filterMethodTable();
            }
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
            while (value >= k && i < sizes.length - 1) { value = value / k; i++; }
            if (i === 0) return bigBytes.toString() + ' B';
            const divisor = k ** BigInt(i);
            const wholePart = bigBytes / divisor;
            const remainder = bigBytes % divisor;
            const decimal = Number(remainder) / Number(divisor);
            return (Number(wholePart) + decimal).toFixed(2) + ' ' + sizes[i];
        }

        function formatTime(ms) {
            if (ms < 1) return '< 1 ms';
            if (ms < 1000) return ms.toFixed(0) + ' ms';
            if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
            const minutes = Math.floor(ms / 60000);
            const seconds = ((ms % 60000) / 1000).toFixed(1);
            return minutes + 'm ' + seconds + 's';
        }

        // Flame graph rendering
        function renderFlameGraph() {
            const container = document.getElementById('flameGraph');
            if (!container || flameGraphData.length === 0) return;

            container.innerHTML = '';
            const width = container.clientWidth || 800;
            const rowHeight = 22;
            const totalSamples = flameGraphData.reduce((sum, d) => sum + d.samples, 0);
            
            // Group by depth and calculate positions
            const maxDepth = Math.max(...flameGraphData.map(d => d.depth));
            const height = (maxDepth + 1) * rowHeight + 20;
            container.style.height = height + 'px';

            // Color palette for flame graph
            const colors = [
                '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#10b981',
                '#f97316', '#ec4899', '#6366f1', '#14b8a6', '#84cc16'
            ];

            flameGraphData.forEach((node, index) => {
                const div = document.createElement('div');
                div.className = 'flame-node';
                div.style.left = (node.x * width) + 'px';
                div.style.width = Math.max(node.width * width - 1, 1) + 'px';
                div.style.top = ((maxDepth - node.depth) * rowHeight) + 'px';
                div.style.backgroundColor = colors[Math.abs(hashCode(node.name)) % colors.length];
                div.style.color = '#fff';
                div.textContent = node.width > 0.02 ? node.name : '';
                div.title = node.name;

                div.addEventListener('mouseenter', (e) => showTooltip(e, node, totalSamples));
                div.addEventListener('mouseleave', hideTooltip);
                div.addEventListener('mousemove', moveTooltip);

                container.appendChild(div);
            });
        }

        function hashCode(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash |= 0;
            }
            return hash;
        }

        function showTooltip(e, node, totalSamples) {
            const tooltip = document.getElementById('flameTooltip');
            const pct = ((node.samples / totalSamples) * 100).toFixed(2);
            tooltip.innerHTML = \`
                <div class="method">\${escapeHtml(node.name)}</div>
                <div class="stats">\${node.samples.toLocaleString()} samples (\${pct}%)</div>
            \`;
            tooltip.style.display = 'block';
            moveTooltip(e);
        }

        function moveTooltip(e) {
            const tooltip = document.getElementById('flameTooltip');
            tooltip.style.left = (e.clientX + 10) + 'px';
            tooltip.style.top = (e.clientY + 10) + 'px';
        }

        function hideTooltip() {
            document.getElementById('flameTooltip').style.display = 'none';
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
    </script>
</body>
</html>`;
    }

    private buildFlameGraphData(result: ParseResult | null): Array<{name: string; x: number; width: number; depth: number; samples: number}> {
        if (!result || !result.stacks || result.stacks.size === 0 || !result.methodProfiles) {
            return [];
        }

        // Build a tree structure from stacks
        interface FlameNode {
            name: string;
            samples: number;
            children: Map<string, FlameNode>;
        }

        const root: FlameNode = { name: 'root', samples: 0, children: new Map() };
        
        // Get method name for an address
        const getMethodName = (addr: bigint): string => {
            // Build sorted method list for binary search
            const methodAddresses: Array<{ address: bigint, endAddress: bigint, name: string }> = [];
            for (const method of result.methods.values()) {
                if (method.methodStartAddress > 0) {
                    const fullName = method.methodNamespace 
                        ? `${method.methodNamespace}.${method.methodName}`
                        : method.methodName || `Method_0x${method.methodStartAddress.toString(16)}`;
                    methodAddresses.push({
                        address: method.methodStartAddress,
                        endAddress: method.methodStartAddress + BigInt(method.methodSize),
                        name: fullName
                    });
                }
            }
            methodAddresses.sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

            // Binary search
            let left = 0, right = methodAddresses.length - 1;
            while (left <= right) {
                const mid = Math.floor((left + right) / 2);
                const entry = methodAddresses[mid];
                if (addr >= entry.address && addr < entry.endAddress) {
                    return entry.name;
                } else if (addr < entry.address) {
                    right = mid - 1;
                } else {
                    left = mid + 1;
                }
            }
            return `0x${addr.toString(16)}`;
        };

        // Sample counts per stack (simplified - use 1 sample per unique stack)
        for (const stack of result.stacks.values()) {
            if (stack.addresses.length === 0) { continue; }

            // Build the path from bottom to top (reverse the stack)
            let current = root;
            root.samples++;

            // Stacks are typically top-first, so reverse for flame graph (bottom-up)
            const reversedAddrs = [...stack.addresses].reverse();
            
            for (const addr of reversedAddrs) {
                const name = getMethodName(addr);
                if (!current.children.has(name)) {
                    current.children.set(name, { name, samples: 0, children: new Map() });
                }
                current = current.children.get(name)!;
                current.samples++;
            }
        }

        // Flatten tree to array with positions
        const nodes: Array<{name: string; x: number; width: number; depth: number; samples: number}> = [];
        const totalSamples = root.samples;

        const flatten = (node: FlameNode, x: number, width: number, depth: number) => {
            if (node.name !== 'root') {
                nodes.push({ name: node.name, x, width, depth, samples: node.samples });
            }

            let childX = x;
            // Sort children by samples for consistent ordering
            const sortedChildren = Array.from(node.children.values()).sort((a, b) => b.samples - a.samples);
            
            for (const child of sortedChildren) {
                const childWidth = (child.samples / totalSamples) * (node.name === 'root' ? 1 : width / (node.samples / totalSamples));
                const actualWidth = (child.samples / totalSamples);
                flatten(child, childX, actualWidth, depth + 1);
                childX += actualWidth;
            }
        };

        flatten(root, 0, 1, -1);
        return nodes;
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
    if (bytes === BigInt(0)) { return '0 B'; }
    
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
    
    const divisor = k ** BigInt(i);
    const wholePart = bytes / divisor;
    const remainder = bytes % divisor;
    const decimal = Number(remainder) / Number(divisor);
    
    const finalValue = Number(wholePart) + decimal;
    return finalValue.toFixed(2) + ' ' + sizes[i];
}

function formatTime(ms: number): string {
    if (ms < 1) { return '< 1 ms'; }
    if (ms < 1000) { return `${ms.toFixed(0)} ms`; }
    if (ms < 60000) { return `${(ms / 1000).toFixed(2)} s`; }
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
}
