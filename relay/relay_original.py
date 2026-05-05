"""
JAC — WebSocket Relay Server

A dumb message forwarder. Deploy this on Render (or any host).
Your Mac connects as the "provider", friends' extensions connect as "clients".
The relay just passes messages between them.

Protocol:
  First message must be: {"type": "auth", "token": "...", "role": "provider"|"client"}
  After auth, all messages are forwarded to the other side as-is.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("relay")

AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
PORT = int(os.environ.get("PORT", "10000"))  # Render uses PORT env var

# State: one provider, many clients
provider_ws = None
clients: set = set()


async def handle(ws):
    global provider_ws

    # ── Auth ──────────────────────────────────────────────────────────────
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
        data = json.loads(raw)
    except (asyncio.TimeoutError, json.JSONDecodeError):
        await ws.close(4001, "Auth timeout or bad JSON")
        return

    token = data.get("token", "")
    role = data.get("role", "")

    if data.get("type") != "auth" or role not in ("provider", "client"):
        await ws.close(4001, "Invalid auth message")
        return

    if not AUTH_TOKEN or not hmac.compare_digest(token.encode(), AUTH_TOKEN.encode()):
        await ws.send(json.dumps({"type": "error", "message": "Authentication failed"}))
        await ws.close(4001, "Unauthorized")
        return

    await ws.send(json.dumps({"type": "auth_ok"}))

    # ── Provider ──────────────────────────────────────────────────────────
    if role == "provider":
        if provider_ws is not None:
            # Kick old provider
            try:
                await provider_ws.close(4002, "Replaced by new provider")
            except Exception:
                pass
        provider_ws = ws
        log.info("Provider connected from %s", ws.remote_address)

        try:
            async for raw_msg in ws:
                # Forward provider messages to ALL clients
                dead = set()
                for client in clients:
                    try:
                        await client.send(raw_msg)
                    except websockets.exceptions.ConnectionClosed:
                        dead.add(client)
                clients -= dead
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if provider_ws is ws:
                provider_ws = None
            log.info("Provider disconnected")

    # ── Client ────────────────────────────────────────────────────────────
    elif role == "client":
        clients.add(ws)
        log.info("Client connected from %s (%d total)", ws.remote_address, len(clients))

        # If no provider, let the client know
        if provider_ws is None:
            await ws.send(json.dumps({"type": "error", "message": "No provider connected"}))

        try:
            async for raw_msg in ws:
                # Forward client messages to the provider
                if provider_ws is not None:
                    try:
                        await provider_ws.send(raw_msg)
                    except websockets.exceptions.ConnectionClosed:
                        await ws.send(json.dumps({"type": "error", "message": "Provider disconnected"}))
                else:
                    await ws.send(json.dumps({"type": "error", "message": "No provider connected"}))
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            clients.discard(ws)
            log.info("Client disconnected (%d remaining)", len(clients))


async def main():
    log.info("Relay starting on port %d", PORT)
    async with websockets.serve(handle, "0.0.0.0", PORT, ping_interval=30, ping_timeout=10, max_size=20_000_000):
        log.info("Relay ready")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
