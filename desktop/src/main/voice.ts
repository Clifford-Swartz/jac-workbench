// Voice I/O for the desktop app.
//
// This deliberately does NOT go through jac-bridge. The bridge has F5-TTS voice cloning
// (bridge_client.py ~535) but the bridge is the disabled path — config has useRelay:false
// and the desktop app talks to OpenRouter / llama-server directly. So speech lives here.
//
// TTS: Windows SAPI via PowerShell. Electron ships no speech backend (speechSynthesis
// reports 0 voices), so the browser API is not an option. SAPI is robotic but present on
// every Windows box with zero install. The engine is isolated behind speak()/stopSpeaking()
// so a nicer one (Piper, or the bridge's F5-TTS) can be dropped in without touching callers.
//
// STT: whisper.cpp, invoked on a wav the renderer records via getUserMedia.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const VOICE_DIR = path.join(os.homedir(), '.jac', 'voice');

let speaking: ChildProcess | null = null;
let speechEnd: (() => void) | null = null;

/**
 * Register a callback for when an utterance finishes ON ITS OWN.
 *
 * Hands-free mode is half-duplex — the mic stays gated while Jac talks, or it hears
 * itself through the earpiece and re-triggers. So the loop needs to know the exact
 * moment speech ended; guessing from text length drifts badly on long replies.
 */
export function onSpeechEnd(cb: (() => void) | null): void { speechEnd = cb; }

/** Stop any in-progress speech. Safe to call when nothing is speaking. */
export function stopSpeaking(): void {
    if (!speaking) return;
    try { speaking.kill(); } catch { /* already gone */ }
    speaking = null;
}

/**
 * Speak `text` aloud. Replaces any current utterance.
 * `voice` is a substring of an installed SAPI voice name (e.g. "Zira", "David").
 */
export function speak(text: string, voice = '', rate = 0): { ok: boolean; error?: string } {
    stopSpeaking();
    const clean = ttsCleanup(text);
    if (!clean) return { ok: false, error: 'nothing to speak' };
    try {
        fs.mkdirSync(VOICE_DIR, { recursive: true });
        // Text goes via a file, not the command line: replies contain quotes, newlines and
        // $ signs that would need escaping through PowerShell's parser, and they can be long.
        const txtFile = path.join(VOICE_DIR, 'utterance.txt');
        fs.writeFileSync(txtFile, clean, 'utf8');
        const ps = path.join(VOICE_DIR, 'speak.ps1');
        fs.writeFileSync(ps, SPEAK_PS1, 'utf8');
        speaking = spawn('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps,
                '-TextFile', txtFile, '-Voice', voice, '-Rate', String(rate)],
            { windowsHide: true, stdio: 'ignore' });
        const child = speaking;
        child.on('exit', () => {
            // A child that is no longer the current one was cancelled (stopSpeaking, or a
            // new utterance replacing it). Only a natural finish closes the loop.
            if (speaking !== child) { return; }
            speaking = null;
            speechEnd?.();
        });
        child.on('error', () => { if (speaking === child) { speaking = null; } });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e) };
    }
}

/**
 * Strip the things that sound terrible read aloud. Code blocks especially — a model
 * reply with 30 lines of Python is unlistenable, so it's announced rather than spoken.
 */
export function ttsCleanup(raw: string): string {
    return raw
        .replace(/```[\s\S]*?```/g, ' . code block omitted . ')
        .replace(/^>\s?💭[^\n]*$/gm, '')            // the "thinking…" header
        .replace(/^>.*$/gm, '')                     // quoted chain-of-thought
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' image . ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // links -> their text
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_#]+/g, '')
        .replace(/\|/g, ' ')                        // table pipes
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);                            // don't monologue for ten minutes
}

const SPEAK_PS1 = String.raw`
param([string]$TextFile, [string]$Voice = '', [int]$Rate = 0)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) {
    $match = $s.GetInstalledVoices() |
             Where-Object { $_.VoiceInfo.Name -like "*$Voice*" } |
             Select-Object -First 1
    if ($match) { $s.SelectVoice($match.VoiceInfo.Name) }
}
$s.Rate = $Rate
$s.SetOutputToDefaultAudioDevice()
$s.Speak([System.IO.File]::ReadAllText($TextFile))
$s.Dispose()
`;

/** Installed SAPI voice names, for the settings UI. */
export function listVoices(): Promise<string[]> {
    return new Promise((resolve) => {
        const pr = spawn('powershell.exe', ['-NoProfile', '-Command',
            'Add-Type -AssemblyName System.Speech; ' +
            '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
            'ForEach-Object { $_.VoiceInfo.Name }'],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        pr.stdout?.on('data', d => { out += String(d); });
        const t = setTimeout(() => { try { pr.kill(); } catch { /* gone */ } resolve([]); }, 8000);
        pr.on('exit', () => { clearTimeout(t); resolve(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)); });
        pr.on('error', () => { clearTimeout(t); resolve([]); });
    });
}

// ── Speech to text ───────────────────────────────────────────────────────────

export interface SttPaths { exe: string; model: string; }

/** Locate a whisper.cpp build + model, if one has been set up. */
export function findWhisper(
    configured?: { exe?: string; model?: string },
    tier: 'fast' | 'accurate' = 'accurate',
): SttPaths | null {
    const exe = configured?.exe && fs.existsSync(configured.exe) ? configured.exe
        : [
            path.join(VOICE_DIR, 'whisper', 'whisper-cli.exe'),
            path.join(VOICE_DIR, 'whisper', 'main.exe'),
            'E:\\build\\whisper.cpp\\build\\bin\\Release\\whisper-cli.exe',
            'E:\\build\\whisper.cpp\\build\\bin\\whisper-cli.exe',
        ].find(p => fs.existsSync(p));
    if (!exe) return null;
    // Wake-word polling runs on every burst of speech in the room, so it needs a model
    // measured in hundreds of milliseconds; tiny.en does the phrase at ~450ms where
    // small.en takes ~2.5s. The actual command is transcribed once per turn, so it can
    // afford the accurate model. Same binary, different weights.
    const names = tier === 'fast'
        ? ['ggml-tiny.en.bin', 'ggml-base.en.bin', 'ggml-small.en.bin']
        : ['ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin'];
    const model = configured?.model && fs.existsSync(configured.model) ? configured.model
        : [
            ...names.map(n => path.join(VOICE_DIR, 'models', n)),
            'E:\\jac-models\\whisper\\ggml-base.en.bin',
        ].find(p => fs.existsSync(p));
    if (!model) return null;
    return { exe, model };
}

/**
 * Transcribe a wav/webm blob written by the renderer. Converts to the 16 kHz mono PCM
 * whisper.cpp requires (it rejects anything else) using the ffmpeg already on this box.
 */
export async function transcribe(
    inputFile: string, stt: SttPaths, ffmpeg: string, alreadyPcm16k = false,
): Promise<{ text: string; error?: string }> {
    // Hands-free capture writes 16 kHz mono PCM itself (the AudioContext is opened at that
    // rate), so the ffmpeg hop is pure latency on the path that is polled continuously.
    let wav: string;
    if (alreadyPcm16k) {
        wav = inputFile;
    } else {
        wav = inputFile.replace(/\.[^.]+$/, '') + '.16k.wav';
        const conv = await run(ffmpeg, ['-y', '-i', inputFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 60000);
        if (!fs.existsSync(wav)) { return { text: '', error: 'ffmpeg failed: ' + conv.slice(-300) }; }
    }
    const out = await run(stt.exe, ['-m', stt.model, '-f', wav, '-nt', '-np', '--output-txt', '-of', wav], 180000);
    let text = '';
    try { text = fs.readFileSync(wav + '.txt', 'utf8'); } catch { text = out; }
    // whisper emits bracketed non-speech markers; they are noise in a chat box
    text = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    try { if (!alreadyPcm16k) { fs.unlinkSync(wav); } fs.unlinkSync(wav + '.txt'); } catch { /* best effort */ }
    return { text };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
        const pr = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        pr.stdout?.on('data', d => { buf += String(d); });
        pr.stderr?.on('data', d => { buf += String(d); });
        const t = setTimeout(() => { try { pr.kill(); } catch { /* gone */ } resolve(buf + '\n[timeout]'); }, timeoutMs);
        pr.on('exit', () => { clearTimeout(t); resolve(buf); });
        pr.on('error', (e) => { clearTimeout(t); resolve('spawn error: ' + e.message); });
    });
}

export const VOICE_PATHS = { dir: VOICE_DIR };
