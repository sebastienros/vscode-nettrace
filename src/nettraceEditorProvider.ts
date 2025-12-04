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
                <tr class="allocation-row" data-index="${index}" data-type="${escapeHtml(alloc.typeName)}">
                    <td class="type-name">
                        <span class="expand-btn" onclick="toggleStackDistribution(${index}, event)">▶</span>
                        ${escapeHtml(alloc.typeName)}
                    </td>
                    <td class="count">${alloc.count.toLocaleString()}</td>
                    <td class="size">${formatBytes(alloc.totalSize)}</td>
                    <td class="avg-size">${formatBytes(alloc.count > 0 ? alloc.totalSize / BigInt(alloc.count) : BigInt(0))}</td>
                </tr>
                <tr class="stack-distribution-row" id="stack-dist-${index}" style="display: none;">
                    <td colspan="4" class="stack-distribution-cell"></td>
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

        // Prepare flame graph data for both CPU and Allocations
        const cpuFlameGraphData = this.buildFlameGraphData(result, 'cpu');
        const allocFlameGraphData = this.buildFlameGraphData(result, 'allocation');
        const hasCpuData = cpuFlameGraphData.length > 0;
        const hasAllocData = allocFlameGraphData.length > 0;

        // Prepare type stack distribution with resolved method names
        const typeStackData = this.buildTypeStackDistribution(result);

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

        .search-box, select {
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--bg-color);
            color: var(--text-color);
            font-size: 0.9em;
        }

        .search-box { width: 250px; }
        
        select {
            cursor: pointer;
            min-width: 150px;
        }
        
        select:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .search-box:focus, select:focus { outline: 1px solid var(--accent-color); border-color: var(--accent-color); }

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

        .expand-btn {
            cursor: pointer;
            display: inline-block;
            width: 16px;
            margin-right: 4px;
            transition: transform 0.2s;
            opacity: 0.7;
        }
        .expand-btn:hover { opacity: 1; }
        .expand-btn.expanded { transform: rotate(90deg); }

        .stack-distribution-row { background: var(--header-bg); }
        .stack-distribution-cell { padding: 0 !important; }
        .stack-distribution-content {
            padding: 12px 20px;
            max-height: 400px;
            overflow-y: auto;
        }
        .stack-dist-item {
            display: flex;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-color);
            cursor: pointer;
        }
        .stack-dist-item:hover { background: var(--hover-bg); }
        .stack-dist-item:last-child { border-bottom: none; }
        .stack-dist-stats {
            min-width: 180px;
            text-align: right;
            opacity: 0.8;
            font-size: 12px;
        }
        .stack-dist-frames {
            flex: 1;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        .stack-frame { padding: 2px 0; }
        .stack-frame.top { font-weight: 600; }
        .stack-preview { 
            color: var(--vscode-textLink-foreground); 
            flex: 1;
            font-family: var(--vscode-editor-font-family);
        }
        .stack-expanded-frames {
            margin-top: 8px;
            padding-left: 20px;
            border-left: 2px solid var(--border-color);
            display: none;
        }
        .stack-expanded-frames.visible { display: block; }

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
            padding-top: 32px;
        }

        .flame-graph {
            min-width: 100%;
            min-height: 400px;
            position: relative;
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

        .flame-reset-btn {
            position: absolute;
            top: -28px;
            left: 0;
            padding: 4px 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            z-index: 100;
        }
        .flame-reset-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .flame-tooltip {
            position: fixed;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 12px;
            z-index: 1000;
            max-width: 500px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }

        .flame-tooltip .method { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
        .flame-tooltip .stats { opacity: 0.8; }
        .flame-tooltip .details-btn {
            margin-top: 8px;
            padding: 4px 8px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .flame-tooltip .details-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        /* Type distribution modal */
        .type-modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 2000;
            justify-content: center;
            align-items: center;
        }
        .type-modal-overlay.visible { display: flex; }
        .type-modal {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            max-width: 600px;
            max-height: 80vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        .type-modal-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .type-modal-header h3 { margin: 0; font-size: 14px; }
        .type-modal-close {
            background: none;
            border: none;
            color: var(--text-color);
            font-size: 20px;
            cursor: pointer;
            padding: 0 4px;
        }
        .type-modal-close:hover { opacity: 0.7; }
        .type-modal-content {
            padding: 16px;
            overflow-y: auto;
            max-height: 60vh;
        }
        .type-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        .type-item:last-child { border-bottom: none; }
        .type-name { font-family: var(--vscode-editor-font-family); flex: 1; word-break: break-all; }
        .type-stats { text-align: right; min-width: 150px; opacity: 0.8; font-size: 12px; }

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

        /* Help icon tooltip */
        .help-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 12px;
            font-weight: 600;
            cursor: help;
            margin-left: 8px;
            position: relative;
        }
        .help-icon:hover .help-tooltip {
            display: block;
        }
        .help-tooltip {
            display: none;
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-top: 8px;
            padding: 12px 16px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            font-size: 13px;
            font-weight: normal;
            line-height: 1.5;
            width: 320px;
            max-width: 90vw;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1000;
            text-align: left;
            white-space: normal;
        }
        .help-tooltip::before {
            content: '';
            position: absolute;
            top: -6px;
            left: 50%;
            transform: translateX(-50%);
            border-left: 6px solid transparent;
            border-right: 6px solid transparent;
            border-bottom: 6px solid var(--border-color);
        }
        .section-header h2 {
            display: flex;
            align-items: center;
        }
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
                <h2>Hot Methods (Top 20)
                    <span class="help-icon">?
                        <span class="help-tooltip">Methods that consumed the most CPU time during profiling. These are the top candidates for optimization. The count shows how many times each method appeared in CPU samples.</span>
                    </span>
                </h2>
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
            <h2>Object Allocations
                <span class="help-icon">?
                    <span class="help-tooltip">Shows all object allocations captured during the trace. Each row represents a .NET type that was allocated, with the total count and memory size. Use this to identify which types consume the most memory and are allocated most frequently. Sort by size to find memory-heavy allocations.</span>
                </span>
            </h2>
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
            <h2>CPU Profiling
                <span class="help-icon">?
                    <span class="help-tooltip">Shows CPU time spent in each method. <strong>Exclusive</strong> time is spent directly in the method. <strong>Inclusive</strong> time includes time spent in methods it calls. High exclusive time indicates the method itself is slow. High inclusive time with low exclusive suggests called methods are slow.</span>
                </span>
            </h2>
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
        <div class="section-header">
            <h2>Flame Graph
                <span class="help-icon" id="flameGraphHelp">?
                    <span class="help-tooltip" id="flameGraphHelpText">${hasCpuData ? 
                        'Visualizes where CPU time is spent across call stacks. Width represents time: wider bars indicate more CPU usage. Stacks grow upward—the bottom shows entry points, each layer above shows called methods. If an upper layer is narrower than its parent, the difference represents exclusive time spent in the parent method itself.' :
                        'Visualizes where memory is allocated across call stacks. Width represents allocation size: wider bars indicate more memory. Stacks grow upward—the bottom shows entry points, each layer above shows called methods. If an upper layer is narrower than its parent, the difference represents memory allocated directly by the parent method itself.'}</span>
                </span>
            </h2>
            ${(hasCpuData || hasAllocData) ? `
            <select id="flameGraphMode" onchange="switchFlameGraphMode()">
                <option value="cpu" ${hasCpuData ? '' : 'disabled'}>CPU Samples${hasCpuData ? '' : ' (no data)'}</option>
                <option value="allocation" ${hasAllocData ? '' : 'disabled'}>Allocations${hasAllocData ? '' : ' (no data)'}</option>
            </select>
            ` : ''}
        </div>
        ${(hasCpuData || hasAllocData) ? `
        <p class="subtitle" id="flameGraphSubtitle">
            ${hasCpuData ? 'Showing CPU samples. Hover for details. Double-click to zoom.' : 'Showing memory allocations. Hover for details. Double-click to zoom.'}
        </p>
        <div class="flame-graph-container">
            <div id="flameGraph" class="flame-graph" style="position: relative;"></div>
        </div>
        <div id="flameTooltip" class="flame-tooltip" style="display: none;"></div>
        <div id="typeModalOverlay" class="type-modal-overlay">
            <div class="type-modal">
                <div class="type-modal-header">
                    <h3 id="typeModalTitle">Allocation Types</h3>
                    <button class="type-modal-close" onclick="closeTypeModal()">&times;</button>
                </div>
                <div id="typeModalContent" class="type-modal-content"></div>
            </div>
        </div>
        ` : `
        <div class="no-data">
            <p>No stack data available for flame graph.</p>
            <p>Make sure the trace includes SampleProfiler or GC allocation events with stack traces.</p>
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

        // Type stack distribution: typeName -> array of stacks with frames
        const typeStackDistribution = ${JSON.stringify(Object.fromEntries(
            Array.from(typeStackData.entries()).map(([typeName, stacks]) => [
                typeName,
                stacks.slice(0, 50) // Limit to top 50 stacks per type
            ])
        ))};

        const cpuFlameGraphData = ${JSON.stringify(cpuFlameGraphData)};
        const allocFlameGraphData = ${JSON.stringify(allocFlameGraphData)};
        let currentFlameGraphMode = '${hasCpuData ? 'cpu' : (hasAllocData ? 'allocation' : 'cpu')}';

        let currentSort = { column: 'size', descending: true };
        let currentMethodSort = { column: 'exclusive', descending: true };

        // Tab switching
        function switchTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            document.querySelector(\`.tab[onclick="switchTab('\${tabId}')"]\`).classList.add('active');
            document.getElementById('tab-' + tabId).classList.add('active');

            if (tabId === 'flamegraph') {
                renderFlameGraph();
            }
        }

        function switchFlameGraphMode() {
            const select = document.getElementById('flameGraphMode');
            currentFlameGraphMode = select.value;
            flameGraphFocusNode = null; // Reset zoom when switching modes
            const subtitle = document.getElementById('flameGraphSubtitle');
            if (subtitle) {
                subtitle.textContent = currentFlameGraphMode === 'cpu' 
                    ? 'Showing CPU samples. Hover for details. Double-click to zoom.'
                    : 'Showing memory allocations. Hover for details. Double-click to zoom.';
            }
            // Update help tooltip text
            const helpText = document.getElementById('flameGraphHelpText');
            if (helpText) {
                helpText.textContent = currentFlameGraphMode === 'cpu'
                    ? 'Visualizes where CPU time is spent across call stacks. Width represents time: wider bars indicate more CPU usage. Stacks grow upward—the bottom shows entry points, each layer above shows called methods. If an upper layer is narrower than its parent, the difference represents exclusive time spent in the parent method itself. Double-click a node to zoom in.'
                    : 'Visualizes where memory is allocated across call stacks. Width represents allocation size: wider bars indicate more memory. Stacks grow upward—the bottom shows entry points, each layer above shows called methods. If an upper layer is narrower than its parent, the difference represents memory allocated directly by the parent method itself. Double-click a node to zoom in.';
            }
            renderFlameGraph();
        }

        function filterTable() {
            const searchBox = document.getElementById('searchBox');
            if (!searchBox) return;
            const searchTerm = searchBox.value.toLowerCase();
            const allocationRows = document.querySelectorAll('#allocationsBody .allocation-row');
            
            allocationRows.forEach((row) => {
                const index = parseInt(row.dataset.index, 10);
                if (allocations[index]) {
                    const typeName = allocations[index].typeName.toLowerCase();
                    const shouldHide = !typeName.includes(searchTerm);
                    row.classList.toggle('hidden', shouldHide);
                    // Also hide the corresponding stack distribution row
                    const distRow = document.getElementById('stack-dist-' + index);
                    if (distRow && shouldHide) {
                        distRow.style.display = 'none';
                        row.querySelector('.expand-btn')?.classList.remove('expanded');
                    }
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
                    <tr class="allocation-row" data-index="\${index}" data-type="\${escapeHtml(alloc.typeName)}">
                        <td class="type-name">
                            <span class="expand-btn" onclick="toggleStackDistribution(\${index}, event)">▶</span>
                            \${escapeHtml(alloc.typeName)}
                        </td>
                        <td class="count">\${Number(alloc.count).toLocaleString()}</td>
                        <td class="size">\${formatBytes(BigInt(alloc.totalSize))}</td>
                        <td class="avg-size">\${formatBytes(BigInt(alloc.avgSize))}</td>
                    </tr>
                    <tr class="stack-distribution-row" id="stack-dist-\${index}" style="display: none;">
                        <td colspan="4" class="stack-distribution-cell"></td>
                    </tr>
                \`).join('');
                filterTable();
            }
        }

        function toggleStackDistribution(index, event) {
            event.stopPropagation();
            const row = document.querySelector(\`.allocation-row[data-index="\${index}"]\`);
            const distRow = document.getElementById('stack-dist-' + index);
            const expandBtn = row?.querySelector('.expand-btn');
            
            if (!row || !distRow) return;
            
            const typeName = row.dataset.type;
            const isExpanded = distRow.style.display !== 'none';
            
            if (isExpanded) {
                distRow.style.display = 'none';
                expandBtn?.classList.remove('expanded');
            } else {
                // Get stack distribution for this type
                const stacks = typeStackDistribution[typeName] || [];
                const cell = distRow.querySelector('.stack-distribution-cell');
                
                if (stacks.length === 0) {
                    cell.innerHTML = '<div class="stack-distribution-content"><em>No stack data available for this type</em></div>';
                } else {
                    const totalSize = stacks.reduce((sum, s) => sum + s.size, 0);
                    const totalCount = stacks.reduce((sum, s) => sum + s.count, 0);
                    
                    let html = '<div class="stack-distribution-content">';
                    html += '<div style="margin-bottom: 8px; opacity: 0.7; font-size: 12px;">' + 
                            stacks.length + ' unique stacks. Click a stack to expand all frames.</div>';
                    
                    stacks.forEach((stack, stackIndex) => {
                        const sizePct = totalSize > 0 ? ((stack.size / totalSize) * 100).toFixed(1) : '0.0';
                        const countPct = totalCount > 0 ? ((stack.count / totalCount) * 100).toFixed(1) : '0.0';
                        const topFrame = stack.frames.length > 0 ? stack.frames[0] : '(unknown)';
                        
                        html += \`
                            <div class="stack-dist-item" onclick="toggleStackFrames(\${index}, \${stackIndex}, event)">
                                <span class="stack-preview">\${escapeHtml(topFrame)}</span>
                                <span class="stack-dist-stats">
                                    \${stack.count.toLocaleString()} (\${countPct}%) • 
                                    \${formatBytes(stack.size)} (\${sizePct}%)
                                </span>
                            </div>
                            <div class="stack-expanded-frames" id="stack-frames-\${index}-\${stackIndex}">
                                \${stack.frames.map((frame, i) => 
                                    '<div class="stack-frame' + (i === 0 ? ' top' : '') + '">' + escapeHtml(frame) + '</div>'
                                ).join('')}
                            </div>
                        \`;
                    });
                    
                    html += '</div>';
                    cell.innerHTML = html;
                }
                
                distRow.style.display = 'table-row';
                expandBtn?.classList.add('expanded');
            }
        }

        function toggleStackFrames(typeIndex, stackIndex, event) {
            event.stopPropagation();
            const framesDiv = document.getElementById('stack-frames-' + typeIndex + '-' + stackIndex);
            if (framesDiv) {
                framesDiv.classList.toggle('visible');
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
        let flameGraphFocusNode = null; // Current focused node for zoom
        
        function renderFlameGraph() {
            const container = document.getElementById('flameGraph');
            let flameGraphData = currentFlameGraphMode === 'cpu' ? cpuFlameGraphData : allocFlameGraphData;
            if (!container || flameGraphData.length === 0) return;

            container.innerHTML = '';
            const width = container.clientWidth || 800;
            const rowHeight = 22;
            const isAllocationMode = currentFlameGraphMode === 'allocation';
            
            // Calculate totals from full data
            const fullTotalSamples = flameGraphData.reduce((sum, d) => sum + d.samples, 0);
            const fullTotalSize = flameGraphData.reduce((sum, d) => sum + (d.size || 0), 0);
            
            // If we have a focused node, filter and rescale the data
            let viewData = flameGraphData;
            let focusX = 0;
            let focusWidth = 1;
            let focusDepth = 0;
            
            if (flameGraphFocusNode) {
                // Find the focused node
                const focusedNode = flameGraphData.find(n => 
                    n.name === flameGraphFocusNode.name && 
                    n.depth === flameGraphFocusNode.depth &&
                    Math.abs(n.x - flameGraphFocusNode.x) < 0.0001
                );
                
                if (focusedNode) {
                    focusX = focusedNode.x;
                    focusWidth = focusedNode.width;
                    focusDepth = focusedNode.depth;
                    
                    // Filter to nodes within or below the focused node
                    viewData = flameGraphData.filter(n => {
                        // Include nodes at same depth or deeper
                        if (n.depth < focusDepth) return false;
                        // Include nodes that overlap with the focused area
                        const nodeEnd = n.x + n.width;
                        const focusEnd = focusX + focusWidth;
                        return n.x < focusEnd && nodeEnd > focusX;
                    });
                }
            }
            
            // Calculate totals for percentage display (use focused node's samples if zoomed)
            const totalSamples = flameGraphFocusNode ? 
                (viewData.find(n => n.depth === focusDepth)?.samples || fullTotalSamples) : 
                fullTotalSamples;
            const totalSize = flameGraphFocusNode ?
                (viewData.find(n => n.depth === focusDepth)?.size || fullTotalSize) :
                fullTotalSize;
            
            // Group by depth and calculate positions
            const maxDepth = Math.max(...viewData.map(d => d.depth));
            const minDepth = flameGraphFocusNode ? focusDepth : 0;
            const height = (maxDepth - minDepth + 1) * rowHeight + 20;
            container.style.height = height + 'px';

            // Color palette - use different colors for CPU vs Allocation
            const cpuColors = [
                '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#10b981',
                '#f97316', '#ec4899', '#6366f1', '#14b8a6', '#84cc16'
            ];
            const allocColors = [
                '#10b981', '#14b8a6', '#0ea5e9', '#3b82f6', '#6366f1',
                '#22c55e', '#06b6d4', '#0284c7', '#2563eb', '#4f46e5'
            ];
            const colors = isAllocationMode ? allocColors : cpuColors;

            // Add reset button if zoomed
            if (flameGraphFocusNode) {
                const resetBtn = document.createElement('button');
                resetBtn.className = 'flame-reset-btn';
                resetBtn.textContent = '← Reset Zoom';
                resetBtn.onclick = () => {
                    flameGraphFocusNode = null;
                    renderFlameGraph();
                };
                container.appendChild(resetBtn);
            }

            viewData.forEach((node, index) => {
                const div = document.createElement('div');
                div.className = 'flame-node';
                
                // Rescale position if zoomed
                const scaledX = focusWidth > 0 ? (node.x - focusX) / focusWidth : node.x;
                const scaledWidth = focusWidth > 0 ? node.width / focusWidth : node.width;
                
                div.style.left = (scaledX * width) + 'px';
                div.style.width = Math.max(scaledWidth * width - 1, 1) + 'px';
                div.style.top = ((maxDepth - node.depth) * rowHeight) + 'px';
                div.style.backgroundColor = colors[Math.abs(hashCode(node.name)) % colors.length];
                div.style.color = '#fff';
                div.textContent = scaledWidth > 0.02 ? node.name : '';
                div.title = node.name;

                div.addEventListener('mouseenter', (e) => showTooltip(e, node, totalSamples, totalSize, isAllocationMode));
                div.addEventListener('mouseleave', scheduleHideTooltip);
                div.addEventListener('mousemove', moveTooltip);
                
                // Double-click to zoom
                div.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    hideTooltip();
                    flameGraphFocusNode = { name: node.name, depth: node.depth, x: node.x };
                    renderFlameGraph();
                });

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

        let currentTooltipNode = null;
        let tooltipHideTimeout = null;

        function showTooltip(e, node, totalSamples, totalSize, isAllocationMode) {
            // Cancel any pending hide
            if (tooltipHideTimeout) {
                clearTimeout(tooltipHideTimeout);
                tooltipHideTimeout = null;
            }
            currentTooltipNode = node;
            const tooltip = document.getElementById('flameTooltip');
            const pct = ((node.samples / totalSamples) * 100).toFixed(2);
            if (isAllocationMode && node.size !== undefined) {
                const sizePct = totalSize > 0 ? ((node.size / totalSize) * 100).toFixed(2) : '0.00';
                const hasTypes = node.types && node.types.length > 0;
                tooltip.innerHTML = \`
                    <div class="method">\${escapeHtml(node.name)}</div>
                    <div class="stats">\${node.samples.toLocaleString()} allocations (\${pct}%)</div>
                    <div class="stats">\${formatBytes(node.size)} (\${sizePct}% of total)</div>
                    \${hasTypes ? '<button class="details-btn" onclick="showTypeDetails(event)">View Type Distribution</button>' : ''}
                \`;
            } else {
                tooltip.innerHTML = \`
                    <div class="method">\${escapeHtml(node.name)}</div>
                    <div class="stats">\${node.samples.toLocaleString()} samples (\${pct}%)</div>
                \`;
            }
            tooltip.style.display = 'block';
            // Position tooltip, but ensure it doesn't go off-screen
            const tooltipRect = tooltip.getBoundingClientRect();
            let left = e.clientX + 10;
            let top = e.clientY + 10;
            
            // Adjust if tooltip would go off right edge
            if (left + tooltipRect.width > window.innerWidth - 10) {
                left = e.clientX - tooltipRect.width - 10;
            }
            // Adjust if tooltip would go off bottom
            if (top + tooltipRect.height > window.innerHeight - 10) {
                top = e.clientY - tooltipRect.height - 10;
            }
            
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
        }

        function moveTooltip(e) {
            // Don't move while mouse is potentially heading to tooltip
        }

        function scheduleHideTooltip() {
            // Give user time to move mouse to tooltip
            tooltipHideTimeout = setTimeout(() => {
                hideTooltip();
            }, 150);
        }

        function hideTooltip() {
            if (tooltipHideTimeout) {
                clearTimeout(tooltipHideTimeout);
                tooltipHideTimeout = null;
            }
            document.getElementById('flameTooltip').style.display = 'none';
            currentTooltipNode = null;
        }

        // Keep tooltip visible when mouse is over it
        document.getElementById('flameTooltip')?.addEventListener('mouseenter', () => {
            if (tooltipHideTimeout) {
                clearTimeout(tooltipHideTimeout);
                tooltipHideTimeout = null;
            }
        });

        document.getElementById('flameTooltip')?.addEventListener('mouseleave', () => {
            hideTooltip();
        });

        function showTypeDetails(event) {
            event.stopPropagation();
            if (!currentTooltipNode || !currentTooltipNode.types) return;
            
            const node = currentTooltipNode;
            const overlay = document.getElementById('typeModalOverlay');
            const title = document.getElementById('typeModalTitle');
            const content = document.getElementById('typeModalContent');
            
            title.textContent = 'Type Distribution: ' + node.name;
            
            // Calculate total for percentages
            const totalSize = node.types.reduce((sum, t) => sum + t.size, 0);
            const totalCount = node.types.reduce((sum, t) => sum + t.count, 0);
            
            let html = '';
            for (const typeInfo of node.types) {
                const sizePct = totalSize > 0 ? ((typeInfo.size / totalSize) * 100).toFixed(1) : '0.0';
                const countPct = totalCount > 0 ? ((typeInfo.count / totalCount) * 100).toFixed(1) : '0.0';
                html += \`
                    <div class="type-item">
                        <span class="type-name">\${escapeHtml(typeInfo.name)}</span>
                        <span class="type-stats">\${typeInfo.count.toLocaleString()} (\${countPct}%) • \${formatBytes(typeInfo.size)} (\${sizePct}%)</span>
                    </div>
                \`;
            }
            
            content.innerHTML = html;
            overlay.classList.add('visible');
            
            // Hide the tooltip
            document.getElementById('flameTooltip').style.display = 'none';
        }

        function closeTypeModal() {
            document.getElementById('typeModalOverlay').classList.remove('visible');
        }

        // Close modal on overlay click
        document.getElementById('typeModalOverlay')?.addEventListener('click', (e) => {
            if (e.target.id === 'typeModalOverlay') {
                closeTypeModal();
            }
        });

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
    </script>
</body>
</html>`;
    }

    private buildFlameGraphData(result: ParseResult | null, mode: 'cpu' | 'allocation'): Array<{name: string; x: number; width: number; depth: number; samples: number; size?: number; types?: Array<{name: string; count: number; size: number}>}> {
        if (!result || !result.stacks || result.stacks.size === 0) {
            return [];
        }

        // For CPU mode, we need methodProfiles; for allocation mode, we need allocationSamples
        if (mode === 'cpu' && (!result.methodProfiles || result.methodProfiles.size === 0)) {
            return [];
        }
        if (mode === 'allocation' && (!result.allocationSamples || result.allocationSamples.size === 0)) {
            return [];
        }

        // Build a tree structure from stacks
        interface FlameNode {
            name: string;
            samples: number;
            size: bigint;
            types: Map<string, { count: number; size: bigint }>;
            children: Map<string, FlameNode>;
        }

        const root: FlameNode = { name: 'root', samples: 0, size: BigInt(0), types: new Map(), children: new Map() };
        
        // Build sorted method list for binary search (once, not per address)
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

        // Get method name for an address using binary search
        const getMethodName = (addr: bigint): string => {
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

        // Get the sample data based on mode
        const sampleData: Map<number, { count: number; size: bigint; types?: Map<string, { count: number; size: bigint }> }> = new Map();
        
        if (mode === 'cpu') {
            // For CPU, we need to reconstruct from stacks (simplified: 1 sample per stack)
            for (const stack of result.stacks.values()) {
                if (stack.addresses.length > 0) {
                    sampleData.set(stack.stackId, { count: 1, size: BigInt(0) });
                }
            }
        } else {
            // For allocation, use the allocation samples
            for (const [stackId, data] of result.allocationSamples) {
                sampleData.set(stackId, { count: data.count, size: data.size, types: data.types });
            }
        }

        // Build tree from stacks
        for (const [stackId, data] of sampleData) {
            const stack = result.stacks.get(stackId);
            if (!stack || stack.addresses.length === 0) { continue; }

            // Build the path from bottom to top (reverse the stack)
            let current = root;
            root.samples += data.count;
            root.size += data.size;
            
            // Merge types into root (for allocation mode)
            if ('types' in data && data.types) {
                for (const [typeName, typeData] of data.types) {
                    const existing = root.types.get(typeName);
                    if (existing) {
                        existing.count += typeData.count;
                        existing.size += typeData.size;
                    } else {
                        root.types.set(typeName, { count: typeData.count, size: typeData.size });
                    }
                }
            }

            // Stacks are typically top-first, so reverse for flame graph (bottom-up)
            const reversedAddrs = [...stack.addresses].reverse();
            
            for (const addr of reversedAddrs) {
                const name = getMethodName(addr);
                if (!current.children.has(name)) {
                    current.children.set(name, { name, samples: 0, size: BigInt(0), types: new Map(), children: new Map() });
                }
                current = current.children.get(name)!;
                current.samples += data.count;
                current.size += data.size;
                
                // Merge types (for allocation mode)
                if ('types' in data && data.types) {
                    for (const [typeName, typeData] of data.types) {
                        const existing = current.types.get(typeName);
                        if (existing) {
                            existing.count += typeData.count;
                            existing.size += typeData.size;
                        } else {
                            current.types.set(typeName, { count: typeData.count, size: typeData.size });
                        }
                    }
                }
            }
        }

        // Flatten tree to array with positions
        const nodes: Array<{name: string; x: number; width: number; depth: number; samples: number; size?: number; types?: Array<{name: string; count: number; size: number}>}> = [];
        const totalSamples = root.samples;

        const flatten = (node: FlameNode, x: number, width: number, depth: number) => {
            if (node.name !== 'root') {
                // Convert types Map to sorted array for JSON serialization
                const typesArray = mode === 'allocation' && node.types.size > 0
                    ? Array.from(node.types.entries())
                        .map(([name, data]) => ({ name, count: data.count, size: Number(data.size) }))
                        .sort((a, b) => b.size - a.size)
                    : undefined;
                    
                nodes.push({ 
                    name: node.name, 
                    x, 
                    width, 
                    depth, 
                    samples: node.samples,
                    size: Number(node.size),
                    types: typesArray
                });
            }

            let childX = x;
            // Sort children by samples for consistent ordering
            const sortedChildren = Array.from(node.children.values()).sort((a, b) => b.samples - a.samples);
            
            for (const child of sortedChildren) {
                const actualWidth = (child.samples / totalSamples);
                flatten(child, childX, actualWidth, depth + 1);
                childX += actualWidth;
            }
        };

        flatten(root, 0, 1, -1);
        return nodes;
    }

    private buildTypeStackDistribution(result: ParseResult | null): Map<string, Array<{ stackId: number; count: number; size: number; frames: string[] }>> {
        const distribution = new Map<string, Array<{ stackId: number; count: number; size: number; frames: string[] }>>();
        
        if (!result || !result.typeStackDistribution || result.typeStackDistribution.size === 0) {
            return distribution;
        }

        // Build method address lookup for resolving stack frames
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

        const getMethodName = (addr: bigint): string => {
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

        // Build distribution for each type
        for (const [typeName, stackMap] of result.typeStackDistribution) {
            const stacks: Array<{ stackId: number; count: number; size: number; frames: string[] }> = [];
            
            for (const [stackId, data] of stackMap) {
                const stack = result.stacks.get(stackId);
                if (!stack) { continue; }
                
                // Resolve stack frames to method names
                const frames = stack.addresses.map(addr => getMethodName(addr));
                
                stacks.push({
                    stackId,
                    count: data.count,
                    size: Number(data.size),
                    frames
                });
            }
            
            // Sort by size descending
            stacks.sort((a, b) => b.size - a.size);
            
            distribution.set(typeName, stacks);
        }

        return distribution;
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
