"""HTTP + WebSocket server for the maze game. Standard library only."""

from __future__ import annotations

import json
import mimetypes
import posixpath
import socket
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .hub import Hub
from .ws import WebSocket, WSError, accept_key

STATIC_ROOT = Path(__file__).resolve().parent / "static"
TICK_HZ = 20.0  # watcher rotation checks and peer position snapshots
SILENCE_TIMEOUT = 12.0  # seconds without any client frame before we hang up

mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/javascript", ".js")


class MazeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"mazegame/{__version__}"
    sys_version = ""
    timeout = 30

    hub: Hub
    verbose: bool = False

    # -- routing -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        url = urlparse(self.path)
        route = unquote(url.path)
        query = parse_qs(url.query)
        if route == "/ws/play":
            self._serve_socket(self._play_loop, query)
        elif route == "/ws/watch":
            self._serve_socket(self._watch_loop, query)
        elif route == "/api/version":
            self._send_json({"version": __version__})
        elif route == "/api/state":
            self._send_json({"version": __version__, **self.hub.stats()})
        elif route in ("/", "/play", "/index.html"):
            self._send_file(STATIC_ROOT / "index.html")
        elif route in ("/watch", "/watch.html"):
            self._send_file(STATIC_ROOT / "watch.html")
        else:
            self._send_static(route)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    # -- static ------------------------------------------------------------

    def _send_static(self, route: str) -> None:
        clean = posixpath.normpath(route).lstrip("/")
        target = (STATIC_ROOT / clean).resolve()
        if not target.is_file() or STATIC_ROOT not in target.parents:
            self._send_error(HTTPStatus.NOT_FOUND, "no such thing in this maze")
            return
        self._send_file(target)

    def _send_file(self, path: Path) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self._send_error(HTTPStatus.NOT_FOUND, "no such thing in this maze")
            return
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, text: str) -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- websocket ---------------------------------------------------------

    def _serve_socket(self, loop, query: dict[str, list[str]]) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            self._send_error(HTTPStatus.BAD_REQUEST, "expected a websocket upgrade")
            return
        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept_key(key))
        self.end_headers()
        self.close_connection = True
        # Clients heartbeat every 3s; silence means the tab is gone (or frozen
        # in the back/forward cache) and the slot must be freed.
        self.connection.settimeout(SILENCE_TIMEOUT)
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        sock = WebSocket(self.rfile, self.wfile)
        try:
            loop(sock, query)
        except (WSError, OSError, ValueError):
            pass
        finally:
            sock.closed = True

    def _play_loop(self, sock: WebSocket, query: dict[str, list[str]]) -> None:
        name = (query.get("name") or [None])[0]
        player = self.hub.add_player(sock, name)
        self.log_event(f"player {player.pid} {player.name} joined")
        try:
            sock.send(json.dumps({
                "t": "welcome",
                "id": player.pid,
                "name": player.name,
                "players": len(self.hub.players),
                **self.hub.world(),
            }))
            while True:
                raw = sock.recv()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = msg.get("t")
                if kind == "pos":
                    self.hub.move_player(
                        player, float(msg["x"]), float(msg["y"]), float(msg["a"])
                    )
                elif kind == "escaped":
                    self.hub.record_finish(player)
        finally:
            self.hub.drop_player(player)
            self.log_event(f"player {player.pid} {player.name} left")

    def _watch_loop(self, sock: WebSocket, query: dict[str, list[str]]) -> None:
        watcher = self.hub.add_watcher(sock)
        self.log_event(f"watcher {watcher.wid} joined")

        try:
            while True:
                raw = sock.recv()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("t") == "skip":
                    self.hub.skip(watcher)
        finally:
            self.hub.drop_watcher(watcher)
            self.log_event(f"watcher {watcher.wid} left")

    # -- logging -----------------------------------------------------------

    def log_event(self, message: str) -> None:
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)

    def log_message(self, fmt: str, *args) -> None:  # quiet access log
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {fmt % args}", flush=True)


class MazeServer(ThreadingHTTPServer):
    # socketserver defaults to a listen backlog of 5, so a crowd arriving at
    # once (a link going around) has its connections refused by the kernel
    # before the accept loop ever sees them.
    request_queue_size = 256
    daemon_threads = True


def serve(
    host: str = "127.0.0.1",
    port: int = 8080,
    verbose: bool = False,
    grace: float | None = None,
):
    """Build a running server. Returns (httpd, hub); caller drives serve_forever."""
    hub = Hub(grace=grace) if grace is not None else Hub()
    handler = type("BoundMazeHandler", (MazeHandler,), {"hub": hub, "verbose": verbose})
    httpd = MazeServer((host, port), handler)
    httpd.daemon_threads = True

    stop = threading.Event()

    def ticker() -> None:
        while not stop.wait(1.0 / TICK_HZ):
            hub.tick()

    thread = threading.Thread(target=ticker, name="hub-tick", daemon=True)
    thread.start()
    httpd.hub = hub
    httpd.stop_ticker = stop
    return httpd, hub
