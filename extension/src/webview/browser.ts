/** Browser panel webview — renders CDP screencast frames, captures input */
export {};

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): any;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Elements ────────────────────────────────────────────────────────────────

const canvas = document.getElementById('screencast') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const urlInput = document.getElementById('url-input') as HTMLInputElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const btnForward = document.getElementById('btn-forward') as HTMLButtonElement;
const btnReload = document.getElementById('btn-reload') as HTMLButtonElement;
const statusOverlay = document.getElementById('status-overlay')!;
const errorOverlay = document.getElementById('error-overlay')!;
const loadingBar = document.getElementById('loading-bar')!;
const viewportWrap = document.getElementById('viewport-wrap')!;

// ── State ───────────────────────────────────────────────────────────────────

let canvasWidth = 1280;
let canvasHeight = 800;
let scaleX = 1;
let scaleY = 1;
let isLoading = false;

// ── Frame rendering ─────────────────────────────────────────────────────────

let frameCount = 0;
const frameImg = new Image();
frameImg.onload = () => {
    if (frameImg.naturalWidth === 0 || frameImg.naturalHeight === 0) { return; }
    canvas.width = frameImg.naturalWidth;
    canvas.height = frameImg.naturalHeight;
    canvasWidth = frameImg.naturalWidth;
    canvasHeight = frameImg.naturalHeight;
    ctx.drawImage(frameImg, 0, 0);
    updateScale();
    frameCount++;
    // Hide overlays once we get first frame
    statusOverlay.style.display = 'none';
    errorOverlay.style.display = 'none';
};

function updateScale(): void {
    const rect = canvas.getBoundingClientRect();
    scaleX = canvasWidth / rect.width;
    scaleY = canvasHeight / rect.height;
}

// ── Message handler ─────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'frame':
            frameImg.src = 'data:image/jpeg;base64,' + msg.data;
            break;
        case 'urlChanged':
            urlInput.value = msg.url;
            break;
        case 'titleChanged':
            document.title = msg.title;
            break;
        case 'navState':
            btnBack.disabled = !msg.canGoBack;
            btnForward.disabled = !msg.canGoForward;
            break;
        case 'loading':
            isLoading = msg.loading;
            loadingBar.classList.toggle('active', isLoading);
            break;
        case 'status':
            if (msg.message) {
                statusOverlay.textContent = msg.message;
                statusOverlay.style.display = 'flex';
            } else {
                statusOverlay.style.display = 'none';
            }
            break;
        case 'error':
            errorOverlay.textContent = msg.message;
            errorOverlay.style.display = 'flex';
            statusOverlay.style.display = 'none';
            break;
    }
});

// ── Navigation ──────────────────────────────────────────────────────────────

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const url = urlInput.value.trim();
        if (url) {
            vscode.postMessage({ type: 'navigate', url });
            canvas.focus();
        }
        e.preventDefault();
    }
});

btnBack.addEventListener('click', () => vscode.postMessage({ type: 'goBack' }));
btnForward.addEventListener('click', () => vscode.postMessage({ type: 'goForward' }));
btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));

// ── Mouse input forwarding ──────────────────────────────────────────────────

function getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
    };
}

function mouseButton(e: MouseEvent): string {
    switch (e.button) {
        case 0: return 'left';
        case 1: return 'middle';
        case 2: return 'right';
        default: return 'left';
    }
}

canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    vscode.postMessage({ type: 'mouseEvent', eventType: 'mousedown', x, y, button: mouseButton(e) });
});

canvas.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    vscode.postMessage({ type: 'mouseEvent', eventType: 'mouseup', x, y, button: mouseButton(e) });
});

canvas.addEventListener('mousemove', (e) => {
    const { x, y } = getCanvasCoords(e);
    vscode.postMessage({ type: 'mouseEvent', eventType: 'mousemove', x, y });
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    vscode.postMessage({ type: 'scroll', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Keyboard input forwarding ───────────────────────────────────────────────

function getModifiers(e: KeyboardEvent): number {
    let m = 0;
    if (e.altKey) { m |= 1; }
    if (e.ctrlKey) { m |= 2; }
    if (e.metaKey) { m |= 4; }
    if (e.shiftKey) { m |= 8; }
    return m;
}

canvas.setAttribute('tabindex', '0');

canvas.addEventListener('keydown', (e) => {
    // Don't intercept if URL bar is focused
    if (document.activeElement === urlInput) { return; }
    e.preventDefault();
    vscode.postMessage({
        type: 'keyEvent',
        eventType: 'keydown',
        key: e.key,
        code: e.code,
        text: e.key.length === 1 ? e.key : '',
        modifiers: getModifiers(e),
    });
});

canvas.addEventListener('keyup', (e) => {
    if (document.activeElement === urlInput) { return; }
    e.preventDefault();
    vscode.postMessage({
        type: 'keyEvent',
        eventType: 'keyup',
        key: e.key,
        code: e.code,
        text: '',
        modifiers: getModifiers(e),
    });
});

// ── Resize handling ─────────────────────────────────────────────────────────

let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

function handleResize(): void {
    updateScale();
    const rect = viewportWrap.getBoundingClientRect();
    // Use CSS pixels (not device pixels) to avoid massive frames on Retina
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 100 && h > 100) {
        vscode.postMessage({ type: 'resize', width: w, height: h });
    }
}

const resizeObserver = new ResizeObserver(() => {
    if (resizeTimeout) { clearTimeout(resizeTimeout); }
    resizeTimeout = setTimeout(handleResize, 300);
});
resizeObserver.observe(viewportWrap);

// ── Init ────────────────────────────────────────────────────────────────────

statusOverlay.textContent = 'Starting browser...';
statusOverlay.style.display = 'flex';

// Send initial size so Chrome viewport matches the panel from the start
setTimeout(() => {
    const rect = viewportWrap.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 100 && h > 100) {
        vscode.postMessage({ type: 'resize', width: w, height: h });
    }
}, 100);

vscode.postMessage({ type: 'ready' });
