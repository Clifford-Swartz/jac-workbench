/** Music panel webview script — Now Playing / Search / Library */
export {};

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): any;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Elements ────────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

// Now Playing
const noMusicEl = document.getElementById('no-music')!;
const nowPlayingEl = document.getElementById('now-playing')!;
const statusMsgEl = document.getElementById('status-msg')!;
const albumArtEl = document.getElementById('album-art') as HTMLImageElement;
const albumArtPlaceholder = document.getElementById('album-art-placeholder')!;
const trackNameEl = document.getElementById('track-name')!;
const artistNameEl = document.getElementById('artist-name')!;
const albumNameEl = document.getElementById('album-name')!;
const timeCurrEl = document.getElementById('time-current')!;
const timeTotalEl = document.getElementById('time-total')!;
const progressFill = document.getElementById('progress-fill')!;
const progressTrack = document.getElementById('progress-track')!;
const btnPlay = document.getElementById('btn-play')!;
const btnNext = document.getElementById('btn-next')!;
const btnPrev = document.getElementById('btn-prev')!;
const btnFav = document.getElementById('btn-fav')!;
const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
const appBadge = document.getElementById('app-badge')!;

// Search
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchBtn = document.getElementById('search-btn')!;
const searchStatus = document.getElementById('search-status')!;
const recentSearchesEl = document.getElementById('recent-searches')!;

// Library
const favoritesList = document.getElementById('favorites-list')!;
const favoritesEmpty = document.getElementById('favorites-empty')!;
const addPlaylistBtn = document.getElementById('add-playlist-btn')!;
const addPlaylistForm = document.getElementById('add-playlist-form')!;
const playlistInput = document.getElementById('playlist-input') as HTMLInputElement;
const playlistSaveBtn = document.getElementById('playlist-save-btn')!;
const playlistError = document.getElementById('playlist-error')!;
const playlistsList = document.getElementById('playlists-list')!;
const quickPicksList = document.getElementById('quick-picks-list')!;
const historyList = document.getElementById('history-list')!;
const historyEmpty = document.getElementById('history-empty')!;
const clearHistoryBtn = document.getElementById('clear-history')!;

// ── State ───────────────────────────────────────────────────────────────────

let isPlaying = false;
let lastTrack = '';
let currentTrack = '';
let currentArtist = '';
let currentAlbum = '';
let currentArtUrl = '';
let isFavorited = false;
const savedState = vscode.getState() as any || {};
let recentSearches: string[] = savedState.recentSearches || [];

// Cached library data for autocomplete
let cachedFavorites: FavEntry[] = [];
let cachedHistory: HistEntry[] = [];

// ── Tabs ────────────────────────────────────────────────────────────────────

function switchTab(target: string): void {
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(tc => tc.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${target}"]`)?.classList.add('active');
    document.getElementById(`tab-${target}`)?.classList.add('active');
    if (target === 'library') {
        vscode.postMessage({ type: 'getLibrary' });
    }
}

tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab!));
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
    if (!seconds || seconds < 0) { return '0:00'; }
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) { return 'Just now'; }
    if (mins < 60) { return `${mins}m ago`; }
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) { return `${hrs}h ago`; }
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Message Handler ─────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'nowPlaying':
            handleNowPlaying(msg.data, msg.isFavorited);
            break;
        case 'status':
            statusMsgEl.textContent = msg.message;
            break;
        case 'libraryData':
            cachedFavorites = msg.favorites || [];
            cachedHistory = msg.history || [];
            renderFavorites(cachedFavorites);
            renderPlaylists(msg.playlists || []);
            renderQuickPicks(msg.quickPicks || []);
            renderHistory(cachedHistory);
            break;
        case 'playlistError':
            playlistError.textContent = msg.message;
            setTimeout(() => { playlistError.textContent = ''; }, 3000);
            break;
        case 'systemVolume':
            volumeSlider.value = String(msg.value);
            break;
        case 'audioBands':
            // Real frequency data from BlackHole capture
            if (msg.bands && msg.bands.length >= NUM_BANDS) {
                // Check if we're actually getting signal (not all zeros/near-zero)
                let sum = 0;
                for (let i = 0; i < msg.bands.length; i++) { sum += msg.bands[i]; }
                const hasSignal = sum > 0.5; // threshold — silence is ~0

                if (hasSignal) {
                    realAudioMode = true;
                    silentFrames = 0;
                    for (let i = 0; i < NUM_BANDS; i++) {
                        // Smooth toward target — 0.25 = responsive but not jittery
                        bands[i] += (msg.bands[i] - bands[i]) * 0.25;
                    }
                } else {
                    silentFrames++;
                    // After 2 seconds of silence (~40 frames at 20fps), fall back to simulation
                    if (silentFrames > 40) {
                        realAudioMode = false;
                    }
                }
            }
            break;
        case 'albumColors':
            if (msg.colors && msg.colors.length > 0) {
                vizPalette = msg.colors.map((c: any) => ({
                    r: c.r, g: c.g, b: c.b, h: c.h, s: c.s, l: c.l,
                }));
                applyAlbumAccentColor(vizPalette);
            }
            break;
        case 'audioMode':
            if (msg.mode === 'real') {
                realAudioMode = true;
                hideAudioPrompt();
            } else if (msg.mode === 'simulated' && (msg.canInstall || msg.message)) {
                showAudioPrompt(msg.missing || [], msg.canInstall, msg.message);
            }
            break;
        case 'audioInstallStatus':
            handleInstallStatus(msg);
            break;
    }
});

// ── Now Playing ─────────────────────────────────────────────────────────────

function handleNowPlaying(np: any, favState: boolean): void {
    if (!np) {
        noMusicEl.style.display = '';
        nowPlayingEl.style.display = 'none';
        statusMsgEl.textContent = '';
        setVizPlaying(false);
        return;
    }

    noMusicEl.style.display = 'none';
    nowPlayingEl.style.display = '';
    statusMsgEl.textContent = '';

    currentTrack = np.track || '';
    currentArtist = np.artist || '';
    currentAlbum = np.album || '';
    currentArtUrl = np.artUrl || '';
    isFavorited = favState;

    trackNameEl.textContent = np.track || 'Unknown';
    artistNameEl.textContent = np.artist || 'Unknown';
    albumNameEl.textContent = np.album || '';

    if (np.artUrl) {
        albumArtEl.src = np.artUrl;
        albumArtEl.style.display = '';
        albumArtPlaceholder.style.display = 'none';
    } else {
        albumArtEl.style.display = 'none';
        albumArtPlaceholder.style.display = '';
    }

    timeCurrEl.textContent = formatTime(np.position);
    timeTotalEl.textContent = formatTime(np.duration);
    progressFill.style.width = np.duration > 0
        ? `${Math.min(100, (np.position / np.duration) * 100)}%`
        : '0%';

    isPlaying = np.isPlaying;
    setVizPlaying(isPlaying);
    btnPlay.innerHTML = isPlaying ? '&#x23F8;' : '&#x25B6;';
    btnPlay.title = isPlaying ? 'Pause' : 'Play';
    appBadge.textContent = np.app || '';

    // Favorite button state
    btnFav.innerHTML = isFavorited ? '&#x2665;' : '&#x2661;';
    btnFav.classList.toggle('fav-active', isFavorited);

    // Update visualizer with track info and position
    updateTrackPosition(np.position || 0, np.duration || 0);
    setTrackSeed(np.track || '', np.artist || '');

    // Track change animation
    if (np.track !== lastTrack && lastTrack) {
        trackNameEl.classList.remove('track-change');
        void trackNameEl.offsetWidth;
        trackNameEl.classList.add('track-change');
    }
    lastTrack = np.track;
}

// ── Playback Controls ───────────────────────────────────────────────────────

btnPlay.addEventListener('click', () => vscode.postMessage({ type: 'playPause' }));
btnNext.addEventListener('click', () => vscode.postMessage({ type: 'next' }));
btnPrev.addEventListener('click', () => vscode.postMessage({ type: 'previous' }));

btnFav.addEventListener('click', () => {
    if (!currentTrack) { return; }
    vscode.postMessage({
        type: 'toggleFavorite',
        track: currentTrack,
        artist: currentArtist,
        album: currentAlbum,
        artUrl: currentArtUrl,
    });
});

let volumeTimeout: ReturnType<typeof setTimeout> | null = null;
volumeSlider.addEventListener('input', () => {
    if (volumeTimeout) { clearTimeout(volumeTimeout); }
    volumeTimeout = setTimeout(() => {
        vscode.postMessage({ type: 'volume', value: parseInt(volumeSlider.value, 10) });
    }, 150);
});

progressTrack.addEventListener('click', (e) => {
    const rect = progressTrack.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const parts = (timeTotalEl.textContent || '0:00').split(':');
    const totalSec = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    if (totalSec > 0) {
        vscode.postMessage({ type: 'seek', value: Math.round(pct * totalSec) });
    }
});

// ── Search ──────────────────────────────────────────────────────────────────

function doSearch(): void {
    const query = searchInput.value.trim();
    if (!query) { return; }

    searchStatus.textContent = `Playing "${query}"...`;
    searchStatus.className = 'search-playing';
    vscode.postMessage({ type: 'search', query });

    recentSearches = recentSearches.filter(s => s !== query);
    recentSearches.unshift(query);
    if (recentSearches.length > 10) { recentSearches = recentSearches.slice(0, 10); }
    vscode.setState({ recentSearches });
    renderRecentSearches();

    setTimeout(() => {
        searchStatus.textContent = '';
        switchTab('playing');
    }, 2000);
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        hideAutocomplete();
        doSearch();
    }
    if (e.key === 'Escape') { hideAutocomplete(); }
});

// Autocomplete as user types
searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { hideAutocomplete(); renderRecentSearches(); return; }
    showAutocomplete(q);
});

searchInput.addEventListener('focus', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length >= 2) { showAutocomplete(q); }
    else { renderRecentSearches(); }
});

function showAutocomplete(query: string): void {
    // Search through favorites, history, and recent searches
    const results: Array<{ track: string; artist: string; artUrl?: string; source: string }> = [];
    const seen = new Set<string>();

    const addResult = (track: string, artist: string, artUrl?: string, source?: string) => {
        const key = `${track.toLowerCase()}::${artist.toLowerCase()}`;
        if (seen.has(key)) { return; }
        seen.add(key);
        results.push({ track, artist, artUrl, source: source || '' });
    };

    // Search favorites
    for (const f of cachedFavorites) {
        if (f.track.toLowerCase().includes(query) || f.artist.toLowerCase().includes(query)) {
            addResult(f.track, f.artist, f.artUrl, 'fav');
        }
    }

    // Search history
    for (const h of cachedHistory) {
        if (h.track.toLowerCase().includes(query) || h.artist.toLowerCase().includes(query)) {
            addResult(h.track, h.artist, h.artUrl, 'history');
        }
    }

    // Search recent searches
    for (const s of recentSearches) {
        if (s.toLowerCase().includes(query)) {
            addResult(s, '', undefined, 'search');
        }
    }

    if (results.length === 0) {
        recentSearchesEl.innerHTML = '<div class="hint" style="padding:8px 0;">No matches — hit enter to search Spotify</div>';
        return;
    }

    let html = '<div class="section-label">Suggestions</div>';
    results.slice(0, 8).forEach(r => {
        const icon = r.source === 'fav' ? '&#x2665;' : r.source === 'history' ? '&#x1F552;' : '&#x1F50D;';
        if (r.artist) {
            html += `<div class="list-item search-suggestion" data-track="${esc(r.track)}" data-artist="${esc(r.artist)}">
                ${r.artUrl ? `<div class="item-art-wrap"><img class="item-art" src="${esc(r.artUrl)}" /></div>` : `<span class="item-icon">${icon}</span>`}
                <div class="item-info">
                    <div class="item-title">${highlightMatch(r.track, query)}</div>
                    <div class="item-subtitle">${highlightMatch(r.artist, query)}</div>
                </div>
            </div>`;
        } else {
            html += `<div class="list-item search-suggestion" data-query="${esc(r.track)}">
                <span class="item-icon">${icon}</span>
                <span class="item-text">${highlightMatch(r.track, query)}</span>
            </div>`;
        }
    });
    recentSearchesEl.innerHTML = html;

    recentSearchesEl.querySelectorAll('.search-suggestion').forEach(el => {
        el.addEventListener('click', () => {
            const d = (el as HTMLElement).dataset;
            if (d.artist) {
                searchInput.value = `${d.artist} ${d.track}`;
            } else if (d.query) {
                searchInput.value = d.query;
            }
            hideAutocomplete();
            doSearch();
        });
    });
}

function hideAutocomplete(): void {
    // Don't clear — let renderRecentSearches handle the content
}

function highlightMatch(text: string, query: string): string {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) { return esc(text); }
    return esc(text.substring(0, idx)) +
        '<b>' + esc(text.substring(idx, idx + query.length)) + '</b>' +
        esc(text.substring(idx + query.length));
}

function renderRecentSearches(): void {
    if (recentSearches.length === 0) {
        recentSearchesEl.innerHTML = '<div class="hint" style="padding:16px 0;">Type a song or artist name to play the top result</div>';
        return;
    }
    let html = '<div class="section-label">Recent searches</div>';
    recentSearches.forEach(q => {
        html += `<div class="list-item search-item" data-query="${esc(q)}">
            <span class="item-icon">&#x1F50D;</span>
            <span class="item-text">${esc(q)}</span>
        </div>`;
    });
    recentSearchesEl.innerHTML = html;
    recentSearchesEl.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', () => {
            searchInput.value = (el as HTMLElement).dataset.query || '';
            doSearch();
        });
    });
}

// ── Library: Favorites ──────────────────────────────────────────────────────

interface FavEntry { track: string; artist: string; album: string; artUrl: string; }

function renderFavorites(entries: FavEntry[]): void {
    if (entries.length === 0) {
        favoritesList.innerHTML = '';
        favoritesEmpty.style.display = 'block';
        return;
    }
    favoritesEmpty.style.display = 'none';
    let html = '<div class="tile-scroll">';
    entries.forEach(f => {
        html += `<div class="tile fav-tile" data-track="${esc(f.track)}" data-artist="${esc(f.artist)}">
            <div class="tile-art">
                ${f.artUrl
                    ? `<img src="${esc(f.artUrl)}" alt="" />`
                    : `<div class="tile-art-placeholder">&#9835;</div>`}
            </div>
            <div class="tile-title">${esc(f.track)}</div>
            <div class="tile-subtitle">${esc(f.artist)}</div>
            <button class="tile-remove" data-track="${esc(f.track)}" data-artist="${esc(f.artist)}">&#x2715;</button>
        </div>`;
    });
    html += '</div>';
    favoritesList.innerHTML = html;

    favoritesList.querySelectorAll('.fav-tile').forEach(el => {
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.tile-remove')) { return; }
            const d = (el as HTMLElement).dataset;
            vscode.postMessage({ type: 'playFavorite', track: d.track, artist: d.artist });
            switchTab('playing');
        });
    });
    favoritesList.querySelectorAll('.tile-remove').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const d = (el as HTMLElement).dataset;
            vscode.postMessage({ type: 'removeFavorite', track: d.track, artist: d.artist });
        });
    });
}

// ── Library: Playlists ──────────────────────────────────────────────────────

interface PlaylistEntry { name: string; uri: string; artUrl?: string; }

addPlaylistBtn.addEventListener('click', () => {
    const visible = addPlaylistForm.style.display !== 'none';
    addPlaylistForm.style.display = visible ? 'none' : 'flex';
    if (!visible) { playlistInput.focus(); }
});

playlistSaveBtn.addEventListener('click', () => {
    const val = playlistInput.value.trim();
    if (val) {
        vscode.postMessage({ type: 'addPlaylist', input: val });
        playlistInput.value = '';
        addPlaylistForm.style.display = 'none';
    }
});

playlistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { playlistSaveBtn.click(); }
    if (e.key === 'Escape') { addPlaylistForm.style.display = 'none'; }
});

function renderPlaylists(entries: PlaylistEntry[]): void {
    if (entries.length === 0) {
        playlistsList.innerHTML = '<div class="lib-empty">Add Spotify playlists or albums to quick-play</div>';
        return;
    }
    let html = '<div class="playlist-grid">';
    entries.forEach(p => {
        html += `<div class="playlist-card" data-uri="${esc(p.uri)}">
            <span class="playlist-card-icon">&#x266B;</span>
            <span class="playlist-card-text">${esc(p.name)}</span>
            <button class="playlist-card-remove" data-uri="${esc(p.uri)}">&#x2715;</button>
        </div>`;
    });
    html += '</div>';
    playlistsList.innerHTML = html;

    playlistsList.querySelectorAll('.playlist-card').forEach(el => {
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.playlist-card-remove')) { return; }
            vscode.postMessage({ type: 'playPlaylist', uri: (el as HTMLElement).dataset.uri });
            switchTab('playing');
        });
    });
    playlistsList.querySelectorAll('.playlist-card-remove').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'removePlaylist', uri: (el as HTMLElement).dataset.uri });
        });
    });
}

// ── Library: Quick Picks ────────────────────────────────────────────────────

function renderQuickPicks(entries: PlaylistEntry[]): void {
    let html = '<div class="quick-picks-grid">';
    entries.forEach(p => {
        html += `<button class="quick-pick" data-uri="${esc(p.uri)}">${esc(p.name)}</button>`;
    });
    html += '</div>';
    quickPicksList.innerHTML = html;

    quickPicksList.querySelectorAll('.quick-pick').forEach(el => {
        el.addEventListener('click', () => {
            vscode.postMessage({ type: 'playPlaylist', uri: (el as HTMLElement).dataset.uri });
            switchTab('playing');
        });
    });
}

// ── Library: History ────────────────────────────────────────────────────────

interface HistEntry { track: string; artist: string; album: string; artUrl: string; app: string; timestamp: number; }

function renderHistory(entries: HistEntry[]): void {
    if (entries.length === 0) {
        historyList.innerHTML = '';
        historyEmpty.style.display = '';
        return;
    }
    historyEmpty.style.display = 'none';
    let html = '<div class="tile-scroll">';
    entries.slice(0, 20).forEach(h => {
        html += `<div class="tile history-tile" data-track="${esc(h.track)}" data-artist="${esc(h.artist)}">
            <div class="tile-art">
                ${h.artUrl
                    ? `<img src="${esc(h.artUrl)}" alt="" />`
                    : `<div class="tile-art-placeholder">&#9835;</div>`}
            </div>
            <div class="tile-title">${esc(h.track)}</div>
            <div class="tile-subtitle">${esc(h.artist)}</div>
        </div>`;
    });
    html += '</div>';
    historyList.innerHTML = html;

    historyList.querySelectorAll('.history-tile').forEach(el => {
        el.addEventListener('click', () => {
            const d = (el as HTMLElement).dataset;
            vscode.postMessage({ type: 'playHistoryItem', track: d.track, artist: d.artist });
            switchTab('playing');
        });
    });
}

clearHistoryBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearHistory' });
});

// ── Ambient Visualizer ──────────────────────────────────────────────────────

const vizCanvas = document.getElementById('visualizer') as HTMLCanvasElement;
const vizCtx = vizCanvas.getContext('2d')!;
const vizFrontCanvas = document.getElementById('visualizer-front') as HTMLCanvasElement;
const vizFrontCtx = vizFrontCanvas.getContext('2d')!;
const vizCycleBtn = document.getElementById('viz-cycle')!;
const vizOpacitySlider = document.getElementById('viz-opacity') as HTMLInputElement;
let vizAnimId = 0;
let vizPlaying = false;
let vizTime = 0;

// Visualization modes
const VIZ_MODES = ['spectrum', 'wave', 'pulse', 'radial', 'sinewave', 'orbit', 'glow', 'fractal', 'progressbar'] as const;
type VizMode = typeof VIZ_MODES[number];
let vizMode: VizMode = (savedState.vizMode as VizMode) || 'spectrum';

vizCycleBtn.addEventListener('click', () => {
    const idx = VIZ_MODES.indexOf(vizMode);
    vizMode = VIZ_MODES[(idx + 1) % VIZ_MODES.length];
    vscode.setState({ ...vscode.getState() as any, vizMode });
});

// Glass transparency control — 0 = fully clear glass, 100 = opaque
// slider right = more transparent, left = more opaque
let glassOpacity = savedState.glassOpacity ?? 35;
vizOpacitySlider.value = String(100 - glassOpacity);

function applyGlassOpacity(): void {
    const alpha = glassOpacity / 100;
    nowPlayingEl.style.background = `rgba(20, 20, 35, ${alpha})`;
    // Also scale blur and border with opacity
    const blur = Math.round(alpha * 16);
    nowPlayingEl.style.backdropFilter = `blur(${blur}px) saturate(${1 + alpha * 0.3})`;
    (nowPlayingEl.style as any).webkitBackdropFilter = `blur(${blur}px) saturate(${1 + alpha * 0.3})`;
    nowPlayingEl.style.borderColor = `rgba(255, 255, 255, ${alpha * 0.15})`;
}
applyGlassOpacity();

vizOpacitySlider.addEventListener('input', () => {
    glassOpacity = 100 - parseInt(vizOpacitySlider.value, 10);
    applyGlassOpacity();
    vscode.setState({ ...vscode.getState() as any, glassOpacity });
});

// Frequency bands — filled from mic analyser or simulated
const NUM_BANDS = 64;
const bands = new Float32Array(NUM_BANDS);
const bandTargets = new Float32Array(NUM_BANDS);
const bandVelocities = new Float32Array(NUM_BANDS);

let realAudioMode = false;
let silentFrames = 0;

// Album-art-derived color palette (HSL + RGB)
interface VizColor { r: number; g: number; b: number; h: number; s: number; l: number; }
let vizPalette: VizColor[] = [
    { r: 138, g: 43, b: 226, h: 270, s: 80, l: 55 },  // purple (default)
    { r: 0, g: 191, b: 255, h: 195, s: 100, l: 50 },   // cyan
    { r: 255, g: 20, b: 147, h: 330, s: 100, l: 54 },   // pink
    { r: 0, g: 200, b: 83, h: 145, s: 100, l: 39 },     // green
];

/** Get color from palette by integer index (no interpolation) */
function palHsl(idx: number, alpha: number, hueShift?: number): string {
    const c = vizPalette[idx % vizPalette.length];
    const h = ((c.h + (hueShift || 0)) % 360 + 360) % 360;
    const s = Math.min(100, c.s + 10);
    const l = Math.min(85, c.l * 1.25);
    return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

/** Smoothly interpolate between palette colors using a 0-1 float position */
function palLerp(t: number, alpha: number, hueShift?: number): string {
    const len = vizPalette.length;
    if (len === 0) { return `hsla(0, 0%, 50%, ${alpha})`; }
    const pos = ((t % 1) + 1) % 1 * len;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = vizPalette[i % len];
    const b = vizPalette[(i + 1) % len];
    const h = lerpAngle(a.h, b.h, f) + (hueShift || 0);
    const s = Math.min(100, a.s + (b.s - a.s) * f + 10); // boost saturation
    const l = Math.min(85, (a.l + (b.l - a.l) * f) * 1.25); // 25% brighter
    return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${alpha})`;
}

/** Apply album-derived accent color to UI elements */
function applyAlbumAccentColor(palette: VizColor[]): void {
    if (palette.length === 0) { return; }

    // Pick the most vibrant color (palette is already sorted by saturation)
    let best = palette[0];

    // Check if it's readable on dark background (luminance > 0.2)
    // Relative luminance formula
    const luminance = (0.299 * best.r + 0.587 * best.g + 0.114 * best.b) / 255;

    let accentColor: string;
    let accentDim: string;

    if (luminance < 0.25) {
        // Too dark to read — lighten it
        const boostedL = Math.min(75, best.l + 30);
        accentColor = `hsl(${best.h}, ${Math.min(100, best.s + 10)}%, ${boostedL}%)`;
        accentDim = `hsl(${best.h}, ${best.s}%, ${boostedL - 10}%)`;
    } else {
        accentColor = `hsl(${best.h}, ${Math.min(100, best.s + 10)}%, ${Math.min(80, best.l * 1.1)}%)`;
        accentDim = `hsl(${best.h}, ${best.s}%, ${Math.max(30, best.l - 10)}%)`;
    }

    // Update CSS custom properties
    document.documentElement.style.setProperty('--accent', accentColor);
    document.documentElement.style.setProperty('--accent-dim', accentDim);

    // Update elements that use inline styles or don't pick up CSS vars
    const progressFillEl = document.getElementById('progress-fill');
    if (progressFillEl) { progressFillEl.style.background = accentColor; }

    const btnPlayEl = document.getElementById('btn-play');
    if (btnPlayEl) { btnPlayEl.style.background = accentColor; }

    const volumeThumb = document.getElementById('volume-slider');
    if (volumeThumb) {
        // Update the thumb color via a style tag (can't set pseudo-element inline)
        let styleTag = document.getElementById('accent-style');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'accent-style';
            document.head.appendChild(styleTag);
        }
        styleTag.textContent = `
            #volume-slider::-webkit-slider-thumb { background: ${accentColor} !important; }
            #volume-slider::-moz-range-thumb { background: ${accentColor} !important; }
            #btn-play { background: ${accentColor} !important; }
            #btn-play:hover { background: ${accentDim} !important; }
            #progress-fill { background: ${accentColor} !important; }
            #artist-name { color: ${accentColor} !important; }
            .tab.active { color: ${accentColor} !important; border-bottom-color: ${accentColor} !important; }
            .fav-btn.fav-active { color: ${accentColor} !important; }
        `;
    }
}

/** Lerp between two angles (handles wraparound at 360) */
function lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    if (diff > 180) { diff -= 360; }
    if (diff < -180) { diff += 360; }
    return a + diff * t;
}

// Audio setup prompt
function showAudioPrompt(missing: string[], canInstall?: boolean, message?: string): void {
    const existing = document.getElementById('audio-prompt');
    if (existing) { return; }
    const label = message || (missing.length === 1 && missing[0] === 'blackhole'
        ? 'Enable real audio visualization?'
        : `Real audio viz needs: ${missing.join(', ')}`);
    const prompt = document.createElement('div');
    prompt.id = 'audio-prompt';
    const installBtn = canInstall
        ? '<button id="audio-install-btn" class="audio-prompt-btn">Set up</button>'
        : '';
    prompt.innerHTML = `
        <span class="audio-prompt-text">${label}</span>
        ${installBtn}
        <button id="audio-dismiss-btn" class="audio-prompt-dismiss">&times;</button>
    `;
    const tabPlaying = document.getElementById('tab-playing')!;
    tabPlaying.appendChild(prompt);

    const installEl = document.getElementById('audio-install-btn');
    if (installEl) {
        installEl.addEventListener('click', () => {
            vscode.postMessage({ type: 'installBlackHole' });
            prompt.querySelector('.audio-prompt-text')!.textContent = 'Setting up...';
            (installEl as HTMLButtonElement).disabled = true;
        });
    }
    document.getElementById('audio-dismiss-btn')!.addEventListener('click', () => {
        prompt.remove();
    });
}

function hideAudioPrompt(): void {
    document.getElementById('audio-prompt')?.remove();
}

function handleInstallStatus(msg: any): void {
    const prompt = document.getElementById('audio-prompt');
    if (!prompt) { return; }
    const textEl = prompt.querySelector('.audio-prompt-text')!;

    if (msg.status === 'copy') {
        // Show copyable command
        textEl.textContent = msg.message;
        const btn = document.getElementById('audio-install-btn');
        if (btn) { btn.remove(); }
        // Add command box
        const cmdBox = document.createElement('code');
        cmdBox.className = 'audio-cmd';
        cmdBox.textContent = msg.command;
        cmdBox.title = 'Click to copy';
        cmdBox.addEventListener('click', () => {
            navigator.clipboard.writeText(msg.command).then(() => {
                cmdBox.textContent = 'Copied!';
                setTimeout(() => { cmdBox.textContent = msg.command; }, 1500);
            });
        });
        prompt.insertBefore(cmdBox, prompt.querySelector('.audio-prompt-dismiss'));
    } else if (msg.status === 'success') {
        textEl.textContent = msg.message;
        // Remove command box and install button if present
        prompt.querySelector('.audio-cmd')?.remove();
        const btn = document.getElementById('audio-install-btn');
        if (btn) { btn.remove(); }
        setTimeout(() => prompt.remove(), 15000);
    } else if (msg.status === 'error') {
        textEl.textContent = msg.message;
        const installBtn = document.getElementById('audio-install-btn') as HTMLButtonElement | null;
        if (installBtn) { installBtn.disabled = false; }
    } else {
        textEl.textContent = msg.message;
    }
}

// ── Track-seeded simulation driven by playback position ─────────────────────
// Each track gets a unique "energy profile" derived from its name hash.
// The animation is tied to the actual playback position so it pauses/resumes
// with the music and looks different for every song.

let trackSeed = 0;
let trackPosition = 0;    // seconds — updated from now playing polling
let trackDuration = 0;
// Per-track characteristics derived from seed
let trackBPM = 120;       // fake BPM (range 80-160)
let trackEnergy = 0.7;    // overall energy level (0-1)
let trackBassWeight = 0.5;
let trackBrightness = 0.5;

function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

function seededRandom(seed: number): number {
    const x = Math.sin(seed) * 43758.5453;
    return x - Math.floor(x);
}

// Perlin-like smooth noise
function smoothNoise(t: number, seed: number): number {
    const i = Math.floor(t);
    const f = t - i;
    const smooth = f * f * (3 - 2 * f); // smoothstep
    const a = seededRandom(seed + i);
    const b = seededRandom(seed + i + 1);
    return a + (b - a) * smooth;
}

function resizeViz(): void {
    const tab = document.getElementById('tab-playing')!;
    const rect = tab.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    vizCanvas.width = rect.width * dpr;
    vizCanvas.height = rect.height * dpr;
    vizCanvas.style.width = rect.width + 'px';
    vizCanvas.style.height = rect.height + 'px';
    vizFrontCanvas.width = rect.width * dpr;
    vizFrontCanvas.height = rect.height * dpr;
    vizFrontCanvas.style.width = rect.width + 'px';
    vizFrontCanvas.style.height = rect.height + 'px';
}

function updateBands(): void {
    // If receiving real audio data, bands are updated via message handler — skip simulation
    if (realAudioMode) { return; }

    if (!vizPlaying) {
        // Fade out gently
        for (let i = 0; i < NUM_BANDS; i++) {
            bandTargets[i] = 0.01;
            bands[i] += (bandTargets[i] - bands[i]) * 0.05;
        }
        return;
    }

    // Use track position as the primary time driver so viz syncs with playback
    const beatPeriod = 60 / trackBPM;
    const beatPhase = (trackPosition % beatPeriod) / beatPeriod; // 0-1 within a beat
    const barPhase = (trackPosition % (beatPeriod * 4)) / (beatPeriod * 4); // 0-1 within a 4-beat bar

    // Generate "energy" at current position (varies through the song)
    const songProgress = trackDuration > 0 ? trackPosition / trackDuration : 0;
    // Songs typically build up, peak around 60-70%, and wind down
    const structureEnergy = Math.sin(songProgress * Math.PI) * 0.3 +
        smoothNoise(songProgress * 8, trackSeed + 100) * 0.4 +
        trackEnergy * 0.3;

    // Beat pulse — sharp attack, quick decay
    const beatPulse = Math.pow(1 - beatPhase, 3) * 0.5;

    for (let i = 0; i < NUM_BANDS; i++) {
        const freqRatio = i / NUM_BANDS; // 0=bass, 1=treble

        // Base level from smooth noise, different per frequency band
        const noiseT = trackPosition * (1.5 + freqRatio * 2) + i * 0.73;
        const noiseVal = smoothNoise(noiseT, trackSeed + i * 17);

        // Bass bands get more beat pulse, treble gets more noise variation
        const bassInfluence = Math.pow(1 - freqRatio, 2) * trackBassWeight;
        const trebleInfluence = Math.pow(freqRatio, 1.5) * trackBrightness;

        // Combine: noise base + beat pulse + structural energy
        let target = noiseVal * (0.3 + structureEnergy * 0.5) +
            beatPulse * bassInfluence * 1.2 +
            trebleInfluence * smoothNoise(trackPosition * 4 + i * 0.5, trackSeed + i * 31) * 0.6;

        // Bar-level variation (every 4 beats, some bands spike)
        const barNoise = smoothNoise(barPhase * 3 + i * 0.2, trackSeed + i * 53);
        target += barNoise * 0.15 * structureEnergy;

        // Clamp and apply
        bandTargets[i] = Math.max(0.02, Math.min(1, target * trackEnergy));

        // Spring physics for smooth movement
        const spring = 0.15 + beatPulse * 0.1;
        const damping = 0.72;
        bandVelocities[i] += (bandTargets[i] - bands[i]) * spring;
        bandVelocities[i] *= damping;
        bands[i] += bandVelocities[i];
        bands[i] = Math.max(0, Math.min(1, bands[i]));
    }
}

// Color helpers
function hsl(h: number, s: number, l: number, a: number): string {
    return `hsla(${h % 360}, ${s}%, ${l}%, ${a})`;
}

// ── Spectrum mode: gradient bars from center ────────────────────────────────
function drawSpectrum(w: number, h: number, dpr: number): void {
    const barWidth = w / NUM_BANDS;
    const centerY = h / 2;
    const maxH = h * 0.7;

    for (let i = 0; i < NUM_BANDS; i++) {
        const val = bands[i];
        const barH = val * maxH;
        const x = i * barWidth;
        const t = i / NUM_BANDS;
        const alpha = 0.2 + val * 0.6;
        const hueShift = Math.sin(vizTime + i * 0.1) * 15;

        // Up bar
        vizCtx.fillStyle = palLerp(t, alpha, hueShift);
        vizCtx.fillRect(x, centerY - barH, barWidth - 1 * dpr, barH);

        // Mirrored down bar (dimmer)
        vizCtx.fillStyle = palLerp(t, alpha * 0.5, hueShift);
        vizCtx.fillRect(x, centerY, barWidth - 1 * dpr, barH * 0.6);
    }
}

// ── Wave mode: layered flowing curves ───────────────────────────────────────
function drawWave(w: number, h: number, dpr: number): void {
    const centerY = h / 2;
    // Each layer samples different frequency ranges
    const layerParams = [
        { amp: 0.6, speed: 1.8, freq: 60, bandLo: 0, bandHi: 16 },       // bass
        { amp: 0.5, speed: 2.5, freq: 45, bandLo: 8, bandHi: 32 },       // low-mid
        { amp: 0.4, speed: 1.4, freq: 80, bandLo: 24, bandHi: 48 },      // mid
        { amp: 0.3, speed: 3.2, freq: 35, bandLo: 40, bandHi: 64 },      // treble
    ];

    for (let li = 0; li < layerParams.length; li++) {
        const layer = layerParams[li];
        // Average energy for this layer's frequency range
        let layerEnergy = 0;
        for (let b = layer.bandLo; b < layer.bandHi && b < NUM_BANDS; b++) {
            layerEnergy += bands[b];
        }
        layerEnergy /= (layer.bandHi - layer.bandLo);

        // Build points for smooth curve
        const points: Array<{x: number; y: number}> = [];
        for (let x = 0; x <= w; x += Math.max(2, w / NUM_BANDS)) {
            const bandIdx = Math.floor((x / w) * NUM_BANDS);
            const val = bands[Math.min(bandIdx, NUM_BANDS - 1)];
            const y = centerY +
                Math.sin(x / (layer.freq * dpr) + vizTime * layer.speed) * val * h * layer.amp +
                Math.sin(x / (layer.freq * 2.3 * dpr) - vizTime * layer.speed * 0.7) * val * h * layer.amp * 0.4;
            points.push({ x, y });
        }

        // Draw with smooth quadratic bezier curves between points
        vizCtx.beginPath();
        vizCtx.moveTo(0, centerY);
        if (points.length > 1) {
            vizCtx.lineTo(points[0].x, points[0].y);
            for (let p = 0; p < points.length - 1; p++) {
                const midX = (points[p].x + points[p + 1].x) / 2;
                const midY = (points[p].y + points[p + 1].y) / 2;
                vizCtx.quadraticCurveTo(points[p].x, points[p].y, midX, midY);
            }
            vizCtx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        }
        vizCtx.lineTo(w, h);
        vizCtx.lineTo(0, h);
        vizCtx.closePath();

        const alpha = vizPlaying ? 0.15 + layerEnergy * 0.35 : 0.06;
        const layerT = (li / layerParams.length + vizTime * 0.02) % 1;
        const grad = vizCtx.createLinearGradient(0, centerY - h * 0.3, 0, h);
        grad.addColorStop(0, palLerp(layerT, alpha));
        grad.addColorStop(1, palLerp(layerT + 0.15, alpha * 0.3));
        vizCtx.fillStyle = grad;
        vizCtx.fill();
    }
}

// ── Pulse mode: radial rings expanding from center ──────────────────────────
const pulses: Array<{ birth: number; val: number; palIdx: number }> = [];
let lastPulseBassAvg = 0;

function drawPulse(w: number, h: number, _dpr: number): void {
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.max(w, h) * 0.8;

    // Bass energy drives pulse spawning (bass = beats)
    const bassAvg = (bands[0] + bands[1] + bands[2] + bands[3] + bands[4] + bands[5]) / 6;
    const midAvg = (bands[20] + bands[21] + bands[22] + bands[23]) / 4;
    const hiAvg = (bands[45] + bands[46] + bands[47] + bands[48]) / 4;
    const overall = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;

    // Detect transient (bass spike above recent average) — this catches actual beats
    const bassRise = bassAvg - lastPulseBassAvg;
    lastPulseBassAvg += (bassAvg - lastPulseBassAvg) * 0.15;

    if (vizPlaying && bassRise > 0.08 && pulses.length < 12) {
        pulses.push({ birth: vizTime, val: bassAvg, palIdx: Math.floor(Math.random() * vizPalette.length) });
    }
    // Also spawn smaller pulses for mid/treble hits
    if (vizPlaying && Math.random() < midAvg * 0.15) {
        pulses.push({ birth: vizTime, val: midAvg * 0.6, palIdx: Math.floor(Math.random() * vizPalette.length) });
    }

    // Draw and age pulses
    for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const age = vizTime - p.birth;
        const life = 2.5 + p.val * 2;
        if (age > life) { pulses.splice(i, 1); continue; }

        const progress = age / life;
        const r = progress * maxR * (0.5 + p.val * 0.5);
        const alpha = (1 - progress) * (0.15 + p.val * 0.5);
        const lineW = (1 - progress) * (4 + p.val * 8) + 1;

        vizCtx.beginPath();
        vizCtx.arc(cx, cy, r, 0, Math.PI * 2);
        vizCtx.strokeStyle = palHsl(p.palIdx, alpha, age * 25);
        vizCtx.lineWidth = lineW;
        vizCtx.stroke();
    }

    // Center glow — pulsates with bass
    const glowR = 20 + bassAvg * 120 + overall * 40;
    const grad = vizCtx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    grad.addColorStop(0, palHsl(0, vizPlaying ? 0.2 + bassAvg * 0.4 : 0.05, vizTime * 20));
    grad.addColorStop(0.5, palHsl(1, vizPlaying ? 0.1 + midAvg * 0.2 : 0.02, vizTime * 15));
    grad.addColorStop(1, 'transparent');
    vizCtx.fillStyle = grad;
    vizCtx.fillRect(0, 0, w, h);
}

// ── Radial mode: spinning circle with frequency bars radiating outward ───────

let radialRotation = 0;

function drawRadial(w: number, h: number, _dpr: number): void {
    const cx = w / 2;
    const cy = h / 2;
    const innerR = Math.min(w, h) * 0.12;
    const maxBarLen = Math.min(w, h) * 0.35;

    const overall = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;

    // Spin: gentle base + energy boost (quiet ≈ slow, loud ≈ faster)
    const spinSpeed = 0.002 + overall * 0.013;
    radialRotation += vizPlaying ? spinSpeed : 0.0005;

    // Draw bars around the circle — outward only
    for (let i = 0; i < NUM_BANDS; i++) {
        const angle = (i / NUM_BANDS) * Math.PI * 2 + radialRotation;
        const val = bands[i];
        const barLen = val * maxBarLen;
        const t = i / NUM_BANDS;

        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        const gap = 3;
        const x1 = cx + cosA * (innerR + gap);
        const y1 = cy + sinA * (innerR + gap);
        const x2 = cx + cosA * (innerR + gap + barLen);
        const y2 = cy + sinA * (innerR + gap + barLen);

        const alpha = 0.3 + val * 0.6;
        const lineW = 2 + val * 3;

        vizCtx.beginPath();
        vizCtx.moveTo(x1, y1);
        vizCtx.lineTo(x2, y2);
        vizCtx.strokeStyle = palLerp(t, alpha);
        vizCtx.lineWidth = lineW;
        vizCtx.lineCap = 'round';
        vizCtx.stroke();
    }

    // Inner circle — solid black background
    vizCtx.beginPath();
    vizCtx.arc(cx, cy, innerR, 0, Math.PI * 2);
    vizCtx.fillStyle = '#000';
    vizCtx.fill();

    // Flat sine wave through the center of the circle, clipped to the circle.
    // The sine moves on its own; spectrum bars extend up/down from the wave line.
    vizCtx.save();
    vizCtx.beginPath();
    vizCtx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
    vizCtx.clip();

    const sineAmp = innerR * 0.25;
    const specAmp = innerR * 0.6;
    const sineSpeed = 2.0;
    const sineFreq = 3;
    const steps = NUM_BANDS;
    const xStart = cx - innerR;
    const xEnd = cx + innerR;
    const xRange = xEnd - xStart;

    // Draw spectrum bars extending from the sine wave
    for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const x = xStart + t * xRange;
        const bandVal = bands[i];

        // Sine wave Y position at this X
        const sineY = cy + Math.sin(t * Math.PI * sineFreq * 2 + vizTime * sineSpeed) * sineAmp;

        // Bar extends up and down from the sine wave
        const barH = bandVal * specAmp;
        const barW = Math.max(1.5, xRange / steps - 1);
        const alpha = 0.4 + bandVal * 0.5;

        // Up bar (from sine line upward)
        vizCtx.fillStyle = palLerp(t, alpha);
        vizCtx.fillRect(x, sineY - barH, barW, barH);

        // Down bar (from sine line downward, dimmer)
        vizCtx.fillStyle = palLerp(t, alpha * 0.4);
        vizCtx.fillRect(x, sineY, barW, barH * 0.5);
    }

    // Draw the sine wave line itself on top
    vizCtx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = xStart + t * xRange;
        const sineY = cy + Math.sin(t * Math.PI * sineFreq * 2 + vizTime * sineSpeed) * sineAmp;
        if (i === 0) { vizCtx.moveTo(x, sineY); }
        else { vizCtx.lineTo(x, sineY); }
    }
    vizCtx.strokeStyle = `rgba(255, 255, 255, ${0.3 + overall * 0.3})`;
    vizCtx.lineWidth = 1.5;
    vizCtx.stroke();

    vizCtx.restore();

    // Circle outline
    vizCtx.beginPath();
    vizCtx.arc(cx, cy, innerR, 0, Math.PI * 2);
    vizCtx.strokeStyle = `rgba(255, 255, 255, ${0.08 + overall * 0.08})`;
    vizCtx.lineWidth = 1;
    vizCtx.stroke();
}

// ── Sine Wave mode: full-width sine with spectrum bars riding on top ─────────

function drawSineWave(w: number, h: number, _dpr: number): void {
    const centerY = h / 2;
    const sineAmp = h * 0.18;
    const specAmp = h * 0.35;
    const sineSpeed = 1.8;
    const sineFreq = 2.5;
    const steps = NUM_BANDS;
    const barW = Math.max(2, w / steps - 1);

    // Draw spectrum bars extending from the sine wave
    for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const x = t * w;
        const bandVal = bands[i];

        // Sine wave Y at this position
        const sineY = centerY + Math.sin(t * Math.PI * sineFreq * 2 + vizTime * sineSpeed) * sineAmp;

        const barH = bandVal * specAmp;
        const alpha = 0.3 + bandVal * 0.6;

        // Up bar
        vizCtx.fillStyle = palLerp(t, alpha);
        vizCtx.fillRect(x, sineY - barH, barW, barH);

        // Down bar (mirrored, dimmer)
        vizCtx.fillStyle = palLerp(t, alpha * 0.4);
        vizCtx.fillRect(x, sineY, barW, barH * 0.5);
    }

    // Draw the sine wave line on top
    const overall = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;
    vizCtx.beginPath();
    for (let i = 0; i <= w; i += 2) {
        const t = i / w;
        const sineY = centerY + Math.sin(t * Math.PI * sineFreq * 2 + vizTime * sineSpeed) * sineAmp;
        if (i === 0) { vizCtx.moveTo(i, sineY); }
        else { vizCtx.lineTo(i, sineY); }
    }
    vizCtx.strokeStyle = `rgba(255, 255, 255, ${0.2 + overall * 0.4})`;
    vizCtx.lineWidth = 2;
    vizCtx.stroke();

    // Subtle glow along the wave
    vizCtx.beginPath();
    for (let i = 0; i <= w; i += 2) {
        const t = i / w;
        const sineY = centerY + Math.sin(t * Math.PI * sineFreq * 2 + vizTime * sineSpeed) * sineAmp;
        if (i === 0) { vizCtx.moveTo(i, sineY); }
        else { vizCtx.lineTo(i, sineY); }
    }
    vizCtx.strokeStyle = palLerp(vizTime * 0.1 % 1, 0.1 + overall * 0.15);
    vizCtx.lineWidth = 6;
    vizCtx.stroke();
}

// ── Orbit mode: circular orbits around the progress bar ──────────────────────

const orbitPhases = [0, 0, 0, 0];

// Comet particles for orbit mode
interface CometParticle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; color: string; }
const cometParticles: CometParticle[] = [];

function drawHelix(w: number, h: number, _dpr: number): void {
    // Center the main wave on the green progress bar line
    const dpr = window.devicePixelRatio || 1;
    const tabRect = document.getElementById('tab-playing')!.getBoundingClientRect();
    const progRect = progressTrack.getBoundingClientRect();
    // Progress bar center Y relative to the canvas (in canvas pixels)
    const progCenterY = (progRect.top + progRect.height / 2 - tabRect.top) * dpr;
    const centerY = progCenterY > 0 && progCenterY < h ? progCenterY : h / 2;

    const overall = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;
    const speed = 1.2;

    const specAmp = h * 0.18;
    const barW = Math.max(3, w / NUM_BANDS);

    // Sun position tracks the song progress along the progress bar
    const progLeft = (progRect.left - tabRect.left) * dpr;
    const progWidth = progRect.width * dpr;
    const songProgress = trackDuration > 0 ? Math.min(1, trackPosition / trackDuration) : 0;
    const orbX = progLeft + songProgress * progWidth;

    const mainFreq = 1.2;

    // Available space above and below the progress bar
    const spaceAbove = centerY;
    const spaceBelow = h - centerY;
    const maxReach = Math.min(spaceAbove, spaceBelow) * 0.85;

    // Main "wave" is just a straight line on the progress bar — no sine
    const mainAmp = 0;

    const getMainY = (_px: number): number => {
        return centerY;
    };

    // Companions orbit around the main wave at fixed distances
    // Distances scaled so outermost stays within maxReach
    // eccentricity: 0 = circle, higher = flatter ellipse. Bass = wide, treble = tight.
    const companions = [
        { bandLo: 0, bandHi: 12, orbitFrac: 0.2, phase: 0, width: 1.5, orbSize: 12, eccentricity: 0.6 },
        { bandLo: 12, bandHi: 28, orbitFrac: 0.4, phase: Math.PI * 0.5, width: 1.2, orbSize: 9, eccentricity: 0.4 },
        { bandLo: 28, bandHi: 48, orbitFrac: 0.65, phase: Math.PI, width: 1.0, orbSize: 7, eccentricity: 0.25 },
        { bandLo: 48, bandHi: 64, orbitFrac: 0.9, phase: Math.PI * 1.5, width: 0.8, orbSize: 5.5, eccentricity: 0.15 },
    ];
    // Available orbit space = maxReach minus main wave amplitude
    const orbitSpace = maxReach - mainAmp;

    // Two-pass drawing: "behind" the progress bar (dimmer), then "in front" (brighter).
    // A companion is "behind" when its Y > centerY (below the bar), "in front" when Y < centerY.

    // Pre-compute companion data
    interface CompData {
        energy: number; dist: number; palBase: number;
        getCompY: (px: number) => number;
        c: typeof companions[0];
    }
    const compData: CompData[] = [];

    // Trail length in pixels — how far back the orbital trail extends
    const trailLen = orbX * 0.85;
    // How much phase the trail covers (higher = more loops visible in the trail)
    const trailPhaseSpan = Math.PI * 3; // ~1.5 full orbits visible

    for (let ci = 0; ci < companions.length; ci++) {
        const c = companions[ci];
        let energy = 0;
        for (let b = c.bandLo; b < c.bandHi && b < NUM_BANDS; b++) { energy += bands[b]; }
        energy /= (c.bandHi - c.bandLo);

        const dist = orbitSpace * c.orbitFrac;
        const palBase = (ci * 0.25 + vizTime * 0.02) % 1;

        // Orbit speed: base + energy boost
        const speedBoost = 0.025 * (1 + energy * 2);
        orbitPhases[ci] += vizPlaying ? speedBoost : 0.005;

        const currentPhase = orbitPhases[ci] + c.phase;

        // getCompY maps screen X to orbital Y position
        // At orbX (the orb), phase = currentPhase
        // Further left = earlier in the orbit (subtract phase)
        // Elliptical orbit: Y uses full dist, but the "horizontal" component
        // (mapped to depth via cos) is compressed by eccentricity.
        // This makes bass orbits wide and flat, treble orbits nearly circular.
        const ecc = c.eccentricity + energy * 0.15; // energy widens the ellipse
        const getCompY = (px: number): number => {
            const behindFrac = (orbX - px) / trailLen;
            if (behindFrac < 0 || behindFrac > 1) { return centerY; }
            const phaseAtPx = currentPhase - behindFrac * trailPhaseSpan;
            // Elliptical: sin for vertical, but scaled by (1 - ecc * cos²) for oval shape
            const sinP = Math.sin(phaseAtPx);
            const cosP = Math.cos(phaseAtPx);
            const ellipseScale = 1 - ecc * cosP * cosP;
            return centerY + sinP * dist * ellipseScale;
        };

        compData.push({ energy, dist, palBase, getCompY, c });
    }

    // Each companion is drawn entirely on ONE canvas at a time.
    // cos(currentPhase) > 0 means the orbiter is on the front side of its orbit → front canvas
    // cos(currentPhase) <= 0 means it's on the back side → back canvas
    // The switch happens at the orbital peaks (sin = ±1), creating a natural crossover.

    // Main sun orb size
    const mainOrbR = 14 + overall * 10;

    // Draw "behind" companions first (behind the sun), then main sun, then "in front" companions
    for (let pass = 0; pass < 2; pass++) {
        const isFrontPass = pass === 1;

        for (let ci = 0; ci < compData.length; ci++) {
            const cd = compData[ci];
            const { energy, palBase, getCompY, c } = cd;
            const currentPhase = orbitPhases[ci] + c.phase;

            // Determine which canvas this companion belongs to right now
            const onFrontSide = Math.cos(currentPhase) > 0;
            if (onFrontSide !== isFrontPass) { continue; }

            const ctx = isFrontPass ? vizFrontCtx : vizCtx;
            const trailStart = Math.max(0, orbX - trailLen);

            // Draw trail line
            const lineAlpha = 0.12 + energy * 0.45;
            const lineW = c.width + energy * 1.5;

            for (let px = trailStart; px < orbX; px += 4) {
                const y1 = getCompY(px);
                const y2 = getCompY(Math.min(px + 4, orbX));
                const fadeFrac = (px - trailStart) / trailLen;
                ctx.beginPath();
                ctx.moveTo(px, y1);
                ctx.lineTo(px + 4, y2);
                ctx.strokeStyle = palLerp(palBase + (1 - fadeFrac) * 0.4, lineAlpha * fadeFrac);
                ctx.lineWidth = lineW;
                ctx.stroke();
            }

            // Glow
            if (energy > 0.15) {
                ctx.beginPath();
                let drawing = false;
                for (let px = trailStart; px <= orbX; px += 2) {
                    const y = getCompY(px);
                    if (!drawing) { ctx.moveTo(px, y); drawing = true; }
                    else { ctx.lineTo(px, y); }
                }
                ctx.strokeStyle = palLerp(palBase, 0.02 + energy * 0.06);
                ctx.lineWidth = lineW * 3;
                ctx.stroke();
            }

            // Spectrum bars along the trail — sized relative to the companion orb
            const compOrbR = c.orbSize + energy * 5 + 2;
            const compBarMax = compOrbR * 0.5; // max half-height is 50% of orb radius
            const barStartPx = orbX - compOrbR - 10;
            for (let bi = 0; bi < NUM_BANDS; bi++) {
                const bandT = bi / NUM_BANDS;
                const barPx = barStartPx - bandT * (barStartPx - trailStart);
                const barY = getCompY(barPx);
                const fadeFactor = Math.pow(1 - bandT, 1.2);
                const bandVal = bands[bi];
                // Scale directly to orb size, not global specAmp
                const halfH = bandVal * compBarMax * fadeFactor;
                const barAlpha = (0.3 + bandVal * 0.7) * fadeFactor;
                const barColor = palBase + bandT * 0.5;

                ctx.fillStyle = palLerp(barColor, barAlpha);
                ctx.fillRect(barPx, barY - halfH, barW, halfH * 2);
            }

            // Companion orb (reuse compOrbR from bar calculation)
            const orbY = getCompY(orbX);

            const orbGrad = ctx.createRadialGradient(orbX, orbY, 0, orbX, orbY, compOrbR * 3);
            orbGrad.addColorStop(0, palLerp(palBase, 0.5 + energy * 0.4));
            orbGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = orbGrad;
            ctx.fillRect(orbX - compOrbR * 3, orbY - compOrbR * 3, compOrbR * 6, compOrbR * 6);

            ctx.beginPath();
            ctx.arc(orbX, orbY, compOrbR, 0, Math.PI * 2);
            ctx.fillStyle = palLerp(palBase, 0.8 + energy * 0.2);
            ctx.fill();

            // Emit comet particles from the orbiter
            if (vizPlaying && Math.random() < 0.6 + energy * 2) {
                const particleCount = 1 + Math.floor(energy * 3);
                for (let p = 0; p < particleCount; p++) {
                    // Particles drift backward and slightly outward from orbit
                    const angle = currentPhase + Math.PI + (Math.random() - 0.5) * 0.8;
                    const spd = 0.3 + Math.random() * 0.8 + energy * 0.5;
                    cometParticles.push({
                        x: orbX + (Math.random() - 0.5) * compOrbR * 0.5,
                        y: orbY + (Math.random() - 0.5) * compOrbR * 0.5,
                        vx: -spd * (0.5 + Math.random()), // drift backward (left)
                        vy: Math.sin(angle) * spd * 0.4,
                        life: 15 + Math.random() * 25 + energy * 15,
                        maxLife: 40 + energy * 15,
                        size: 1 + Math.random() * 2 + energy * 1.5,
                        color: palLerp(palBase + Math.random() * 0.2, 0.9),
                    });
                }
            }
        }

        // Draw main sun after "behind" pass, before "in front" pass
        if (pass === 0) {

            // Main spectrum bars on the progress bar line — spectrum-style but scaled to orbit
            const mainBarMaxHalf = maxReach * 0.5; // half the available space above/below
            const mainBarStartX = orbX - mainOrbR - 10;
            const mainTrailStart = Math.max(0, orbX - trailLen);

            for (let bi = 0; bi < NUM_BANDS; bi++) {
                const bandT = bi / NUM_BANDS;
                const barPx = mainBarStartX - bandT * (mainBarStartX - mainTrailStart);
                const fadeFactor = 0.15 + 0.85 * Math.pow(1 - bandT, 1.5);
                const bandVal = bands[bi];
                const halfH = bandVal * mainBarMaxHalf * fadeFactor;
                const barAlpha = (0.25 + bandVal * 0.65) * fadeFactor;

                // Equal bars above and below centerY
                vizFrontCtx.fillStyle = palLerp(bandT, barAlpha);
                vizFrontCtx.fillRect(barPx, centerY - halfH, barW, halfH * 2);
            }

            // Main sun orb
            const mainGrad = vizFrontCtx.createRadialGradient(orbX, centerY, 0, orbX, centerY, mainOrbR * 3);
            mainGrad.addColorStop(0, `rgba(255, 255, 255, ${0.5 + overall * 0.4})`);
            mainGrad.addColorStop(1, 'transparent');
            vizFrontCtx.fillStyle = mainGrad;
            vizFrontCtx.fillRect(orbX - mainOrbR * 3, centerY - mainOrbR * 3, mainOrbR * 6, mainOrbR * 6);

            vizFrontCtx.beginPath();
            vizFrontCtx.arc(orbX, centerY, mainOrbR, 0, Math.PI * 2);
            vizFrontCtx.fillStyle = `rgba(255, 255, 255, ${0.85 + overall * 0.15})`;
            vizFrontCtx.fill();
        }
    }

    // ── Comet particles: update and render ──
    for (let i = cometParticles.length - 1; i >= 0; i--) {
        const p = cometParticles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy *= 0.98; // slight drag
        p.vx *= 0.97;
        p.life--;

        if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) {
            cometParticles.splice(i, 1);
            continue;
        }

        const lifeRatio = p.life / p.maxLife;
        const alpha = lifeRatio * 0.7;
        const size = p.size * (0.3 + lifeRatio * 0.7);

        // Draw particle with glow
        vizFrontCtx.beginPath();
        vizFrontCtx.arc(p.x, p.y, size, 0, Math.PI * 2);
        vizFrontCtx.fillStyle = p.color.replace(/[\d.]+\)$/, `${alpha})`);
        vizFrontCtx.fill();

        // Soft glow halo
        if (size > 1.5) {
            vizFrontCtx.beginPath();
            vizFrontCtx.arc(p.x, p.y, size * 2.5, 0, Math.PI * 2);
            vizFrontCtx.fillStyle = p.color.replace(/[\d.]+\)$/, `${alpha * 0.12})`);
            vizFrontCtx.fill();
        }
    }

    // Cap particles
    while (cometParticles.length > 300) { cometParticles.shift(); }
}

// ── Glow mode: full-height bars where brightness = amplitude ─────────────────

let glowExpandSmooth = 0;
let glowBassHistory: number[] = [];  // rolling history of bass values for calibration
let glowCalibrated = false;
let glowBassMax = 0.3;  // dynamic max — learned from the song

function drawGlow(w: number, h: number, _dpr: number): void {
    const barWidth = w / NUM_BANDS;
    const overall = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;

    // Current bass level
    const bassNow = (bands[0] + bands[1] + bands[2] + bands[3] + bands[4] + bands[5]) / 6;

    // Calibrate: track bass levels over time to learn the song's range
    glowBassHistory.push(bassNow);
    if (glowBassHistory.length > 120) { glowBassHistory.shift(); } // ~2 seconds at 60fps

    // Dynamic max: use the 90th percentile of recent bass values
    if (glowBassHistory.length > 30) {
        const sorted = [...glowBassHistory].sort((a, b) => a - b);
        glowBassMax = Math.max(0.05, sorted[Math.floor(sorted.length * 0.9)]);
        glowCalibrated = true;
    }

    // Normalize bass relative to the song's own range
    const normalizedBass = glowCalibrated ? Math.min(1, bassNow / glowBassMax) : bassNow * 2;

    // Each bass hit above threshold ratchets the expansion up
    // Uses normalized bass so quiet songs expand just as well as loud ones
    const increment = normalizedBass * 0.008;  // small per-frame increment
    if (normalizedBass > 0.3) {
        glowExpandSmooth = Math.min(1, glowExpandSmooth + increment);
    }
    const expandFactor = glowExpandSmooth;

    const activeCount = Math.max(4, Math.floor(NUM_BANDS * expandFactor));
    const startBand = Math.floor((NUM_BANDS - activeCount) / 2);
    const endBand = startBand + activeCount;
    const activeWidth = activeCount * barWidth;
    const offsetX = (w - activeWidth) / 2;

    for (let i = startBand; i < endBand; i++) {
        const val = bands[i];
        const localIdx = i - startBand;
        const t = localIdx / activeCount;
        const x = offsetX + localIdx * barWidth;

        // Base bar: full height, very dim
        const baseAlpha = 0.03;
        vizCtx.fillStyle = palLerp(t, baseAlpha);
        vizCtx.fillRect(x, 0, barWidth - 1, h);

        // Glow intensity from band value
        // The bar is always full height, but brightness scales with amplitude
        const glowAlpha = val * 0.7;
        if (glowAlpha > 0.01) {
            // Main bright bar
            vizCtx.fillStyle = palLerp(t + vizTime * 0.02, glowAlpha);
            vizCtx.fillRect(x, 0, barWidth - 1, h);

            // Soft glow (wider, dimmer) using shadow or wider rect
            if (val > 0.3) {
                const glowWidth = barWidth + val * 8;
                const glowX = x - (glowWidth - barWidth) / 2;
                vizCtx.fillStyle = palLerp(t + vizTime * 0.02, glowAlpha * 0.25);
                vizCtx.fillRect(glowX, 0, glowWidth, h);
            }

            // Neon core: thin bright center line
            if (val > 0.2) {
                const coreWidth = Math.max(1, barWidth * 0.3);
                const coreX = x + (barWidth - coreWidth) / 2;
                vizCtx.fillStyle = palLerp(t + vizTime * 0.02, Math.min(1, val * 1.2), 15);
                vizCtx.fillRect(coreX, 0, coreWidth, h);
            }
        }
    }

    // Horizontal scanning line that pulses with bass
    const bassAvg = (bands[0] + bands[1] + bands[2] + bands[3]) / 4;
    const scanY = h * 0.5 + Math.sin(vizTime * 1.5) * h * 0.3;
    const scanAlpha = 0.05 + bassAvg * 0.2;
    const scanGrad = vizCtx.createLinearGradient(0, scanY - 20, 0, scanY + 20);
    scanGrad.addColorStop(0, 'transparent');
    scanGrad.addColorStop(0.5, palLerp(vizTime * 0.03 % 1, scanAlpha));
    scanGrad.addColorStop(1, 'transparent');
    vizCtx.fillStyle = scanGrad;
    vizCtx.fillRect(offsetX, scanY - 20, activeWidth, 40);
}

// ── Progress Bar mode: the progress bar itself glows with spectrum data ──────

function drawProgressBar(w: number, h: number, _dpr: number): void {
    const dpr = window.devicePixelRatio || 1;
    const tabRect = document.getElementById('tab-playing')!.getBoundingClientRect();
    const progRect = progressTrack.getBoundingClientRect();

    // Map the progress bar's screen position to canvas coordinates
    const barLeft = (progRect.left - tabRect.left) * dpr;
    const barTop = (progRect.top - tabRect.top) * dpr;
    const barWidth = progRect.width * dpr;
    const barHeight = progRect.height * dpr;

    if (barWidth <= 0 || barHeight <= 0) { return; }

    // How far the song has progressed (0-1)
    const progress = trackDuration > 0 ? Math.min(1, trackPosition / trackDuration) : 0;
    const filledWidth = barWidth * progress;

    // Draw spectrum-based glow segments along the progress bar
    const segmentCount = NUM_BANDS;
    const segWidth = barWidth / segmentCount;
    const overall = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;

    // Max glow height above/below the bar
    const maxGlowH = h * 0.25;

    // Draw each segment with its own glow height — color interpolates smoothly via palLerp
    // Widen each segment slightly so edges overlap for smoother transitions
    const overlapPx = segWidth * 0.3;

    for (let i = 0; i < segmentCount; i++) {
        const t = (i + 0.5) / segmentCount; // center of segment in 0-1 range
        const segX = barLeft + i * segWidth - overlapPx;
        const drawW = segWidth + overlapPx * 2;
        const bandVal = bands[i];

        const segMidX = barLeft + (i + 0.5) * segWidth;
        if (segMidX > barLeft + filledWidth) { continue; }

        const glowH = bandVal * maxGlowH;
        const alpha = 0.2 + bandVal * 0.7;
        // Color slowly shifts over time for a living feel
        const colorT = t + vizTime * 0.015;

        // Upward glow gradient
        const grad = vizFrontCtx.createLinearGradient(0, barTop - glowH, 0, barTop);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, palLerp(colorT, alpha));
        vizFrontCtx.fillStyle = grad;
        vizFrontCtx.fillRect(segX, barTop - glowH, drawW, glowH);

        // Bright core on the bar
        vizFrontCtx.fillStyle = palLerp(colorT, alpha * 0.9);
        vizFrontCtx.fillRect(segX, barTop - 2 * dpr, drawW, barHeight + 4 * dpr);

        // Downward glow gradient
        const gradDown = vizFrontCtx.createLinearGradient(0, barTop + barHeight, 0, barTop + barHeight + glowH);
        gradDown.addColorStop(0, palLerp(colorT, alpha * 0.6));
        gradDown.addColorStop(1, 'transparent');
        vizFrontCtx.fillStyle = gradDown;
        vizFrontCtx.fillRect(segX, barTop + barHeight, drawW, glowH);
    }

    // Subtle scanning highlight that moves with time
    if (overall > 0.1) {
        const scanPos = ((vizTime * 0.3) % 1) * filledWidth + barLeft;
        const scanWidth = barWidth * 0.1;
        const scanGrad = vizFrontCtx.createLinearGradient(scanPos - scanWidth, 0, scanPos + scanWidth, 0);
        scanGrad.addColorStop(0, 'transparent');
        scanGrad.addColorStop(0.5, `rgba(255, 255, 255, ${0.1 + overall * 0.15})`);
        scanGrad.addColorStop(1, 'transparent');
        vizFrontCtx.fillStyle = scanGrad;
        vizFrontCtx.fillRect(barLeft, barTop - maxGlowH * 0.5, filledWidth, barHeight + maxGlowH);
    }
}

// ── Fractal visualizer ──────────────────────────────────────────────────────
// Julia set fractal that reacts to music:
//   - Bass controls the Julia constant (morphs the shape)
//   - Mids control zoom level
//   - Treble shifts the color palette
//   - Beats trigger zoom pulses
//   - Renders at reduced resolution for performance, then upscales

let fractalTime = 0;
let fractalHueShift = 0;
let fractalImageData: ImageData | null = null;
const FRACTAL_SCALE = 4;

// Smoothed audio parameters
let fractalBassSmooth = 0;
let fractalMidSmooth = 0;
let fractalTrebleSmooth = 0;
let fractalEnergySmooth = 0;

// Album color extraction for fractal palette
let albumColors: [number, number, number][] = [[77, 170, 252], [78, 201, 144], [240, 160, 48]]; // default palette
let lastAlbumArtSrc = '';

function extractAlbumColors(): void {
    if (!albumArtEl.src || albumArtEl.src === lastAlbumArtSrc || !albumArtEl.naturalWidth) return;
    lastAlbumArtSrc = albumArtEl.src;

    try {
        const c = document.createElement('canvas');
        const size = 32; // sample at low res for speed
        c.width = size; c.height = size;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(albumArtEl, 0, 0, size, size);
        const pixels = ctx.getImageData(0, 0, size, size).data;

        // K-means-ish: bucket pixels by hue, pick top 3 distinct colors
        const buckets: Map<number, {r: number, g: number, b: number, count: number}> = new Map();
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
            // Skip very dark or very light (background/text)
            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            if (lum < 30 || lum > 230) continue;
            // Bucket by quantized hue (12 buckets)
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let hue = 0;
            if (max !== min) {
                if (max === r) hue = ((g - b) / (max - min)) % 6;
                else if (max === g) hue = (b - r) / (max - min) + 2;
                else hue = (r - g) / (max - min) + 4;
            }
            const bucket = Math.floor(((hue + 6) % 6) * 2); // 12 buckets
            const existing = buckets.get(bucket);
            if (existing) {
                existing.r += r; existing.g += g; existing.b += b; existing.count++;
            } else {
                buckets.set(bucket, {r, g, b, count: 1});
            }
        }

        // Sort by count, take top 3
        const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
        const newColors: [number, number, number][] = [];
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
            const s = sorted[i];
            newColors.push([
                Math.floor(s.r / s.count),
                Math.floor(s.g / s.count),
                Math.floor(s.b / s.count),
            ]);
        }
        // Pad to 3 colors
        while (newColors.length < 3) newColors.push(newColors[0] || [77, 170, 252]);
        albumColors = newColors;
    } catch { /* CORS or other error — keep default colors */ }
}

function drawFractal(w: number, h: number, _dpr: number): void {
    // Extract colors from album art (runs once per track change)
    extractAlbumColors();

    // Smoothed audio
    const rawBass = (bands[0] + bands[1] + bands[2] + bands[3]) / 4;
    const rawMid = (bands[16] + bands[17] + bands[18] + bands[19]) / 4;
    const rawTreble = (bands[48] + bands[49] + bands[50] + bands[51]) / 4;
    const rawEnergy = bands.reduce((a, b) => a + b, 0) / NUM_BANDS;

    fractalBassSmooth += (rawBass - fractalBassSmooth) * 0.06;
    fractalMidSmooth += (rawMid - fractalMidSmooth) * 0.06;
    fractalTrebleSmooth += (rawTreble - fractalTrebleSmooth) * 0.06;
    fractalEnergySmooth += (rawEnergy - fractalEnergySmooth) * 0.04;

    // Time — music speeds up the journey
    fractalTime += vizPlaying ? (0.003 + fractalEnergySmooth * 0.008) : 0.001;
    fractalHueShift += fractalTrebleSmooth * 2 + 0.3;

    // ── KEY INSIGHT: Trace the Mandelbrot set boundary ──
    // The main cardioid boundary is parametrized as:
    //   c = (e^(iθ)/2) - (e^(2iθ)/4)
    // Julia sets for c ON this boundary always have maximum fractal detail.
    // We trace just OUTSIDE the boundary for the richest "dendrite" Julia sets.
    //
    // θ advances with time; music modulates small perturbations.

    const theta = fractalTime;
    const boundaryR = 0.5;  // cardioid radius

    // Base position: trace the main cardioid
    let cx = boundaryR * Math.cos(theta) - (boundaryR * boundaryR / 2) * Math.cos(2 * theta);
    let cy = boundaryR * Math.sin(theta) - (boundaryR * boundaryR / 2) * Math.sin(2 * theta);

    // Perturb slightly OUTWARD from the boundary (richer detail outside)
    // Bass pushes further out (more dendrite arms), mids rotate the perturbation
    const perturbAngle = theta + fractalMidSmooth * Math.PI;
    const perturbDist = 0.01 + fractalBassSmooth * 0.03;
    cx += Math.cos(perturbAngle) * perturbDist;
    cy += Math.sin(perturbAngle) * perturbDist;

    // Fixed zoom with gentle bass breathing — no infinite zoom needed
    // because the morphing IS the visual journey
    const zoom = 1.3 + fractalBassSmooth * 0.3;

    // Render
    const rw = Math.floor(w / FRACTAL_SCALE);
    const rh = Math.floor(h / FRACTAL_SCALE);
    if (!fractalImageData || fractalImageData.width !== rw || fractalImageData.height !== rh) {
        fractalImageData = vizCtx.createImageData(rw, rh);
    }

    const data = fractalImageData.data;
    const maxIter = 80 + Math.floor(fractalEnergySmooth * 40);
    const aspect = rh / rw;

    for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
            let zr = (px / rw - 0.5) * 2 * zoom;
            let zi = (py / rh - 0.5) * 2 * zoom * aspect;

            // Julia iteration: z = z² + c
            let iter = 0;
            let zr2 = zr * zr, zi2 = zi * zi;
            while (iter < maxIter && zr2 + zi2 < 4) {
                zi = 2 * zr * zi + cy;
                zr = zr2 - zi2 + cx;
                zr2 = zr * zr;
                zi2 = zi * zi;
                iter++;
            }

            const idx = (py * rw + px) * 4;

            if (iter === maxIter) {
                // Inside the set — darkened version of primary album color
                const c0 = albumColors[0];
                const pulse = fractalBassSmooth;
                data[idx] = Math.floor(c0[0] * 0.05 + pulse * c0[0] * 0.15);
                data[idx + 1] = Math.floor(c0[1] * 0.05 + pulse * c0[1] * 0.15);
                data[idx + 2] = Math.floor(c0[2] * 0.05 + pulse * c0[2] * 0.15);
                data[idx + 3] = 255;
            } else {
                // Smooth escape coloring using album colors
                const log2 = Math.log(2);
                const mag = Math.sqrt(zr2 + zi2);
                const nu = (mag > 1) ? Math.log(Math.log(mag) / log2) / log2 : 0;
                const smooth = (iter + 1 - nu) / maxIter;

                // Interpolate between album colors based on escape speed + hue shift
                const t = ((smooth * 3 + fractalHueShift * 0.003) % 1 + 1) % 1;
                const colorPos = t * (albumColors.length);
                const ci = Math.floor(colorPos) % albumColors.length;
                const cn = (ci + 1) % albumColors.length;
                const blend = colorPos - Math.floor(colorPos);

                const c1 = albumColors[ci];
                const c2 = albumColors[cn];

                // Lerp between two album colors
                let r = c1[0] + (c2[0] - c1[0]) * blend;
                let g = c1[1] + (c2[1] - c1[1]) * blend;
                let b = c1[2] + (c2[2] - c1[2]) * blend;

                // Apply brightness from escape speed
                const brightness = 0.1 + smooth * 0.9;
                r *= brightness;
                g *= brightness;
                b *= brightness;

                // Energy boost — louder = more saturated
                const boost = 1 + fractalEnergySmooth * 0.5;
                r = Math.min(255, r * boost);
                g = Math.min(255, g * boost);
                b = Math.min(255, b * boost);

                data[idx] = Math.floor(r);
                data[idx + 1] = Math.floor(g);
                data[idx + 2] = Math.floor(b);
                data[idx + 3] = 255;
            }
        }
    }

    // Upscale with smoothing
    const offscreen = document.createElement('canvas');
    offscreen.width = rw;
    offscreen.height = rh;
    offscreen.getContext('2d')!.putImageData(fractalImageData, 0, 0);
    vizCtx.imageSmoothingEnabled = true;
    vizCtx.imageSmoothingQuality = 'high';
    vizCtx.drawImage(offscreen, 0, 0, w, h);
}

// ── Main draw loop ──────────────────────────────────────────────────────────
function drawViz(): void {
    const w = vizCanvas.width;
    const h = vizCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    vizCtx.clearRect(0, 0, w, h);
    vizFrontCtx.clearRect(0, 0, w, h);
    vizTime += vizPlaying ? 0.02 : 0.005;
    // Interpolate position between polls (~60fps, polls every 2s)
    if (vizPlaying) { trackPosition += 1 / 60; }
    updateBands();

    switch (vizMode) {
        case 'spectrum': drawSpectrum(w, h, dpr); break;
        case 'wave': drawWave(w, h, dpr); break;
        case 'pulse': drawPulse(w, h, dpr); break;
        case 'radial': drawRadial(w, h, dpr); break;
        case 'sinewave': drawSineWave(w, h, dpr); break;
        case 'orbit': drawHelix(w, h, dpr); break;
        case 'glow': drawGlow(w, h, dpr); break;
        case 'fractal': drawFractal(w, h, dpr); break;
        case 'progressbar': drawProgressBar(w, h, dpr); break;
    }

    vizAnimId = requestAnimationFrame(drawViz);
}

function startViz(): void {
    resizeViz();
    if (!vizAnimId) { drawViz(); }
}

function setVizPlaying(playing: boolean): void {
    vizPlaying = playing;
}

function setTrackSeed(track: string, artist: string): void {
    const newSeed = hashStr(track + '::' + artist);
    if (newSeed === trackSeed) { return; } // same track, no reset
    trackSeed = newSeed;
    // Derive unique track characteristics from seed
    trackBPM = 80 + seededRandom(trackSeed + 1) * 80;
    trackEnergy = 0.4 + seededRandom(trackSeed + 2) * 0.6;
    trackBassWeight = 0.3 + seededRandom(trackSeed + 3) * 0.7;
    trackBrightness = 0.2 + seededRandom(trackSeed + 4) * 0.8;
    // Reset glow expand and calibration for the new song
    glowExpandSmooth = 0;
    glowBassHistory = [];
    glowCalibrated = false;
    glowBassMax = 0.3;
}

function updateTrackPosition(pos: number, dur: number): void {
    trackPosition = pos;
    trackDuration = dur;
}

const vizResizeObs = new ResizeObserver(() => resizeViz());
vizResizeObs.observe(document.getElementById('tab-playing')!);

// ── Init ────────────────────────────────────────────────────────────────────

renderRecentSearches();
startViz();
vscode.postMessage({ type: 'ready' });
