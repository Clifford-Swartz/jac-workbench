#!/usr/bin/env python3
"""
JAC — Bridge Client

Runs on your Mac. Connects outbound to the relay as "provider".
Receives queries from clients (forwarded by relay), runs them through
Claude CLI via the Agent SDK, and streams responses back.

Usage:
    python bridge_client.py --relay wss://your-relay.onrender.com --token YOUR_TOKEN
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

try:
    import send2trash as _send2trash
except ImportError:
    _send2trash = None  # required for fs.trash, install via pip if missing

import anthropic
import websockets

from server.claude_bridge import ClaudeBridge
from server.config import ServerConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("bridge")

# Reconnect delay range (exponential backoff)
RECONNECT_MIN = 2
RECONNECT_MAX = 30

# Default model list (aliases the CLI accepts)
DEFAULT_CLAUDE_MODELS = [
    {"id": "sonnet", "label": "Sonnet (Claude)"},
    {"id": "opus", "label": "Opus (Claude)"},
    {"id": "haiku", "label": "Haiku (Claude)"},
]

OPENAI_MODELS = [
    {"id": "gpt-4o", "label": "GPT-4o"},
    {"id": "gpt-4o-mini", "label": "GPT-4o Mini"},
    {"id": "o3", "label": "o3"},
    {"id": "o4-mini", "label": "o4-mini"},
]

GEMINI_MODELS = [
    {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash"},
]

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
_openrouter_models_cache: list[dict] = []
_openrouter_cache_ts: float = 0


_openrouter_tool_support: dict[str, bool] = {}  # "or:model/id" → True if supports tools

# Per-session conversation history for OR queries. Keyed by session_id.
# Trimmed to keep the last MAX_OR_HISTORY_MESSAGES messages (system prompt is
# re-applied fresh on each query).
_openrouter_history: dict[str, list[dict]] = {}
MAX_OR_HISTORY_MESSAGES = 40  # ~20 turns worth of user+assistant exchanges

_HISTORY_DIR = os.path.expanduser("~/.jac/history")


def _history_path(session_id: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", session_id)
    return os.path.join(_HISTORY_DIR, f"{safe}.json")


# ── Filesystem ops ─────────────────────────────────────────────────────────

FS_READ_DEFAULT_MAX_BYTES = 200_000


def _fs_resolve(path: str) -> Path:
    return Path(path).expanduser().resolve(strict=False)


def fs_list(path: str) -> dict[str, Any]:
    p = _fs_resolve(path)
    if not p.exists():
        return {"type": "fs.error", "request_type": "fs.list", "path": path, "error": "not found"}
    if not p.is_dir():
        return {"type": "fs.error", "request_type": "fs.list", "path": path, "error": "not a directory"}
    entries: list[dict[str, Any]] = []
    try:
        with os.scandir(p) as it:
            for entry in it:
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                entries.append({"name": entry.name, "is_dir": entry.is_dir(follow_symlinks=False),
                                 "size": stat.st_size, "modified": stat.st_mtime})
    except PermissionError as e:
        return {"type": "fs.error", "request_type": "fs.list", "path": path, "error": str(e)}
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"type": "fs.list.response", "path": str(p), "entries": entries}


def fs_read(path: str, max_bytes: int = FS_READ_DEFAULT_MAX_BYTES) -> dict[str, Any]:
    p = _fs_resolve(path)
    if not p.exists():
        return {"type": "fs.error", "request_type": "fs.read", "path": path, "error": "not found"}
    if not p.is_file():
        return {"type": "fs.error", "request_type": "fs.read", "path": path, "error": "not a file"}
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            data = f.read(max_bytes)
        truncated = size > max_bytes
        try:
            content = data.decode("utf-8")
            encoding = "utf-8"
        except UnicodeDecodeError:
            content = base64.b64encode(data).decode("ascii")
            encoding = "base64"
        return {"type": "fs.read.response", "path": str(p), "content": content,
                "encoding": encoding, "size": size, "truncated": truncated}
    except (OSError, PermissionError) as e:
        return {"type": "fs.error", "request_type": "fs.read", "path": path, "error": str(e)}


def fs_stat(path: str) -> dict[str, Any]:
    p = _fs_resolve(path)
    if not p.exists():
        return {"type": "fs.error", "request_type": "fs.stat", "path": path, "error": "not found"}
    try:
        s = p.stat()
    except OSError as e:
        return {"type": "fs.error", "request_type": "fs.stat", "path": path, "error": str(e)}
    return {"type": "fs.stat.response", "path": str(p), "is_dir": p.is_dir(),
            "is_file": p.is_file(), "size": s.st_size, "modified": s.st_mtime}


def fs_home() -> dict[str, Any]:
    return {"type": "fs.home.response", "path": str(Path.home())}


# ── Trash (send / list / empty), cross-platform ───────────────────────────────
# Mirrors jac-provider's helpers verbatim. send-to-trash via send2trash on
# every OS; listing + emptying are per-OS (macOS reads ~/.Trash, Linux
# follows the freedesktop spec, Windows shells out to PowerShell + the
# Shell.Application COM object).

def _trash_dir_size(p: Path, max_files: int = 5000) -> int:
    total = 0
    count = 0
    try:
        for root, _, files in os.walk(p):
            for f in files:
                try:
                    total += (Path(root) / f).stat().st_size
                except OSError:
                    pass
                count += 1
                if count >= max_files:
                    return total
    except OSError:
        pass
    return total


def fs_trash(path: str) -> dict[str, Any]:
    if _send2trash is None:
        return {"type": "fs.error", "request_type": "fs.trash", "path": path,
                "error": "send2trash not installed on the daemon"}
    p = Path(path).expanduser().resolve(strict=False)
    if not p.exists():
        return {"type": "fs.error", "request_type": "fs.trash", "path": path, "error": "not found"}
    try:
        _send2trash.send2trash(str(p))
    except Exception as e:
        return {"type": "fs.error", "request_type": "fs.trash", "path": path, "error": str(e)}
    return {"type": "fs.trash.response", "path": str(p)}


def _trash_list_mac() -> dict[str, Any]:
    trash = Path.home() / ".Trash"
    entries: list[dict[str, Any]] = []
    total = 0
    if not trash.is_dir():
        return {"type": "fs.trash.list.response", "platform": "darwin",
                "entries": entries, "total_size": 0}
    try:
        with os.scandir(trash) as it:
            for entry in it:
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                is_dir = entry.is_dir(follow_symlinks=False)
                size = _trash_dir_size(Path(entry.path)) if is_dir else stat.st_size
                entries.append({
                    "name": entry.name, "path": entry.path,
                    "is_dir": is_dir, "size": size, "modified": stat.st_mtime,
                    "original_path": None,
                })
                total += size
    except PermissionError as e:
        return {"type": "fs.error", "request_type": "fs.trash.list", "error": str(e)}
    entries.sort(key=lambda e: e["modified"], reverse=True)
    return {"type": "fs.trash.list.response", "platform": "darwin",
            "entries": entries, "total_size": total}


def _trash_list_linux() -> dict[str, Any]:
    base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "Trash"
    files_dir = base / "files"
    info_dir = base / "info"
    entries: list[dict[str, Any]] = []
    total = 0
    if not files_dir.is_dir():
        return {"type": "fs.trash.list.response", "platform": "linux",
                "entries": entries, "total_size": 0}
    try:
        with os.scandir(files_dir) as it:
            for entry in it:
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                is_dir = entry.is_dir(follow_symlinks=False)
                size = _trash_dir_size(Path(entry.path)) if is_dir else stat.st_size
                original = None
                info_path = info_dir / f"{entry.name}.trashinfo"
                if info_path.exists():
                    try:
                        for line in info_path.read_text().splitlines():
                            if line.startswith("Path="):
                                original = urllib.parse.unquote(line[5:])
                                break
                    except OSError:
                        pass
                entries.append({
                    "name": entry.name, "path": entry.path,
                    "is_dir": is_dir, "size": size, "modified": stat.st_mtime,
                    "original_path": original,
                })
                total += size
    except PermissionError as e:
        return {"type": "fs.error", "request_type": "fs.trash.list", "error": str(e)}
    entries.sort(key=lambda e: e["modified"], reverse=True)
    return {"type": "fs.trash.list.response", "platform": "linux",
            "entries": entries, "total_size": total}


_WIN_TRASH_LIST_PS = r'''
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$bin = $shell.NameSpace(0xA)
$out = @()
foreach ($item in $bin.Items()) {
    $orig = $bin.GetDetailsOf($item, 1)
    $size = 0
    try { $size = (Get-Item -LiteralPath $item.Path -Force).Length } catch {}
    if (-not $size -and $item.IsFolder) {
        try {
            $size = (Get-ChildItem -LiteralPath $item.Path -Recurse -Force -ErrorAction SilentlyContinue |
                     Measure-Object -Property Length -Sum).Sum
        } catch { $size = 0 }
    }
    $out += [PSCustomObject]@{
        name = $item.Name
        path = $item.Path
        is_dir = [bool]$item.IsFolder
        size = [int64]([double]($size -as [int64]))
        modified = [int64](([DateTimeOffset]$item.ModifyDate).ToUnixTimeSeconds())
        original_path = $orig
    }
}
$out | ConvertTo-Json -Compress -Depth 4
'''


def _trash_list_win() -> dict[str, Any]:
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _WIN_TRASH_LIST_PS],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0:
            return {"type": "fs.error", "request_type": "fs.trash.list",
                    "error": (proc.stderr or "powershell failed").strip()}
        out = (proc.stdout or "").strip() or "[]"
        try:
            data = json.loads(out)
        except json.JSONDecodeError as e:
            return {"type": "fs.error", "request_type": "fs.trash.list",
                    "error": f"powershell output not JSON: {e}"}
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            data = []
        total = sum(int(d.get("size") or 0) for d in data)
        return {"type": "fs.trash.list.response", "platform": "win32",
                "entries": data, "total_size": total}
    except Exception as e:
        return {"type": "fs.error", "request_type": "fs.trash.list", "error": str(e)}


def fs_trash_list() -> dict[str, Any]:
    if sys.platform == "darwin":
        return _trash_list_mac()
    if sys.platform == "win32":
        return _trash_list_win()
    if sys.platform.startswith("linux"):
        return _trash_list_linux()
    return {"type": "fs.error", "request_type": "fs.trash.list",
            "error": f"trash listing not supported on {sys.platform}"}


def _trash_empty_dirs(dirs: list[Path]) -> dict[str, Any]:
    items = 0
    total = 0
    errors: list[str] = []
    for d in dirs:
        if not d.is_dir():
            continue
        try:
            with os.scandir(d) as it:
                for entry in it:
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                        size = _trash_dir_size(Path(entry.path)) if is_dir else \
                               entry.stat(follow_symlinks=False).st_size
                        if is_dir:
                            shutil.rmtree(entry.path, ignore_errors=True)
                        else:
                            os.unlink(entry.path)
                        items += 1
                        total += size
                    except OSError as e:
                        errors.append(f"{entry.path}: {e}")
        except OSError as e:
            errors.append(f"{d}: {e}")
    resp: dict[str, Any] = {"type": "fs.trash.empty.response", "items": items, "bytes": total}
    if errors:
        resp["partial_errors"] = errors[:10]
    return resp


def _trash_empty_win() -> dict[str, Any]:
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
             "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0 and (proc.stderr or "").strip():
            return {"type": "fs.error", "request_type": "fs.trash.empty",
                    "error": proc.stderr.strip()}
        return {"type": "fs.trash.empty.response", "items": -1, "bytes": -1}
    except Exception as e:
        return {"type": "fs.error", "request_type": "fs.trash.empty", "error": str(e)}


def fs_trash_empty() -> dict[str, Any]:
    if sys.platform == "darwin":
        return _trash_empty_dirs([Path.home() / ".Trash"])
    if sys.platform == "win32":
        return _trash_empty_win()
    if sys.platform.startswith("linux"):
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "Trash"
        return _trash_empty_dirs([base / "files", base / "info"])
    return {"type": "fs.error", "request_type": "fs.trash.empty",
            "error": f"trash empty not supported on {sys.platform}"}


# ── environment_details ─────────────────────────────────────────────────────

_ENV_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".env",
    "dist", "build", ".next", ".expo", ".turbo", ".cache", ".parcel-cache",
    ".idea", ".vscode", "target", ".gradle", ".dart_tool",
    "Pods", "DerivedData", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "site-packages", "__MACOSX",
}
ENV_MAX_FILES = 300


def build_environment_details(cwd: str) -> str:
    p = Path(cwd).expanduser()
    try:
        p = p.resolve(strict=True)
    except (OSError, RuntimeError):
        return f"<environment_details>\n# Working directory not found: {cwd}\n</environment_details>"
    if not p.is_dir():
        return f"<environment_details>\n# Not a directory: {cwd}\n</environment_details>"
    rels: list[str] = []
    truncated = False
    for root, dirs, files in os.walk(p):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in _ENV_SKIP_DIRS]
        for f in files:
            if f.startswith("."):
                continue
            full = Path(root) / f
            try:
                rel = full.relative_to(p)
            except ValueError:
                continue
            rels.append(str(rel))
            if len(rels) >= ENV_MAX_FILES:
                truncated = True
                break
        if truncated:
            break
    rels.sort()
    note = f" (truncated to {ENV_MAX_FILES})" if truncated else ""
    body = "\n".join(rels) if rels else "(no source files)"
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return (f"<environment_details>\n"
            f"# Current Working Directory ({p}) Files{note}\n"
            f"{body}\n"
            f"# Current Time\n"
            f"{now}\n"
            f"</environment_details>")


# ── History helpers ─────────────────────────────────────────────────────────

def _save_or_history(session_id: str, msgs: list[dict]) -> None:
    try:
        os.makedirs(_HISTORY_DIR, exist_ok=True)
        with open(_history_path(session_id), "w") as f:
            json.dump(msgs, f)
    except Exception:
        pass


def _load_or_history(session_id: str) -> list[dict]:
    try:
        with open(_history_path(session_id)) as f:
            return json.load(f)
    except Exception:
        return []


def _trim_or_history(msgs: list[dict]) -> list[dict]:
    """Trim conversation history. Keeps system prompt + most recent messages.

    Tool-call sequences must stay consecutive (assistant tool_calls → tool
    results) so we walk backwards and never split a tool-call block.
    """
    if len(msgs) <= MAX_OR_HISTORY_MESSAGES:
        return msgs
    # Split system (always kept) from the rest
    system = [m for m in msgs if m.get("role") == "system"]
    rest = [m for m in msgs if m.get("role") != "system"]
    # Keep the last MAX_OR_HISTORY_MESSAGES of rest, but don't start on an
    # orphaned "tool" message (it would reference an assistant that's gone)
    keep = rest[-MAX_OR_HISTORY_MESSAGES:]
    while keep and keep[0].get("role") == "tool":
        keep = keep[1:]
    return system + keep


def _fetch_openrouter_models() -> list[dict]:
    """Fetch full OpenRouter model catalog, cached for 10 minutes."""
    global _openrouter_models_cache, _openrouter_cache_ts
    import time
    if not OPENROUTER_API_KEY:
        return []
    now = time.time()
    if _openrouter_models_cache and (now - _openrouter_cache_ts) < 600:
        return _openrouter_models_cache
    try:
        import urllib.request
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        models = []
        tool_count = 0
        for m in data.get("data", []):
            mid = m.get("id", "")
            name = m.get("name", mid)
            if not mid:
                continue
            supports_tools = "tools" in (m.get("supported_parameters") or [])
            key = f"or:{mid}"
            _openrouter_tool_support[key] = supports_tools
            if supports_tools:
                tool_count += 1
                label = f"{name} (OR)"
            else:
                label = f"{name} (OR, no tools)"
            models.append({"id": key, "label": label})
        _openrouter_models_cache = models
        _openrouter_cache_ts = now
        log.info("Fetched %d OpenRouter models (%d support tool use)",
                 len(models), tool_count)
        return models
    except Exception as e:
        log.warning("Failed to fetch OpenRouter models: %s", e)
        return _openrouter_models_cache  # fall back to stale cache if any

# Machine ID for multi-provider routing
# os.uname() is POSIX-only (crashes on Windows at import). Python evaluates
# the second arg to getenv before passing it as a default, so the unconditional
# call would fire even when JAC_MACHINE_ID is set. socket.gethostname() is
# cross-platform and gives the same value on macOS/Linux.
MACHINE_ID = os.getenv("JAC_MACHINE_ID") or socket.gethostname()


def find_cli(name: str) -> str | None:
    """Find a CLI binary, checking common locations.

    Cross-platform: shutil.which honors PATHEXT on Windows, but only when
    the lookup name itself includes the extension or matches a PATHEXT entry.
    Try the bare name first (handles `claude.cmd` shim, native macOS/Linux
    binaries) then explicit `.exe` / `.cmd` suffixes for Windows.
    """
    for candidate in (name, f"{name}.exe", f"{name}.cmd"):
        found = shutil.which(candidate)
        if found:
            return found
    # VS Code extension fallback. Mac/Linux ship the binary as `claude`,
    # Windows as `claude.exe`. The extension folder name carries the
    # platform suffix (`...-darwin-arm64`, `...-win32-x64`), which the glob
    # unfolds.
    if name == "claude":
        import glob
        base = os.path.expanduser(
            "~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/"
        )
        for binname in ("claude", "claude.exe", "claude.cmd"):
            matches = sorted(glob.glob(base + binname), reverse=True)
            if matches:
                return matches[0]
    return None


def _is_codex_logged_in() -> bool:
    """Check if Codex CLI is authenticated."""
    codex = find_cli("codex")
    if not codex:
        return False
    try:
        result = subprocess.run(
            [codex, "login", "status"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def _is_gemini_logged_in() -> bool:
    """Check if Gemini CLI has auth configured."""
    import pathlib
    settings = pathlib.Path.home() / ".gemini" / "settings.json"
    if not settings.exists():
        return False
    try:
        data = json.loads(settings.read_text())
        # Has an API key or auth method configured
        return bool(data)
    except Exception:
        return False


def _detect_local_llm_models() -> list[dict]:
    """Detect locally running llama-server instances and their models."""
    import urllib.request
    models = []

    # Check default local port
    ports = [8787]

    # Check environment for additional endpoints
    # JAC_LLM_ENDPOINTS="http://192.168.1.50:8080,http://homepc:8787"
    extra = os.environ.get("JAC_LLM_ENDPOINTS", "")
    endpoints = [f"http://127.0.0.1:{p}" for p in ports]
    if extra:
        endpoints.extend([e.strip() for e in extra.split(",") if e.strip()])

    for endpoint in endpoints:
        try:
            req = urllib.request.Request(f"{endpoint}/v1/models", method="GET")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=2) as resp:
                data = json.loads(resp.read())
                for m in data.get("data", []):
                    model_id = m.get("id", "")
                    # Clean up the model ID (remove path, .gguf extension)
                    label = model_id.split("/")[-1].replace(".gguf", "").replace("-Q4_K_M", "")
                    is_local = "127.0.0.1" in endpoint or "localhost" in endpoint
                    import socket
                    source = socket.gethostname().split(".")[0] if is_local else endpoint.split("//")[1].split(":")[0]
                    models.append({
                        "id": f"llm:{model_id}",
                        "label": f"{label} ({source})",
                        "endpoint": endpoint,
                    })
                    log.info("LLM model found at %s: %s", endpoint, label)
        except Exception:
            pass  # endpoint not reachable

    return models


def get_available_models(cli_path: str | None = None) -> list[dict]:
    """Discover all available models based on installed AND authenticated CLIs."""
    models = []

    # ── Claude (via CLI or VS Code extension) ────────────────────────────
    claude_cli = cli_path or find_cli("claude")
    if claude_cli:
        models.extend(DEFAULT_CLAUDE_MODELS)
        log.info("Claude CLI found: %s", claude_cli)

    # ── OpenAI Codex CLI (only if logged in) ─────────────────────────────
    codex_cli = find_cli("codex")
    if codex_cli and _is_codex_logged_in():
        models.extend(OPENAI_MODELS)
        log.info("Codex CLI found and authenticated: %s", codex_cli)
    elif codex_cli:
        log.info("Codex CLI found but NOT logged in: %s (run 'codex login')", codex_cli)

    # ── Gemini CLI (only if auth configured) ─────────────────────────────
    gemini_cli = find_cli("gemini")
    if gemini_cli and _is_gemini_logged_in():
        models.extend(GEMINI_MODELS)
        log.info("Gemini CLI found and authenticated: %s", gemini_cli)
    elif gemini_cli:
        log.info("Gemini CLI found but NOT authenticated: %s (run 'gemini' to set up)", gemini_cli)

    # ── OpenRouter (if API key configured) ─────────────────────────────
    if OPENROUTER_API_KEY:
        or_models = _fetch_openrouter_models()
        if or_models:
            models.extend(or_models)

    # ── Local/remote LLM servers (llama-server, vLLM, etc.) ──────────────
    llm_models = _detect_local_llm_models()
    models.extend(llm_models)

    return models if models else DEFAULT_CLAUDE_MODELS


def is_claude_model(model_id: str) -> bool:
    """Check if a model ID is a Claude model."""
    return model_id in {"sonnet", "opus", "haiku"} or "claude" in model_id.lower()


def is_openai_model(model_id: str) -> bool:
    """Check if a model ID is an OpenAI model."""
    return model_id.startswith("gpt-") or model_id.startswith("o3") or model_id.startswith("o4")


def is_gemini_model(model_id: str) -> bool:
    """Check if a model ID is a Gemini model."""
    return "gemini" in model_id.lower()


def is_openrouter_model(model_id: str) -> bool:
    """Check if a model ID is an OpenRouter model."""
    return model_id.startswith("or:")


# ── OpenRouter tool use ─────────────────────────────────────────────────────

# Risk classification — foundation for the full permission system.
# Used by the lethal-bash check now; will drive allowlists/prompts later.
TOOL_RISK = {
    # Read-only — safe to auto-run
    "read_file": "safe",
    "list_directory": "safe",
    "glob": "safe",
    "grep": "safe",
    "fetch_url": "safe",
    "view_image": "safe",
    "git": "safe",             # subcommand-level risk handled inside the executor

    # Mutating — will require approval in strict mode
    "write_file": "write",
    "edit_file": "write",
    "apply_patch": "write",
    "cad_execute": "write",
    "schematic_command": "write",
    "open_panel": "write",

    # Full shell access — always highest scrutiny
    "bash": "dangerous",
}

# Patterns that should NEVER execute, regardless of permission mode.
# These are things a rogue model could do to wreck the bridge machine or
# exfiltrate secrets. Added conservatively — better to reject a legit command
# than let one of these through.
LETHAL_BASH_PATTERNS = [
    # Catastrophic deletes
    r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(/|~|\$HOME|/\*|/\s|~/\s|~/$|\.\.)",
    r"\brm\s+-rf\s+/\S*",
    # Privilege escalation
    r"\bsudo\b",
    r"\bsu\s+-",
    r"\bdoas\b",
    # Pipe-to-shell from network (classic supply-chain attack)
    r"(curl|wget|fetch)[^|;&]*\|\s*(sh|bash|zsh|python|python3|perl|node)\b",
    # Filesystem destruction
    r"\bmkfs\.",
    r"\bdd\b[^\n]*\b(if|of)=/dev/(sd|nvme|disk|rdisk|zero|random|urandom)",
    r">\s*/dev/(sd|nvme|disk|rdisk)",
    # Fork bomb
    r":\(\)\s*\{\s*:\|:&\s*\}\s*;:",
    # System state changes
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bhalt\b",
    r"\bpoweroff\b",
    # User / password management
    r"\bpasswd\b",
    r"\buseradd\b",
    r"\buserdel\b",
    r"\busermod\b",
    # Opening up permissions on critical paths
    r"\bchmod\s+(-R\s+)?[0-7]*7{2,}[0-7]*\s+/",
    r"\bchmod\s+(-R\s+)?\+\S*w\S*\s+/etc",
    # Wiping git history / force pushing to main
    r"\bgit\s+push\s+[^\n]*--force[^\n]*\b(main|master|trunk)\b",
    r"\bgit\s+push\s+[^\n]*\b(main|master|trunk)\b[^\n]*--force\b",
    # Secret exfiltration — reading SSH keys / cloud creds and piping out
    r"cat\s+[^|;&]*\.ssh/id_\S+[^|;&]*\|\s*(curl|nc|wget|base64)",
    r"cat\s+[^|;&]*\.aws/credentials[^|;&]*\|\s*(curl|nc|wget)",
    # Cron persistence
    r"\bcrontab\s+-[^l]",  # -l is list (safe); anything else modifies
    # Process mass-kill
    r"\bkillall\s+-9\s+\.",
    r"\bkill\s+-9\s+-1\b",
]

_LETHAL_BASH_RE = [re.compile(p, re.IGNORECASE) for p in LETHAL_BASH_PATTERNS]


def check_bash_lethal(command: str) -> str | None:
    """Return the pattern that matched if the command is lethal, else None."""
    for rx in _LETHAL_BASH_RE:
        m = rx.search(command)
        if m:
            return rx.pattern
    return None


# ── Permission system ───────────────────────────────────────────────────────
# Three modes, from most to least restrictive:
#   strict         — all write/dangerous tools prompt the user
#   acceptWrites   — write tools auto-run; dangerous tools still prompt
#   bypass         — everything auto-runs (still subject to lethal-bash check)

PERMISSION_MODES = ("strict", "acceptWrites", "bypass")
DEFAULT_PERMISSION_MODE = "strict"

# Tools that accept a file path as their primary argument (for allow/deny checks)
FILE_PATH_TOOLS = {
    "read_file": "path",
    "write_file": "path",
    "edit_file": "path",
    "apply_patch": "path",
    "list_directory": "path",
    "view_image": "path",
    "glob": "cwd",
    "grep": "path",
}

# Default global denylist — always rejected regardless of mode/config.
# Meant to protect secrets on the bridge machine.
GLOBAL_DENY_PATHS = [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.config/gcloud",
    "~/.kube",
    "~/.docker/config.json",
    "~/.netrc",
    "~/.pypirc",
    "~/Library/Keychains",
]


class PermissionManager:
    """Per-session permission state and tool gating logic."""

    def __init__(self):
        import os
        self.config_path = os.path.expanduser("~/.jac/permissions.json")
        self.config: dict = {}
        self.session_modes: dict[str, str] = {}  # session_id → mode
        self.pending_permissions: dict[str, asyncio.Future[bool]] = {}
        self.load_config()

    def load_config(self) -> None:
        import os
        defaults = {
            "default_mode": DEFAULT_PERMISSION_MODE,
            "owner_session_ids": [],
            "sessions": {},
            "global_denied_paths": GLOBAL_DENY_PATHS,
            "allowlist": [],  # list of {tool, match, scope}
        }
        if not os.path.exists(self.config_path):
            log.info("No permission config at %s — using defaults (strict mode)", self.config_path)
            self.config = defaults
            return
        try:
            with open(self.config_path, "r") as f:
                self.config = json.load(f)
            # Backfill any new fields
            for k, v in defaults.items():
                self.config.setdefault(k, v)
            log.info("Loaded permission config from %s (%d allowlist entries)",
                     self.config_path, len(self.config.get("allowlist", [])))
        except Exception as e:
            log.error("Failed to load permission config: %s — using defaults", e)
            self.config = defaults

    def save_config(self) -> None:
        import os
        try:
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            with open(self.config_path, "w") as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            log.error("Failed to save permission config: %s", e)

    def mode_for(self, session_id: str) -> str:
        # Session override (set via set_permission_mode message)
        if session_id in self.session_modes:
            return self.session_modes[session_id]
        # Owner sessions always bypass
        if session_id in self.config.get("owner_session_ids", []):
            return "bypass"
        # Config file session rule
        rule = self.config.get("sessions", {}).get(session_id) or {}
        if rule.get("mode") in PERMISSION_MODES:
            return rule["mode"]
        # Default
        return self.config.get("default_mode", DEFAULT_PERMISSION_MODE)

    def set_mode(self, session_id: str, mode: str) -> bool:
        if mode not in PERMISSION_MODES:
            return False
        self.session_modes[session_id] = mode
        log.info("Session %s mode set to %s", session_id[:8], mode)
        return True

    def _norm_path(self, p: str) -> str:
        import os
        return os.path.abspath(os.path.expanduser(p))

    def _make_signature(self, tool_name: str, tool_input: dict, cwd: str) -> tuple[str, str]:
        """Return (scope, match) describing this tool invocation for allowlist lookup.

        scope:
          - 'prefix'   : match if command starts with this (bash)
          - 'dirtree'  : match if path is within this directory (file tools)
          - 'tool'     : match just the tool name (everything else)
        """
        import os
        if tool_name == "bash":
            cmd = (tool_input.get("command") or "").strip()
            # Take the first token, and if it's git/npm/etc add the subcommand too
            tokens = cmd.split()
            if not tokens:
                return ("prefix", "")
            if len(tokens) >= 2 and tokens[0] in (
                "git", "npm", "pnpm", "yarn", "cargo", "brew", "pip", "pip3",
                "python", "python3", "node", "deno", "go", "make", "docker",
            ):
                return ("prefix", f"{tokens[0]} {tokens[1]}")
            return ("prefix", tokens[0])

        if tool_name in FILE_PATH_TOOLS:
            arg = FILE_PATH_TOOLS[tool_name]
            raw = tool_input.get(arg) or cwd
            raw = os.path.expanduser(os.path.expandvars(raw))
            if not os.path.isabs(raw):
                raw = os.path.join(cwd, raw)
            # For files, use the parent directory so the allowlist entry covers siblings.
            # For directories, use the directory itself.
            if os.path.isdir(raw):
                return ("dirtree", os.path.abspath(raw))
            return ("dirtree", os.path.abspath(os.path.dirname(raw)))

        return ("tool", tool_name)

    def _check_allowlist(self, tool_name: str, signature: tuple[str, str]) -> bool:
        """Return True if this invocation is covered by the allowlist."""
        import os
        scope, match = signature
        for entry in self.config.get("allowlist", []):
            if entry.get("tool") != tool_name:
                continue
            e_scope = entry.get("scope", "")
            e_match = entry.get("match", "")
            if e_scope != scope:
                continue
            if scope == "prefix":
                if match.startswith(e_match):
                    return True
            elif scope == "dirtree":
                try:
                    common = os.path.commonpath([match, e_match])
                    if common == e_match:
                        return True
                except ValueError:
                    pass
            elif scope == "tool":
                if match == e_match:
                    return True
        return False

    def add_to_allowlist(self, tool_name: str, signature: tuple[str, str]) -> None:
        scope, match = signature
        entry = {"tool": tool_name, "scope": scope, "match": match}
        # Dedupe
        for existing in self.config.get("allowlist", []):
            if existing == entry:
                return
        self.config.setdefault("allowlist", []).append(entry)
        self.save_config()
        log.info("Added to allowlist: %s", entry)

    def _path_denied(self, path: str, session_id: str) -> str | None:
        """Return the deny rule that matched, or None if allowed."""
        import os
        norm = self._norm_path(path)
        # Global denylist
        for denied in self.config.get("global_denied_paths", GLOBAL_DENY_PATHS):
            denied_norm = self._norm_path(denied)
            if norm == denied_norm or norm.startswith(denied_norm + os.sep):
                return f"global denylist: {denied}"
        # Session-specific denylist
        rule = self.config.get("sessions", {}).get(session_id) or {}
        for denied in rule.get("denied_paths", []):
            denied_norm = self._norm_path(denied)
            if norm == denied_norm or norm.startswith(denied_norm + os.sep):
                return f"session denylist: {denied}"
        # Session-specific allowlist (if set, path must match)
        allowlist = rule.get("allowed_paths")
        if allowlist:
            for allowed in allowlist:
                allowed_norm = self._norm_path(allowed)
                if norm == allowed_norm or norm.startswith(allowed_norm + os.sep):
                    return None
            return f"not in allowlist for session"
        return None

    async def check_tool(
        self,
        tool_name: str,
        tool_input: dict,
        session_id: str,
        cwd: str,
        send_fn,
    ) -> tuple[bool, str | None]:
        """Return (allowed, deny_reason)."""
        import os
        mode = self.mode_for(session_id)
        risk = TOOL_RISK.get(tool_name, "dangerous")

        # Path checks first (reject before prompting, save the user a click)
        path_arg_name = FILE_PATH_TOOLS.get(tool_name)
        if path_arg_name:
            raw_path = tool_input.get(path_arg_name) or cwd
            # Expand ~ and env vars BEFORE joining with cwd
            raw_path = os.path.expanduser(os.path.expandvars(raw_path))
            if not os.path.isabs(raw_path):
                raw_path = os.path.join(cwd, raw_path)
            denied = self._path_denied(raw_path, session_id)
            if denied:
                return False, f"Path denied ({denied})"

        # Decide based on mode + risk
        auto_allow = False
        if mode == "bypass":
            auto_allow = True
        elif mode == "acceptWrites":
            auto_allow = risk in ("safe", "write")
        elif mode == "strict":
            auto_allow = risk == "safe"

        if auto_allow:
            return True, None

        # Check the remembered allowlist
        signature = self._make_signature(tool_name, tool_input, cwd)
        if self._check_allowlist(tool_name, signature):
            log.info("Allowlist hit for %s (%s)", tool_name, signature)
            return True, None

        # Prompt the user (with allowlist suggestion so the UI can offer "always")
        import uuid
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[tuple[bool, bool]] = loop.create_future()
        self.pending_permissions[request_id] = future

        try:
            await send_fn({
                "type": "permission_request",
                "request_id": request_id,
                "tool_name": tool_name,
                "tool_input": tool_input,
                "session_id": session_id,
                "allowlist_suggestion": {
                    "scope": signature[0],
                    "match": signature[1],
                },
            })
            try:
                result = await asyncio.wait_for(future, timeout=300.0)
                if isinstance(result, tuple):
                    allowed, remember = result
                else:
                    allowed, remember = bool(result), False
            except asyncio.TimeoutError:
                allowed, remember = False, False
                log.warning("Permission request timed out for %s (session %s)",
                            tool_name, session_id[:8])
        finally:
            self.pending_permissions.pop(request_id, None)

        if allowed and remember:
            self.add_to_allowlist(tool_name, signature)

        return (True, None) if allowed else (False, "Denied by user")

    def resolve(self, request_id: str, allow: bool, remember: bool = False) -> None:
        future = self.pending_permissions.get(request_id)
        if future and not future.done():
            future.set_result((allow, remember))


# Module-level singleton
_permission_manager = PermissionManager()


# Tools exposed to OpenRouter models so they can read/write/search the host
OPENROUTER_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command on the host machine. Use for flexible operations: running scripts, checking processes, git, etc. Output is truncated to 10k chars.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to run"},
                    "cwd": {"type": "string", "description": "Working directory (optional, defaults to user's cwd)"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file from the host filesystem. Content is truncated to 20k chars.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute or relative path to the file"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to write to"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and subdirectories in a directory. Directories are marked with trailing /.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path (default: current working directory)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "Find files matching a glob pattern. Use ** for recursive matching (e.g. '**/*.py').",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern"},
                    "cwd": {"type": "string", "description": "Directory to search in (optional)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search for a regex pattern in files. Returns matching lines with file:line prefix.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search for"},
                    "path": {"type": "string", "description": "Directory or file to search (default: cwd)"},
                    "glob": {"type": "string", "description": "File glob filter, e.g. '*.py' (optional)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Find-and-replace in an existing file. More efficient than read+write for small edits. The old_string must appear exactly once in the file (use more surrounding context to disambiguate).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file to edit"},
                    "old_string": {"type": "string", "description": "Exact text to find (must be unique in the file)"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                    "replace_all": {"type": "boolean", "description": "If true, replace all occurrences (default: false)"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_patch",
            "description": (
                "Apply one or more SEARCH/REPLACE edits to a file. "
                "Preferred over edit_file for multi-location changes and over write_file for any edit to an existing file. "
                "Format the `patch` parameter as one or more blocks:\n"
                "<<<<<<< SEARCH\n"
                "exact lines to find\n"
                "=======\n"
                "replacement lines\n"
                ">>>>>>> REPLACE\n"
                "Each SEARCH string must match exactly (including whitespace). "
                "Blocks are applied top-to-bottom; earlier replacements affect later searches."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file to edit"},
                    "patch": {"type": "string", "description": "One or more SEARCH/REPLACE blocks"},
                },
                "required": ["path", "patch"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "Fetch content from a URL via HTTP GET. HTML is stripped to plain text. Use for reading documentation, API responses, READMEs on the web.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL (http:// or https://)"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cad_execute",
            "description": "Execute build123d Python code in the CAD panel. Generate 3D geometry — the final expression must be assigned to RESULT (a Part or Compound). Returns mesh info for rendering in the 3D viewer. Requires the CAD panel to be open.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "build123d Python code. Must end with RESULT = <Part>"},
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schematic_command",
            "description": "Run a schematic editor command to place components, wire them, or query the schematic. Commands: 'add <type> <x> <y>' to place a component (e.g. 'add 555 200 200'), 'wire <ref1> <pin1> <ref2> <pin2>' to connect pins, 'list' to show all components. Requires the PCB panel to be open.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Schematic command string"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_panel",
            "description": "Open a JAC panel on the user's VSCode window. Use this before calling cad_execute (requires 'cad'), schematic_command (requires 'pcb'), or anything needing the browser or music panel.",
            "parameters": {
                "type": "object",
                "properties": {
                    "panel": {
                        "type": "string",
                        "enum": ["cad", "pcb", "browser", "music"],
                        "description": "Which panel to open",
                    },
                },
                "required": ["panel"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git",
            "description": "Run structured git operations. Returns clean output for common commands. Use bash if you need something this doesn't support.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subcommand": {
                        "type": "string",
                        "enum": ["status", "diff", "log", "branch", "add", "commit", "push", "pull", "show"],
                        "description": "The git subcommand to run",
                    },
                    "args": {
                        "type": "string",
                        "description": "Extra arguments: for diff/show a file path, for log a number of commits, for add file paths, for commit the message, for branch a name.",
                    },
                    "cwd": {"type": "string", "description": "Repo directory (optional)"},
                },
                "required": ["subcommand"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "view_image",
            "description": "Load an image file (PNG/JPG/GIF/WebP) and add it to the conversation so you can see it. Works with vision-capable models (Claude, GPT-4o, Gemini, Llama 4).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the image file"},
                },
                "required": ["path"],
            },
        },
    },
]


async def execute_openrouter_tool(
    name: str,
    args: dict,
    cwd: str,
    messages: list | None = None,
    send_fn=None,
    session_id: str = "",
) -> str:
    """Execute a single tool call on the host and return the result as text.

    messages: mutable list of chat messages — view_image appends a user message
        with the image content so the next model turn sees it.
    send_fn: callback to the client (used by open_panel to ask the extension
        to open a VSCode panel).
    """
    import os
    try:
        if name == "bash":
            cmd = args.get("command", "")
            lethal = check_bash_lethal(cmd)
            if lethal:
                log.warning("BLOCKED lethal bash command: %s (matched: %s)", cmd[:100], lethal)
                return (
                    f"Error: command blocked by safety filter (matched pattern: {lethal}). "
                    "This command was refused because it could irreversibly damage the host "
                    "machine, exfiltrate secrets, or escalate privileges. If you genuinely "
                    "need to run it, ask the user to do so manually."
                )
            tcwd = args.get("cwd") or cwd
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=tcwd,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
            except asyncio.TimeoutError:
                proc.kill()
                return "Error: command timed out after 60s"
            out = stdout.decode(errors="replace") + stderr.decode(errors="replace")
            return out[:10000] if out else f"(exit code {proc.returncode})"

        elif name == "read_file":
            path = args.get("path", "")
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            with open(path, "r", errors="replace") as f:
                content = f.read()
            return content[:20000]

        elif name == "write_file":
            path = args.get("path", "")
            content = args.get("content", "")
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "w") as f:
                f.write(content)
            return f"Wrote {len(content)} chars to {path}"

        elif name == "list_directory":
            path = args.get("path") or cwd
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            entries = os.listdir(path)
            lines = []
            for e in sorted(entries):
                full = os.path.join(path, e)
                lines.append(f"{e}/" if os.path.isdir(full) else e)
            return "\n".join(lines) or "(empty directory)"

        elif name == "glob":
            import glob as glob_mod
            pattern = args.get("pattern", "")
            gcwd = args.get("cwd") or cwd
            full_pattern = pattern if os.path.isabs(pattern) else os.path.join(gcwd, pattern)
            matches = glob_mod.glob(full_pattern, recursive=True)
            return "\n".join(matches[:100]) if matches else "(no matches)"

        elif name == "grep":
            pattern = args.get("pattern", "")
            path = args.get("path") or cwd
            globarg = args.get("glob", "")
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            cmd = ["grep", "-rEn"]
            if globarg:
                cmd.extend(["--include", globarg])
            cmd.extend([pattern, path])
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
            except asyncio.TimeoutError:
                proc.kill()
                return "Error: grep timed out"
            out = stdout.decode(errors="replace")
            return out[:10000] if out else "(no matches)"

        elif name == "edit_file":
            path = args.get("path", "")
            old_string = args.get("old_string", "")
            new_string = args.get("new_string", "")
            replace_all = args.get("replace_all", False)
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            with open(path, "r", errors="replace") as f:
                content = f.read()
            if old_string not in content:
                return f"Error: old_string not found in {path}"
            if replace_all:
                count = content.count(old_string)
                new_content = content.replace(old_string, new_string)
                msg = f"Replaced {count} occurrence(s)"
            else:
                if content.count(old_string) > 1:
                    return (
                        f"Error: old_string appears {content.count(old_string)} times in {path}. "
                        "Add more surrounding context to make it unique, or set replace_all=true."
                    )
                new_content = content.replace(old_string, new_string, 1)
                msg = "Replaced 1 occurrence"
            with open(path, "w") as f:
                f.write(new_content)
            return f"{msg} in {path}"

        elif name == "apply_patch":
            path = args.get("path", "")
            patch = args.get("patch", "")
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            if not os.path.isfile(path):
                return f"Error: file not found: {path}"
            # Parse SEARCH/REPLACE blocks
            block_re = re.compile(
                r"<{7} SEARCH\n(.*?)\n={7}\n(.*?)\n>{7} REPLACE",
                re.DOTALL,
            )
            blocks = block_re.findall(patch)
            if not blocks:
                return "Error: no valid SEARCH/REPLACE blocks found. Format: <<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE"
            with open(path, "r", errors="replace") as f:
                content = f.read()
            applied = 0
            for search, replace in blocks:
                if search not in content:
                    return f"Error: SEARCH block {applied + 1} not found in {path}:\n{search[:200]}"
                if content.count(search) > 1:
                    return (
                        f"Error: SEARCH block {applied + 1} matches {content.count(search)} locations in {path}. "
                        "Add more surrounding context to make it unique."
                    )
                content = content.replace(search, replace, 1)
                applied += 1
            with open(path, "w") as f:
                f.write(content)
            return f"Applied {applied} patch block(s) to {path}"

        elif name == "fetch_url":
            import aiohttp
            url = args.get("url", "")
            if not url.startswith(("http://", "https://")):
                return "Error: URL must start with http:// or https://"
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(url, headers={"User-Agent": "JAC/1.0"},
                                        timeout=aiohttp.ClientTimeout(total=30),
                                        allow_redirects=True) as resp:
                        ctype = resp.headers.get("Content-Type", "").lower()
                        body = await resp.text(errors="replace")
                        if "html" in ctype:
                            # Strip HTML to plain text
                            text = re.sub(r"<script[^>]*>.*?</script>", "", body, flags=re.DOTALL | re.IGNORECASE)
                            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
                            text = re.sub(r"<[^>]+>", " ", text)
                            text = re.sub(r"\s+", " ", text).strip()
                            return f"[HTTP {resp.status}] {text[:15000]}"
                        return f"[HTTP {resp.status}] {body[:15000]}"
            except Exception as e:
                return f"Error fetching {url}: {e}"

        elif name == "cad_execute":
            import aiohttp
            code = args.get("code", "")
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.post("http://127.0.0.1:5050/",
                                         json={"tool": "cad_execute", "args": {"code": code}},
                                         timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        data = await resp.json()
                        if not data.get("ok"):
                            return f"CAD error: {data.get('error', 'unknown')}"
                        parts = data.get("parts", [])
                        summary = f"Executed OK. {len(parts)} part(s) generated."
                        if parts:
                            p0 = parts[0]
                            bbox = p0.get("bbox", {})
                            summary += f" First part bbox: {bbox}"
                        return summary
            except aiohttp.ClientConnectorError:
                return "Error: CAD tool server not running on port 5050. Open the CAD panel in JAC first."
            except Exception as e:
                return f"CAD error: {e}"

        elif name == "open_panel":
            panel = args.get("panel", "")
            if panel not in ("cad", "pcb", "browser", "music"):
                return f"Error: unknown panel '{panel}'"
            if send_fn is None:
                return "Error: no client connection to open panel"
            await send_fn({
                "type": "open_panel",
                "panel": panel,
                "session_id": session_id,
            })
            return f"Requested that the '{panel}' panel be opened. Wait a moment for it to load before using tools that depend on it."

        elif name == "git":
            sub = args.get("subcommand", "")
            extra = args.get("args", "") or ""
            gcwd = args.get("cwd") or cwd
            if sub == "status":
                cmd = ["git", "status", "--short", "--branch"]
            elif sub == "diff":
                cmd = ["git", "--no-pager", "diff"]
                if extra.strip():
                    cmd.extend(extra.split())
            elif sub == "log":
                n = extra.strip() or "10"
                try:
                    int(n)
                except ValueError:
                    n = "10"
                cmd = ["git", "--no-pager", "log", "--oneline", f"-n{n}"]
            elif sub == "branch":
                if extra.strip():
                    cmd = ["git", "branch", extra.strip()]
                else:
                    cmd = ["git", "branch", "--all"]
            elif sub == "add":
                paths = extra.split() if extra else ["."]
                cmd = ["git", "add"] + paths
            elif sub == "commit":
                msg = extra or "Update"
                cmd = ["git", "commit", "-m", msg]
            elif sub == "push":
                cmd = ["git", "push"] + (extra.split() if extra else [])
            elif sub == "pull":
                cmd = ["git", "pull"] + (extra.split() if extra else [])
            elif sub == "show":
                cmd = ["git", "--no-pager", "show"] + (extra.split() if extra else ["HEAD"])
            else:
                return f"Error: unknown git subcommand '{sub}'"
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=gcwd,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
            except asyncio.TimeoutError:
                proc.kill()
                return "Error: git command timed out"
            out = stdout.decode(errors="replace") + stderr.decode(errors="replace")
            if not out.strip():
                return f"(git {sub} completed, no output)"
            return out[:15000]

        elif name == "view_image":
            import base64
            import mimetypes
            path = args.get("path", "")
            if not os.path.isabs(path):
                path = os.path.join(cwd, path)
            if not os.path.exists(path):
                return f"Error: file not found: {path}"
            mime, _ = mimetypes.guess_type(path)
            if not mime or not mime.startswith("image/"):
                return f"Error: not an image file (mime: {mime})"
            with open(path, "rb") as f:
                img_bytes = f.read()
            if len(img_bytes) > 20 * 1024 * 1024:
                return f"Error: image too large ({len(img_bytes)} bytes, max 20MB)"
            b64 = base64.b64encode(img_bytes).decode()
            data_url = f"data:{mime};base64,{b64}"
            if messages is not None:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"[Image loaded: {path}]"},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                })
                return f"Image loaded ({len(img_bytes)} bytes, {mime}). You can now see it."
            return f"Loaded {len(img_bytes)} bytes but no conversation context to attach it to."

        elif name == "schematic_command":
            import aiohttp
            command = args.get("command", "").strip()
            # Parse: "add 555 200 200" → tool "add", args {type: "555", x: 200, y: 200}
            parts = command.split()
            if not parts:
                return "Error: empty command"
            verb = parts[0].lower()
            try:
                async with aiohttp.ClientSession() as sess:
                    if verb == "add" and len(parts) >= 4:
                        payload = {"tool": "add_component", "args": {
                            "type": parts[1], "x": float(parts[2]), "y": float(parts[3]),
                        }}
                    elif verb == "wire" and len(parts) >= 5:
                        payload = {"tool": "add_wire", "args": {
                            "from_ref": parts[1], "from_pin": parts[2],
                            "to_ref": parts[3], "to_pin": parts[4],
                        }}
                    elif verb == "list":
                        payload = {"tool": "list_components", "args": {}}
                    else:
                        return (
                            f"Unknown command '{command}'. Supported: "
                            "'add <type> <x> <y>', 'wire <ref1> <pin1> <ref2> <pin2>', 'list'"
                        )
                    async with sess.post("http://127.0.0.1:5051/", json=payload,
                                         timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        data = await resp.json()
                        if not data.get("ok"):
                            return f"Schematic error: {data.get('error', 'unknown')}"
                        return json.dumps({k: v for k, v in data.items() if k != "ok"})[:2000]
            except aiohttp.ClientConnectorError:
                return "Error: PCB tool server not running on port 5051. Open the PCB panel in JAC first."
            except Exception as e:
                return f"Schematic error: {e}"

        else:
            return f"Error: unknown tool '{name}'"

    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


async def run_bridge(relay_url: str, auth_token: str, config: ServerConfig):
    """Connect to relay as provider and handle client messages."""
    delay = RECONNECT_MIN

    # ── Persistent state (survives reconnects) ─────────────────────────
    sessions: dict[str, ClaudeBridge] = {}     # session_id → bridge
    query_tasks: dict[str, asyncio.Task] = {}  # session_id → task
    # Mutable container so closures always reference the current websocket
    ws_ref: list = [None]

    async def send_to_ws(msg: dict) -> None:
        """Callback for bridge to send messages to the relay."""
        ws = ws_ref[0]
        if ws is None:
            log.warning("send_to_ws called with no active connection, dropping message")
            return
        try:
            await ws.send(json.dumps(msg))
        except websockets.exceptions.ConnectionClosed:
            log.warning("Connection closed while sending, message dropped")

    def get_or_create_bridge(session_id: str) -> ClaudeBridge:
        """Get existing Claude bridge for session or create one."""
        if session_id not in sessions:
            log.info("Creating new Claude session: %s", session_id[:8])
            sessions[session_id] = ClaudeBridge(
                model=config.model,
                permission_mode=config.permission_mode,
                cwd=config.cwd,
                cli_path=config.cli_path,
                send_fn=send_to_ws,
                session_id=session_id,
                proxy_mode=config.proxy_mode,
            )
        return sessions[session_id]

    async def run_query_codex(session_id: str, model: str, prompt: str, cwd: str) -> None:
        """Run a query through the Codex CLI (uses ChatGPT subscription)."""
        codex_cli = find_cli("codex")
        if not codex_cli:
            await send_to_ws({"type": "error", "message": "Codex CLI not found", "session_id": session_id})
            query_tasks.pop(session_id, None)
            return

        try:
            await send_to_ws({"type": "system", "subtype": "init", "session_id": session_id})

            # codex exec --json -c model="gpt-4o" "prompt"
            cmd = [codex_cli, "exec", "--json", "-c", f'model="{model}"', prompt]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )

            full_text = ""
            async for line in proc.stdout:
                line = line.decode().strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type", "")

                # Codex JSONL events: message_delta, message_complete, tool_use, etc.
                if event_type == "message_delta":
                    delta = event.get("delta", "")
                    if delta:
                        full_text += delta
                        await send_to_ws({
                            "type": "assistant_text_delta",
                            "text": delta,
                            "session_id": session_id,
                        })
                elif event_type == "message_complete":
                    text = event.get("content", full_text)
                    await send_to_ws({
                        "type": "assistant_text",
                        "text": text,
                        "model": model,
                        "session_id": session_id,
                    })
                elif event_type == "tool_use":
                    await send_to_ws({
                        "type": "tool_use",
                        "tool_name": event.get("name", ""),
                        "tool_use_id": event.get("id", ""),
                        "args": event.get("input", {}),
                        "session_id": session_id,
                    })
                elif event_type == "tool_result":
                    await send_to_ws({
                        "type": "tool_result",
                        "tool_use_id": event.get("id", ""),
                        "content": event.get("output", ""),
                        "is_error": event.get("is_error", False),
                        "session_id": session_id,
                    })
                elif event_type == "error":
                    err_msg = event.get("message", "Unknown error")
                    if "rate" in err_msg.lower() or "limit" in err_msg.lower():
                        await send_to_ws({"type": "rate_limited", "session_id": session_id})
                    await send_to_ws({
                        "type": "error",
                        "message": f"Codex: {err_msg}",
                        "session_id": session_id,
                    })

            await proc.wait()

            # Send result
            await send_to_ws({
                "type": "result",
                "session_id": session_id,
                "duration_ms": 0,
                "total_cost_usd": None,
                "num_turns": 1,
                "is_error": proc.returncode != 0,
            })

        except Exception as e:
            log.error("Codex query error: %s", e)
            await send_to_ws({"type": "error", "message": f"Codex: {e}", "session_id": session_id})
        finally:
            query_tasks.pop(session_id, None)

    async def run_query_gemini(session_id: str, model: str, prompt: str, cwd: str) -> None:
        """Run a query through the Gemini CLI (uses Google AI subscription)."""
        gemini_cli = find_cli("gemini")
        if not gemini_cli:
            await send_to_ws({"type": "error", "message": "Gemini CLI not found", "session_id": session_id})
            query_tasks.pop(session_id, None)
            return

        try:
            await send_to_ws({"type": "system", "subtype": "init", "session_id": session_id})

            # gemini -p "prompt" -m model -o stream-json --yolo
            cmd = [gemini_cli, "-p", prompt, "-m", model, "-o", "stream-json", "--yolo"]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )

            full_text = ""
            async for line in proc.stdout:
                line = line.decode().strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type", "")

                # Gemini stream-json events
                if event_type == "text_delta" or event_type == "content_delta":
                    delta = event.get("text", event.get("delta", ""))
                    if delta:
                        full_text += delta
                        await send_to_ws({
                            "type": "assistant_text_delta",
                            "text": delta,
                            "session_id": session_id,
                        })
                elif event_type == "message" or event_type == "response":
                    text = event.get("text", event.get("content", full_text))
                    if text and not full_text:
                        full_text = text
                        await send_to_ws({
                            "type": "assistant_text_delta",
                            "text": text,
                            "session_id": session_id,
                        })
                elif event_type == "tool_use" or event_type == "function_call":
                    await send_to_ws({
                        "type": "tool_use",
                        "tool_name": event.get("name", ""),
                        "tool_use_id": event.get("id", ""),
                        "args": event.get("args", event.get("input", {})),
                        "session_id": session_id,
                    })
                elif event_type == "tool_result" or event_type == "function_response":
                    await send_to_ws({
                        "type": "tool_result",
                        "tool_use_id": event.get("id", ""),
                        "content": event.get("output", event.get("response", "")),
                        "is_error": event.get("is_error", False),
                        "session_id": session_id,
                    })
                elif event_type == "error":
                    err_msg = event.get("message", event.get("error", "Unknown error"))
                    if isinstance(err_msg, dict):
                        err_msg = err_msg.get("message", str(err_msg))
                    if "quota" in str(err_msg).lower() or "limit" in str(err_msg).lower():
                        await send_to_ws({"type": "rate_limited", "session_id": session_id})
                    await send_to_ws({
                        "type": "error",
                        "message": f"Gemini: {err_msg}",
                        "session_id": session_id,
                    })

            await proc.wait()

            # If we got text but no explicit message_complete, send it now
            if full_text:
                await send_to_ws({
                    "type": "assistant_text",
                    "text": full_text,
                    "model": model,
                    "session_id": session_id,
                })

            await send_to_ws({
                "type": "result",
                "session_id": session_id,
                "duration_ms": 0,
                "total_cost_usd": None,
                "num_turns": 1,
                "is_error": proc.returncode != 0,
            })

        except Exception as e:
            log.error("Gemini query error: %s", e)
            await send_to_ws({"type": "error", "message": f"Gemini: {e}", "session_id": session_id})
        finally:
            query_tasks.pop(session_id, None)

    async def run_query_llm(session_id: str, model_id: str, prompt: str, send_fn) -> None:
        """Route query to a remote/local LLM server via OpenAI-compatible API."""
        import aiohttp
        try:
            # Find the endpoint for this model
            real_model = model_id.removeprefix("llm:")
            endpoint = None
            for m in get_available_models(config.cli_path):
                if m.get("id") == model_id and "endpoint" in m:
                    endpoint = m["endpoint"]
                    break

            if not endpoint:
                # Try default local
                endpoint = "http://127.0.0.1:8787"

            await send_fn({"type": "system", "subtype": "init", "session_id": session_id})

            url = f"{endpoint}/v1/chat/completions"
            payload = {
                "model": real_model,
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant. Be concise."},
                    {"role": "user", "content": prompt},
                ],
                "stream": True,
                "max_tokens": 2048,
                "temperature": 0.7,
            }

            full_text = ""
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=300)) as resp:
                    async for line in resp.content:
                        line = line.decode().strip()
                        if not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0]["delta"]
                            content = delta.get("content") or ""
                            if content:
                                full_text += content
                                await send_fn({
                                    "type": "assistant_text_delta",
                                    "text": content,
                                    "session_id": session_id,
                                })
                        except (json.JSONDecodeError, KeyError, IndexError):
                            pass

            await send_fn({
                "type": "assistant_text",
                "text": full_text,
                "model": model_id,
                "session_id": session_id,
            })
            await send_fn({
                "type": "result",
                "session_id": session_id,
                "duration_ms": 0,
                "total_cost_usd": 0,
                "num_turns": 1,
            })
        except Exception as e:
            log.error("LLM query error: %s", e)
            await send_fn({"type": "error", "message": f"LLM: {e}", "session_id": session_id})
        finally:
            query_tasks.pop(session_id, None)

    async def run_query_openrouter(session_id: str, model_id: str, prompt: str, send_fn, cwd: str = "") -> None:
        """Route query to OpenRouter API with tool-use loop (OpenAI-compatible)."""
        import aiohttp
        import os
        cwd = cwd or os.getcwd()
        try:
            real_model = model_id.removeprefix("or:")

            await send_fn({"type": "system", "subtype": "init", "session_id": session_id})

            url = "https://openrouter.ai/api/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "HTTP-Referer": "https://github.com/Clifford-Swartz/jac",
                "X-Title": "JAC",
            }

            system_prompt = (
                f"You are JAC, an AI assistant with access to tools for the user's filesystem, "
                f"shell, and CAD/schematic panels. Current working directory: {cwd}.\n\n"
                f"RULES OF BEHAVIOR:\n"
                f"1. Only do what the user explicitly asks. Do not chain unrelated tasks, "
                f"do not 'also' do extra things 'while you're at it'.\n"
                f"2. If the user asks a question, answer it — don't jump straight to actions.\n"
                f"3. Never create CAD/schematic/3D output unless the user explicitly asks for "
                f"3D modeling, a part, a schematic, or a circuit. The CAD panel being open is "
                f"NOT a request to use it.\n"
                f"4. Tools you've already called in this conversation: assume their results are "
                f"still valid. Don't re-run list_directory or read_file on the same target "
                f"unless something changed.\n"
                f"5. If a command or approach fails, diagnose the root cause rather than "
                f"spamming workaround attempts. If you're not sure what to do next, ASK.\n"
                f"6. Be concise. Don't narrate every step before doing it."
            )

            # Load per-session history (in-memory first, fall back to disk).
            # System prompt is always rewritten fresh since cwd and rules may change.
            if session_id not in _openrouter_history:
                _openrouter_history[session_id] = _load_or_history(session_id)
            prior = _openrouter_history[session_id]
            # Strip any stale system prompt from the prior history
            prior = [m for m in prior if m.get("role") != "system"]
            messages: list[dict] = [{"role": "system", "content": system_prompt}]
            messages.extend(prior)
            messages.append({"role": "user", "content": prompt})

            # Build request-only copy with env_details on latest user turn (not persisted)
            if cwd:
                request_messages = messages[:-1] + [{
                    "role": "user",
                    "content": f"{prompt}\n\n{build_environment_details(cwd)}",
                }]
            else:
                request_messages = messages

            full_text = ""
            MAX_ITERATIONS = 15
            iteration = 0

            # Loop detection: track (tool_name, sorted_args_json) signatures
            _loop_last_sig: str | None = None
            _loop_streak: int = 0
            LOOP_WARN = 3
            LOOP_HARD = 5

            def _tool_sig(tool_name: str, args: dict) -> str:
                return f"{tool_name}:{json.dumps(args, sort_keys=True)}"

            # Check upfront whether this model supports tool use
            supports_tools = _openrouter_tool_support.get(model_id, True)

            while iteration < MAX_ITERATIONS:
                iteration += 1
                # First iteration uses request_messages (has env_details); subsequent tool-loop
                # iterations use messages directly (env_details not needed mid-loop).
                payload = {
                    "model": real_model,
                    "messages": request_messages if iteration == 1 else messages,
                    "stream": True,
                    "max_tokens": 4096,
                }
                if supports_tools:
                    payload["tools"] = OPENROUTER_TOOLS
                    payload["tool_choice"] = "auto"

                # Accumulators for this round
                tool_calls_acc: dict[int, dict] = {}
                content_acc = ""
                finish_reason: str | None = None

                async with aiohttp.ClientSession() as session:
                    async with session.post(url, json=payload, headers=headers,
                                            timeout=aiohttp.ClientTimeout(total=300)) as resp:
                        if resp.status != 200:
                            body = await resp.text()
                            # Some models claim to support tools but no provider does — retry without
                            if (
                                supports_tools
                                and resp.status == 404
                                and "tool use" in body.lower()
                            ):
                                log.warning("Model %s failed tool-use check, retrying without tools", model_id)
                                supports_tools = False
                                _openrouter_tool_support[model_id] = False
                                iteration -= 1  # don't count this attempt
                                continue
                            raise Exception(f"OpenRouter HTTP {resp.status}: {body[:300]}")

                        async for line in resp.content:
                            line = line.decode().strip()
                            if not line.startswith("data: "):
                                continue
                            data = line[6:]
                            if data == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data)
                                choice = chunk["choices"][0]
                                delta = choice.get("delta", {})

                                # Streaming content
                                content = delta.get("content") or ""
                                if content:
                                    content_acc += content
                                    full_text += content
                                    await send_fn({
                                        "type": "assistant_text_delta",
                                        "text": content,
                                        "session_id": session_id,
                                    })

                                # Reasoning tokens
                                reasoning = delta.get("reasoning") or delta.get("reasoning_content") or ""
                                if reasoning:
                                    await send_fn({
                                        "type": "thinking_delta",
                                        "text": reasoning,
                                        "session_id": session_id,
                                    })

                                # Tool call chunks (streamed piece by piece)
                                for tc in (delta.get("tool_calls") or []):
                                    idx = tc.get("index", 0)
                                    if idx not in tool_calls_acc:
                                        tool_calls_acc[idx] = {"id": "", "name": "", "arguments": ""}
                                    if tc.get("id"):
                                        tool_calls_acc[idx]["id"] = tc["id"]
                                    func = tc.get("function") or {}
                                    if func.get("name"):
                                        tool_calls_acc[idx]["name"] += func["name"]
                                    if func.get("arguments"):
                                        tool_calls_acc[idx]["arguments"] += func["arguments"]

                                fr = choice.get("finish_reason")
                                if fr:
                                    finish_reason = fr
                            except (json.JSONDecodeError, KeyError, IndexError):
                                pass

                # No tool calls → model is done
                if not tool_calls_acc:
                    break

                # Append assistant message (with tool calls) to history
                messages.append({
                    "role": "assistant",
                    "content": content_acc or None,
                    "tool_calls": [
                        {
                            "id": tc["id"] or f"call_{idx}",
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": tc["arguments"] or "{}",
                            },
                        }
                        for idx, tc in sorted(tool_calls_acc.items())
                    ],
                })

                # Execute each tool call and append results
                # Parse all tool calls first
                parsed_calls = []
                for idx, tc in sorted(tool_calls_acc.items()):
                    tool_id = tc["id"] or f"call_{idx}"
                    tool_name = tc["name"]
                    try:
                        args = json.loads(tc["arguments"]) if tc["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {}
                    parsed_calls.append((tool_id, tool_name, args))

                # Tools that don't modify state can run in parallel
                PARALLEL_SAFE = {"read_file", "list_directory", "glob", "grep", "fetch_url", "view_image"}

                # Notify UI and check permissions sequentially (may involve user prompts)
                permitted = []
                for tool_id, tool_name, args in parsed_calls:
                    await send_fn({
                        "type": "tool_use",
                        "tool_use_id": tool_id,
                        "tool_name": tool_name,
                        "tool_input": args,
                        "session_id": session_id,
                    })
                    log.info("OR tool [%s]: %s(%s)", session_id[:8], tool_name, str(args)[:100])
                    allowed, deny_reason = await _permission_manager.check_tool(
                        tool_name, args, session_id, cwd, send_fn,
                    )
                    if not allowed:
                        log.info("OR tool denied [%s]: %s — %s", session_id[:8], tool_name, deny_reason)
                    permitted.append((tool_id, tool_name, args, allowed, deny_reason))

                # Execute — batch consecutive parallel-safe tools together
                async def _exec_one(tool_id, tool_name, args, allowed, deny_reason):
                    if not allowed:
                        return f"Permission denied: {deny_reason}"
                    return await execute_openrouter_tool(
                        tool_name, args, cwd,
                        messages=messages, send_fn=send_fn, session_id=session_id,
                    )

                # Group into runs: each run is either all parallel-safe or a single mutating call
                results_map: dict[str, str] = {}
                i = 0
                while i < len(permitted):
                    tool_id, tool_name, args, allowed, deny_reason = permitted[i]
                    if tool_name in PARALLEL_SAFE:
                        # Collect the full run of parallel-safe calls
                        batch = []
                        while i < len(permitted) and permitted[i][1] in PARALLEL_SAFE:
                            batch.append(permitted[i])
                            i += 1
                        if len(batch) > 1:
                            log.info("OR parallel tools [%s]: %s", session_id[:8],
                                     [t[1] for t in batch])
                        results = await asyncio.gather(*[
                            _exec_one(*b) for b in batch
                        ])
                        for (tid, *_), result in zip(batch, results):
                            results_map[tid] = result
                    else:
                        results_map[tool_id] = await _exec_one(tool_id, tool_name, args, allowed, deny_reason)
                        i += 1

                # Loop detection — check the signature of this batch
                batch_sig = "|".join(
                    _tool_sig(t, a) for _, t, a, _, _ in permitted
                )
                if batch_sig == _loop_last_sig:
                    _loop_streak += 1
                else:
                    _loop_streak = 1
                    _loop_last_sig = batch_sig

                if _loop_streak >= LOOP_HARD:
                    log.warning("OR loop hard-stop [%s]: identical calls x%d", session_id[:8], _loop_streak)
                    # Inject a hard-stop into the tool results so the model sees it
                    for tool_id, tool_name, args, _, _ in permitted:
                        results_map[tool_id] = (
                            f"LOOP DETECTED: this exact {tool_name} call has been made "
                            f"{_loop_streak} times in a row with identical arguments. "
                            "Stop retrying. Summarise what you have learned so far and "
                            "either ask the user for clarification or report the result."
                        )
                elif _loop_streak >= LOOP_WARN:
                    log.warning("OR loop warning [%s]: identical calls x%d", session_id[:8], _loop_streak)
                    for tool_id, tool_name, args, _, _ in permitted:
                        results_map[tool_id] = (
                            results_map[tool_id] +
                            f"\n\n[WARNING: you have called {tool_name} with these same arguments "
                            f"{_loop_streak} times consecutively. Consider whether you are stuck "
                            "and try a different approach.]"
                        )

                # Emit results and append to messages in original order
                for tool_id, tool_name, args, _, _ in permitted:
                    result = results_map[tool_id]
                    await send_fn({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result,
                        "session_id": session_id,
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": result,
                    })

                # Continue loop with new tool results in context

            if iteration >= MAX_ITERATIONS:
                log.warning("OR query [%s] hit MAX_ITERATIONS", session_id[:8])

            # If the model finished without producing any streamed text
            # (e.g. only tool calls then stopped), include a final turn of
            # content_acc so the UI shows something. Otherwise skip — the
            # deltas already rendered everything live.
            if not full_text and content_acc:
                await send_fn({
                    "type": "assistant_text_delta",
                    "text": content_acc,
                    "session_id": session_id,
                })

            # Ensure a terminal assistant message is in the history so future
            # turns have the response to reference
            if (
                (full_text or content_acc)
                and (not messages or messages[-1].get("role") != "assistant"
                     or messages[-1].get("tool_calls"))
            ):
                messages.append({
                    "role": "assistant",
                    "content": full_text or content_acc,
                })

            # Persist trimmed history for next turn (memory + disk)
            trimmed = _trim_or_history(messages)
            _openrouter_history[session_id] = trimmed
            _save_or_history(session_id, trimmed)

            await send_fn({
                "type": "result",
                "session_id": session_id,
                "duration_ms": 0,
                "total_cost_usd": 0,
                "num_turns": iteration,
            })
            credits = await check_openrouter_credits()
            if credits:
                credits["session_id"] = session_id
                await send_fn(credits)
        except Exception as e:
            log.error("OpenRouter query error: %s", e)
            await send_fn({"type": "error", "message": f"OpenRouter: {e}", "session_id": session_id})
        finally:
            query_tasks.pop(session_id, None)

    async def run_query_local(session_id: str, model: str, prompt: str, send_fn) -> None:
        """Run a query through the local llama-server."""
        try:
            from server.local_models import get_server
            server = get_server()

            if not server.ready or server.current_model != model:
                await send_fn({"type": "assistant_text_delta", "text": f"*Starting local model {model}...*\n", "session_id": session_id})
                ok = await server.start(model)
                if not ok:
                    await send_fn({"type": "error", "message": f"Failed to start {model}", "session_id": session_id})
                    return

            messages = [{"role": "user", "content": prompt}]

            import time
            t0 = time.time()

            # Route reasoning_content to thinking bubble, content to main response
            server.thinking_cb = lambda delta: asyncio.ensure_future(
                send_fn({"type": "thinking", "text": delta, "session_id": session_id})
            )
            full_text = await server.query(
                messages,
                stream_cb=lambda delta: asyncio.ensure_future(
                    send_fn({"type": "assistant_text_delta", "text": delta, "session_id": session_id})
                ),
            )

            duration_ms = int((time.time() - t0) * 1000)

            await send_fn({
                "type": "assistant_text",
                "text": full_text,
                "model": model,
                "session_id": session_id,
            })

            await send_fn({
                "type": "result",
                "session_id": session_id,
                "duration_ms": duration_ms,
                "total_cost_usd": 0,  # local models are free
                "num_turns": 1,
                "is_error": False,
            })

        except Exception as e:
            log.error("Local query error: %s", e)
            await send_fn({"type": "error", "message": f"Local model: {e}", "session_id": session_id})
        finally:
            query_tasks.pop(session_id, None)

    # ── Council mode system prompts ─────────────────────────────────────
    COUNCIL_PROMPTS = {
        "debate": (
            "You are in a multi-model debate. Your job is to critically analyze "
            "the previous response, identify flaws or gaps in reasoning, and present "
            "a stronger alternative if you disagree. Be direct and specific. "
            "If you agree, explain WHY you agree and add nuance."
        ),
        "brainstorm": (
            "You are in a collaborative brainstorming session with other AI models. "
            "Build on the previous ideas, add new angles, combine concepts creatively. "
            "Don't just agree — push the ideas further and explore wild possibilities."
        ),
        "review": (
            "You are reviewing the previous model's response as a senior engineer would "
            "review code or a proposal. Check for correctness, completeness, edge cases, "
            "security concerns, and suggest improvements. Be constructive but thorough."
        ),
        "consensus": (
            "You are working toward consensus with other models. Acknowledge valid points "
            "from the previous response, note disagreements clearly, and propose a synthesis. "
            "Focus on converging toward the best answer."
        ),
    }

    async def run_council_turn(session_id: str, model_id: str, prompt: str, cwd: str) -> str:
        """Run a single council turn through the appropriate CLI and collect the full response text."""
        full_text = ""

        if is_openai_model(model_id):
            codex_cli = find_cli("codex")
            if not codex_cli:
                return "[Codex CLI not available]"
            cmd = [codex_cli, "exec", "--json", "-c", f'model="{model_id}"', prompt]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=cwd,
            )
            async for line in proc.stdout:
                line = line.decode().strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "message_delta":
                    delta = event.get("delta", "")
                    full_text += delta
                    await send_to_ws({
                        "type": "assistant_text_delta",
                        "text": delta,
                        "session_id": session_id,
                    })
                elif event.get("type") == "message_complete":
                    full_text = event.get("content", full_text)
            await proc.wait()

        elif is_gemini_model(model_id):
            gemini_cli = find_cli("gemini")
            if not gemini_cli:
                return "[Gemini CLI not available]"
            cmd = [gemini_cli, "-p", prompt, "-m", model_id, "-o", "stream-json", "--yolo"]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=cwd,
            )
            async for line in proc.stdout:
                line = line.decode().strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") in ("modelTurn", "partialText"):
                    text = event.get("text", "")
                    if text:
                        full_text += text
                        await send_to_ws({
                            "type": "assistant_text_delta",
                            "text": text,
                            "session_id": session_id,
                        })
            await proc.wait()

        else:
            # Claude — use a fresh bridge for council turns (no persistent session)
            bridge = ClaudeBridge(
                model=model_id,
                permission_mode="bypassPermissions",
                cwd=cwd,
                cli_path=config.cli_path,
                send_fn=send_to_ws,
                session_id=session_id,
            )
            try:
                async for protocol_msg in bridge.query(prompt, cwd=cwd):
                    if protocol_msg.get("type") == "assistant_text":
                        full_text = protocol_msg.get("text", full_text)
                    elif protocol_msg.get("type") == "assistant_text_delta":
                        full_text += protocol_msg.get("text", "")
                    if protocol_msg.get("type") in ("assistant_text_delta", "thinking"):
                        await send_to_ws(protocol_msg)
            finally:
                await bridge.cleanup()

        return full_text

    async def run_council(session_id: str, prompt: str, models: list[str], mode: str, rounds: int, cwd: str) -> None:
        """Run a multi-model council discussion."""
        try:
            mode_prompt = COUNCIL_PROMPTS.get(mode, COUNCIL_PROMPTS["debate"])
            conversation: list[dict] = []  # {"model": str, "text": str}

            # Get friendly model labels
            all_models = get_available_models()
            def label_for(mid: str) -> str:
                for m in all_models:
                    if m["id"] == mid:
                        return m["label"]
                return mid

            await send_to_ws({"type": "system", "subtype": "init", "session_id": session_id})

            for round_num in range(rounds):
                for mi, model_id in enumerate(models):
                    model_label = label_for(model_id)

                    # Announce this model's turn
                    await send_to_ws({
                        "type": "council_turn_start",
                        "model_id": model_id,
                        "model_label": model_label,
                        "round": round_num + 1,
                        "total_rounds": rounds,
                        "session_id": session_id,
                    })

                    # Build the prompt for this turn
                    if round_num == 0 and mi == 0:
                        # First model, first round — just the original question
                        turn_prompt = prompt
                    else:
                        # Subsequent turns — include conversation history + mode instruction
                        history_text = "\n\n".join(
                            f"**{t['model']}:** {t['text']}" for t in conversation
                        )
                        turn_prompt = (
                            f"{mode_prompt}\n\n"
                            f"## Original Question\n{prompt}\n\n"
                            f"## Discussion So Far\n{history_text}\n\n"
                            f"Now give your perspective as {model_label}."
                        )

                    # Run this model's turn
                    response_text = await run_council_turn(session_id, model_id, turn_prompt, cwd)

                    conversation.append({"model": model_label, "text": response_text})

                    # Send the complete turn
                    await send_to_ws({
                        "type": "council_turn_complete",
                        "model_id": model_id,
                        "model_label": model_label,
                        "text": response_text,
                        "round": round_num + 1,
                        "session_id": session_id,
                    })

            # Council complete
            await send_to_ws({
                "type": "council_complete",
                "rounds": rounds,
                "models": [label_for(m) for m in models],
                "session_id": session_id,
            })

            await send_to_ws({
                "type": "result",
                "session_id": session_id,
                "duration_ms": 0,
                "total_cost_usd": None,
                "num_turns": len(conversation),
                "is_error": False,
            })

        except asyncio.CancelledError:
            log.info("Council query cancelled [%s]", session_id[:8])
        except Exception as e:
            log.error("Council query error [%s]: %s", session_id[:8], e)
            await send_to_ws({"type": "error", "message": f"Council: {e}", "session_id": session_id})
        finally:
            query_tasks.pop(session_id, None)

    async def _compact_bridge(bridge: ClaudeBridge, session_id: str) -> None:
        """Summarize conversation log and reset the bridge subprocess."""
        log.info("Compacting session %s after %d turns", session_id[:8], bridge._turn_count)
        turns = bridge._conversation_log
        if not turns:
            return
        transcript = "\n".join(
            f"{'User' if t['role'] == 'user' else 'Assistant'}: {t['text']}" for t in turns
        )
        summary_prompt = (
            "Summarize this coding session concisely. Preserve: project context, "
            "key decisions, current state of work, important file paths or technical details, "
            "what was done and what remains. Under 400 words.\n\n" + transcript
        )
        try:
            summary = await _call_or_simple("or:anthropic/claude-haiku-4.5", summary_prompt)
            if summary:
                await bridge.compact(summary)
                log.info("Session %s compacted successfully", session_id[:8])
        except Exception as e:
            log.warning("Compaction failed for session %s: %s", session_id[:8], e)

    async def _call_or_simple(model: str, prompt: str) -> str | None:
        """Single-turn OR call, no streaming, returns text or None."""
        if not OPENROUTER_API_KEY:
            return None
        import aiohttp
        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model.replace("or:", ""),
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 600,
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=headers, json=payload,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    data = await resp.json()
                    return data["choices"][0]["message"]["content"]
        except Exception as e:
            log.warning("_call_or_simple failed: %s", e)
            return None

    async def run_query(session_id: str, bridge: ClaudeBridge, prompt: str, cwd: str, images: list | None = None) -> None:
        """Run bridge.query() in background, send results to ws."""
        assistant_response = ""
        try:
            async for protocol_msg in bridge.query(prompt, cwd=cwd, images=images):
                if protocol_msg.get("type") == "assistant_text_delta":
                    assistant_response += protocol_msg.get("text", "")
                elif protocol_msg.get("type") == "assistant_text":
                    assistant_response = protocol_msg.get("text", assistant_response)
                await send_to_ws(protocol_msg)
        except Exception as e:
            log.error("Query task error (session %s): %s", session_id[:8], e)
            await send_to_ws({
                "type": "error", "message": str(e), "session_id": session_id,
            })
        finally:
            query_tasks.pop(session_id, None)

        # Log the turn and compact if needed
        bridge.log_turn(prompt, assistant_response)
        if bridge.should_compact:
            asyncio.create_task(_compact_bridge(bridge, session_id))

    async def app_keepalive(ws) -> None:
        """Send app-level pings every 15s to keep Render's proxy happy."""
        try:
            while True:
                await asyncio.sleep(15)
                await ws.send(json.dumps({"type": "ping"}))
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass

    async def check_openrouter_credits() -> dict | None:
        """Fetch OpenRouter credit/usage info."""
        if not OPENROUTER_API_KEY:
            return None
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get("https://openrouter.ai/api/v1/auth/key",
                    headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
                    timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status == 200:
                        data = (await resp.json()).get("data", {})
                        return {
                            "type": "openrouter_credits",
                            "usage_usd": data.get("usage", 0),
                            "usage_daily_usd": data.get("usage_daily", 0),
                            "limit_usd": data.get("limit"),
                            "limit_remaining_usd": data.get("limit_remaining"),
                        }
        except Exception as e:
            log.debug("OpenRouter credit check failed: %s", e)
        return None

    async def model_watcher(ws) -> None:
        """Re-check CLI auth every 30s and push updated model list if changed."""
        last_model_ids: set[str] = set()
        try:
            while True:
                await asyncio.sleep(30)
                models = get_available_models(config.cli_path)
                current_ids = {m["id"] for m in models}
                if current_ids != last_model_ids:
                    last_model_ids = current_ids
                    log.info("Model availability changed: %s", [m["id"] for m in models])
                    await ws.send(json.dumps({
                        "type": "models_list",
                        "current_model": config.model,
                        "models": models,
                    }))
                # Broadcast OpenRouter credits every cycle
                credits = await check_openrouter_credits()
                if credits:
                    await ws.send(json.dumps(credits))
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass

    while True:
        try:
            log.info("Connecting to relay at %s ...", relay_url)
            async with websockets.connect(
                relay_url,
                ping_interval=20,
                ping_timeout=10,
                max_size=20_000_000,
            ) as ws:
                ws_ref[0] = ws

                # ── Authenticate as provider ───────────────────────────────
                await ws.send(json.dumps({
                    "type": "auth",
                    "token": auth_token,
                    "role": "provider",
                    "machine_id": MACHINE_ID,
                    "provider_id": f"{MACHINE_ID}-jac",
                }))

                raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                resp = json.loads(raw)
                if resp.get("type") != "auth_ok":
                    log.error("Auth failed: %s", resp.get("message", "unknown"))
                    ws_ref[0] = None
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, RECONNECT_MAX)
                    continue

                log.info("Connected to relay as provider")
                delay = RECONNECT_MIN  # Reset backoff on successful connect

                # Send available models to client
                await ws.send(json.dumps({
                    "type": "models_list",
                    "current_model": config.model,
                    "models": get_available_models(config.cli_path),
                }))

                # Start app-level keepalive and model watcher
                keepalive_task = asyncio.create_task(app_keepalive(ws))
                model_watcher_task = asyncio.create_task(model_watcher(ws))

                # ── Message loop ───────────────────────────────────────────
                try:
                    async for raw_msg in ws:
                        try:
                            msg = json.loads(raw_msg)
                        except json.JSONDecodeError:
                            await ws.send(json.dumps({
                                "type": "error", "message": "Invalid JSON",
                            }))
                            continue

                        msg_type = msg.get("type")
                        session_id = msg.get("session_id", "default")

                        if msg_type == "query":
                            if session_id in query_tasks:
                                await ws.send(json.dumps({
                                    "type": "error",
                                    "message": "A query is already in progress",
                                    "session_id": session_id,
                                }))
                                continue

                            prompt = msg.get("prompt", "")
                            images = msg.get("images") or []
                            if not prompt and not images:
                                await ws.send(json.dumps({
                                    "type": "error", "message": "Empty prompt",
                                    "session_id": session_id,
                                }))
                                continue

                            cwd = msg.get("cwd") or config.cwd
                            current_model = config.model

                            # Check if this is a local model
                            def is_local_model(m):
                                try:
                                    from server.local_models import MODEL_CATALOG
                                    return any(c["id"] == m for c in MODEL_CATALOG)
                                except ImportError:
                                    return False

                            # Route to the right adapter based on model
                            if is_openrouter_model(current_model):
                                log.info("Query [%s] → OpenRouter %s: %.80s...", session_id[:8], current_model, prompt)
                                query_tasks[session_id] = asyncio.create_task(
                                    run_query_openrouter(session_id, current_model, prompt, send_to_ws, cwd)
                                )
                            elif is_local_model(current_model):
                                log.info("Query [%s] → Local %s: %.80s...", session_id[:8], current_model, prompt)
                                query_tasks[session_id] = asyncio.create_task(
                                    run_query_local(session_id, current_model, prompt, send_to_ws)
                                )
                            elif is_openai_model(current_model):
                                log.info("Query [%s] → Codex %s: %.80s...", session_id[:8], current_model, prompt)
                                query_tasks[session_id] = asyncio.create_task(
                                    run_query_codex(session_id, current_model, prompt, cwd)
                                )
                            elif is_gemini_model(current_model):
                                log.info("Query [%s] → Gemini %s: %.80s...", session_id[:8], current_model, prompt)
                                query_tasks[session_id] = asyncio.create_task(
                                    run_query_gemini(session_id, current_model, prompt, cwd)
                                )
                            elif current_model.startswith("llm:"):
                                # Remote/local LLM server (llama-server, vLLM, etc.)
                                log.info("Query [%s] → LLM %s: %.80s...", session_id[:8], current_model, prompt)
                                query_tasks[session_id] = asyncio.create_task(
                                    run_query_llm(session_id, current_model, prompt, send_to_ws)
                                )
                            else:
                                # Default: Claude via ClaudeBridge
                                bridge = get_or_create_bridge(session_id)
                                if bridge.is_busy:
                                    await ws.send(json.dumps({
                                        "type": "error",
                                        "message": "A query is already in progress",
                                        "session_id": session_id,
                                    }))
                                    continue
                                log.info("Query [%s] → Claude %s: %.80s... (cwd=%s, images=%d)",
                                         session_id[:8], current_model, prompt, cwd, len(images))
                                query_tasks[session_id] = asyncio.create_task(
                                    run_query(session_id, bridge, prompt, cwd, images or None)
                                )

                        elif msg_type == "permission_response":
                            request_id = msg.get("request_id", "")
                            allow = msg.get("allow", False)
                            remember = msg.get("remember", False)
                            # Claude CLI sessions
                            bridge = sessions.get(session_id)
                            if bridge:
                                bridge.resolve_permission(request_id, allow)
                            # OpenRouter sessions (may share a request_id namespace)
                            _permission_manager.resolve(request_id, allow, remember)
                            log.info(
                                "Permission response [%s]: %s -> %s%s",
                                session_id[:8],
                                request_id[:8],
                                "allow" if allow else "deny",
                                " (remembered)" if remember else "",
                            )

                        elif msg_type == "set_permission_mode":
                            mode = msg.get("mode", "default")
                            bridge = sessions.get(session_id)
                            if bridge:
                                bridge.set_permission_mode(mode)
                            # Also apply to OR permission manager if it's one of our modes
                            if mode in PERMISSION_MODES:
                                _permission_manager.set_mode(session_id, mode)
                            await ws.send(json.dumps({
                                "type": "permission_mode_changed",
                                "mode": mode,
                                "session_id": session_id,
                            }))
                            log.info("Permission mode [%s] changed to: %s", session_id[:8], mode)

                        elif msg_type == "set_model":
                            new_model = msg.get("model", config.model)
                            is_local = msg.get("local", False)
                            config.model = new_model

                            if is_local:
                                # Start local model server
                                async def _start_local():
                                    try:
                                        from server.local_models import get_server
                                        server = get_server()
                                        await send_to_ws({"type": "assistant_text_delta", "text": f"\n*Loading local model {new_model}...*\n", "session_id": session_id})
                                        ok = await server.start(new_model)
                                        if ok:
                                            await send_to_ws({"type": "assistant_text", "text": f"Local model **{new_model}** ready.", "model": new_model, "session_id": session_id})
                                        else:
                                            await send_to_ws({"type": "error", "message": f"Failed to start local model {new_model}", "session_id": session_id})
                                    except Exception as e:
                                        log.error("Failed to start local model: %s", e)
                                        await send_to_ws({"type": "error", "message": str(e), "session_id": session_id})
                                asyncio.create_task(_start_local())
                            else:
                                # Cloud model handling
                                bridge = sessions.get(session_id)
                                if bridge and is_claude_model(new_model):
                                    bridge._model = new_model
                                elif bridge and not is_claude_model(new_model):
                                    old = sessions.pop(session_id, None)
                                    if old:
                                        await old.cleanup()
                                    log.info("Cleared Claude bridge for non-Claude model: %s", new_model)

                            log.info("Model [%s] changed to: %s (local=%s)", session_id[:8], new_model, is_local)
                            await ws.send(json.dumps({
                                "type": "models_list",
                                "current_model": new_model,
                                "models": get_available_models(config.cli_path),
                            }))

                        elif msg_type == "abort_query":
                            task = query_tasks.pop(session_id, None)
                            if task is not None:
                                task.cancel()
                                try:
                                    await task
                                except asyncio.CancelledError:
                                    pass
                            # Mark bridge as not busy so user can send new queries
                            bridge = sessions.get(session_id)
                            if bridge:
                                bridge._busy = False
                            log.info("Query aborted [%s]", session_id[:8])

                        elif msg_type == "new_conversation":
                            # Cancel running query for this session
                            task = query_tasks.pop(session_id, None)
                            if task is not None:
                                task.cancel()
                                try:
                                    await task
                                except asyncio.CancelledError:
                                    pass

                            # Clean up persistent client and remove bridge
                            old_bridge = sessions.pop(session_id, None)
                            if old_bridge:
                                await old_bridge.cleanup()

                            # Clear OR conversation history (memory + disk)
                            _openrouter_history.pop(session_id, None)
                            try:
                                os.remove(_history_path(session_id))
                            except FileNotFoundError:
                                pass

                            await ws.send(json.dumps({
                                "type": "conversation_reset",
                                "session_id": session_id,
                            }))
                            log.info("Conversation reset [%s]", session_id[:8])

                        elif msg_type == "tool_result_response":
                            # Client sends back the result of a tool execution
                            tool_id = msg.get("tool_id", "")
                            bridge = sessions.get(session_id)
                            if bridge and tool_id:
                                bridge.resolve_tool_result(tool_id, {
                                    "content": msg.get("content", ""),
                                    "is_error": msg.get("is_error", False),
                                })
                                log.debug(
                                    "Tool result [%s]: %s -> %s",
                                    session_id[:8], tool_id[:8],
                                    "error" if msg.get("is_error") else "ok",
                                )

                        elif msg_type == "council_query":
                            # Multi-model deliberation mode
                            if session_id in query_tasks:
                                await ws.send(json.dumps({
                                    "type": "error",
                                    "message": "A query is already in progress",
                                    "session_id": session_id,
                                }))
                                continue

                            prompt = msg.get("prompt", "")
                            council_models = msg.get("models", ["sonnet", "gpt-4o", "gemini-2.5-pro"])
                            council_mode = msg.get("mode", "debate")  # debate, brainstorm, review, consensus
                            rounds = msg.get("rounds", 1)
                            cwd = msg.get("cwd") or config.cwd

                            log.info("Council query [%s] mode=%s models=%s rounds=%d: %.80s...",
                                     session_id[:8], council_mode, council_models, rounds, prompt)

                            query_tasks[session_id] = asyncio.create_task(
                                run_council(session_id, prompt, council_models, council_mode, rounds, cwd)
                            )

                        elif msg_type == "generate_greeting":
                            asyncio.create_task(
                                _generate_greeting(ws)
                            )

                        # ── Local model management ──────────────────────
                        elif msg_type == "get_local_models":
                            try:
                                from server.local_models import list_models
                                models = list_models()
                                await send_to_ws({"type": "local_models_list", "models": models, "session_id": session_id})
                            except Exception as e:
                                log.error("Failed to list local models: %s", e)

                        elif msg_type == "download_local_model":
                            model_id = msg.get("model_id", "")
                            async def _download():
                                try:
                                    from server.local_models import download_model, list_models
                                    await download_model(
                                        model_id,
                                        progress_cb=lambda s: asyncio.ensure_future(
                                            send({"type": "assistant_text_delta", "text": f"\n*{s}*\n", "session_id": session_id})
                                        ),
                                    )
                                    # Send updated model list
                                    models = list_models()
                                    await send_to_ws({"type": "local_models_list", "models": models, "session_id": session_id})
                                except Exception as e:
                                    log.error("Download failed: %s", e)
                            asyncio.create_task(_download())

                        elif msg_type == "browse_local_models":
                            try:
                                from server.local_models import list_models
                                models = list_models()
                                await send_to_ws({"type": "local_models_list", "models": models, "session_id": session_id})
                            except Exception as e:
                                log.error("Failed to browse models: %s", e)

                        elif msg_type and msg_type.startswith("fs."):
                            if msg_type == "fs.list":
                                resp = fs_list(msg.get("path") or "~")
                            elif msg_type == "fs.read":
                                resp = fs_read(msg.get("path") or "",
                                               int(msg.get("max_bytes") or FS_READ_DEFAULT_MAX_BYTES))
                            elif msg_type == "fs.stat":
                                resp = fs_stat(msg.get("path") or "")
                            elif msg_type == "fs.home":
                                resp = fs_home()
                            elif msg_type == "fs.trash":
                                resp = fs_trash(msg.get("path") or "")
                            elif msg_type == "fs.trash.list":
                                resp = fs_trash_list()
                            elif msg_type == "fs.trash.empty":
                                resp = fs_trash_empty()
                            else:
                                resp = {"type": "fs.error", "request_type": msg_type,
                                        "error": f"unknown op {msg_type}"}
                            await ws.send(json.dumps(resp))

                        elif msg_type in ("ping", "pong"):
                            if msg_type == "ping":
                                await ws.send(json.dumps({"type": "pong"}))
                finally:
                    keepalive_task.cancel()
                    model_watcher_task.cancel()
                    ws_ref[0] = None
                    log.info("Connection loop ended, sessions preserved for reconnect (%d active)", len(sessions))

        except (
            websockets.exceptions.ConnectionClosed,
            websockets.exceptions.InvalidURI,
            websockets.exceptions.InvalidHandshake,
            OSError,
            asyncio.TimeoutError,
        ) as e:
            ws_ref[0] = None
            log.warning("Relay connection lost: %s. Reconnecting in %ds...", e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX)

        except Exception as e:
            ws_ref[0] = None
            log.error("Unexpected error: %s. Reconnecting in %ds...", e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX)


async def _generate_greeting(ws) -> None:
    """Generate a fun greeting using a cheap Haiku call."""
    try:
        client = anthropic.AsyncAnthropic()
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=60,
            messages=[{
                "role": "user",
                "content": (
                    "Generate a single short, fun, witty greeting for a coding assistant called JAC. "
                    "Be playful and creative — reference coding, debugging, shipping, coffee, etc. "
                    "One sentence only, no quotes, no emoji. Make it different every time."
                ),
            }],
        )
        text = response.content[0].text.strip()
        await ws.send(json.dumps({"type": "greeting_response", "text": text}))
    except Exception as e:
        log.debug("Greeting generation failed: %s", e)


def main():
    parser = argparse.ArgumentParser(description="JAC Bridge Client")
    parser.add_argument(
        "--relay",
        default=os.getenv("RELAY_URL", ""),
        help="Relay WebSocket URL (e.g. wss://your-relay.onrender.com)",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("AUTH_TOKEN", ""),
        help="Auth token (must match relay's AUTH_TOKEN)",
    )
    parser.add_argument("--model", default=None, help="Claude model to use")
    parser.add_argument(
        "--proxy-mode", action="store_true",
        help="Forward tool calls (Bash/Read/Edit/...) over WS to a connected IDE "
             "extension instead of executing them on this machine. Default is local "
             "execution — set this when running alongside the JAC VSCode extension.",
    )
    args = parser.parse_args()

    relay_url = args.relay
    auth_token = args.token

    if not relay_url:
        log.error("Relay URL required. Use --relay or set RELAY_URL env var.")
        return
    if not auth_token:
        log.error("Auth token required. Use --token or set AUTH_TOKEN env var.")
        return

    # Load server config for model/permission_mode/cwd/cli_path
    config = ServerConfig()
    config.auth_token = auth_token
    if args.model:
        config.model = args.model
    if args.proxy_mode:
        config.proxy_mode = True

    log.info("Bridge client starting")
    log.info("  Relay: %s", relay_url)
    log.info("  Model: %s", config.model)
    log.info("  Tool execution: %s", "proxy (forwarded to IDE)" if config.proxy_mode else "local")

    loop = asyncio.new_event_loop()

    # Graceful shutdown on Ctrl+C. add_signal_handler is POSIX-only — Windows'
    # ProactorEventLoop raises NotImplementedError. There, KeyboardInterrupt
    # bubbles out of run_until_complete naturally and the existing handler
    # below catches it.
    if sys.platform != "win32":
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, lambda: loop.stop())

    try:
        loop.run_until_complete(run_bridge(relay_url, auth_token, config))
    except KeyboardInterrupt:
        pass
    finally:
        log.info("Bridge client stopped")
        loop.close()


if __name__ == "__main__":
    main()
