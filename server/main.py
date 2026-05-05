#!/usr/bin/env python3
"""JAC - WebSocket server entry point."""

from __future__ import annotations

import argparse
import asyncio
import logging

from .config import ServerConfig
from .ws_server import serve

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)


def main():
    parser = argparse.ArgumentParser(description="JAC Server")
    parser.add_argument("--host", default=None, help="Bind host")
    parser.add_argument("--port", type=int, default=None, help="Bind port")
    parser.add_argument("--model", default=None, help="Claude model to use")
    args = parser.parse_args()

    config = ServerConfig()
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port
    if args.model:
        config.model = args.model
    config.validate()

    asyncio.run(serve(config))


if __name__ == "__main__":
    main()
