// CodeMirror 6 editor factory + theme system, exposed on window for the file-viewer.
import { EditorState, Extension, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import {
    dracula, nord, githubDark, githubLight, materialDark, materialLight, monokai,
    tokyoNight, gruvboxDark, gruvboxLight, copilot, aura, andromeda, sublime,
    xcodeDark, xcodeLight,
    defaultSettingsDracula, defaultSettingsNord, defaultSettingsGithubDark, defaultSettingsGithubLight,
    defaultSettingsMaterialDark, defaultSettingsMaterialLight, defaultSettingsMonokai, defaultSettingsTokyoNight,
    defaultSettingsGruvboxDark, defaultSettingsGruvboxLight, defaultSettingsCopilot, defaultSettingsAura,
    defaultSettingsAndromeda, defaultSettingsSublime, defaultSettingsXcodeDark, defaultSettingsXcodeLight,
} from '@uiw/codemirror-themes-all';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { java } from '@codemirror/lang-java';
import { php } from '@codemirror/lang-php';

const THEMES: Record<string, Extension> = {
    'Bloodline': dracula,
    'One Dark': oneDark,
    'Dracula': dracula,
    'Tokyo Night': tokyoNight,
    'Nord': nord,
    'GitHub Dark': githubDark,
    'Material': materialDark,
    'Monokai': monokai,
    'Gruvbox Dark': gruvboxDark,
    'Copilot': copilot,
    'Aura': aura,
    'Andromeda': andromeda,
    'Sublime': sublime,
    'Xcode Dark': xcodeDark,
    'GitHub Light': githubLight,
    'Material Light': materialLight,
    'Gruvbox Light': gruvboxLight,
    'Xcode Light': xcodeLight,
};

function langForExt(ext: string): Extension {
    switch ((ext || '').toLowerCase().replace(/^\./, '')) {
        case 'js': case 'mjs': case 'cjs': return javascript();
        case 'jsx': return javascript({ jsx: true });
        case 'ts': return javascript({ typescript: true });
        case 'tsx': return javascript({ typescript: true, jsx: true });
        case 'py': case 'pyw': return python();
        case 'json': case 'jsonc': return json();
        case 'md': case 'markdown': return markdown();
        case 'html': case 'htm': return html();
        case 'css': case 'scss': case 'less': return css();
        case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return cpp();
        case 'rs': return rust();
        case 'xml': case 'svg': return xml();
        case 'yaml': case 'yml': return yaml();
        case 'sql': return sql();
        case 'java': return java();
        case 'php': return php();
        default: return [];
    }
}

const themeCompartment = new Compartment();
let currentTheme = 'One Dark';
const liveViews = new Set<EditorView>();
const W = window as unknown as Record<string, unknown>;

W.jacEditorThemes = Object.keys(THEMES);
W.jacGetEditorTheme = () => currentTheme;
W.jacSetEditorTheme = (name: string) => {
    if (!THEMES[name]) return;
    currentTheme = name;
    for (const v of [...liveViews]) {
        try { v.dispatch({ effects: themeCompartment.reconfigure(THEMES[name]) }); }
        catch { liveViews.delete(v); }   // view was destroyed
    }
};

// ── App-wide theming: derive a UI palette from each editor theme's settings ──────
interface ThemeSettings { background?: string; foreground?: string; gutterForeground?: string; caret?: string; accent?: string; }
const SETTINGS: Record<string, ThemeSettings> = {
    'Bloodline': { background: '#160c10', foreground: '#e0ccd0', gutterForeground: '#7a5560', accent: '#1a5ce0' },
    'One Dark': { background: '#282c34', foreground: '#abb2bf', gutterForeground: '#7d8799', caret: '#528bff' },
    'Dracula': defaultSettingsDracula,
    'Tokyo Night': defaultSettingsTokyoNight,
    'Nord': defaultSettingsNord,
    'GitHub Dark': defaultSettingsGithubDark,
    'Material': defaultSettingsMaterialDark,
    'Monokai': defaultSettingsMonokai,
    'Gruvbox Dark': defaultSettingsGruvboxDark,
    'Copilot': defaultSettingsCopilot,
    'Aura': defaultSettingsAura,
    'Andromeda': defaultSettingsAndromeda,
    'Sublime': defaultSettingsSublime,
    'Xcode Dark': defaultSettingsXcodeDark,
    'GitHub Light': defaultSettingsGithubLight,
    'Material Light': defaultSettingsMaterialLight,
    'Gruvbox Light': defaultSettingsGruvboxLight,
    'Xcode Light': defaultSettingsXcodeLight,
};

function hexToRgb(h: string): [number, number, number] {
    let s = h.replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function mix(a: string, b: string, t: number): string {
    const A = hexToRgb(a), B = hexToRgb(b);
    return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
function luminance(h: string): number { const [r, g, b] = hexToRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

interface Palette {
    bg: string; panel: string; fg: string; dim: string; border: string; accent: string;
    // Derived below. The chat leaned on ~70 usages of hardcoded near-black grounds and a
    // white hover veil, so switching to any of the four light themes left tool cards,
    // the composer and the sidebar dark with dark text on them — 1.14:1 to 1.24:1.
    toolBg: string; inputBg: string; inputBorder: string; userBg: string;
    sidebarBg: string; listHover: string; descFg: string;
    success: string; error: string; focusBorder: string; brand: string;
}
function appPalette(name: string): Palette {
    const s = SETTINGS[name] || SETTINGS['One Dark'];
    const bg = s.background || '#1e1e1e';
    const fg = s.foreground || '#d4d4d4';
    const light = luminance(bg) > 0.5;
    const toward = light ? '#000000' : '#ffffff';
    const accent = s.accent || '#4daafc';
    return {
        bg,
        fg,
        panel: mix(bg, toward, light ? 0.045 : 0.06),
        // Was 0.15 — which lands on #2b2b2b against #191919, a 1.24:1 hairline that is
        // present but not perceptible, so panels and table rules read as one flat slab.
        border: mix(bg, toward, light ? 0.20 : 0.24),
        dim: s.gutterForeground || mix(fg, bg, 0.45),
        accent,

        // Surfaces: recessed for tool output, raised for anything you type into. Both are
        // relative to the theme's own ground, so they invert correctly on light themes.
        toolBg: mix(bg, light ? '#000000' : '#000000', light ? 0.035 : 0.14),
        inputBg: mix(bg, toward, light ? 0.03 : 0.07),
        inputBorder: mix(bg, toward, light ? 0.22 : 0.30),
        userBg: mix(bg, toward, light ? 0.05 : 0.09),
        sidebarBg: mix(bg, toward, light ? 0.045 : 0.06),

        // Hover was rgba(255,255,255,0.04) — an invisible white veil on a white ground.
        // Tint by the theme's own foreground instead.
        listHover: mix(bg, fg, 0.08),

        // Secondary text: #888 is 3.54:1 on white, under AA. Keep it nearer fg than dim is.
        descFg: mix(fg, bg, 0.32),

        // Semantic colours need different lightness per ground to stay legible.
        success: light ? '#1a7f37' : '#4ec944',
        error: light ? '#c8342b' : '#f44747',
        focusBorder: accent,
        // Claude orange, darkened on light grounds where #d97757 is only 3.0:1.
        brand: light ? '#b8512c' : '#d97757',
    };
}

function applyPaletteTo(docEl: HTMLElement, p: Palette): void {
    const V = (k: string, v: string) => docEl.style.setProperty(k, v);
    // app + iframe conventions
    for (const [k, v] of Object.entries({ bg: p.bg, panel: p.panel, fg: p.fg, dim: p.dim, border: p.border, accent: p.accent })) {
        V('--app-' + k, v); V('--' + k, v);
    }
    // The chat's own token names. Without these the theme only reached six of the
    // eighteen tokens the chat actually uses, and the light themes were unreadable.
    for (const [k, v] of Object.entries({
        '--tool-bg': p.toolBg,
        '--input-bg': p.inputBg,
        '--input-secondary-bg': p.inputBg,
        '--input-fg': p.fg,
        '--input-border': p.inputBorder,
        '--user-bg': p.userBg,
        '--sidebar-bg': p.sidebarBg,
        '--list-hover': p.listHover,
        '--desc-fg': p.descFg,
        '--text-faint': p.descFg,
        '--success': p.success,
        '--error': p.error,
        '--focus-border': p.focusBorder,
        '--claude-orange': p.brand,
    })) { V(k, v); }
    // VS Code webview vars the chat UI relies on
    const vs: Record<string, string> = {
        '--vscode-foreground': p.fg,
        '--vscode-editor-background': p.bg,
        '--vscode-editor-foreground': p.fg,
        '--vscode-sideBar-background': p.panel,
        '--vscode-sideBarSectionHeader-background': p.panel,
        '--vscode-titleBar-activeBackground': p.panel,
        '--vscode-titleBar-activeForeground': p.fg,
        '--vscode-editorGroupHeader-tabsBackground': p.panel,
        '--vscode-tab-activeBackground': p.bg,
        '--vscode-tab-inactiveBackground': p.panel,
        '--vscode-tab-activeForeground': p.fg,
        '--vscode-tab-inactiveForeground': p.dim,
        '--vscode-panel-background': p.bg,
        '--vscode-panelSectionHeader-background': p.panel,
        '--vscode-editorWidget-background': p.panel,
        '--vscode-editorWidget-foreground': p.fg,
        '--vscode-dropdown-background': p.panel,
        '--vscode-dropdown-foreground': p.fg,
        '--vscode-input-background': p.panel,
        '--vscode-input-foreground': p.fg,
        '--vscode-widget-border': p.border,
        '--vscode-panel-border': p.border,
        '--vscode-focusBorder': p.accent,
        '--vscode-button-background': p.accent,
        '--vscode-button-foreground': '#ffffff',
        '--vscode-textLink-foreground': p.accent,
        '--vscode-badge-background': p.accent,
        '--vscode-descriptionForeground': p.dim,
        // NOTE: the chat webview's own vars (--tool-bg, --input-*, --desc-fg, --user-bg,
        // --sidebar-bg, --focus-border) used to be set here as flat aliases of panel/dim/bg.
        // They now come from the derived palette above, which separates recessed surfaces
        // (tool output) from raised ones (things you type into) instead of making both
        // p.panel, and gives --desc-fg contrast headroom. Setting them here too would win
        // by source order and silently undo that.
    };
    for (const [k, v] of Object.entries(vs)) V(k, v);
}

let currentPalette: Palette = appPalette('One Dark');
W.jacGetAppPalette = () => currentPalette;
W.jacPaletteFor = (name: string) => appPalette(name);   // palette for any theme (for the picker preview)
// Apply a theme to the WHOLE app: UI palette everywhere + editor theme.
W.jacApplyAppTheme = (name: string) => {
    currentPalette = appPalette(name);
    document.documentElement.dataset.jacTheme = name;
    applyPaletteTo(document.documentElement, currentPalette);
    document.querySelectorAll('iframe').forEach((f) => {
        try {
            const d = (f as HTMLIFrameElement).contentDocument;
            if (d) { d.documentElement.dataset.jacTheme = name; applyPaletteTo(d.documentElement, currentPalette); }
        } catch { /* cross-origin */ }
    });
    (W.jacSetEditorTheme as (n: string) => void)(name);
    // Recolor the native window controls (min/max/close) to match.
    const jac = W.jac as { setTitleBarOverlay?: (c: string, s: string) => void } | undefined;
    jac?.setTitleBarOverlay?.(currentPalette.panel, currentPalette.fg);
};
// Re-apply the palette to an iframe once it loads (they load asynchronously).
W.jacThemeIframe = (f: HTMLIFrameElement) => {
    try {
        const d = f.contentDocument;
        if (d) { d.documentElement.dataset.jacTheme = currentTheme; applyPaletteTo(d.documentElement, currentPalette); }
    } catch { /* */ }
};

interface JacEditorHandle { getValue(): string; focus(): void; destroy(): void; }

W.jacCreateEditor = function (
    parent: HTMLElement,
    doc: string,
    ext: string,
    onChange: () => void,
    onSave: (value: string) => void,
): JacEditorHandle {
    const state = EditorState.create({
        doc,
        extensions: [
            basicSetup,
            themeCompartment.of(THEMES[currentTheme] || oneDark),
            langForExt(ext),
            keymap.of([
                indentWithTab,
                { key: 'Mod-s', preventDefault: true, run: (view) => { onSave(view.state.doc.toString()); return true; } },
            ]),
            EditorView.updateListener.of((u) => { if (u.docChanged) onChange(); }),
            EditorView.theme({
                '&': { height: '100%' },
                '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, Consolas, monospace' },
            }),
        ],
    });
    const view = new EditorView({ state, parent });
    liveViews.add(view);
    return {
        getValue: () => view.state.doc.toString(),
        focus: () => view.focus(),
        destroy: () => { liveViews.delete(view); view.destroy(); },
    };
};

export {};
