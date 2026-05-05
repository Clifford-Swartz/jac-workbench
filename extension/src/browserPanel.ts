/**
 * Browser panel — renders a Chromium screencast in an editor tab.
 * Uses CDP to stream frames and forward input.
 */

import * as vscode from 'vscode';
import { BrowserClient, findChromePath } from './browserClient';

export class BrowserPanel {
    public static currentPanel: BrowserPanel | undefined;
    private static readonly viewType = 'jacBrowser';

    private readonly panel: vscode.WebviewPanel;
    private client?: BrowserClient;
    private disposed = false;
    private pendingSize?: { width: number; height: number };

    public static createOrShow(extensionUri: vscode.Uri): void {
        if (BrowserPanel.currentPanel) {
            BrowserPanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            BrowserPanel.viewType,
            'Browser',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
            },
        );
        BrowserPanel.currentPanel = new BrowserPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;

        const cssUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'browser.css'),
        );
        const scriptUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'browser.js'),
        );
        const nonce = getNonce();
        panel.webview.html = this.getHtml(panel.webview, cssUri, scriptUri, nonce);

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    await this.launchBrowser();
                    break;
                case 'navigate':
                    await this.client?.navigate(msg.url);
                    break;
                case 'goBack':
                    await this.client?.goBack();
                    break;
                case 'goForward':
                    await this.client?.goForward();
                    break;
                case 'reload':
                    await this.client?.reload();
                    break;
                case 'mouseEvent':
                    await this.client?.dispatchMouseEvent(
                        msg.eventType, msg.x, msg.y, msg.button, msg.deltaX, msg.deltaY,
                    );
                    break;
                case 'keyEvent':
                    await this.client?.dispatchKeyEvent(
                        msg.eventType, msg.key, msg.code, msg.text, msg.modifiers,
                    );
                    break;
                case 'scroll':
                    await this.client?.dispatchScrollEvent(msg.x, msg.y, msg.deltaX, msg.deltaY);
                    break;
                case 'resize':
                    if (this.client) {
                        await this.client.resize(msg.width, msg.height);
                    } else {
                        this.pendingSize = { width: msg.width, height: msg.height };
                    }
                    break;
            }
        });

        panel.onDidDispose(() => this.dispose());
    }

    private async launchBrowser(): Promise<void> {
        const chromePath = findChromePath();
        if (!chromePath) {
            this.panel.webview.postMessage({
                type: 'error',
                message: 'Chrome/Chromium not found. Install Chrome or set the path in settings.',
            });
            return;
        }

        this.panel.webview.postMessage({ type: 'status', message: 'Launching browser...' });

        try {
            this.client = new BrowserClient(chromePath, {
                onFrame: (frame) => {
                    if (!this.disposed) {
                        this.panel.webview.postMessage({ type: 'frame', data: frame.data });
                    }
                },
                onUrlChanged: (url) => {
                    this.panel.webview.postMessage({ type: 'urlChanged', url });
                },
                onTitleChanged: (title) => {
                    this.panel.title = title || 'Browser';
                    this.panel.webview.postMessage({ type: 'titleChanged', title });
                },
                onNavState: (canGoBack, canGoForward) => {
                    this.panel.webview.postMessage({ type: 'navState', canGoBack, canGoForward });
                },
                onLoading: (loading) => {
                    this.panel.webview.postMessage({ type: 'loading', loading });
                },
            });

            // Launch with initial size so Chrome viewport matches panel from the start
            await this.client.launch(this.pendingSize?.width, this.pendingSize?.height);
            this.pendingSize = undefined;

            this.panel.webview.postMessage({ type: 'status', message: '' });
        } catch (e: any) {
            this.panel.webview.postMessage({
                type: 'error',
                message: `Failed to launch browser: ${e.message}`,
            });
        }
    }

    private dispose(): void {
        this.disposed = true;
        this.client?.dispose();
        this.client = undefined;
        BrowserPanel.currentPanel = undefined;
        this.panel.dispose();
    }

    private getHtml(webview: vscode.Webview, cssUri: vscode.Uri, scriptUri: vscode.Uri, nonce: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:;" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Browser</title>
</head>
<body>
    <div id="browser-root">
        <div id="toolbar">
            <button id="btn-back" disabled title="Back">&#x2190;</button>
            <button id="btn-forward" disabled title="Forward">&#x2192;</button>
            <button id="btn-reload" title="Reload">&#x21BB;</button>
            <div id="url-bar-wrap">
                <div id="loading-bar"></div>
                <input id="url-input" type="text" placeholder="Search or enter URL..." value="" />
            </div>
        </div>
        <div id="viewport-wrap">
            <div id="status-overlay"></div>
            <div id="error-overlay" style="display:none;"></div>
            <canvas id="screencast"></canvas>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) { nonce += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return nonce;
}
