"""
JAC — WebSocket Relay Server (Multi-Provider + Model Routing)

Providers register with their available models. The relay routes queries
to the provider that supports the requested model. Automatic failover
when a provider is capped or disconnected.

Protocol:
  Provider auth: {"type": "auth", "token": "...", "role": "provider",
                   "machine_id": "my-mac", "phone_number": "+1..." (optional)}
  Provider models: {"type": "models_list", "models": [...], "current_model": "..."}
  Client auth:   {"type": "auth", "token": "...", "role": "client",
                   "target_phone": "+1..." (optional)}
               OR {"type": "auth", "role": "client", "device_token": "dt_..."}
  Client query:  {"type": "query", "prompt": "...", "model": "..." (optional)}

HTTP API (same port):
  GET /health              → providers, models, status
  GET /provider-status     → individual provider status
  GET /models              → all available models across all providers
  POST /pair               → redeem a pair code, get device_token
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import sys
import time
from http import HTTPStatus
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("relay")

AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
PORT = int(os.environ.get("PORT", "10000"))

# ── Pairing state ─────────────────────────────────────────────────────────────

# code → {"provider_id": str, "expires_at": float, "used": bool}
pair_codes: dict[str, dict] = {}

# device_token → {"provider_ids": list[str], "device_label": str, "paired_at": float}
device_tokens: dict[str, dict] = {}

_PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L


def _generate_pair_code() -> str:
    raw = "".join(secrets.choice(_PAIR_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def _generate_device_token() -> str:
    return "dt_" + secrets.token_urlsafe(32)


def _cleanup_expired_codes():
    now = time.time()
    expired = [c for c, info in pair_codes.items()
               if info["expires_at"] < now or info["used"]]
    for c in expired:
        pair_codes.pop(c, None)


# ── Client tracking ───────────────────────────────────────────────────────────

class ClientInfo:
    """Tracks a connected client."""
    def __init__(self, ws, client_id: str = "unknown"):
        self.ws = ws
        self.client_id = client_id
        self.connected_at = time.time()
        self.last_message_at: float = 0
        self.message_count: int = 0

    def to_dict(self) -> dict:
        return {
            "client_id": self.client_id,
            "connected_since": self.connected_at,
            "last_message_at": self.last_message_at,
            "message_count": self.message_count,
            "idle_s": round(time.time() - self.last_message_at) if self.last_message_at else -1,
        }


# ── Provider Registry ─────────────────────────────────────────────────────────

class ProviderInfo:
    """Tracks a connected provider bridge."""
    def __init__(self, ws, machine_id: str, phone_number: str | None = None):
        self.ws = ws
        self.machine_id = machine_id
        self.phone_number = phone_number
        self.models: list[dict] = []
        self.current_model: str = ""
        self.connected_at = time.time()
        self.last_query_at: float = 0
        self.is_capped = False
        self.clients: dict = {}              # ws → ClientInfo

    def supports_model(self, model_id: str) -> bool:
        return any(m["id"] == model_id for m in self.models)

    def to_dict(self) -> dict:
        return {
            "machine_id": self.machine_id,
            "phone_number": self.phone_number,
            "models": self.models,
            "current_model": self.current_model,
            "is_capped": self.is_capped,
            "connected_since": self.connected_at,
            "clients": len(self.clients),
            "client_details": [c.to_dict() for c in self.clients.values()],
        }


# All connected providers, keyed by machine_id
providers: dict[str, ProviderInfo] = {}

# Legacy single-provider state (backward compat for clients without model routing)
provider_ws = None
clients: set = set()

# Phone-based registry (backward compat)
phone_registry: dict[str, ProviderInfo] = {}


def get_all_models() -> list[dict]:
    """Aggregate all unique models from all connected providers."""
    seen = set()
    models = []
    for p in providers.values():
        if p.is_capped:
            continue
        for m in p.models:
            if m["id"] not in seen:
                seen.add(m["id"])
                models.append({**m, "machine_id": p.machine_id})
    return models


def get_scoped_models(allowed_provider_ids: list[str]) -> list[dict]:
    """Models visible to a phone client — only from its paired providers."""
    seen: set[str] = set()
    out: list[dict] = []
    for pid in allowed_provider_ids:
        p = providers.get(pid)
        if not p or p.is_capped:
            continue
        for m in p.models:
            if m["id"] not in seen:
                seen.add(m["id"])
                out.append({**m, "machine_id": p.machine_id, "provider_id": pid})
    return out


def find_provider_for_model(model_id: str) -> ProviderInfo | None:
    """Find a non-capped provider that supports the requested model."""
    for p in providers.values():
        if not p.is_capped and p.current_model == model_id:
            return p
    for p in providers.values():
        if not p.is_capped and p.supports_model(model_id):
            return p
    return None


def find_any_provider() -> ProviderInfo | None:
    """Find any non-capped provider, preferring ones with models."""
    for p in providers.values():
        if not p.is_capped and len(p.models) > 0:
            return p
    for p in providers.values():
        if not p.is_capped:
            return p
    return None


def broadcast_models_to_clients():
    """Send updated model list to all connected clients."""
    all_models = get_all_models()
    msg = json.dumps({
        "type": "models_list",
        "models": all_models,
        "current_model": "",
    })
    for p in providers.values():
        for client_ws in list(p.clients):
            asyncio.create_task(_safe_send(client_ws, msg))
    for client in clients:
        asyncio.create_task(_safe_send(client, msg))


async def _safe_send(ws, msg: str):
    try:
        await ws.send(msg)
    except Exception:
        pass


# ── HTTP API ──────────────────────────────────────────────────────────────────

async def process_request(connection, request):
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    parsed = urlparse(request.path)

    if parsed.path == "/health":
        body = json.dumps({
            "status": "ok",
            "providers": [p.to_dict() for p in providers.values()],
            "legacy_provider_online": provider_ws is not None,
            "total_models": len(get_all_models()),
        }).encode()
        return Response(HTTPStatus.OK, "OK",
            Headers([("Content-Type", "application/json"), ("Content-Length", str(len(body)))]), body)

    if parsed.path == "/models":
        body = json.dumps({"models": get_all_models()}).encode()
        return Response(HTTPStatus.OK, "OK",
            Headers([("Content-Type", "application/json"), ("Content-Length", str(len(body)))]), body)

    if parsed.path == "/provider-status":
        qs = parse_qs(parsed.query)
        machine = qs.get("machine", [None])[0]
        phone = qs.get("phone", [None])[0]
        if machine and machine in providers:
            body = json.dumps({"online": True, **providers[machine].to_dict()}).encode()
        elif phone:
            online = phone in phone_registry
            body = json.dumps({"online": online, "phone": phone}).encode()
        else:
            body = json.dumps({"online": False}).encode()
        return Response(HTTPStatus.OK, "OK",
            Headers([("Content-Type", "application/json"), ("Content-Length", str(len(body)))]), body)

    # POST /pair — phone redeems a pair code, gets a device_token
    if parsed.path == "/pair" and request.method == "POST":
        _cleanup_expired_codes()
        try:
            body_bytes = request.body or b""
            body_json = json.loads(body_bytes.decode())
            code = (body_json.get("code") or "").strip().upper()
            device_label = (body_json.get("device_label") or "").strip()[:64] or "Phone"
        except Exception:
            err = b"Bad Request"
            return Response(HTTPStatus.BAD_REQUEST, "Bad Request",
                Headers([("Content-Length", str(len(err)))]), err)

        info = pair_codes.get(code)
        if not info or info["used"] or info["expires_at"] < time.time():
            err = json.dumps({"error": "invalid_or_expired_code"}).encode()
            return Response(HTTPStatus.UNAUTHORIZED, "Unauthorized",
                Headers([("Content-Type", "application/json"), ("Content-Length", str(len(err)))]), err)

        info["used"] = True
        provider_id = info["provider_id"]

        # Reuse existing token if phone already has one
        auth_header = request.headers.get("Authorization", "")
        existing_token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""

        if existing_token and existing_token in device_tokens:
            rec = device_tokens[existing_token]
            if provider_id not in rec["provider_ids"]:
                rec["provider_ids"].append(provider_id)
            token = existing_token
        else:
            token = _generate_device_token()
            device_tokens[token] = {
                "provider_ids": [provider_id],
                "device_label": device_label,
                "paired_at": time.time(),
            }

        # Notify the provider
        p = providers.get(provider_id)
        if p:
            asyncio.create_task(_safe_send(p.ws, json.dumps({
                "type": "pair_complete",
                "device_label": device_label,
            })))

        machine_id = p.machine_id if p else provider_id
        resp_body = json.dumps({
            "device_token": token,
            "provider_id": provider_id,
            "machine_id": machine_id,
        }).encode()
        return Response(HTTPStatus.OK, "OK",
            Headers([("Content-Type", "application/json"),
                     ("Content-Length", str(len(resp_body))),
                     ("Access-Control-Allow-Origin", "*")]), resp_body)

    # OPTIONS preflight for /pair
    if parsed.path == "/pair" and request.method == "OPTIONS":
        return Response(HTTPStatus.NO_CONTENT, "No Content",
            Headers([("Access-Control-Allow-Origin", "*"),
                     ("Access-Control-Allow-Methods", "POST, OPTIONS"),
                     ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
                     ("Content-Length", "0")]), b"")

    body = b"Not Found"
    return Response(HTTPStatus.NOT_FOUND, "Not Found",
        Headers([("Content-Length", str(len(body)))]), body)


# ── WebSocket Handler ─────────────────────────────────────────────────────────

async def handle(ws):
    global provider_ws

    # ── Auth ──────────────────────────────────────────────────────────────
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
        data = json.loads(raw)
    except (asyncio.TimeoutError, json.JSONDecodeError):
        await ws.close(4001, "Auth timeout or bad JSON")
        return

    role = data.get("role", "")

    if data.get("type") != "auth" or role not in ("provider", "client"):
        await ws.close(4001, "Invalid auth message")
        return

    # Per-connection scope for phone clients (None = legacy/unscoped)
    allowed_provider_ids: list[str] | None = None

    if role == "provider":
        token = data.get("token", "")
        if not AUTH_TOKEN or not hmac.compare_digest(token.encode(), AUTH_TOKEN.encode()):
            await ws.send(json.dumps({"type": "error", "message": "Authentication failed"}))
            await ws.close(4001, "Unauthorized")
            return
    else:  # client
        device_token = data.get("device_token", "")
        if device_token:
            rec = device_tokens.get(device_token)
            if not rec:
                await ws.send(json.dumps({"type": "error", "message": "Invalid device token"}))
                await ws.close(4001, "Unauthorized")
                return
            allowed_provider_ids = list(rec["provider_ids"])
            log.info("Phone client connected: %s providers=%s", rec["device_label"], allowed_provider_ids)
        else:
            # Legacy: shared AUTH_TOKEN
            token = data.get("token", "")
            if not AUTH_TOKEN or not hmac.compare_digest(token.encode(), AUTH_TOKEN.encode()):
                await ws.send(json.dumps({"type": "error", "message": "Authentication failed"}))
                await ws.close(4001, "Unauthorized")
                return

    await ws.send(json.dumps({"type": "auth_ok"}))

    # ── Provider ──────────────────────────────────────────────────────────
    if role == "provider":
        machine_id = data.get("machine_id") or data.get("client_id") or f"provider-{id(ws)}"
        phone_number = data.get("phone_number")

        info = ProviderInfo(ws, machine_id, phone_number)

        if machine_id in providers:
            old = providers[machine_id]
            try:
                await old.ws.close(4002, "Replaced by new provider")
            except Exception:
                pass

        providers[machine_id] = info
        if phone_number:
            phone_registry[phone_number] = info

        if not phone_number:
            if provider_ws is not None:
                try:
                    await provider_ws.close(4002, "Replaced")
                except Exception:
                    pass
            provider_ws = ws

        log.info("Provider registered: machine=%s phone=%s from %s",
                 machine_id, phone_number, ws.remote_address)

        try:
            async for raw_msg in ws:
                try:
                    msg = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type")

                if msg_type == "ping":
                    continue

                # Provider requests a pairing code
                if msg_type == "pair_request":
                    _cleanup_expired_codes()
                    code = _generate_pair_code()
                    pair_codes[code] = {
                        "provider_id": info.machine_id,
                        "expires_at": time.time() + 60.0,
                        "used": False,
                    }
                    await ws.send(json.dumps({
                        "type": "pair_code",
                        "code": code,
                        "expires_at": pair_codes[code]["expires_at"],
                    }))
                    log.info("Pair code issued for provider %s", machine_id)
                    continue

                if msg_type == "models_list":
                    info.models = msg.get("models", [])
                    info.current_model = msg.get("current_model", "")
                    log.info("Provider %s models: %s (current: %s)",
                             machine_id, [m["id"] for m in info.models], info.current_model)
                    broadcast_models_to_clients()
                    continue

                if msg_type == "rate_limited":
                    info.is_capped = True
                    log.warning("Provider %s is capped!", machine_id)
                    broadcast_models_to_clients()
                    continue

                if msg_type == "rate_limit_cleared":
                    info.is_capped = False
                    log.info("Provider %s cap cleared", machine_id)
                    broadcast_models_to_clients()
                    continue

                # Forward all other messages to this provider's clients
                dead = set()
                for client in list(info.clients):
                    try:
                        await client.send(raw_msg)
                    except websockets.exceptions.ConnectionClosed:
                        dead.add(client)
                for d in dead:
                    info.clients.pop(d, None)

                if not phone_number:
                    dead_legacy = set()
                    for client in clients:
                        try:
                            await client.send(raw_msg)
                        except Exception:
                            dead_legacy.add(client)
                    if dead_legacy:
                        clients.difference_update(dead_legacy)

        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            log.error("PROVIDER HANDLER CRASH: %s: %s", type(e).__name__, e)
            import traceback; traceback.print_exc()
        finally:
            if providers.get(machine_id) is info:
                del providers[machine_id]
            if phone_number and phone_registry.get(phone_number) is info:
                del phone_registry[phone_number]
            if provider_ws is ws:
                provider_ws = None
            log.info("Provider disconnected: machine=%s", machine_id)
            broadcast_models_to_clients()

    # ── Client ────────────────────────────────────────────────────────────
    elif role == "client":
        target_phone = data.get("target_phone")
        client_id = data.get("client_id") or data.get("machine_id") or str(ws.remote_address)
        client_info = ClientInfo(ws, client_id)
        current_provider: ProviderInfo | None = None

        # Determine initial provider
        if allowed_provider_ids is not None:
            # Phone client — connect to first available paired provider
            for pid in allowed_provider_ids:
                p = providers.get(pid)
                if p and not p.is_capped:
                    current_provider = p
                    break
        elif target_phone and target_phone in phone_registry:
            current_provider = phone_registry[target_phone]
        elif not target_phone:
            current_provider = find_any_provider()

        if current_provider:
            current_provider.clients[ws] = client_info
            models = (get_scoped_models(allowed_provider_ids)
                      if allowed_provider_ids is not None else get_all_models())
            await _safe_send(ws, json.dumps({
                "type": "models_list",
                "models": models,
                "current_model": current_provider.current_model,
            }))
        else:
            if not target_phone and allowed_provider_ids is None:
                clients.add(ws)
                if provider_ws is None:
                    await ws.send(json.dumps({"type": "error", "message": "No provider connected"}))
            else:
                await ws.send(json.dumps({"type": "error", "message": "Provider not connected"}))

        log.info("Client connected from %s (provider=%s, scoped=%s)",
                 ws.remote_address,
                 current_provider.machine_id if current_provider else "legacy",
                 allowed_provider_ids is not None)

        try:
            async for raw_msg in ws:
                try:
                    msg = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type")

                # Client requesting a pairing code for its current provider
                if msg_type == "pair_request":
                    if current_provider:
                        _cleanup_expired_codes()
                        code = _generate_pair_code()
                        pair_codes[code] = {
                            "provider_id": current_provider.machine_id,
                            "expires_at": time.time() + 60.0,
                            "used": False,
                        }
                        await _safe_send(ws, json.dumps({
                            "type": "pair_code",
                            "code": code,
                            "expires_at": pair_codes[code]["expires_at"],
                        }))
                        log.info("Pair code issued for provider %s (via client request)", current_provider.machine_id)
                    else:
                        await _safe_send(ws, json.dumps({"type": "error", "message": "No provider connected"}))
                    continue

                if msg_type == "set_model":
                    requested_model = msg.get("model", "")
                    requested_pid = msg.get("provider_id")
                    if requested_pid:
                        new_provider = providers.get(requested_pid)
                    else:
                        new_provider = find_provider_for_model(requested_model)

                    # Phone clients can only reach their paired providers
                    if new_provider and allowed_provider_ids is not None:
                        if new_provider.machine_id not in allowed_provider_ids:
                            new_provider = None

                    if new_provider and new_provider is not current_provider:
                        if current_provider:
                            current_provider.clients.pop(ws, None)
                        current_provider = new_provider
                        current_provider.clients[ws] = client_info

                    if current_provider:
                        await _safe_send(current_provider.ws, raw_msg)
                    elif provider_ws:
                        await _safe_send(provider_ws, raw_msg)
                    continue

                client_info.last_message_at = time.time()
                client_info.message_count += 1

                if msg_type == "query":
                    preferred_model = msg.get("model")
                    if preferred_model:
                        better_provider = find_provider_for_model(preferred_model)
                        # Scope check for phone clients
                        if better_provider and allowed_provider_ids is not None:
                            if better_provider.machine_id not in allowed_provider_ids:
                                better_provider = None
                        if better_provider and better_provider is not current_provider:
                            if current_provider:
                                current_provider.clients.pop(ws, None)
                            current_provider = better_provider
                            current_provider.clients[ws] = client_info

                if current_provider:
                    live = providers.get(current_provider.machine_id)
                    if live and live is not current_provider:
                        current_provider.clients.pop(ws, None)
                        current_provider = live
                        current_provider.clients[ws] = client_info
                target_ws = current_provider.ws if current_provider else provider_ws
                if target_ws:
                    try:
                        await target_ws.send(raw_msg)
                    except websockets.exceptions.ConnectionClosed:
                        await ws.send(json.dumps({"type": "error", "message": "Provider disconnected"}))
                        fallback = find_any_provider()
                        if fallback:
                            if allowed_provider_ids is not None and fallback.machine_id not in allowed_provider_ids:
                                await ws.send(json.dumps({"type": "error", "message": "All paired providers offline"}))
                            else:
                                if current_provider:
                                    current_provider.clients.pop(ws, None)
                                current_provider = fallback
                                current_provider.clients[ws] = client_info
                                try:
                                    await current_provider.ws.send(raw_msg)
                                except Exception:
                                    await ws.send(json.dumps({"type": "error", "message": "All providers offline"}))
                else:
                    await ws.send(json.dumps({"type": "error", "message": "No provider connected"}))

        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            log.error("CLIENT HANDLER CRASH: %s: %s", type(e).__name__, e)
            import traceback; traceback.print_exc()
        finally:
            if current_provider:
                current_provider.clients.pop(ws, None)
            clients.discard(ws)
            log.info("Client disconnected")


async def main():
    log.info("Relay starting on port %d", PORT)
    async with websockets.serve(
        handle,
        "0.0.0.0",
        PORT,
        ping_interval=30,
        ping_timeout=10,
        max_size=20_000_000,
        process_request=process_request,
    ):
        log.info("Relay ready — multi-provider + model routing + phone pairing active")
        await asyncio.Future()


def run():
    asyncio.run(main())


if "gunicorn" in sys.modules or "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
    log.info("Detected gunicorn — taking over process for WebSocket relay")
    run()
    sys.exit(0)

app = None

if __name__ == "__main__":
    run()
