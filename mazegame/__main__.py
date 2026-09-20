"""Entry point: `python -m mazegame --port 8080`."""

from __future__ import annotations

import argparse

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

    httpd, _hub = serve(args.host, args.port, verbose=not args.quiet, grace=args.grace)
    host, port = httpd.server_address[:2]
    shown = f"[{host}]" if ":" in str(host) else host
    print(f"mazegame: play at http://{shown}:{port}/  watch at http://{shown}:{port}/watch")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        httpd.stop_ticker.set()
        httpd.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
