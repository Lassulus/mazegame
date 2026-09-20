"""Entry point: `python -m mazegame --port 8080`."""

from __future__ import annotations

import argparse
import asyncio

from .hub import ROUND_GRACE
from .server import serve


def main() -> int:
    parser = argparse.ArgumentParser(prog="mazegame", description="NixOS maze game server")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: %(default)s)")
    parser.add_argument("--port", type=int, default=8080, help="bind port (default: %(default)s)")
    parser.add_argument("-q", "--quiet", action="store_true", help="suppress request logging")
    parser.add_argument(
        "--grace",
        type=float,
        default=ROUND_GRACE,
        help="seconds between the first escape and the next maze (default: %(default)s)",
    )
    args = parser.parse_args()

    asyncio.run(_run(args))
    return 0


async def _run(args) -> None:
    server, _hub = await serve(args.host, args.port, verbose=not args.quiet, grace=args.grace)
    host, port = server.sockets[0].getsockname()[:2]
    shown = f"[{host}]" if ":" in str(host) else host
    print(f"mazegame: play at http://{shown}:{port}/  watch at http://{shown}:{port}/watch")
    try:
        async with server:
            await server.serve_forever()
    except (KeyboardInterrupt, asyncio.CancelledError):
        print()


if __name__ == "__main__":
    raise SystemExit(main())
