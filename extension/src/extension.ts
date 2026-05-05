import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { ClaudeUltraPanel } from './webviewProvider';
import { MusicPanel } from './musicPanel';
import { BrowserPanel } from './browserPanel';
import { CadPanel } from './cadPanel';
import { setExtensionPath, getSpeakerVolume, setSpeakerVolume } from './audioCapture';
import { registerPairPhoneCommand } from './pairPhone';

const JAC_RELEASE_API = 'https://api.github.com/repos/Clifford-Swartz/jac/releases/latest';

async function checkForUpdate(context: vscode.ExtensionContext) {
    const ext = vscode.extensions.getExtension('claudiusmaximus.jac');
    if (!ext) return;
    const currentVersion = ext.packageJSON.version as string;

    try {
        const release = await new Promise<any>((resolve, reject) => {
            const fetch = (url: string, redirects = 0) => {
                if (redirects > 5) { reject(new Error('Too many redirects')); return; }
                https.get(url, { headers: { 'User-Agent': 'JAC', 'Accept': 'application/vnd.github+json' } }, (res) => {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        fetch(res.headers.location!, redirects + 1); return;
                    }
                    let data = '';
                    res.on('data', (chunk: string) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                    });
                }).on('error', reject);
            };
            fetch(JAC_RELEASE_API);
        });

        const latestVersion = (release.tag_name as string).replace(/^v/, '');
        if (latestVersion === currentVersion) return;

        // Compare semver
        const parse = (v: string) => v.split('.').map(Number);
        const [cMaj, cMin, cPat] = parse(currentVersion);
        const [lMaj, lMin, lPat] = parse(latestVersion);
        if (lMaj < cMaj || (lMaj === cMaj && lMin < cMin) || (lMaj === cMaj && lMin === cMin && lPat <= cPat)) return;

        const vsixAsset = release.assets?.find((a: any) => a.name.endsWith('.vsix'));
        if (!vsixAsset) return;

        const action = await vscode.window.showInformationMessage(
            `JAC ${latestVersion} is available (you have ${currentVersion})`,
            'Update', 'Later'
        );
        if (action !== 'Update') return;

        // Download and install
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Updating JAC...' },
            async () => {
                const tmpDir = path.join(os.tmpdir(), 'jac-update');
                fs.mkdirSync(tmpDir, { recursive: true });
                const vsixPath = path.join(tmpDir, vsixAsset.name);

                await new Promise<void>((resolve, reject) => {
                    const download = (url: string, redirects = 0) => {
                        if (redirects > 5) { reject(new Error('Too many redirects')); return; }
                        https.get(url, { headers: { 'User-Agent': 'JAC', 'Accept': 'application/octet-stream' } }, (res) => {
                            if (res.statusCode === 301 || res.statusCode === 302) {
                                download(res.headers.location!, redirects + 1); return;
                            }
                            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                            const file = fs.createWriteStream(vsixPath);
                            res.pipe(file);
                            file.on('finish', () => { file.close(); resolve(); });
                        }).on('error', reject);
                    };
                    download(vsixAsset.browser_download_url);
                });

                await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
                try { fs.unlinkSync(vsixPath); } catch { /* */ }

                const reload = await vscode.window.showInformationMessage(
                    `JAC updated to ${latestVersion}!`, 'Reload Window'
                );
                if (reload === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            }
        );
    } catch {
        // Silent fail — don't bother user if update check fails
    }
}

export function activate(context: vscode.ExtensionContext) {
    setExtensionPath(context.extensionUri.fsPath);

    // Check for updates in the background (5s delay to not slow startup)
    setTimeout(() => checkForUpdate(context), 5000);

    // Volume commands — work even when Multi-Output Device disables system volume keys
    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.volumeUp', async () => {
            const current = await getSpeakerVolume();
            const newVol = Math.min(100, current + 6);
            await setSpeakerVolume(newVol);
            musicProvider.syncVolume(newVol);
        }),
        vscode.commands.registerCommand('claudeUltra.volumeDown', async () => {
            const current = await getSpeakerVolume();
            const newVol = Math.max(0, current - 6);
            await setSpeakerVolume(newVol);
            musicProvider.syncVolume(newVol);
        }),
        vscode.commands.registerCommand('claudeUltra.volumeMute', async () => {
            const current = await getSpeakerVolume();
            const newVol = current > 0 ? 0 : 25;
            await setSpeakerVolume(newVol);
            musicProvider.syncVolume(newVol);
        }),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.open', () => {
            ClaudeUltraPanel.createOrShow(context.extensionUri, context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.newConversation', () => {
            ClaudeUltraPanel.currentPanel?.newConversation();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.disconnect', () => {
            ClaudeUltraPanel.currentPanel?.disconnect();
        })
    );

    // Music panel – registers as a bottom-panel webview view
    const musicProvider = new MusicPanel(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MusicPanel.viewType, musicProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.music', () => {
            vscode.commands.executeCommand('jacMusic.focus');
        })
    );

    // Browser panel – Chromium-powered browser in an editor tab
    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.browser', () => {
            BrowserPanel.createOrShow(context.extensionUri);
        })
    );

    // CAD panel – 3D modeling + schematic editor
    context.subscriptions.push(
        vscode.commands.registerCommand('claudeUltra.cad', () => {
            CadPanel.createOrShow(context.extensionUri);
        })
    );

    // Phone pairing — show QR code panel
    context.subscriptions.push(
        registerPairPhoneCommand(context, {
            sendRaw: (msg) => ClaudeUltraPanel.wsClient?.sendRaw(msg),
            onMessage: (handler) => ClaudeUltraPanel.wsClient?.onMessage(handler) ?? { dispose: () => {} },
        })
    );
}

export function deactivate() {
    CadPanel.cleanup();
}
