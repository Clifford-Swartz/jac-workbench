import * as os from 'os';
import * as vscode from 'vscode';
import * as QRCode from 'qrcode';

export function registerPairPhoneCommand(
    context: vscode.ExtensionContext,
    ws: { sendRaw(msg: Record<string, unknown>): void; onMessage(handler: (msg: any) => void): { dispose(): void } },
): vscode.Disposable {
    return vscode.commands.registerCommand('claudeUltra.pairPhone', async () => {
        const panel = vscode.window.createWebviewPanel(
            'jacPairPhone',
            'Pair Phone',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false },
        );

        panel.webview.html = renderHtml('Requesting pairing code…', null, null, 0);

        let codeReceived = false;
        let completed = false;
        let expiryTimer: NodeJS.Timeout | undefined;

        const sub = ws.onMessage(async (msg: any) => {
            if (msg?.type === 'pair_code' && !codeReceived) {
                codeReceived = true;
                const expiresInMs = Math.max(0, (msg.expires_at * 1000) - Date.now());
                const svgString = await QRCode.toString(msg.code, { type: 'svg', margin: 1, width: 240 });
                panel.webview.html = renderHtml('Scan with JAC on your phone', msg.code, svgString, expiresInMs);
                expiryTimer = setTimeout(() => {
                    if (!completed) {
                        panel.webview.html = renderHtml('Code expired — run "JAC: Pair Phone" again.', null, null, 0);
                    }
                }, expiresInMs);
            }
            if (msg?.type === 'pair_complete') {
                completed = true;
                vscode.window.showInformationMessage(`JAC: Paired with ${msg.device_label || 'Phone'} ✓`);
                panel.dispose();
            }
        });

        panel.onDidDispose(() => {
            sub.dispose();
            if (expiryTimer) clearTimeout(expiryTimer);
        });

        const configuredMachineId = vscode.workspace.getConfiguration('claudeUltra').get<string>('providerMachineId');
        const machineId = (configuredMachineId && configuredMachineId.trim()) || os.hostname();
        ws.sendRaw({ type: 'pair_request', machine_id: machineId });
    });
}

function renderHtml(status: string, code: string | null, qrSvg: string | null, expiresInMs: number): string {
    const expiresSec = Math.ceil(expiresInMs / 1000);
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body {
    font-family: -apple-system, system-ui, sans-serif;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    margin: 0; padding: 40px;
    display: flex; flex-direction: column; align-items: center; gap: 24px;
    min-height: 100vh; box-sizing: border-box;
  }
  h2 { margin: 0; font-weight: 600; font-size: 18px; }
  .qr-wrap {
    background: white; padding: 16px; border-radius: 14px;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 16px rgba(0,0,0,0.18);
  }
  .qr-wrap svg { display: block; }
  .code {
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 26px; letter-spacing: 6px;
    padding: 10px 20px;
    background: var(--vscode-input-background);
    border-radius: 8px;
  }
  .hint { opacity: 0.65; font-size: 13px; text-align: center; max-width: 300px; line-height: 1.6; }
  .countdown { opacity: 0.5; font-size: 12px; }
</style>
</head>
<body>
  <h2>${esc(status)}</h2>
  ${qrSvg ? `
  <div class="qr-wrap">${qrSvg}</div>
  <div class="code">${esc(code!)}</div>
  <div class="hint">Open JAC on your phone → tap <strong>Pair Machine</strong> → scan this code, or type it in manually.</div>
  <div class="countdown" id="cd">Expires in ${expiresSec}s</div>
  <script>
    let s = ${expiresSec};
    const el = document.getElementById('cd');
    const t = setInterval(() => {
      s--;
      if (s <= 0) { clearInterval(t); el.textContent = 'Expired'; }
      else el.textContent = 'Expires in ' + s + 's';
    }, 1000);
  </script>` : ''}
</body>
</html>`;
}

function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
