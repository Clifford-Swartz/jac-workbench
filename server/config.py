"""Server configuration loaded from environment and CLI args."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass
class ServerConfig:
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "9100"))
    auth_token: str = os.getenv("AUTH_TOKEN", "")
    model: str = os.getenv("MODEL", "claude-sonnet-4-6")
    permission_mode: str = os.getenv("PERMISSION_MODE", "bypassPermissions")
    cwd: str | None = os.getenv("CWD", None)
    cli_path: str | None = os.getenv("CLAUDE_CLI_PATH", None)

    def validate(self):
        if not self.auth_token:
            raise ValueError(
                "AUTH_TOKEN must be set in .env or environment. "
                "Generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
            )
