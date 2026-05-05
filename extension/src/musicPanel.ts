/**
 * Music controller webview – renders in the bottom panel as a WebviewViewProvider.
 * Tabs: Now Playing, Search, Library (favorites + playlists + history).
 */

import * as vscode from 'vscode';
import { createMusicController, MusicController, NowPlaying } from './musicController';
import { detectAudioSetup, getInstallSteps, AudioCapture, setupMacMultiOutput, restoreMacSpeakers, getSpeakerVolume, setSpeakerVolume, VolumeDaemon } from './audioCapture';
import { execFile, spawn as cpSpawn } from 'child_process';
import * as https from 'https';

interface HistoryEntry {
    track: string;
    artist: string;
    album: string;
    artUrl: string;
    app: string;
    timestamp: number;
}

interface FavoriteEntry {
    track: string;
    artist: string;
    album: string;
    artUrl: string;
}

interface SavedPlaylist {
    name: string;
    uri: string;        // e.g. spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
    artUrl?: string;
}

// Curated quick-pick playlists (popular Spotify playlists)
const QUICK_PICKS: SavedPlaylist[] = [
    { name: "Today's Top Hits",  uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' },
    { name: 'RapCaviar',         uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd' },
    { name: 'All Out 2010s',     uri: 'spotify:playlist:37i9dQZF1DX5Ejj0EkURtP' },
    { name: 'Rock Classics',     uri: 'spotify:playlist:37i9dQZF1DWXRqgorJj26U' },
    { name: 'Chill Hits',        uri: 'spotify:playlist:37i9dQZF1DX4WYpdgoIcn6' },
    { name: 'Lo-Fi Beats',       uri: 'spotify:playlist:37i9dQZF1DWWQRwui0ExPn' },
    { name: 'Hot Country',       uri: 'spotify:playlist:37i9dQZF1DX1lVhptIYRda' },
    { name: 'Jazz Vibes',        uri: 'spotify:playlist:37i9dQZF1DX0SM0LYsmbMT' },
    { name: 'Beast Mode',        uri: 'spotify:playlist:37i9dQZF1DX76Wlfdnj7AP' },
    { name: 'Deep Focus',        uri: 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ' },
    { name: 'Viva Latino',       uri: 'spotify:playlist:37i9dQZF1DX10zKzsJ2jva' },
    { name: 'R&B Favourites',    uri: 'spotify:playlist:37i9dQZF1DX4SBhb3fqCJd' },
];

const MAX_HISTORY = 50;
const MAX_FAVORITES = 100;

// ── Album art color extraction ──────────────────────────────────────────────

interface RGB { r: number; g: number; b: number; }

/**
 * Extract dominant colors from an album art URL.
 * Uses ffmpeg to scale to 8x8, reads raw RGB pixels, and clusters them.
 */
function extractDominantColors(url: string): Promise<Array<{ r: number; g: number; b: number; h: number; s: number; l: number }>> {
    return new Promise((resolve) => {
        const proc = cpSpawn('ffmpeg', [
            '-i', url,
            '-vf', 'scale=8:8',
            '-f', 'rawvideo',
            '-pix_fmt', 'rgb24',
            '-v', 'quiet',
            'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        const chunks: Buffer[] = [];
        proc.stdout?.on('data', (d: Buffer) => chunks.push(d));
        proc.on('close', (code) => {
            if (code !== 0 || chunks.length === 0) { resolve([]); return; }
            const buf = Buffer.concat(chunks);
            const pixels: RGB[] = [];
            for (let i = 0; i + 2 < buf.length; i += 3) {
                pixels.push({ r: buf[i], g: buf[i + 1], b: buf[i + 2] });
            }
            const palette = kMeansColors(pixels, 4);
            // Convert to HSL and sort by saturation (most vibrant first)
            const result = palette.map(c => {
                const hsl = rgbToHsl(c.r, c.g, c.b);
                return { r: c.r, g: c.g, b: c.b, h: hsl.h, s: hsl.s, l: hsl.l };
            }).sort((a, b) => b.s - a.s);
            resolve(result);
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { proc.kill(); resolve([]); }, 5000);
    });
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) { return { h: 0, s: 0, l: l * 100 }; }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) { h = ((g - b) / d + (g < b ? 6 : 0)) / 6; }
    else if (max === g) { h = ((b - r) / d + 2) / 6; }
    else { h = ((r - g) / d + 4) / 6; }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

/** Simple k-means clustering to find dominant colors */
function kMeansColors(pixels: RGB[], k: number): RGB[] {
    if (pixels.length === 0) { return []; }
    // Initialize centroids by spreading evenly
    let centroids: RGB[] = [];
    for (let i = 0; i < k; i++) {
        centroids.push(pixels[Math.floor(i * pixels.length / k)]);
    }

    for (let iter = 0; iter < 10; iter++) {
        const clusters: RGB[][] = Array.from({ length: k }, () => []);
        // Assign pixels to nearest centroid
        for (const p of pixels) {
            let minDist = Infinity, minIdx = 0;
            for (let c = 0; c < k; c++) {
                const dr = p.r - centroids[c].r;
                const dg = p.g - centroids[c].g;
                const db = p.b - centroids[c].b;
                const dist = dr * dr + dg * dg + db * db;
                if (dist < minDist) { minDist = dist; minIdx = c; }
            }
            clusters[minIdx].push(p);
        }
        // Recalculate centroids
        centroids = clusters.map((cluster, i) => {
            if (cluster.length === 0) { return centroids[i]; }
            const sum = cluster.reduce((a, p) => ({ r: a.r + p.r, g: a.g + p.g, b: a.b + p.b }), { r: 0, g: 0, b: 0 });
            return {
                r: Math.round(sum.r / cluster.length),
                g: Math.round(sum.g / cluster.length),
                b: Math.round(sum.b / cluster.length),
            };
        });
    }

    // Filter out very dark or very desaturated colors
    return centroids.filter(c => {
        const hsl = rgbToHsl(c.r, c.g, c.b);
        return hsl.l > 10 && hsl.l < 90; // skip pure black/white
    });
}

export class MusicPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'jacMusic';

    private view?: vscode.WebviewView;
    private controller: MusicController = createMusicController();
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private history: HistoryEntry[] = [];
    private favorites: FavoriteEntry[] = [];
    private savedPlaylists: SavedPlaylist[] = [];
    private lastTrackKey = '';
    private lastArtUrl = '';
    private context?: vscode.ExtensionContext;
    private audioCapture?: AudioCapture;
    private volumeDaemon?: VolumeDaemon;
    private multiOutputActive = false;
    private blackHoleDevice: string | null = null;
    private audioSetupPrompted = false;

    constructor(private readonly extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
        this.context = context;
        if (context) {
            this.history = context.globalState.get<HistoryEntry[]>('jac.musicHistory', []);
            this.favorites = context.globalState.get<FavoriteEntry[]>('jac.musicFavorites', []);
            this.savedPlaylists = context.globalState.get<SavedPlaylist[]>('jac.musicPlaylists', []);
        }
    }

    /** Called from extension.ts when volume keys are pressed */
    syncVolume(pct: number): void {
        this.view?.webview.postMessage({ type: 'systemVolume', value: pct });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
        };

        const cssUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'music.css'),
        );
        const scriptUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'music.js'),
        );
        const nonce = getNonce();
        webviewView.webview.html = this.getHtml(webviewView.webview, cssUri, scriptUri, nonce);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                // Playback
                case 'playPause': await this.controller.playPause(); break;
                case 'next': await this.controller.next(); break;
                case 'previous': await this.controller.previous(); break;
                case 'volume':
                    if (this.multiOutputActive) {
                        await setSpeakerVolume(msg.value);
                    } else {
                        await this.controller.setSystemVolume(msg.value);
                    }
                    break;
                case 'getVolume': {
                    const vol = this.multiOutputActive
                        ? await getSpeakerVolume()
                        : await this.controller.getSystemVolume();
                    webviewView.webview.postMessage({ type: 'systemVolume', value: vol });
                    break;
                }
                case 'seek': await this.controller.seek(msg.value); break;

                // Search
                case 'search':
                    await this.controller.playQuery(msg.query);
                    setTimeout(() => this.sendNowPlaying(), 1500);
                    break;

                // Favorites
                case 'toggleFavorite':
                    this.toggleFavorite(msg);
                    break;
                case 'playFavorite':
                    await this.controller.playQuery(`${msg.artist} ${msg.track}`);
                    setTimeout(() => this.sendNowPlaying(), 1500);
                    break;
                case 'removeFavorite':
                    this.favorites = this.favorites.filter(
                        f => !(f.track === msg.track && f.artist === msg.artist)
                    );
                    this.saveFavorites();
                    this.sendLibraryData();
                    break;

                // Playlists
                case 'addPlaylist':
                    await this.addPlaylist(msg.input);
                    break;
                case 'playPlaylist':
                    await this.controller.playPlaylist(msg.uri);
                    setTimeout(() => this.sendNowPlaying(), 1500);
                    break;
                case 'removePlaylist':
                    this.savedPlaylists = this.savedPlaylists.filter(p => p.uri !== msg.uri);
                    this.savePlaylists();
                    this.sendLibraryData();
                    break;

                // History
                case 'playHistoryItem':
                    await this.controller.playQuery(`${msg.artist} ${msg.track}`);
                    setTimeout(() => this.sendNowPlaying(), 1500);
                    break;
                case 'clearHistory':
                    this.history = [];
                    this.saveHistory();
                    this.sendLibraryData();
                    break;

                // Init
                case 'getLibrary':
                    this.sendLibraryData();
                    break;
                case 'ready':
                    this.startPolling();
                    this.sendLibraryData();
                    this.controller.getSystemVolume().then(vol => {
                        webviewView.webview.postMessage({ type: 'systemVolume', value: vol });
                    });
                    this.initAudioCapture();
                    break;
                case 'installBlackHole':
                    this.handleInstallBlackHole();
                    break;
            }
            if (['playPause', 'next', 'previous'].includes(msg.type)) {
                setTimeout(() => this.sendNowPlaying(), 300);
            }
        });

        webviewView.onDidDispose(() => {
            this.disposed = true;
            this.audioCapture?.stop();
            this.volumeDaemon?.stop();
            if (this.pollTimer) { clearInterval(this.pollTimer); }
            this.view = undefined;
            // Restore speakers as default output on Mac
            if (this.multiOutputActive) {
                this.multiOutputActive = false;
                restoreMacSpeakers();
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && !this.pollTimer) {
                this.startPolling();
            } else if (!webviewView.visible && this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = undefined;
            }
        });

        this.controller.isAvailable().then((available) => {
            if (!available) {
                webviewView.webview.postMessage({
                    type: 'status',
                    message: `No music app detected. Open Spotify${process.platform === 'darwin' ? ' or Apple Music' : ''} and play something!`,
                });
            }
        });
    }

    // ── Polling ─────────────────────────────────────────────────────────────

    private startPolling(): void {
        this.sendNowPlaying();
        this.pollTimer = setInterval(() => {
            if (!this.disposed && this.view?.visible) { this.sendNowPlaying(); }
        }, 1000);
    }

    private async sendNowPlaying(): Promise<void> {
        try {
            const np = await this.controller.getNowPlaying();
            const isFav = np ? this.favorites.some(f => f.track === np.track && f.artist === np.artist) : false;
            this.view?.webview.postMessage({ type: 'nowPlaying', data: np, isFavorited: isFav });
            if (np) {
                this.recordHistory(np);
                // Extract colors when album art changes
                if (np.artUrl && np.artUrl !== this.lastArtUrl) {
                    this.lastArtUrl = np.artUrl;
                    this.extractAlbumColors(np.artUrl);
                }
            }
        } catch { /* ignore */ }
    }

    private async extractAlbumColors(artUrl: string): Promise<void> {
        try {
            const colors = await extractDominantColors(artUrl);
            if (colors.length > 0) {
                this.view?.webview.postMessage({ type: 'albumColors', colors });
            }
        } catch { /* ignore — fall back to default palette */ }
    }

    // ── Library data ────────────────────────────────────────────────────────

    private sendLibraryData(): void {
        this.view?.webview.postMessage({
            type: 'libraryData',
            favorites: this.favorites,
            playlists: this.savedPlaylists,
            quickPicks: QUICK_PICKS,
            history: this.history,
        });
    }

    // ── Favorites ───────────────────────────────────────────────────────────

    private toggleFavorite(msg: any): void {
        const key = (f: FavoriteEntry) => `${f.track}::${f.artist}`;
        const target = { track: msg.track, artist: msg.artist, album: msg.album, artUrl: msg.artUrl };
        const existing = this.favorites.findIndex(f => key(f) === key(target));

        if (existing >= 0) {
            this.favorites.splice(existing, 1);
        } else {
            this.favorites.unshift(target);
            if (this.favorites.length > MAX_FAVORITES) { this.favorites.pop(); }
        }
        this.saveFavorites();
        this.sendLibraryData();
        // Re-send now playing to update heart state
        this.sendNowPlaying();
    }

    private saveFavorites(): void {
        this.context?.globalState.update('jac.musicFavorites', this.favorites);
    }

    // ── Playlists ───────────────────────────────────────────────────────────

    private async addPlaylist(input: string): Promise<void> {
        // Accept: spotify:playlist:ID, https://open.spotify.com/playlist/ID, or album variants
        let uri = input.trim();

        // Convert URL to URI
        const urlMatch = uri.match(/open\.spotify\.com\/(playlist|album)\/([a-zA-Z0-9]+)/);
        if (urlMatch) {
            uri = `spotify:${urlMatch[1]}:${urlMatch[2]}`;
        }

        // Validate it looks like a spotify URI
        if (!uri.match(/^spotify:(playlist|album):[a-zA-Z0-9]+$/)) {
            this.view?.webview.postMessage({ type: 'playlistError', message: 'Paste a Spotify playlist or album URL/URI' });
            return;
        }

        // Check not already saved
        if (this.savedPlaylists.some(p => p.uri === uri)) {
            this.view?.webview.postMessage({ type: 'playlistError', message: 'Already saved!' });
            return;
        }

        // Try to get name from oEmbed
        const name = await this.fetchPlaylistName(uri);

        this.savedPlaylists.unshift({ name: name || uri, uri });
        this.savePlaylists();
        this.sendLibraryData();
    }

    private fetchPlaylistName(uri: string): Promise<string> {
        return new Promise((resolve) => {
            const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(uri)}`;
            const req = https.get(url, { timeout: 3000 }, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.title || '');
                    } catch { resolve(''); }
                });
            });
            req.on('error', () => resolve(''));
            req.on('timeout', () => { req.destroy(); resolve(''); });
        });
    }

    private savePlaylists(): void {
        this.context?.globalState.update('jac.musicPlaylists', this.savedPlaylists);
    }

    // ── History ─────────────────────────────────────────────────────────────

    private recordHistory(np: NowPlaying): void {
        const key = `${np.track}::${np.artist}`;
        if (key === this.lastTrackKey) { return; }
        this.lastTrackKey = key;

        this.history = this.history.filter(h => `${h.track}::${h.artist}` !== key);
        this.history.unshift({
            track: np.track,
            artist: np.artist,
            album: np.album,
            artUrl: np.artUrl,
            app: np.app,
            timestamp: Date.now(),
        });
        if (this.history.length > MAX_HISTORY) { this.history = this.history.slice(0, MAX_HISTORY); }
        this.saveHistory();
    }

    private saveHistory(): void {
        this.context?.globalState.update('jac.musicHistory', this.history);
    }

    // ── Audio Capture (cross-platform) ─────────────────────────────────────

    private async initAudioCapture(): Promise<void> {
        const status = await detectAudioSetup();

        if (process.platform === 'darwin') {
            // macOS: Use ScreenCaptureKit — no BlackHole or Multi-Output needed.
            // Volume keys work because speakers stay as the default output.
            this.startAudioCapture('screencapture');
            this.startVolumeDaemon(); // volume-watch polls speaker volume changes
            const vol = await getSpeakerVolume();
            this.view?.webview.postMessage({ type: 'systemVolume', value: vol });
            this.view?.webview.postMessage({ type: 'audioMode', mode: 'real' });
            return;
        }
        if (status.ready && status.source) {
            // Non-Mac — use the detected source directly
            this.startAudioCapture(status.source);
            this.view?.webview.postMessage({ type: 'audioMode', mode: 'real' });
        } else if (!this.audioSetupPrompted && status.missing.length > 0) {
            this.audioSetupPrompted = true;
            this.view?.webview.postMessage({
                type: 'audioMode',
                mode: 'simulated',
                canInstall: status.canAutoInstall,
                missing: status.missing,
                message: status.message,
            });
        }
    }

    private startVolumeDaemon(): void {
        this.volumeDaemon?.stop();
        this.volumeDaemon = new VolumeDaemon({
            onVolumeChange: (pct) => {
                this.view?.webview.postMessage({ type: 'systemVolume', value: pct });
            },
            onMuteChange: (_muted) => {
                // Could show a mute indicator — for now just sync volume
                getSpeakerVolume().then(vol => {
                    this.view?.webview.postMessage({ type: 'systemVolume', value: vol });
                });
            },
        });
        this.volumeDaemon.start();
    }

    private startAudioCapture(source: string): void {
        this.audioCapture?.stop();
        this.audioCapture = new AudioCapture(source, {
            onBands: (data) => {
                if (!this.disposed && this.view?.visible) {
                    this.view.webview.postMessage({ type: 'audioBands', bands: data.bands });
                }
            },
            onError: () => {
                this.audioCapture?.stop();
                this.audioCapture = undefined;
                this.view?.webview.postMessage({ type: 'audioMode', mode: 'simulated' });
            },
        });
        this.audioCapture.start();
    }

    /** Sequentially install whatever's missing, then re-detect */
    private async handleInstallBlackHole(): Promise<void> {
        const sendStatus = (status: string, message: string) => {
            this.view?.webview.postMessage({ type: 'audioInstallStatus', status, message });
        };

        const status = await detectAudioSetup();
        const steps = getInstallSteps(status.missing);

        if (steps.length === 0 && !status.ready) {
            sendStatus('error', status.message || 'Manual setup required.');
            return;
        }

        for (const step of steps) {
            sendStatus('installing', step.label);
            const ok = await step.run();
            if (!ok) {
                sendStatus('error', `Failed: ${step.label}`);
                return;
            }
        }

        if (process.platform === 'darwin' && status.missing.includes('blackhole')) {
            // BlackHole needs sudo — give user a copyable command
            this.view?.webview.postMessage({
                type: 'audioInstallStatus',
                status: 'copy',
                message: 'Run this in your terminal or paste it into JAC:',
                command: 'brew install blackhole-2ch',
            });
            this.pollForBlackHole();
            return;
        } else {
            // Re-detect immediately for non-macOS
            const newStatus = await detectAudioSetup();
            if (newStatus.ready && newStatus.source) {
                this.startAudioCapture(newStatus.source);
                this.view?.webview.postMessage({ type: 'audioMode', mode: 'real' });
                sendStatus('success', 'All set! Real audio visualization is now active.');
            } else {
                sendStatus('success', newStatus.message || 'Installed! Restart VS Code to activate.');
            }
        }
    }

    /** Poll every 5 seconds to detect when BlackHole has been installed */
    private pollForBlackHole(): void {
        let checks = 0;
        const maxChecks = 60; // 5 minutes max
        const timer = setInterval(async () => {
            checks++;
            if (checks > maxChecks || this.disposed) {
                clearInterval(timer);
                return;
            }
            const newStatus = await detectAudioSetup();
            if (newStatus.ready && newStatus.source) {
                clearInterval(timer);
                this.startAudioCapture(newStatus.source);
                this.view?.webview.postMessage({ type: 'audioMode', mode: 'real' });
                this.view?.webview.postMessage({
                    type: 'audioInstallStatus',
                    status: 'success',
                    message: 'BlackHole detected! Real audio visualization is active. You may need to reboot for best results.',
                });
            }
        }, 5000);
    }

    // ── HTML ────────────────────────────────────────────────────────────────

    private getHtml(webview: vscode.Webview, cssUri: vscode.Uri, scriptUri: vscode.Uri, nonce: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; connect-src https://open.spotify.com; media-src *;" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Music</title>
</head>
<body>
    <div id="music-root">
        <!-- Tab bar -->
        <div id="tab-bar">
            <button class="tab active" data-tab="playing">Now Playing</button>
            <button class="tab" data-tab="search">Search</button>
            <button class="tab" data-tab="library">Library</button>
        </div>

        <!-- Now Playing tab -->
        <div id="tab-playing" class="tab-content active">
            <canvas id="visualizer"></canvas>
            <canvas id="visualizer-front"></canvas>
            <div id="status-msg"></div>
            <div id="no-music">
                <div class="no-music-icon">&#9835;</div>
                <div>Nothing playing</div>
                <div class="hint">Open a music app and hit play</div>
            </div>
            <div id="now-playing" style="display:none;">
                <div id="viz-controls">
                    <input id="viz-opacity" type="range" min="0" max="100" value="65" title="Glass transparency" />
                    <button id="viz-cycle" title="Change visualization">&#x25CE;</button>
                </div>
                <div id="np-main">
                    <div id="album-art-wrap">
                        <img id="album-art" src="" alt="" />
                        <div id="album-art-placeholder">&#9835;</div>
                        <button id="btn-fav" class="fav-btn" title="Add to favorites">&#x2661;</button>
                    </div>
                    <div id="np-details">
                        <div id="track-info">
                            <div id="track-name"></div>
                            <div id="artist-name"></div>
                            <div id="album-name"></div>
                        </div>
                        <div id="progress-bar">
                            <span id="time-current">0:00</span>
                            <div id="progress-track">
                                <div id="progress-fill"></div>
                            </div>
                            <span id="time-total">0:00</span>
                        </div>
                        <div id="controls-row">
                            <div id="controls">
                                <button id="btn-prev" title="Previous">&#x23EE;</button>
                                <button id="btn-play" title="Play/Pause">&#x23EF;</button>
                                <button id="btn-next" title="Next">&#x23ED;</button>
                            </div>
                            <div id="volume-row">
                                <span class="vol-icon vol-lo">&#x2758;</span>
                                <input id="volume-slider" type="range" min="0" max="100" value="50" />
                                <span class="vol-icon vol-hi">&#x2758;&#x2758;&#x2758;</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="app-badge"></div>
            </div>
        </div>

        <!-- Search tab -->
        <div id="tab-search" class="tab-content">
            <div id="search-box">
                <input id="search-input" type="text" placeholder="Search for a song or artist..." />
                <button id="search-btn" title="Play top result">&#x25B6;</button>
            </div>
            <div id="search-status"></div>
            <div id="recent-searches"></div>
        </div>

        <!-- Library tab -->
        <div id="tab-library" class="tab-content">
            <!-- Favorites section -->
            <div class="lib-section">
                <div class="lib-section-header">
                    <span>&#x2665; Favorites</span>
                </div>
                <div id="favorites-list"></div>
                <div id="favorites-empty" class="lib-empty">Tap the heart on Now Playing to save tracks</div>
            </div>

            <!-- Your Playlists section -->
            <div class="lib-section">
                <div class="lib-section-header">
                    <span>&#x266B; Your Playlists</span>
                    <button id="add-playlist-btn" title="Add playlist">+ Add</button>
                </div>
                <div id="add-playlist-form" style="display:none;">
                    <input id="playlist-input" type="text" placeholder="Paste Spotify playlist or album URL..." />
                    <button id="playlist-save-btn">Save</button>
                </div>
                <div id="playlist-error"></div>
                <div id="playlists-list"></div>
            </div>

            <!-- Quick Picks section -->
            <div class="lib-section">
                <div class="lib-section-header">
                    <span>&#x26A1; Quick Picks</span>
                </div>
                <div id="quick-picks-list"></div>
            </div>

            <!-- History section -->
            <div class="lib-section">
                <div class="lib-section-header">
                    <span>&#x1F552; Recently Played</span>
                    <button id="clear-history" title="Clear">Clear</button>
                </div>
                <div id="history-list"></div>
                <div id="history-empty" class="lib-empty">Your listening history will appear here</div>
            </div>
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
