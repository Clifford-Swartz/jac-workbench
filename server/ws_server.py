"""WebSocket server for JAC."""

from __future__ import annotations

import asyncio
import json
import logging

import websockets

from .auth import validate_token
from .claude_bridge import ClaudeBridge
from .config import ServerConfig

log = logging.getLogger("ccu-server")


async def handle_connection(ws, config: ServerConfig):
    """Handle a single WebSocket connection lifecycle."""

    # ── Authentication ────────────────────────────────────────────────────
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
        data = json.loads(raw)
        if data.get("type") != "auth" or not validate_token(
            data.get("token", ""), config.auth_token
        ):
            await ws.send(json.dumps({"type": "error", "message": "Authentication failed"}))
            await ws.close(4001, "Unauthorized")
            return
    except (asyncio.TimeoutError, json.JSONDecodeError):
        await ws.close(4001, "Auth timeout or invalid format")
        return

    await ws.send(json.dumps({"type": "auth_ok"}))
    log.info("Client authenticated from %s", ws.remote_address)

    # ── Session ───────────────────────────────────────────────────────────
    async def send_to_ws(msg: dict) -> None:
        await ws.send(json.dumps(msg))

    bridge = ClaudeBridge(
        model=config.model,
        permission_mode=config.permission_mode,
        cwd=config.cwd,
        cli_path=config.cli_path,
        send_fn=send_to_ws,
    )

    query_task: asyncio.Task | None = None

    async def run_query(prompt: str, cwd: str, images: list | None = None) -> None:
        nonlocal query_task
        try:
            async for protocol_msg in bridge.query(prompt, cwd=cwd, images=images):
                await ws.send(json.dumps(protocol_msg))
        except Exception as e:
            log.error("Query task error: %s", e)
            await ws.send(json.dumps({"type": "error", "message": str(e)}))
        finally:
            query_task = None

    try:
        async for raw_msg in ws:
            try:
                msg = json.loads(raw_msg)
            except json.JSONDecodeError:
                await ws.send(json.dumps({"type": "error", "message": "Invalid JSON"}))
                continue

            msg_type = msg.get("type")

            if msg_type == "query":
                if bridge.is_busy or query_task is not None:
                    await ws.send(json.dumps({
                        "type": "error",
                        "message": "A query is already in progress",
                    }))
                    continue

                prompt = msg.get("prompt", "")
                images = msg.get("images") or []
                if not prompt and not images:
                    await ws.send(json.dumps({"type": "error", "message": "Empty prompt"}))
                    continue

                cwd = msg.get("cwd") or config.cwd
                query_task = asyncio.create_task(run_query(prompt, cwd, images or None))

            elif msg_type == "permission_response":
                request_id = msg.get("request_id", "")
                allow = msg.get("allow", False)
                bridge.resolve_permission(request_id, allow)

            elif msg_type == "set_permission_mode":
                mode = msg.get("mode", "default")
                bridge.set_permission_mode(mode)
                await ws.send(json.dumps({
                    "type": "permission_mode_changed",
                    "mode": mode,
                }))

            elif msg_type == "new_conversation":
                if query_task is not None:
                    query_task.cancel()
                    try:
                        await query_task
                    except asyncio.CancelledError:
                        pass
                    query_task = None

                bridge = ClaudeBridge(
                    model=config.model,
                    permission_mode=config.permission_mode,
                    cwd=config.cwd,
                    cli_path=config.cli_path,
                    send_fn=send_to_ws,
                )
                await ws.send(json.dumps({"type": "conversation_reset"}))

            elif msg_type == "ping":
                await ws.send(json.dumps({"type": "pong"}))

    except websockets.exceptions.ConnectionClosed:
        log.info("Client disconnected")
    finally:
        if query_task is not None:
            query_task.cancel()
            try:
                await query_task
            except asyncio.CancelledError:
                pass


async def serve(config: ServerConfig):
    """Start the WebSocket server."""
    log.info("JAC server starting on %s:%d", config.host, config.port)
    log.info("Model: %s | Permission mode: %s", config.model, config.permission_mode)

    async with websockets.serve(
        lambda ws: handle_connection(ws, config),
        config.host,
        config.port,
        ping_interval=30,
        ping_timeout=10,
    ):
        log.info("Server ready. Waiting for connections...")
        await asyncio.Future()  # Run forever
