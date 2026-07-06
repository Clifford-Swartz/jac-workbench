#!/usr/bin/env node
// shell-mcp.js — a minimal MCP stdio server that gives JAC's chat agent the ability to run
// commands on this machine. Speaks the same hand-rolled JSON-RPC 2.0 / newline-stdio dialect as
// JAC's mcp/manager.ts (initialize -> tools/list -> tools/call).
//
// Two tools:
//   run_command    — run a command, block until it finishes, return stdout/stderr/exit code.
//   run_background — launch a detached / GUI / long-running program and return its PID immediately.
const { exec, spawn } = require('child_process');
const os = require('os');

const NUL = String.fromCharCode(0);
const MAX_OUT = 30000;   // cap returned text so a huge/corrupt file can't flood the chat

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(obj) { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* pipe closed */ } }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32000, message } }); }
function textResult(id, text, isError) { reply(id, { content: [{ type: 'text', text }], isError: !!isError }); }

// Make raw command output safe to return: strip NUL bytes (a corrupted/binary/UTF-16 source otherwise
// comes back as thousands of invisible blanks) and cap the size (head + tail so a trailing error survives).
function sanitize(out) {
  let notes = '';
  if (out.indexOf(NUL) >= 0) { out = out.split(NUL).join(''); notes += ' [stripped NUL bytes — source looks binary/corrupted]'; }
  if (out.length > MAX_OUT) {
    out = out.slice(0, MAX_OUT - 3000) + `\n…[${out.length - MAX_OUT} chars elided — write it to a file and read a slice]…\n` + out.slice(-3000);
    notes += ' [truncated]';
  }
  return { out, notes };
}

const TOOLS = [
  {
    name: 'run_command',
    description: 'Run a shell command on this Windows machine and return its stdout, stderr, and exit code. '
      + 'BLOCKS until the command finishes (or hits the timeout). Use it for builds, tests, git, python scripts, '
      + 'file operations — anything that completes and returns. For a program that opens a window or runs '
      + 'indefinitely (a GUI, a dev server, a watcher), use run_background instead so this call does not hang.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run, via the system shell (cmd.exe on Windows). You can chain with && .' },
        cwd: { type: 'string', description: 'Working directory to run in. Defaults to the user home directory.' },
        timeout_ms: { type: 'number', description: 'Max milliseconds to wait before killing it (default 120000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_background',
    description: 'Launch a long-running or GUI program DETACHED from this call and return immediately with its PID. '
      + 'Use this for anything that opens a window or stays running (e.g. a Tkinter teleop GUI, a dev server, a file watcher). '
      + 'The process keeps running after the tool call returns and is NOT killed when it ends. To stop it, prefer a '
      + 'GRACEFUL stop (close its window / use the stop-flag it prints / `taskkill /PID <pid>` without /F) so it can '
      + 'release USB devices and flush logs; use /F only as a last resort.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to launch, via the system shell. You can chain with && (e.g. activate a venv then run python).' },
        cwd: { type: 'string', description: 'Working directory to launch in. Defaults to the user home directory.' },
      },
      required: ['command'],
    },
  },
];

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shell', version: '0.1.0' } });
    case 'notifications/initialized':
      return; // notification, no reply
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (name === 'run_command') return runCommand(id, args);
      if (name === 'run_background') return runBackground(id, args);
      return replyErr(id, 'Unknown tool: ' + name);
    }
    default:
      if (typeof id === 'number') replyErr(id, 'Unsupported method: ' + method);
  }
}

function runCommand(id, args) {
  const cwd = args.cwd || os.homedir();
  const timeout = args.timeout_ms || 120000;
  exec(args.command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
    let raw = '';
    if (stdout) raw += String(stdout);
    if (stderr) raw += (raw ? '\n' : '') + '[stderr]\n' + String(stderr);
    const { out, notes } = sanitize(raw);
    let tail = `\n[exit code: ${code}]`;
    if (err && err.killed) tail += ' (killed — timed out after ' + timeout + 'ms)';
    if (err && /maxBuffer/i.test(String(err.message || ''))) tail += ' (output exceeded 10MB — too large; write it to a file and read a slice)';
    textResult(id, ((out + tail).trim() || `(no output) [exit code: ${code}]`) + notes, code !== 0);
  });
}

function runBackground(id, args) {
  const cwd = args.cwd || os.homedir();
  try {
    const child = spawn(args.command, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    textResult(id, `Launched in background (PID ${child.pid}) in ${cwd}:\n  ${args.command}\n`
      + `It keeps running after this call.\n`
      + `To STOP it, prefer a graceful stop so it can clean up (flush logs, release USB/devices): use the `
      + `program's own quit — close its window, or the stop-flag file it prints on startup — or `
      + `"taskkill /PID ${child.pid}" WITHOUT /F. Use /F only as a last resort: a hard kill can corrupt `
      + `half-written files and leave a USB device wedged (needing a physical replug).`, false);
  } catch (e) {
    textResult(id, 'Failed to launch: ' + (e && e.message ? e.message : String(e)), true);
  }
}
