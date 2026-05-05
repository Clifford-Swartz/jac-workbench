/**
 * BrowserClient — manages a headless Chrome instance via puppeteer-core.
 * Streams screenshots and forwards input events via CDP.
 * Uses a mirrored Chrome profile for persistent auth/cookies.
 */

import * as puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Chrome detection ────────────────────────────────────────────────────────

const CHROME_PATHS: Record<string, string[]> = {
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
    ],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
};

export function findChromePath(): string | null {
    const candidates = CHROME_PATHS[process.platform] || [];
    for (const p of candidates) {
        if (existsSync(p)) { return p; }
    }
    return null;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScreencastFrame {
    data: string;
    sessionId: number;
}

export interface BrowserCallbacks {
    onFrame(frame: ScreencastFrame): void;
    onUrlChanged(url: string): void;
    onTitleChanged(title: string): void;
    onNavState(canGoBack: boolean, canGoForward: boolean): void;
    onLoading(loading: boolean): void;
}

// ── BrowserClient ───────────────────────────────────────────────────────────

export class BrowserClient {
    private browser: puppeteer.Browser | null = null;
    private page: puppeteer.Page | null = null;
    private cdp: puppeteer.CDPSession | null = null;
    private callbacks: BrowserCallbacks;
    private chromePath: string;
    private disposed = false;
    private viewportWidth = 800;
    private viewportHeight = 600;
    private screencastActive = false;

    constructor(chromePath: string, callbacks: BrowserCallbacks) {
        this.chromePath = chromePath;
        this.callbacks = callbacks;
    }

    async launch(initialWidth?: number, initialHeight?: number): Promise<void> {
        if (initialWidth && initialWidth > 200) { this.viewportWidth = initialWidth; }
        if (initialHeight && initialHeight > 150) { this.viewportHeight = initialHeight; }
        // Persistent profile dir — cookies/logins survive across sessions.
        // Users log in once inside the panel; no mirroring needed (Chrome encrypts cookies per-profile).
        const profileDir = path.join(os.homedir(), '.jac', 'browser-profile');
        if (!existsSync(profileDir)) { mkdirSync(profileDir, { recursive: true }); }

        // Remove stale lock file if it exists (from a previous crash)
        const lockFile = path.join(profileDir, 'SingletonLock');
        try { if (existsSync(lockFile)) { require('fs').unlinkSync(lockFile); } } catch { /* skip */ }

        this.browser = await puppeteer.launch({
            executablePath: this.chromePath,
            headless: 'shell',
            userDataDir: profileDir,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--remote-allow-origins=*',
                '--allow-file-access-from-files',
                '--hide-scrollbars',
                '--no-first-run',
                '--no-default-browser-check',
                `--window-size=${this.viewportWidth},${this.viewportHeight}`,
            ],
            defaultViewport: {
                width: this.viewportWidth,
                height: this.viewportHeight,
            },
        });

        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();

        // Create CDP session
        const target = this.page.target();
        this.cdp = await target.createCDPSession();

        // Listen for screencast frames
        this.cdp.on('Page.screencastFrame', (params: any) => {
            this.screencastActive = true;
            this.callbacks.onFrame({
                data: params.data,
                sessionId: params.sessionId,
            });
            this.cdp?.send('Page.screencastFrameAck', {
                sessionId: params.sessionId,
            }).catch(() => {});
        });

        // Navigation events
        this.cdp.on('Page.frameNavigated', (params: any) => {
            if (params.frame?.parentId) { return; }
            this.callbacks.onUrlChanged(params.frame?.url || '');
            this.updateNavState();
        });

        this.cdp.on('Page.loadEventFired', () => {
            this.callbacks.onLoading(false);
            this.updateTitle();
            this.updateNavState();
        });

        this.cdp.on('Page.frameStartedLoading', (params: any) => {
            if (!params.frameId) { return; }
            this.callbacks.onLoading(true);
        });

        await this.cdp.send('Page.enable');

        // Start screencast
        await this.cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 80,
            maxWidth: this.viewportWidth,
            maxHeight: this.viewportHeight,
            everyNthFrame: 1,
        });

        // Navigate to start page
        await this.page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });
    }

    async navigate(url: string): Promise<void> {
        if (!this.page || this.disposed) { return; }
        if (!/^https?:\/\//i.test(url) && !url.startsWith('file://')) {
            if (url.includes('.') && !url.includes(' ')) {
                url = 'https://' + url;
            } else {
                url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
            }
        }
        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch { /* timeout ok */ }
        this.updateTitle();
        this.updateNavState();
    }

    async goBack(): Promise<void> {
        if (!this.page || this.disposed) { return; }
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        this.updateTitle();
        this.updateNavState();
    }

    async goForward(): Promise<void> {
        if (!this.page || this.disposed) { return; }
        await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        this.updateTitle();
        this.updateNavState();
    }

    async reload(): Promise<void> {
        if (!this.page || this.disposed) { return; }
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    }

    // ── Input forwarding ────────────────────────────────────────────────────

    async dispatchMouseEvent(type: string, x: number, y: number, button?: string, deltaX?: number, deltaY?: number): Promise<void> {
        if (!this.cdp || this.disposed) { return; }
        const cdpType: Record<string, string> = {
            mousedown: 'mousePressed',
            mouseup: 'mouseReleased',
            mousemove: 'mouseMoved',
        };
        if (type === 'wheel') {
            await this.cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: Math.round(x),
                y: Math.round(y),
                deltaX: deltaX || 0,
                deltaY: deltaY || 0,
                button: 'none',
                clickCount: 0,
            }).catch(() => {});
            return;
        }
        const mappedType = cdpType[type] || type;
        const btn = button || 'left';
        await (this.cdp as any).send('Input.dispatchMouseEvent', {
            type: mappedType,
            x: Math.round(x),
            y: Math.round(y),
            button: btn,
            clickCount: (type === 'mousedown' || type === 'mouseup') ? 1 : 0,
        }).catch(() => {});
    }

    async dispatchKeyEvent(type: string, key: string, code: string, text: string, modifiers: number): Promise<void> {
        if (!this.cdp || this.disposed) { return; }
        const cdpType = type === 'keydown' ? 'keyDown' : type === 'keyup' ? 'keyUp' : 'char';
        const params: any = {
            type: cdpType,
            key,
            code,
            modifiers,
            windowsVirtualKeyCode: 0,
            nativeVirtualKeyCode: 0,
        };
        if (cdpType === 'keyDown' || cdpType === 'char') {
            params.text = text;
        }
        await this.cdp.send('Input.dispatchKeyEvent', params).catch(() => {});
    }

    async dispatchScrollEvent(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
        return this.dispatchMouseEvent('wheel', x, y, undefined, deltaX, deltaY);
    }

    // ── Viewport resize ─────────────────────────────────────────────────────

    async resize(width: number, height: number): Promise<void> {
        if (!this.page || !this.cdp || this.disposed) { return; }
        if (width < 200 || height < 150) { return; }
        this.viewportWidth = width;
        this.viewportHeight = height;
        await this.page.setViewport({ width, height });
        // Always restart screencast with new dimensions
        await this.cdp.send('Page.stopScreencast').catch(() => {});
        await this.cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 80,
            maxWidth: width,
            maxHeight: height,
            everyNthFrame: 1,
        }).catch(() => {});
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async updateTitle(): Promise<void> {
        if (!this.page || this.disposed) { return; }
        try {
            const title = await this.page.title();
            this.callbacks.onTitleChanged(title || 'Browser');
        } catch { /* ignore */ }
    }

    private async updateNavState(): Promise<void> {
        if (!this.cdp || this.disposed) { return; }
        try {
            const history = await this.cdp.send('Page.getNavigationHistory') as any;
            const idx = history.currentIndex || 0;
            const entries = history.entries || [];
            this.callbacks.onNavState(idx > 0, idx < entries.length - 1);
        } catch { /* ignore */ }
    }

    getUrl(): string {
        return this.page?.url() || '';
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        try {
            if (this.cdp) {
                await this.cdp.send('Page.stopScreencast').catch(() => {});
                await this.cdp.detach().catch(() => {});
            }
            if (this.browser) {
                await this.browser.close().catch(() => {});
            }
        } catch { /* ignore */ }
        this.cdp = null;
        this.page = null;
        this.browser = null;
    }
}
