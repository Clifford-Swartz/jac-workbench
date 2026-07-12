"""Wraps ClaudeSDKClient and translates SDK messages to protocol format.

In proxy mode (default), file/bash tools are forwarded to the remote client
for local execution via the proxy MCP server.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import shutil
import tempfile
import uuid
from typing import Any, AsyncGenerator, Awaitable, Callable

log = logging.getLogger("bridge")

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
)
from claude_agent_sdk.types import StreamEvent

from server.proxy_tools import create_proxy_mcp_server

def _find_claude_cli() -> str:
    """Find the Claude CLI binary, checking PATH first then VS Code extensions.

    Re-resolves the glob each call so we survive extension updates.
    """
    found = shutil.which("claude")
    if found:
        return found
    import glob as _glob
    exts = sorted(
        _glob.glob(os.path.expanduser(
            "~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude"
        )),
        reverse=True,
    )
    if exts:
        return exts[0]
    return "claude"  # fallback — hope it's on PATH

# Tools whose tool_use/tool_result events should not be forwarded to the client UI
_HIDDEN_TOOLS = {"AskUserQuestion", "ToolSearch", "LoadSkill"}

def _strip_mcp(name: str) -> str:
    """Strip MCP prefix from tool names for cleaner UI display."""
    import re
    return re.sub(r"^mcp__\w+__", "", name)


# ── gstack skill loading ──────────────────────────────────────────────────
_SKILLS_DIR = os.path.join(os.path.dirname(__file__), "skills")
_SKILL_CACHE: dict[str, str] = {}

def _load_skills() -> dict[str, str]:
    """Load gstack SKILL.md files from disk, cached."""
    if _SKILL_CACHE:
        return _SKILL_CACHE
    if not os.path.isdir(_SKILLS_DIR):
        return _SKILL_CACHE
    for fname in os.listdir(_SKILLS_DIR):
        if fname.endswith(".md"):
            cmd_name = fname.removesuffix(".md")  # e.g. "plan-ceo-review"
            path = os.path.join(_SKILLS_DIR, fname)
            with open(path, "r") as f:
                _SKILL_CACHE[cmd_name] = f.read()
    return _SKILL_CACHE


def _expand_skill(prompt: str) -> str:
    """If prompt starts with a gstack slash command, prepend the skill prompt.

    Supports:
      /review              — single skill
      /review fix the auth — single skill with user context
      /chain review ship   — sequential skill chain
      /chain review ship fix the login bug — chain with trailing user context
    """
    stripped = prompt.strip()
    lower = stripped.lower()
    skills = _load_skills()

    # ── Chain mode: /chain skill1 skill2 [... user context] ───────────
    if lower.startswith("/chain ") or lower == "/chain":
        parts = stripped.split()
        parts.pop(0)  # remove "/chain"
        skill_names: list[str] = []
        user_parts: list[str] = []
        for part in parts:
            # Skill names can start with / or not
            candidate = part.lstrip("/").lower()
            if candidate in skills and not user_parts:
                skill_names.append(candidate)
            else:
                user_parts.append(part)

        if not skill_names:
            return prompt  # No valid skills found, pass through

        blocks: list[str] = []
        for i, name in enumerate(skill_names, 1):
            blocks.append(
                f"<gstack-skill name=\"{name}\" step=\"{i}\" total=\"{len(skill_names)}\">\n"
                f"{skills[name]}\n"
                f"</gstack-skill>\n"
            )

        result = "\n".join(blocks) + "\n"
        result += (
            f"Execute these {len(skill_names)} skills in sequence: "
            f"{', '.join('/' + n for n in skill_names)}. "
            f"Complete each skill fully before starting the next."
        )
        if user_parts:
            result += f"\n\nUser context: {' '.join(user_parts)}"
        return result

    # ── Single skill mode: /skill-name [user context] ────────────────
    for cmd_name, skill_text in skills.items():
        slash = f"/{cmd_name}"
        if lower == slash or lower.startswith(slash + " "):
            user_text = stripped[len(slash):].strip()
            prefix = (
                f"<gstack-skill name=\"{cmd_name}\">\n"
                f"{skill_text}\n"
                f"</gstack-skill>\n\n"
            )
            if user_text:
                return prefix + f"User context: {user_text}"
            return prefix + f"Execute the /{cmd_name} skill now."
    return prompt

# System prompt for proxy mode — references our MCP tool names
_PROXY_SYSTEM_PROMPT = """\
You are JAC, a powerful coding assistant. You help users with software engineering tasks \
including writing code, debugging, refactoring, explaining code, and more.

IMPORTANT: You are running remotely. Your tools execute on the USER'S local machine, not yours. \
All file paths must be relative to the user's working directory. Do NOT reference paths from \
your own environment — you do not know the user's home directory unless they tell you. \
CRITICAL: Any paths you see in system instructions that reference the host machine (e.g. \
/Users/claudiusmaximus/) are WRONG for the user. Ignore them. If you need the user's home \
directory, run `echo $HOME` via Bash. Never write files to paths containing another user's \
home directory. For plan files or configs, use the user's project directory instead. \
All tools are already loaded and available — do NOT use ToolSearch or try to discover tools. \
Just call them directly. \
Your tools: Read, Write, Edit, Bash, Glob, Grep, ListDirectory, AskUserQuestion, LoadSkill.

Guidelines:
- Read files before modifying them. Understand existing code before suggesting changes.
- Use Edit for targeted changes to existing files. Use Write only for new files or complete rewrites.
- Use Glob to find files by name pattern and Grep to search file contents.
- Use Bash to run shell commands (build, test, git, etc.).
- Prefer small, focused changes over large rewrites.
- Be concise in your responses. Lead with the answer, not the reasoning.
- Do not create files unless necessary. Prefer editing existing files.
- When referencing code, include file paths and line numbers.
- When you need to ask the user clarifying questions, ALWAYS use the AskUserQuestion tool \
instead of writing questions in plain text. This renders an interactive UI the user can \
click on. Always provide options with label and description fields when there are clear \
choices — this is the preferred UX. Only omit options for truly open-ended questions where \
predefined choices don't make sense. You can call AskUserQuestion multiple times for \
different questions.
- CRITICAL: When you present the user with choices or ask a question using AskUserQuestion, \
you MUST stop and wait for the user's response before proceeding. Do NOT continue working \
or assume a default choice. End your turn immediately after asking.
- IMPORTANT: To avoid re-reading files, summarize key findings (structure, important variables, \
function signatures, issues found) in your text responses. When context gets compacted, your \
summaries persist but tool results are lost. Write your responses as if future-you will only \
have your text to work from. Do NOT re-read files you have already read unless the user has \
modified them or you need to see a specific section you didn't summarize.

JAC Hardware Design (PCB & Schematic):
JAC is also a full hardware design tool. When a user wants to design a circuit or PCB, tell them \
about these capabilities — do NOT say PCB layout is unavailable. JAC has:
- Schematic capture: add symbols, wire nets, run ERC, export .kicad_sch
- PCB layout: drag-and-drop component placement, auto-arrange, interactive trace routing \
  (KiCad WASM router with obstacle avoidance, multi-layer F.Cu/B.Cu, via drops), copper pours \
  (ground planes), DRC with violations shown on canvas
- Fabrication export: .kicad_pcb, Gerbers zipped for JLCPCB/PCBWay, BOM CSV with LCSC part numbers
The schematic and PCB panels are accessible from the JAC toolbar. The backend runs at \
localhost:5051 and you can drive it programmatically via Bash using curl, e.g.: \
`curl -s -X POST http://localhost:5051/ -H "Content-Type: application/json" \
-d '{"tool":"add_component","args":{"ref":"U1","value":"ATmega328P","x":100,"y":100}}'`
Available PCB/schematic tools (POST to http://localhost:5051/): add_component, remove_component, \
move_component, set_component_property, add_symbol, add_wire, auto_place_pcb, add_track, \
remove_track, clear_tracks, add_zone, remove_zone, clear_zones, set_netclass, assign_net, \
export_pcb, export_kicad, export_bom, run_erc, save_project, load_project, reset. \
Use curl via Bash to call these when a user asks you to help design a circuit or PCB.

Skills (auto-invoke when the user's intent matches):
You have access to powerful workflow skills via the LoadSkill tool. When you detect the user's \
intent matches a skill below, call LoadSkill with the skill name to get the full instructions, \
then follow them. The user can also invoke these directly with slash commands (which pre-loads \
the skill automatically).
Built-in skills:
- /plan-ceo-review — Founder-mode architectural review. Use when user wants a high-level \
  plan review, architecture critique, or asks you to "think like a CEO/founder" about their code.
- /plan-eng-review — Engineering leadership plan review. Use when user wants technical plan \
  validation, dependency analysis, or test coverage review before coding.
- /review — Pre-landing PR review. Use when user says "review my PR", "review this diff", \
  "check my changes", or wants a code review against main.
- /ship — Automated release workflow. Use when user says "ship it", "release", "deploy", \
  "merge and push", or wants to cut a release.
- /retro — Weekly engineering retrospective. Use when user asks for a retro, wants to \
  analyze shipping patterns, or asks "how did we do this week".
Custom skills: Users can add their own skills by creating .md files in .jac/skills/ in their \
project directory. Use LoadSkill(skill_name="list") to discover all available skills. \
Skill chaining: You can chain multiple skills by calling LoadSkill multiple times, executing \
each skill fully before loading the next. Users can also use /chain skill1 skill2 syntax. \
When auto-invoking: first call LoadSkill to get the full skill prompt, then start your \
response with **Activating /skill-name** and follow the loaded instructions.
"""


class ClaudeBridge:
    """Manages a Claude SDK session and streams protocol messages."""

    def __init__(
        self,
        model: str = "claude-sonnet-4-6",
        permission_mode: str = "bypassPermissions",
        cwd: str | None = None,
        cli_path: str | None = None,
        send_fn: Callable[[dict], Awaitable[None]] | None = None,
        session_id: str | None = None,
        proxy_mode: bool = False,
    ):
        self._model = model
        self._permission_mode = permission_mode
        self._cwd = cwd
        self._cli_path = cli_path or _find_claude_cli()
        self._client: ClaudeSDKClient | None = None
        self._session_id: str = session_id or str(uuid.uuid4())
        self._busy = False
        self._send_fn = send_fn
        self._proxy_mode = proxy_mode
        self._client_platform: str | None = None  # "win32", "darwin", "linux"
        self._client_home: str | None = None       # e.g. "C:\Users\you"
        self._pending_permissions: dict[str, asyncio.Future[bool]] = {}
        self._pending_tool_requests: dict[str, asyncio.Future[dict]] = {}
        self._persistent_client: ClaudeSDKClient | None = None
        self._client_cwd: str | None = None
        self._turn_count: int = 0
        self._compact_summary: str | None = None
        self._conversation_log: list[dict] = []  # [{role, text}] trimmed per turn

    def set_client_platform(self, platform: str, home: str | None = None) -> None:
        self._client_platform = platform
        self._client_home = home

    def set_proxy_mode(self, proxy: bool) -> None:
        if proxy != self._proxy_mode:
            self._proxy_mode = proxy
            # Force client reconnect with new options on next query
            if self._persistent_client:
                asyncio.create_task(self.cleanup())

    COMPACT_AFTER_TURNS = 20
    MAX_LOG_CHARS_PER_TURN = 800

    @property
    def should_compact(self) -> bool:
        return self._turn_count > 0 and self._turn_count % self.COMPACT_AFTER_TURNS == 0

    def log_turn(self, prompt: str, response: str) -> None:
        self._turn_count += 1
        self._conversation_log.append({
            "role": "user",
            "text": prompt[:self.MAX_LOG_CHARS_PER_TURN],
        })
        self._conversation_log.append({
            "role": "assistant",
            "text": response[:self.MAX_LOG_CHARS_PER_TURN],
        })

    async def compact(self, summary: str) -> None:
        """Reset the subprocess with a compacted summary injected as context."""
        self._compact_summary = summary
        if self._persistent_client:
            try:
                await self._persistent_client.disconnect()
            except Exception:
                pass
            self._persistent_client = None
        self._conversation_log = []
        self._turn_count = 0

    async def _can_use_tool(
        self, tool_name: str, tool_input: dict[str, Any], context: Any,
    ) -> PermissionResultAllow | PermissionResultDeny:
        """Called by the SDK when a tool needs permission."""
        # In proxy mode with bypassPermissions, auto-allow MCP tools
        if self._proxy_mode and self._permission_mode == "bypassPermissions":
            return PermissionResultAllow()

        if self._send_fn is None:
            return PermissionResultAllow()

        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()

        self._pending_permissions[request_id] = future

        await self._send_fn({
            "type": "permission_request",
            "request_id": request_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
            "session_id": self._session_id,
        })

        try:
            allowed = await asyncio.wait_for(future, timeout=300.0)
        except asyncio.TimeoutError:
            allowed = False
        finally:
            self._pending_permissions.pop(request_id, None)

        if allowed:
            return PermissionResultAllow()
        return PermissionResultDeny(message="User denied permission")

    def resolve_permission(self, request_id: str, allow: bool) -> None:
        """Resolve a pending permission Future."""
        future = self._pending_permissions.get(request_id)
        if future and not future.done():
            future.set_result(allow)

    def resolve_tool_result(self, tool_id: str, result: dict) -> None:
        """Resolve a pending tool execution Future from the remote client."""
        future = self._pending_tool_requests.get(tool_id)
        if future and not future.done():
            future.set_result(result)

    def set_permission_mode(self, mode: str) -> None:
        """Change permission mode."""
        self._permission_mode = mode

    def _save_images_to_temp(self, images: list[dict]) -> list[str]:
        """Save base64 images to temp files, return file paths."""
        ext_map = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
        }
        paths: list[str] = []
        for img in images:
            ext = ext_map.get(img["mediaType"], ".png")
            fd, path = tempfile.mkstemp(suffix=ext, prefix="jac_img_")
            os.write(fd, base64.b64decode(img["data"]))
            os.close(fd)
            paths.append(path)
        return paths

    def _build_options(self, cwd: str | None) -> ClaudeAgentOptions:
        """Build ClaudeAgentOptions based on current mode."""
        if self._proxy_mode:
            # Store client's cwd for tool context, but use a valid LOCAL directory
            # for the CLI process (client cwd may be a Windows path on a Mac bridge)
            self._client_cwd = cwd
            proxy_server = create_proxy_mcp_server(
                send_fn=self._send_fn,
                session_id=self._session_id,
                pending_results=self._pending_tool_requests,
            )
            mcp_tool_names = [
                "mcp__local__Read",
                "mcp__local__Write",
                "mcp__local__Edit",
                "mcp__local__Bash",
                "mcp__local__Glob",
                "mcp__local__Grep",
                "mcp__local__ListDirectory",
                "mcp__local__AskUserQuestion",
                "mcp__local__LoadSkill",
            ]
            import tempfile, os as _os
            local_cwd = self._cwd or _os.path.expanduser("~")
            if not _os.path.isdir(local_cwd):
                local_cwd = tempfile.gettempdir()
            return ClaudeAgentOptions(
                model=self._model,
                permission_mode=self._permission_mode,
                cli_path=self._cli_path,
                cwd=local_cwd,
                include_partial_messages=True,
                system_prompt=_PROXY_SYSTEM_PROMPT + (
                    f"\nThe user's current working directory is: {cwd}\n"
                    if cwd else ""
                ) + (
                    f"\nThe user's machine is running {self._client_platform} "
                    f"(home directory: {self._client_home}). "
                    "Use appropriate shell commands for their OS: "
                    "on win32 use PowerShell/cmd syntax (e.g. mkdir, %USERPROFILE%, $env:USERPROFILE); "
                    "on darwin/linux use bash syntax (e.g. mkdir -p, ~/). "
                    "Never use Unix paths on Windows or vice versa.\n"
                    if self._client_platform else ""
                ),
                mcp_servers={"local": proxy_server},
                allowed_tools=mcp_tool_names,
                disallowed_tools=[
                    "Read", "Write", "Edit", "MultiEdit", "Bash",
                    "Glob", "Grep", "WebFetch", "WebSearch",
                    "TodoRead", "TodoWrite", "NotebookEdit",
                    "AskUserQuestion", "Agent",
                    "ToolSearch", "EnterPlanMode", "ExitPlanMode",
                    "EnterWorktree", "Skill", "CronCreate", "CronDelete", "CronList",
                ],
                can_use_tool=self._can_use_tool,
                env={
                    "CLAUDECODE": "",
                    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING": "",
                },
            )
        else:
            # Legacy mode: tools execute on the bridge machine
            import os as _os
            resolved_cwd = cwd or self._cwd or _os.path.expanduser("~")
            if not _os.path.isdir(resolved_cwd):
                log.warning("cwd %r does not exist, falling back to home", resolved_cwd)
                resolved_cwd = _os.path.expanduser("~")
            return ClaudeAgentOptions(
                model=self._model,
                permission_mode=self._permission_mode,
                cli_path=self._cli_path,
                cwd=resolved_cwd,
                include_partial_messages=True,
                system_prompt={"type": "preset", "preset": "claude_code"},
                can_use_tool=self._can_use_tool,
                env={
                    "CLAUDECODE": "",
                    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING": "",
                },
            )

    async def _get_client(self, cwd: str | None) -> ClaudeSDKClient:
        """Get or create a persistent SDK client for this session."""
        if self._persistent_client is None:
            options = self._build_options(cwd)
            client = ClaudeSDKClient(options)
            await client.connect()
            self._persistent_client = client
        return self._persistent_client

    async def cleanup(self) -> None:
        """Disconnect the persistent client."""
        if self._persistent_client:
            try:
                await self._persistent_client.disconnect()
            except Exception:
                pass
            self._persistent_client = None

    async def query(
        self,
        prompt: str,
        cwd: str | None = None,
        images: list[dict] | None = None,
    ) -> AsyncGenerator[dict, None]:
        """Send a prompt and yield protocol-formatted dicts."""
        self._busy = True
        image_paths: list[str] = []
        try:
            # Expand gstack skill commands (e.g. /review → skill prompt)
            prompt = _expand_skill(prompt)

            # Inject compacted context from previous session if present
            if self._compact_summary:
                prompt = (
                    f"[Summary of previous conversation]\n{self._compact_summary}\n\n"
                    f"[Current message]\n{prompt}"
                )
                self._compact_summary = None  # consume once

            if images:
                image_paths = self._save_images_to_temp(images)
                file_refs = "\n".join(
                    f"[Image {i+1}]: {p}" for i, p in enumerate(image_paths)
                )
                prompt = (
                    f"{prompt or 'What is in this image?'}\n\n"
                    f"I've attached {len(image_paths)} image(s) for you to analyze. "
                    f"Use the Read tool to view them:\n{file_refs}"
                )

            client = await self._get_client(cwd)
            self._client = client
            await client.query(prompt)
            async for message in client.receive_response():
                async for msg in self._translate(message):
                    yield msg

            yield {"type": "done", "session_id": self._session_id}

        except Exception as e:
            # If the client died, clear it so next query creates a fresh one
            self._persistent_client = None
            yield {"type": "error", "message": str(e), "session_id": self._session_id}
        finally:
            self._client = None
            self._busy = False
            for p in image_paths:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    async def _translate(self, message) -> AsyncGenerator[dict, None]:
        """Translate an SDK message into protocol messages."""
        if isinstance(message, StreamEvent):
            event = message.event
            event_type = event.get("type", "")

            sid = self._session_id

            if event_type == "content_block_delta":
                delta = event.get("delta", {})
                delta_type = delta.get("type", "")

                if delta_type == "text_delta":
                    yield {
                        "type": "assistant_text_delta",
                        "text": delta.get("text", ""),
                        "session_id": sid,
                        "model": self._model,
                    }
                elif delta_type == "thinking_delta":
                    yield {
                        "type": "thinking",
                        "text": delta.get("thinking", ""),
                        "session_id": sid,
                        "model": self._model,
                    }

            elif event_type == "content_block_start":
                block = event.get("content_block", {})
                if block.get("type") == "tool_use":
                    tool_name = block.get("name", "")
                    # Hide tools that are handled via proxy or shouldn't appear in UI
                    if not any(s in tool_name for s in _HIDDEN_TOOLS):
                        yield {
                            "type": "tool_use",
                            "tool_name": _strip_mcp(tool_name),
                            "tool_use_id": block.get("id", ""),
                            "args": {},
                            "session_id": sid,
                        }

        elif isinstance(message, AssistantMessage):
            sid = self._session_id
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    if not any(s in block.name for s in _HIDDEN_TOOLS):
                        yield {
                            "type": "tool_use",
                            "tool_name": _strip_mcp(block.name),
                            "tool_use_id": block.id,
                            "args": block.input if isinstance(block.input, dict) else {},
                            "session_id": sid,
                        }
                elif isinstance(block, ToolResultBlock):
                    content = block.content
                    if isinstance(content, list):
                        content = "\n".join(
                            b.get("text", "") for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        )
                    yield {
                        "type": "tool_result",
                        "tool_use_id": block.tool_use_id,
                        "content": content,
                        "is_error": getattr(block, "is_error", False) or False,
                        "session_id": sid,
                    }

        elif isinstance(message, ResultMessage):
            yield {
                "type": "result",
                "session_id": message.session_id,
                "duration_ms": message.duration_ms,
                "total_cost_usd": message.total_cost_usd,
                "num_turns": message.num_turns,
                "is_error": message.is_error,
                "usage": message.usage,
                "model": self._model,
            }

        elif isinstance(message, SystemMessage):
            yield {
                "type": "system",
                "subtype": message.subtype,
                "session_id": self._session_id,
            }

    @property
    def is_busy(self) -> bool:
        return self._busy
