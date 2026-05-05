/**
 * Platform-specific music player controllers.
 * Uses native OS mechanisms — no API keys or auth needed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface NowPlaying {
    track: string;
    artist: string;
    album: string;
    artUrl: string;
    isPlaying: boolean;
    position: number;   // seconds
    duration: number;   // seconds
    app: string;        // "Spotify", "Music", etc.
}

export interface MusicController {
    playPause(): Promise<void>;
    next(): Promise<void>;
    previous(): Promise<void>;
    getNowPlaying(): Promise<NowPlaying | null>;
    setVolume(pct: number): Promise<void>;
    seek(seconds: number): Promise<void>;
    isAvailable(): Promise<boolean>;
    /** Play a search query (top result) or a URI/URL */
    playQuery(query: string): Promise<void>;
    /** Get user's playlists (Apple Music only; Spotify returns empty) */
    getPlaylists(): Promise<Array<{ name: string; id: string; count: number }>>;
    /** Play a specific playlist by id/URI */
    playPlaylist(id: string): Promise<void>;
    /** Get system volume (0-100) */
    getSystemVolume(): Promise<number>;
    /** Set system volume (0-100) */
    setSystemVolume(pct: number): Promise<void>;
    readonly platform: string;
}

// ── macOS (osascript) ────────────────────────────────────────────────────────

async function osa(script: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
        return stdout.trim();
    } catch {
        return '';
    }
}

/** Detect which music app is running on macOS */
async function detectMacApp(): Promise<'Spotify' | 'Music' | null> {
    const running = await osa(
        'tell application "System Events" to get name of every process whose background only is false'
    );
    if (running.includes('Spotify')) { return 'Spotify'; }
    if (running.includes('Music')) { return 'Music'; }
    return null;
}

class DarwinController implements MusicController {
    readonly platform = 'darwin';
    private app: string = 'Spotify'; // default, auto-detected on first use

    private async getApp(): Promise<string> {
        const detected = await detectMacApp();
        if (detected) { this.app = detected; }
        return this.app;
    }

    async playPause(): Promise<void> {
        const app = await this.getApp();
        await osa(`tell application "${app}" to playpause`);
    }

    async next(): Promise<void> {
        const app = await this.getApp();
        await osa(`tell application "${app}" to next track`);
    }

    async previous(): Promise<void> {
        const app = await this.getApp();
        await osa(`tell application "${app}" to previous track`);
    }

    async setVolume(pct: number): Promise<void> {
        const app = await this.getApp();
        const vol = Math.max(0, Math.min(100, Math.round(pct)));
        await osa(`tell application "${app}" to set sound volume to ${vol}`);
    }

    async seek(seconds: number): Promise<void> {
        const app = await this.getApp();
        await osa(`tell application "${app}" to set player position to ${seconds}`);
    }

    async getNowPlaying(): Promise<NowPlaying | null> {
        const app = await this.getApp();
        // Get all properties in one call for efficiency
        const script = app === 'Spotify'
            ? `tell application "Spotify"
                if player state is stopped then return "STOPPED"
                set t to name of current track
                set a to artist of current track
                set al to album of current track
                set art to artwork url of current track
                set p to player position
                set d to duration of current track
                set s to player state as string
                return t & "||" & a & "||" & al & "||" & art & "||" & p & "||" & (d / 1000) & "||" & s
               end tell`
            : `tell application "Music"
                if player state is stopped then return "STOPPED"
                set t to name of current track
                set a to artist of current track
                set al to album of current track
                set p to player position
                set d to duration of current track
                set s to player state as string
                return t & "||" & a & "||" & al & "||" & "||" & p & "||" & d & "||" & s
               end tell`;

        const result = await osa(script);
        if (!result || result === 'STOPPED') { return null; }

        const parts = result.split('||');
        if (parts.length < 7) { return null; }

        return {
            track: parts[0],
            artist: parts[1],
            album: parts[2],
            artUrl: parts[3] || '',
            position: parseFloat(parts[4]) || 0,
            duration: parseFloat(parts[5]) || 0,
            isPlaying: parts[6] === 'playing',
            app,
        };
    }

    async playQuery(query: string): Promise<void> {
        const app = await this.getApp();
        if (app === 'Spotify') {
            const safeQuery = query.replace(/"/g, '\\"');
            // Use NSWorkspace to open URI without activating Spotify
            await osa(`
                use framework "AppKit"
                use scripting additions
                set ws to current application's NSWorkspace's sharedWorkspace()
                set config to current application's NSWorkspaceOpenConfiguration's configuration()
                config's setActivates_(false)
                set theURL to current application's NSURL's URLWithString_("spotify:search:${safeQuery}")
                ws's openURL_configuration_completionHandler_(theURL, config, missing value)
            `);
        } else {
            const safeQuery = query.replace(/"/g, '\\"');
            await osa(`tell application "Music"
                set results to (every track whose name contains "${safeQuery}" or artist contains "${safeQuery}")
                if (count of results) > 0 then
                    play item 1 of results
                end if
            end tell`);
        }
    }

    async getPlaylists(): Promise<Array<{ name: string; id: string; count: number }>> {
        const app = await this.getApp();
        if (app === 'Spotify') {
            // Spotify AppleScript doesn't expose playlists
            return [];
        }
        // Apple Music has full playlist access
        const result = await osa(`tell application "Music"
            set output to ""
            repeat with p in (every playlist whose special kind is none)
                set output to output & name of p & "||" & id of p & "||" & (count of tracks of p) & "\\n"
            end repeat
            return output
        end tell`);
        if (!result) { return []; }
        return result.split('\n').filter(Boolean).map(line => {
            const [name, id, count] = line.split('||');
            return { name: name || '', id: id || '', count: parseInt(count, 10) || 0 };
        });
    }

    async playPlaylist(id: string): Promise<void> {
        const app = await this.getApp();
        if (app === 'Spotify') {
            // Use NSWorkspace to open URI without activating Spotify
            await osa(`
                use framework "AppKit"
                use scripting additions
                set ws to current application's NSWorkspace's sharedWorkspace()
                set config to current application's NSWorkspaceOpenConfiguration's configuration()
                config's setActivates_(false)
                set theURL to current application's NSURL's URLWithString_("${id}")
                ws's openURL_configuration_completionHandler_(theURL, config, missing value)
            `);
        } else {
            await osa(`tell application "Music"
                play playlist id ${id}
            end tell`);
        }
    }

    async getSystemVolume(): Promise<number> {
        const result = await osa('output volume of (get volume settings)');
        return parseInt(result, 10) || 0;
    }

    async setSystemVolume(pct: number): Promise<void> {
        const vol = Math.max(0, Math.min(100, Math.round(pct)));
        await osa(`set volume output volume ${vol}`);
    }

    async isAvailable(): Promise<boolean> {
        const app = await detectMacApp();
        return app !== null;
    }
}

// ── Linux (playerctl) ────────────────────────────────────────────────────────

async function playerctl(...args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('playerctl', args, { timeout: 3000 });
        return stdout.trim();
    } catch {
        return '';
    }
}

class LinuxController implements MusicController {
    readonly platform = 'linux';

    async playPause(): Promise<void> { await playerctl('play-pause'); }
    async next(): Promise<void> { await playerctl('next'); }
    async previous(): Promise<void> { await playerctl('previous'); }

    async setVolume(pct: number): Promise<void> {
        const vol = Math.max(0, Math.min(100, Math.round(pct))) / 100;
        await playerctl('volume', vol.toString());
    }

    async seek(seconds: number): Promise<void> {
        // playerctl position takes seconds
        await playerctl('position', seconds.toString());
    }

    async getNowPlaying(): Promise<NowPlaying | null> {
        const status = await playerctl('status');
        if (!status || status === 'Stopped') { return null; }

        const [track, artist, album, artUrl, posUs, lenUs, player] = await Promise.all([
            playerctl('metadata', 'xesam:title'),
            playerctl('metadata', 'xesam:artist'),
            playerctl('metadata', 'xesam:album'),
            playerctl('metadata', 'mpris:artUrl'),
            playerctl('position'),           // microseconds
            playerctl('metadata', 'mpris:length'), // microseconds
            playerctl('-l'),                  // list players
        ]);

        return {
            track: track || 'Unknown',
            artist: artist || 'Unknown',
            album: album || '',
            artUrl: artUrl || '',
            position: (parseFloat(posUs) || 0),         // playerctl returns seconds
            duration: (parseFloat(lenUs) || 0) / 1e6,   // mpris:length is microseconds
            isPlaying: status === 'Playing',
            app: (player.split('\n')[0] || 'Unknown').replace(/\.\w+$/, ''),
        };
    }

    async playQuery(_query: string): Promise<void> { /* not supported */ }
    async getPlaylists(): Promise<Array<{ name: string; id: string; count: number }>> { return []; }
    async playPlaylist(_id: string): Promise<void> { /* not supported */ }
    async getSystemVolume(): Promise<number> { return 50; }
    async setSystemVolume(_pct: number): Promise<void> { /* not supported */ }

    async isAvailable(): Promise<boolean> {
        const result = await playerctl('status');
        return result !== '';
    }
}

// ── Windows (PowerShell) ─────────────────────────────────────────────────────

async function powershell(script: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command', script,
        ], { timeout: 5000 });
        return stdout.trim();
    } catch {
        return '';
    }
}

class WindowsController implements MusicController {
    readonly platform = 'win32';

    // Windows uses the SystemMediaTransportControls via PowerShell
    // This works with Spotify, Windows Media Player, and other UWP media apps

    private async sendMediaKey(key: string): Promise<void> {
        // Use SendKeys via PowerShell to simulate media keys
        const keyMap: Record<string, string> = {
            playPause: '0xB3',  // VK_MEDIA_PLAY_PAUSE
            next: '0xB0',       // VK_MEDIA_NEXT_TRACK
            previous: '0xB1',   // VK_MEDIA_PREV_TRACK
        };
        const vk = keyMap[key];
        if (!vk) { return; }
        await powershell(`
            Add-Type -TypeDefinition @"
            using System;
            using System.Runtime.InteropServices;
            public class MediaKeys {
                [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
            }
"@
            [MediaKeys]::keybd_event(${vk}, 0, 0, 0)
            [MediaKeys]::keybd_event(${vk}, 0, 2, 0)
        `);
    }

    async playPause(): Promise<void> { await this.sendMediaKey('playPause'); }
    async next(): Promise<void> { await this.sendMediaKey('next'); }
    async previous(): Promise<void> { await this.sendMediaKey('previous'); }
    async setVolume(_pct: number): Promise<void> { /* Not easily available without nircmd */ }
    async seek(_seconds: number): Promise<void> { /* Not available via media keys */ }

    async getNowPlaying(): Promise<NowPlaying | null> {
        // Try to get Spotify window title (format: "Artist - Track - Spotify")
        const title = await powershell(
            `(Get-Process spotify -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle} | Select-Object -First 1).MainWindowTitle`
        );
        if (!title || title === 'Spotify' || title === 'Spotify Free' || title === 'Spotify Premium') {
            return null;
        }
        // Spotify window title format: "Artist - Song"
        const dash = title.indexOf(' - ');
        if (dash === -1) { return null; }

        return {
            track: title.substring(dash + 3),
            artist: title.substring(0, dash),
            album: '',
            artUrl: '',
            position: 0,
            duration: 0,
            isPlaying: true, // If we got a title, it's playing
            app: 'Spotify',
        };
    }

    async playQuery(_query: string): Promise<void> { /* not supported */ }
    async getPlaylists(): Promise<Array<{ name: string; id: string; count: number }>> { return []; }
    async playPlaylist(_id: string): Promise<void> { /* not supported */ }
    async getSystemVolume(): Promise<number> { return 50; }
    async setSystemVolume(_pct: number): Promise<void> { /* not supported */ }

    async isAvailable(): Promise<boolean> {
        const result = await powershell(
            `Get-Process spotify -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Id }`
        );
        return result !== '';
    }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMusicController(): MusicController {
    switch (process.platform) {
        case 'darwin': return new DarwinController();
        case 'linux': return new LinuxController();
        case 'win32': return new WindowsController();
        default: return new LinuxController(); // fallback to playerctl
    }
}
