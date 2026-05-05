/**
 * Real-time audio capture via ffmpeg — cross-platform.
 *
 * Platform strategies:
 *   macOS:   BlackHole loopback device (requires install)
 *   Windows: WASAPI loopback via DirectShow (built-in, no install needed)
 *   Linux:   PulseAudio/PipeWire monitor source (built-in, no install needed)
 *
 * All platforms need ffmpeg. The FFT and band processing is shared.
 */

import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const NUM_BANDS = 64;
const SMOOTHING = 0.7;  // temporal smoothing (0 = no smoothing, 0.9 = very smooth)
const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;
const CAPTURE_INTERVAL_MS = 33; // ~30fps

export interface AudioBandData {
    bands: number[];
}

export interface AudioCaptureCallbacks {
    onBands(data: AudioBandData): void;
    onError(message: string): void;
}

// ── Platform detection results ──────────────────────────────────────────────

export interface AudioSetupStatus {
    /** Can capture system audio right now */
    ready: boolean;
    /** What's missing — empty if ready */
    missing: string[];
    /** Human-readable description of what's needed */
    message: string;
    /** Whether we can auto-install missing pieces */
    canAutoInstall: boolean;
    /** The audio source identifier to pass to AudioCapture */
    source: string | null;
}

// ── Detection ──────────────────────────────────────────────────────────────

export async function detectFfmpeg(): Promise<boolean> {
    try {
        await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

export async function detectBrew(): Promise<boolean> {
    if (process.platform !== 'darwin') { return false; }
    try {
        await execFileAsync('brew', ['--version'], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

/** macOS: detect BlackHole loopback device */
export async function detectBlackHole(): Promise<string | null> {
    if (process.platform !== 'darwin') { return null; }
    const devices = await listAvfoundationAudioDevices();
    const bh = devices.find(d => d.includes('BlackHole'));
    return bh || null;
}

/** macOS: detect built-in microphone */
export async function detectMacMic(): Promise<string | null> {
    if (process.platform !== 'darwin') { return null; }
    const devices = await listAvfoundationAudioDevices();
    // Prefer built-in mic
    const mic = devices.find(d => /microphone|built.?in/i.test(d));
    return mic || devices[0] || null;
}

/** List avfoundation audio devices */
function listAvfoundationAudioDevices(): Promise<string[]> {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            const lines = stderr.split('\n');
            let inAudio = false;
            const devices: string[] = [];
            for (const line of lines) {
                if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
                if (inAudio) {
                    const match = line.match(/\[\d+\]\s+(.+)/);
                    if (match) { devices.push(match[1].trim()); }
                }
            }
            resolve(devices);
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => { proc.kill(); resolve([]); }, 5000);
    });
}

/** Windows: detect WASAPI loopback audio devices via DirectShow */
async function detectWindowsLoopback(): Promise<string | null> {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            // Look for audio devices — prefer "Stereo Mix" or any audio input
            const lines = stderr.split('\n');
            let inAudio = false;
            const audioDevices: string[] = [];
            for (const line of lines) {
                if (line.includes('DirectShow audio devices')) { inAudio = true; continue; }
                if (inAudio && line.includes(']  "')) {
                    const match = line.match(/"([^"]+)"/);
                    if (match) { audioDevices.push(match[1]); }
                }
            }
            // Prefer "Stereo Mix" or "What U Hear" (loopback names)
            const loopback = audioDevices.find(d =>
                /stereo mix|what u hear|loopback|wave out/i.test(d)
            );
            if (loopback) { resolve(loopback); return; }
            // Fall back to virtual audio cable if present
            const vac = audioDevices.find(d => /virtual|vb-audio|cable/i.test(d));
            if (vac) { resolve(vac); return; }
            resolve(null);
        });
        proc.on('error', () => resolve(null));
        setTimeout(() => { proc.kill(); resolve(null); }, 5000);
    });
}

/** Linux: detect PulseAudio/PipeWire monitor source */
async function detectLinuxMonitor(): Promise<string | null> {
    // Check for PulseAudio / PipeWire
    try {
        const { stdout } = await execFileAsync('pactl', ['list', 'short', 'sources'], { timeout: 3000 });
        // Look for monitor sources (e.g. "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor")
        const lines = stdout.split('\n');
        for (const line of lines) {
            if (line.includes('.monitor')) {
                const parts = line.split('\t');
                if (parts[1]) { return parts[1]; }
            }
        }
        // Fall back to "default" which sometimes works
        return 'default';
    } catch {
        return null;
    }
}

/** Detect Windows package managers for ffmpeg install */
async function detectWinget(): Promise<boolean> {
    try {
        await execFileAsync('winget', ['--version'], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

async function detectChoco(): Promise<boolean> {
    try {
        await execFileAsync('choco', ['--version'], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

// ── Full platform setup detection ──────────────────────────────────────────

export async function detectAudioSetup(): Promise<AudioSetupStatus> {
    const hasFfmpeg = await detectFfmpeg();
    const missing: string[] = [];

    if (process.platform === 'darwin') {
        // macOS: needs ffmpeg + BlackHole
        if (!hasFfmpeg) {
            missing.push('ffmpeg');
            const hasBrew = await detectBrew();
            if (!hasBrew) { missing.push('brew'); }
            return {
                ready: false, missing,
                message: `Needs: ${missing.join(', ')}`,
                canAutoInstall: true, source: null,
            };
        }

        // Check for BlackHole
        const blackhole = await detectBlackHole();
        if (blackhole) {
            return { ready: true, missing: [], message: '', canAutoInstall: false, source: blackhole };
        }

        // No BlackHole — offer install
        missing.push('blackhole');
        const hasBrew = await detectBrew();
        return {
            ready: false, missing,
            message: 'Install BlackHole for real audio visualization',
            canAutoInstall: hasBrew,
            source: null,
        };

    } else if (process.platform === 'win32') {
        // Windows: needs ffmpeg, WASAPI loopback is built-in
        if (!hasFfmpeg) {
            missing.push('ffmpeg');
            const hasWinget = await detectWinget();
            const hasChoco = await detectChoco();
            return {
                ready: false,
                missing,
                message: 'Install ffmpeg for real audio visualization',
                canAutoInstall: hasWinget || hasChoco,
                source: null,
            };
        }

        // ffmpeg is available — try to find a loopback device
        const device = await detectWindowsLoopback();
        if (device) {
            return { ready: true, missing: [], message: '', canAutoInstall: false, source: device };
        }

        // No loopback found — may need to enable "Stereo Mix" in Sound settings
        return {
            ready: false,
            missing: ['stereo-mix'],
            message: 'Enable "Stereo Mix" in Sound Settings → Recording devices',
            canAutoInstall: false,
            source: null,
        };

    } else {
        // Linux: needs ffmpeg + PulseAudio/PipeWire
        if (!hasFfmpeg) {
            missing.push('ffmpeg');
            return {
                ready: false,
                missing,
                message: 'Install ffmpeg: sudo apt install ffmpeg',
                canAutoInstall: false,
                source: null,
            };
        }

        const monitor = await detectLinuxMonitor();
        if (monitor) {
            return { ready: true, missing: [], message: '', canAutoInstall: false, source: monitor };
        }
        return {
            ready: false,
            missing: ['pulseaudio'],
            message: 'PulseAudio or PipeWire required for audio capture',
            canAutoInstall: false,
            source: null,
        };
    }
}

// ── Cross-platform install ──────────────────────────────────────────────────

export interface InstallStep {
    label: string;
    run: () => Promise<boolean>;
}

export function getInstallSteps(missing: string[]): InstallStep[] {
    const steps: InstallStep[] = [];

    if (process.platform === 'darwin') {
        if (missing.includes('brew')) {
            steps.push({
                label: 'Installing Homebrew...',
                run: () => runCmd('/bin/bash', ['-c',
                    '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'],
                    { NONINTERACTIVE: '1' }),
            });
        }
        if (missing.includes('ffmpeg')) {
            steps.push({
                label: 'Installing ffmpeg...',
                run: () => runCmd('brew', ['install', 'ffmpeg']),
            });
        }
        if (missing.includes('blackhole')) {
            steps.push({
                label: 'copy-command',
                run: async () => true, // no-op — handled by UI showing copyable command
            });
        }
    } else if (process.platform === 'win32') {
        if (missing.includes('ffmpeg')) {
            steps.push({
                label: 'Installing ffmpeg...',
                run: async () => {
                    const ok = await runCmd('winget', ['install', 'ffmpeg', '--accept-package-agreements', '--accept-source-agreements']);
                    if (ok) { return true; }
                    return runCmd('choco', ['install', 'ffmpeg', '-y']);
                },
            });
        }
    }

    return steps;
}

function runCmd(cmd: string, args: string[], env?: Record<string, string>): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

// ── macOS Multi-Output Device setup via Audio MIDI Setup GUI scripting ───────

/**
 * Creates a Multi-Output Device with speakers + BlackHole via Audio MIDI Setup,
 * then sets it as the system default output.
 * Returns the BlackHole device name for ffmpeg capture, or null on failure.
 */
// ── macOS Multi-Output Device management via compiled Swift helper ───────────

import * as path from 'path';

/** Path to the jac-audio native binary (compiled Swift, ships with extension) */
function jacAudioBin(extensionPath?: string): string {
    if (extensionPath) {
        return path.join(extensionPath, 'native', 'jac-audio');
    }
    // Fallback: try relative to this file's location
    return path.join(__dirname, '..', 'native', 'jac-audio');
}

let _extensionPath: string | undefined;
export function setExtensionPath(p: string): void { _extensionPath = p; }

async function runJacAudio(command: string): Promise<{ ok: boolean; output: string }> {
    const bin = jacAudioBin(_extensionPath);
    try {
        const { stdout } = await execFileAsync(bin, [command], { timeout: 5000 });
        return { ok: true, output: stdout.trim() };
    } catch (e: any) {
        return { ok: false, output: e.stdout?.trim() || e.message || '' };
    }
}

/** Check if Multi-Output Device exists */
async function multiOutputExists(): Promise<boolean> {
    const { output } = await runJacAudio('list');
    return output.includes('Multi-Output Device');
}

/**
 * Activate Multi-Output Device as default output.
 * If it doesn't exist yet, creates it via Audio MIDI Setup GUI scripting.
 * Returns BlackHole device name for ffmpeg, or null on failure.
 */
export async function setupMacMultiOutput(): Promise<string | null> {
    if (process.platform !== 'darwin') { return null; }

    if (await multiOutputExists()) {
        const { ok } = await runJacAudio('activate');
        if (ok) { return await detectBlackHole(); }
    }

    // First-time: create via Audio MIDI Setup GUI
    const created = await createMultiOutputViaGUI();
    if (!created) { return null; }

    const { ok } = await runJacAudio('activate');
    if (!ok) { return null; }
    return await detectBlackHole();
}

/** Restore speakers as default output */
export async function restoreMacSpeakers(): Promise<void> {
    if (process.platform !== 'darwin') { return; }
    await runJacAudio('restore');
}

/** Get speaker sub-device volume (0-100) */
export async function getSpeakerVolume(): Promise<number> {
    const { ok, output } = await runJacAudio('get-volume');
    if (ok && output.startsWith('VOL:')) {
        return parseInt(output.split(':')[1], 10) || 0;
    }
    return 50;
}

/** Set speaker sub-device volume (0-100) */
export async function setSpeakerVolume(pct: number): Promise<void> {
    await runJacAudio(`set-volume`); // Needs the arg passed separately
    // runJacAudio only takes one arg — use execFileAsync directly
    const bin = jacAudioBin(_extensionPath);
    try {
        await execFileAsync(bin, ['set-volume', String(Math.round(pct))], { timeout: 3000 });
    } catch { /* ignore */ }
}

// ── Volume key daemon ───────────────────────────────────────────────────────

export interface VolumeDaemonCallbacks {
    onVolumeChange(pct: number): void;
    onMuteChange(muted: boolean): void;
}

export class VolumeDaemon {
    private proc: ChildProcess | null = null;
    private callbacks: VolumeDaemonCallbacks;
    private running = false;

    constructor(callbacks: VolumeDaemonCallbacks) {
        this.callbacks = callbacks;
    }

    start(): void {
        if (this.running) { return; }
        this.running = true;

        // Kill any leftover daemons from previous sessions
        if (process.platform !== 'win32') {
            try { require('child_process').execSync('pkill -f "jac-audio volume-daemon"', { stdio: 'ignore' }); } catch { /* none running */ }
            try { require('child_process').execSync('pkill -f "jac-audio volume-watch"', { stdio: 'ignore' }); } catch { /* none running */ }
        }

        const bin = jacAudioBin(_extensionPath);
        // Use volume-watch (polling) on macOS Sequoia+ where CGEventTap
        // can't intercept volume keys. Falls back to volume-daemon on older macOS.
        const cmd = process.platform === 'darwin' ? 'volume-watch' : 'volume-daemon';
        this.proc = spawn(bin, [cmd], { stdio: ['pipe', 'pipe', 'pipe'] });

        let buffer = '';
        this.proc.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';  // keep incomplete last line
            for (const line of lines) {
                if (line.startsWith('VOL:')) {
                    const pct = parseInt(line.split(':')[1], 10);
                    if (!isNaN(pct)) { this.callbacks.onVolumeChange(pct); }
                } else if (line.startsWith('MUTE:')) {
                    const muted = line.split(':')[1] === 'true';
                    this.callbacks.onMuteChange(muted);
                }
            }
        });

        this.proc.stderr?.on('data', () => { /* suppress */ });
        this.proc.on('close', () => { this.running = false; });
        this.proc.on('error', () => { this.running = false; });
    }

    stop(): void {
        this.running = false;
        if (this.proc) {
            this.proc.kill('SIGTERM');
            this.proc = null;
        }
    }
}

/** Create Multi-Output Device via Audio MIDI Setup GUI scripting (first-time only) */
async function createMultiOutputViaGUI(): Promise<boolean> {
    return new Promise((resolve) => {
        const script = `
            tell application "Audio MIDI Setup" to activate
            delay 3
            tell application "System Events"
                tell process "Audio MIDI Setup"
                    set frontmost to true
                    delay 1
                    set w to window 1
                    set sg to splitter group 1 of w
                    set ol to outline 1 of scroll area 1 of sg

                    set multiOutputRow to 0
                    repeat with i from 1 to (count of rows of ol)
                        set r to row i of ol
                        try
                            set els to every static text of UI element 1 of r
                            repeat with el in els
                                if (value of el as string) is "Multi-Output Device" then
                                    set multiOutputRow to i
                                end if
                            end repeat
                        end try
                        try
                            set tfs to every text field of UI element 1 of r
                            repeat with tf in tfs
                                if (value of tf as string) is "Multi-Output Device" then
                                    set multiOutputRow to i
                                end if
                            end repeat
                        end try
                    end repeat

                    if multiOutputRow is 0 then
                        click menu button 1 of sg
                        delay 0.5
                        click menu item "Create Multi-Output Device" of menu 1 of menu button 1 of sg
                        delay 2
                        set multiOutputRow to (count of rows of ol)
                    end if

                    select row multiOutputRow of ol
                    delay 1

                    set t to table 1 of scroll area 2 of sg
                    repeat with i from 1 to (count of rows of t)
                        set r to row i of t
                        try
                            set cb to checkbox 1 of UI element 1 of r
                            if (value of cb) is 0 then
                                click cb
                                delay 0.3
                            end if
                        end try
                    end repeat

                    return "OK"
                end tell
            end tell
        `;
        const proc = spawn('osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.on('close', (code) => {
            // Close Audio MIDI Setup
            spawn('osascript', ['-e', 'tell application "Audio MIDI Setup" to quit'], { stdio: 'ignore' });
            resolve(code === 0);
        });
        proc.on('error', () => resolve(false));
        setTimeout(() => { proc.kill(); resolve(false); }, 30000);
    });
}

// ── AudioCapture (cross-platform) ──────────────────────────────────────────

export class AudioCapture {
    private proc: ChildProcess | null = null;
    private callbacks: AudioCaptureCallbacks;
    private source: string;
    private running = false;
    private buffer = Buffer.alloc(0);
    private fftTimer: ReturnType<typeof setInterval> | null = null;
    private window: Float32Array;
    // Hybrid normalization: mix of global peak + per-band peak
    private peakGlobal = 0.001;
    private peakBands = new Float32Array(NUM_BANDS).fill(0.001);
    private peakDecay = 0.985;
    private prevBands = new Float32Array(NUM_BANDS);

    constructor(source: string, callbacks: AudioCaptureCallbacks) {
        this.source = source;
        this.callbacks = callbacks;
        this.window = new Float32Array(FFT_SIZE);
        for (let i = 0; i < FFT_SIZE; i++) {
            this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
        }
    }

    start(): void {
        if (this.running) { return; }
        this.running = true;

        // Prefer ScreenCaptureKit (no BlackHole needed, volume keys work)
        // Falls back to ffmpeg if native binary not available
        const nativeBin = this.findNativeBinary();
        let cmd: string;
        let args: string[];
        if (this.source === 'screencapture' && nativeBin) {
            cmd = nativeBin;
            args = ['capture-audio', String(SAMPLE_RATE)];
        } else {
            cmd = 'ffmpeg';
            args = this.buildFfmpegArgs();
        }

        this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        this.proc.stdout?.on('data', (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            const maxBytes = FFT_SIZE * 4 * 2;
            if (this.buffer.length > maxBytes) {
                this.buffer = this.buffer.subarray(this.buffer.length - maxBytes);
            }
        });

        this.proc.stderr?.on('data', () => { /* suppress */ });

        this.proc.on('error', (e) => {
            this.callbacks.onError(`ffmpeg error: ${e.message}`);
            this.stop();
        });

        this.proc.on('close', (code) => {
            if (this.running && code !== 0) {
                this.callbacks.onError(`ffmpeg exited with code ${code}`);
            }
            this.running = false;
        });

        this.fftTimer = setInterval(() => this.processFFT(), CAPTURE_INTERVAL_MS);
    }

    private findNativeBinary(): string | null {
        return _extensionPath ? jacAudioBin(_extensionPath) : null;
    }

    private buildFfmpegArgs(): string[] {
        const outputArgs = ['-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', 'pipe:1'];

        switch (process.platform) {
            case 'darwin':
                // avfoundation: audio device by name
                return ['-f', 'avfoundation', '-i', `:${this.source}`, ...outputArgs];

            case 'win32':
                // dshow: audio device by name
                return ['-f', 'dshow', '-i', `audio=${this.source}`, ...outputArgs];

            case 'linux':
                // pulse: monitor source name
                return ['-f', 'pulse', '-i', this.source, ...outputArgs];

            default:
                return ['-f', 'pulse', '-i', 'default', ...outputArgs];
        }
    }

    stop(): void {
        this.running = false;
        if (this.fftTimer) { clearInterval(this.fftTimer); this.fftTimer = null; }
        if (this.proc) {
            this.proc.kill('SIGTERM');
            this.proc = null;
        }
        this.buffer = Buffer.alloc(0);
    }

    private processFFT(): void {
        const bytesNeeded = FFT_SIZE * 4;
        if (this.buffer.length < bytesNeeded) { return; }

        const offset = this.buffer.length - bytesNeeded;
        const real = new Float32Array(FFT_SIZE);
        const imag = new Float32Array(FFT_SIZE);
        for (let i = 0; i < FFT_SIZE; i++) {
            real[i] = this.buffer.readFloatLE(offset + i * 4) * this.window[i];
            imag[i] = 0;
        }

        fft(real, imag);

        const halfN = FFT_SIZE / 2;
        const bands: number[] = new Array(NUM_BANDS);

        // First pass: compute raw magnitudes per band
        // Use logarithmic frequency mapping (like human hearing) instead of quadratic
        // This spreads bass/mid/treble more evenly across the bars
        const rawBands = new Float64Array(NUM_BANDS);
        let frameMax = 0;
        const minFreq = 20;    // Hz
        const maxFreq = 16000; // Hz
        const minBin = Math.floor(minFreq / SAMPLE_RATE * FFT_SIZE);
        const maxBin = Math.floor(maxFreq / SAMPLE_RATE * FFT_SIZE);
        const logMin = Math.log(minBin + 1);
        const logMax = Math.log(maxBin + 1);

        for (let b = 0; b < NUM_BANDS; b++) {
            const fLow = Math.floor(Math.exp(logMin + (logMax - logMin) * (b / NUM_BANDS)) - 1);
            const fHigh = Math.max(fLow + 1, Math.floor(Math.exp(logMin + (logMax - logMin) * ((b + 1) / NUM_BANDS)) - 1));
            let sum = 0;
            let count = 0;
            for (let k = fLow; k < fHigh && k < halfN; k++) {
                sum += Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
                count++;
            }
            rawBands[b] = count > 0 ? sum / count : 0;
            if (rawBands[b] > frameMax) { frameMax = rawBands[b]; }
        }

        // Hybrid normalization: 70% global peak + 30% per-band peak.
        // Global peak preserves relative loudness between bands (bass louder than treble).
        // Per-band peak gives each band some independent dynamic range.
        this.peakGlobal *= this.peakDecay;
        if (frameMax > this.peakGlobal) this.peakGlobal = frameMax;
        const globalNorm = Math.max(this.peakGlobal, 0.001);

        for (let b = 0; b < NUM_BANDS; b++) {
            this.peakBands[b] *= this.peakDecay;
            if (rawBands[b] > this.peakBands[b]) this.peakBands[b] = rawBands[b];
            const bandNorm = Math.max(this.peakBands[b], 0.0001);

            // Blend: mostly global (preserves relative levels) with some per-band (prevents flatline)
            const normFactor = globalNorm * 0.7 + bandNorm * 0.3;
            const normalized = rawBands[b] / normFactor;

            // Gentle power curve + gain
            const boosted = Math.pow(normalized, 0.5) * 1.4;

            // Soft limiter
            const compressed = boosted / (1 + boosted * 0.3);
            const clamped = Math.max(0, Math.min(1, compressed));

            // Temporal smoothing: fast attack, slow release
            const prev = this.prevBands[b];
            let smoothed;
            if (clamped > prev) {
                smoothed = prev + (clamped - prev) * (1 - SMOOTHING * 0.3);
            } else {
                smoothed = prev + (clamped - prev) * (1 - SMOOTHING);
            }
            this.prevBands[b] = smoothed;
            bands[b] = smoothed;
        }

        this.callbacks.onBands({ bands });
    }
}

// ── Radix-2 in-place FFT ───────────────────────────────────────────────────

function fft(real: Float32Array, imag: Float32Array): void {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) { j ^= bit; }
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const halfLen = len >> 1;
        const angle = -2 * Math.PI / len;
        const wReal = Math.cos(angle);
        const wImag = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curReal = 1, curImag = 0;
            for (let j = 0; j < halfLen; j++) {
                const a = i + j;
                const b = a + halfLen;
                const tReal = curReal * real[b] - curImag * imag[b];
                const tImag = curReal * imag[b] + curImag * real[b];
                real[b] = real[a] - tReal;
                imag[b] = imag[a] - tImag;
                real[a] += tReal;
                imag[a] += tImag;
                const newCurReal = curReal * wReal - curImag * wImag;
                curImag = curReal * wImag + curImag * wReal;
                curReal = newCurReal;
            }
        }
    }
}
