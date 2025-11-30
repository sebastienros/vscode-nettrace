import * as vscode from 'vscode';
import { NetTraceEditorProvider } from './nettraceEditorProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('NetTrace Viewer extension is now active');

	// Register the custom editor provider for .nettrace files
	const provider = new NetTraceEditorProvider(context);
	
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			NetTraceEditorProvider.viewType,
			provider,
			{
				webviewOptions: {
					retainContextWhenHidden: true
				},
				supportsMultipleEditorsPerDocument: false
			}
		)
	);

	// Register command to open a .nettrace file
	context.subscriptions.push(
		vscode.commands.registerCommand('nettrace-viewer.openFile', async () => {
			const fileUri = await vscode.window.showOpenDialog({
				canSelectMany: false,
				filters: {
					'NetTrace Files': ['nettrace']
				},
				title: 'Open NetTrace File'
			});

			if (fileUri && fileUri[0]) {
				await vscode.commands.executeCommand('vscode.openWith', fileUri[0], NetTraceEditorProvider.viewType);
			}
		})
	);
}

export function deactivate() {}
