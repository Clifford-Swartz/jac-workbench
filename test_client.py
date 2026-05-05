#!/usr/bin/env python3
"""Quick test client for the JAC server."""

import asyncio
import json
import os
import sys

async def test():
    import websockets

    token = sys.argv[1] if len(sys.argv) > 1 else ""
    if not token:
        print("Usage: python test_client.py <auth_token>")
        return

    print(f"Connecting to ws://localhost:9100...")
    async with websockets.connect("ws://localhost:9100") as ws:
        # Auth
        await ws.send(json.dumps({"type": "auth", "token": token}))
        resp = json.loads(await ws.recv())
        print(f"Auth response: {resp}")

        if resp.get("type") != "auth_ok":
            print("Auth failed!")
            return

        # Send a simple query
        prompt = "What is 2 + 2? Reply in one sentence."
        print(f"\nSending query: {prompt}")
        await ws.send(json.dumps({"type": "query", "prompt": prompt}))

        # Collect responses
        full_text = []
        while True:
            msg = json.loads(await ws.recv())
            t = msg["type"]

            if t == "assistant_text_delta":
                sys.stdout.write(msg["text"])
                sys.stdout.flush()
                full_text.append(msg["text"])
            elif t == "assistant_text":
                print(f"\n[complete text] {msg['text'][:200]}")
            elif t == "tool_use":
                print(f"\n[tool_use] {msg['tool_name']}({json.dumps(msg['args'])[:100]})")
            elif t == "tool_result":
                print(f"[tool_result] {str(msg.get('content', ''))[:100]}")
            elif t == "thinking":
                print(f"[thinking] {msg['text'][:100]}...")
            elif t == "result":
                print(f"\n[result] turns={msg['num_turns']} duration={msg['duration_ms']}ms cost={msg.get('total_cost_usd')}")
            elif t == "error":
                print(f"\n[error] {msg['message']}")
                break
            elif t == "done":
                print("[done]")
                break
            elif t == "system":
                print(f"[system] {msg.get('subtype', '')}")
            else:
                print(f"[{t}] {json.dumps(msg)[:150]}")

asyncio.run(test())
