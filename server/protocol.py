"""WebSocket protocol message types for JAC."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any


# ── Client → Server ──────────────────────────────────────────────────────────

@dataclass
class AuthMessage:
    token: str
    type: str = "auth"


@dataclass
class QueryMessage:
    prompt: str
    type: str = "query"


@dataclass
class NewConversationMessage:
    type: str = "new_conversation"


@dataclass
class PingMessage:
    type: str = "ping"


# ── Server → Client ──────────────────────────────────────────────────────────

@dataclass
class AuthOkMessage:
    type: str = "auth_ok"


@dataclass
class AssistantTextDelta:
    text: str
    type: str = "assistant_text_delta"


@dataclass
class AssistantText:
    text: str
    model: str = ""
    type: str = "assistant_text"


@dataclass
class ToolUse:
    tool_name: str
    tool_use_id: str
    args: dict[str, Any] = field(default_factory=dict)
    type: str = "tool_use"


@dataclass
class ToolResult:
    tool_use_id: str
    content: Any = None
    is_error: bool = False
    type: str = "tool_result"


@dataclass
class Thinking:
    text: str
    type: str = "thinking"


@dataclass
class ResultInfo:
    session_id: str = ""
    duration_ms: float = 0
    total_cost_usd: float | None = None
    num_turns: int = 0
    is_error: bool = False
    type: str = "result"


@dataclass
class DoneMessage:
    type: str = "done"


@dataclass
class ErrorMessage:
    message: str
    type: str = "error"


@dataclass
class ConversationReset:
    type: str = "conversation_reset"


@dataclass
class PongMessage:
    type: str = "pong"


def to_json(msg) -> str:
    """Serialize a protocol dataclass to JSON string."""
    return json.dumps(asdict(msg))


def parse_client_message(raw: str) -> dict[str, Any]:
    """Parse a raw JSON string from the client."""
    return json.loads(raw)
