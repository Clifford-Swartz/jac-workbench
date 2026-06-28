"""Proxy MCP tools that forward execution to a remote client via WebSocket."""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any, Awaitable, Callable

from claude_agent_sdk import create_sdk_mcp_server, tool
from claude_agent_sdk.types import McpSdkServerConfig

# ── Skill file directory (lives on the bridge server) ─────────────────────
_SKILLS_DIR = os.path.join(os.path.dirname(__file__), "skills")


def create_proxy_mcp_server(
    send_fn: Callable[[dict], Awaitable[None]],
    session_id: str,
    pending_results: dict[str, asyncio.Future],
) -> McpSdkServerConfig:
    """Create an MCP server whose tools proxy execution to the remote client.

    Each tool sends a ``tool_execute`` message through the relay and waits for the
    client extension to execute the tool locally and return a ``tool_result_response``.
    """

    async def _remote(name: str, args: dict, timeout: float = 120.0) -> str:
        """Send a tool call to the client and wait for the result."""
        import logging
        log = logging.getLogger("proxy")
        tool_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict] = loop.create_future()
        pending_results[tool_id] = future

        log.info("Sending tool_execute: %s (id=%s, session=%s)", name, tool_id[:8], session_id)
        await send_fn({
            "type": "tool_execute",
            "tool_id": tool_id,
            "tool_name": name,
            "tool_input": args,
            "session_id": session_id,
        })
        log.info("tool_execute sent, waiting for result...")

        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            if result.get("is_error"):
                raise RuntimeError(result.get("content", "Tool execution failed"))
            return result.get("content", "")
        except asyncio.TimeoutError:
            raise RuntimeError(f"Tool '{name}' timed out after {timeout}s")
        finally:
            pending_results.pop(tool_id, None)

    def _ok(text: str) -> dict:
        return {"content": [{"type": "text", "text": text}]}

    def _err(text: str) -> dict:
        return {"content": [{"type": "text", "text": text}], "is_error": True}

    # ── Tool definitions ─────────────────────────────────────────────────────

    @tool(
        "Read",
        "Read a file from the user's filesystem. Returns the file contents with line numbers.",
        {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the file to read"},
                "offset": {"type": "integer", "description": "Line number to start reading from (optional)"},
                "limit": {"type": "integer", "description": "Max number of lines to read (optional)"},
            },
            "required": ["file_path"],
        },
    )
    async def read_file(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("Read", args))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "Write",
        "Create or overwrite a file on the user's filesystem.",
        {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the file"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["file_path", "content"],
        },
    )
    async def write_file(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("Write", args))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "Edit",
        "Make exact string replacements in a file. Specify old_string and new_string. "
        "The old_string must be unique in the file. Use replace_all=true to replace every occurrence.",
        {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Absolute path to the file"},
                "old_string": {"type": "string", "description": "Exact text to find and replace"},
                "new_string": {"type": "string", "description": "Replacement text"},
                "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)"},
            },
            "required": ["file_path", "old_string", "new_string"],
        },
    )
    async def edit_file(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("Edit", args))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "Bash",
        "Execute a shell command on the user's machine. Returns stdout and stderr.",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "timeout": {"type": "integer", "description": "Timeout in milliseconds (default 120000)"},
                "cwd": {"type": "string", "description": "Working directory (optional)"},
            },
            "required": ["command"],
        },
    )
    async def bash(args: dict[str, Any]) -> dict:
        timeout = (args.get("timeout") or 120000) / 1000.0 + 5
        # Drop cwd — it's a Mac path from the bridge machine, not the client's machine.
        # The extension falls back to its workspace folder which is correct.
        args = {k: v for k, v in args.items() if k != "cwd"}
        try:
            return _ok(await _remote("Bash", args, timeout=timeout))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "Glob",
        "Find files matching a glob pattern. Returns matching file paths.",
        {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern (e.g. '**/*.ts')"},
                "path": {"type": "string", "description": "Directory to search in (optional)"},
            },
            "required": ["pattern"],
        },
    )
    async def glob(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("Glob", args))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "Grep",
        "Search file contents using regex. Returns matching lines or file paths.",
        {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for"},
                "path": {"type": "string", "description": "File or directory to search in (optional)"},
                "glob": {"type": "string", "description": "Glob to filter files (e.g. '*.ts')"},
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "description": "Output mode (default: files_with_matches)",
                },
            },
            "required": ["pattern"],
        },
    )
    async def grep(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("Grep", args))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "ListDirectory",
        "List contents of a directory. Returns file and subdirectory names.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the directory"},
            },
            "required": ["path"],
        },
    )
    async def list_directory(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("ListDirectory", args))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "Monitor",
        "Run a command on the user's machine and stream its output line-by-line. "
        "Use for long-running processes: build watchers, test runners, dev servers, etc. "
        "Returns all output when the process exits or times out.",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run"},
                "timeout_ms": {"type": "integer", "description": "Max runtime in ms (default 300000 = 5 min)"},
                "cwd": {"type": "string", "description": "Working directory (optional)"},
            },
            "required": ["command"],
        },
    )
    async def monitor(args: dict[str, Any]) -> dict:
        timeout = (args.get("timeout_ms") or 300000) / 1000.0 + 5
        args = {k: v for k, v in args.items() if k != "cwd"}
        try:
            return _ok(await _remote("Monitor", args, timeout=timeout))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "AskUserQuestion",
        "Ask the user a question and wait for their response. Use this to gather information, "
        "clarify requirements, or present options. You can provide multiple-choice options or "
        "ask a free-form question.",
        {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question to ask the user"},
                "options": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "Short label for the option"},
                            "description": {"type": "string", "description": "Longer description (optional)"},
                        },
                        "required": ["label"],
                    },
                    "description": "Multiple-choice options (optional — omit for free-form input)",
                },
                "multiSelect": {"type": "boolean", "description": "Allow selecting multiple options (default false)"},
            },
            "required": ["question"],
        },
    )
    async def ask_user_question(args: dict[str, Any]) -> dict:
        try:
            return _ok(await _remote("AskUserQuestion", args, timeout=300.0))
        except RuntimeError as e:
            return _err(str(e))

    @tool(
        "LoadSkill",
        "Load a skill prompt by name. Returns the full skill content to follow as instructions. "
        "Built-in skills: plan-ceo-review, plan-eng-review, review, ship, retro. "
        "Users can also add custom skills in .jac/skills/ in their project. "
        "Pass skill_name='list' to see all available skills (built-in + user custom). "
        "Call this tool when auto-invoking a skill so you have the complete instructions. "
        "You can call this tool multiple times to chain skills in sequence.",
        {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Skill name (e.g. 'review', 'ship', 'plan-ceo-review') or 'list' to see all",
                },
            },
            "required": ["skill_name"],
        },
    )
    async def load_skill(args: dict[str, Any]) -> dict:
        """Load skill content — checks built-in first, then user's .jac/skills/ via proxy."""
        import logging
        log = logging.getLogger("proxy")
        name = args.get("skill_name", "").strip().lstrip("/")

        # ── List mode: show all available skills ──────────────────────────
        if name == "list":
            builtin = sorted(
                f.removesuffix(".md")
                for f in os.listdir(_SKILLS_DIR)
                if f.endswith(".md")
            ) if os.path.isdir(_SKILLS_DIR) else []

            # Try to discover user skills via proxy
            user_skills: list[str] = []
            try:
                listing = await _remote("Glob", {
                    "pattern": "*.md",
                    "path": ".jac/skills",
                }, timeout=10.0)
                for line in listing.strip().splitlines():
                    fname = line.strip().rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
                    if fname.endswith(".md"):
                        user_skills.append(fname.removesuffix(".md"))
            except Exception:
                pass  # User may not have .jac/skills/

            lines = []
            if builtin:
                lines.append("**Built-in skills:**")
                for s in builtin:
                    lines.append(f"  - {s}")
            if user_skills:
                lines.append("**User custom skills (.jac/skills/):**")
                for s in sorted(user_skills):
                    lines.append(f"  - {s}")
            if not builtin and not user_skills:
                lines.append("No skills found.")
            return _ok("\n".join(lines))

        # ── Load mode: try built-in first ─────────────────────────────────
        skill_path = os.path.join(_SKILLS_DIR, f"{name}.md")
        if os.path.isfile(skill_path):
            with open(skill_path, "r") as f:
                content = f.read()
            return _ok(
                f"<gstack-skill name=\"{name}\" source=\"built-in\">\n{content}\n</gstack-skill>\n\n"
                f"Follow the instructions in this skill prompt now."
            )

        # ── Fall back to user's .jac/skills/ on their machine ─────────────
        try:
            content = await _remote("Read", {
                "file_path": f".jac/skills/{name}.md",
            }, timeout=15.0)
            if content and content.strip():
                return _ok(
                    f"<gstack-skill name=\"{name}\" source=\"user-custom\">\n{content}\n</gstack-skill>\n\n"
                    f"Follow the instructions in this skill prompt now."
                )
        except RuntimeError:
            pass  # File doesn't exist on user's machine

        # ── Not found anywhere ────────────────────────────────────────────
        available = sorted(
            f.removesuffix(".md")
            for f in os.listdir(_SKILLS_DIR)
            if f.endswith(".md")
        ) if os.path.isdir(_SKILLS_DIR) else []
        return _err(
            f"Unknown skill '{name}'. Built-in: {', '.join(available)}. "
            f"Users can add custom skills at .jac/skills/{name}.md in their project. "
            f"Use LoadSkill(skill_name='list') to see all available skills."
        )

    return create_sdk_mcp_server(
        "local",
        tools=[read_file, write_file, edit_file, bash, glob, grep, list_directory, ask_user_question, load_skill],
    )
