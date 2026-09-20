"""HTTP + WebSocket server for the maze game. Standard library only.

One asyncio loop owns every connection and the hub tick. The threaded version
of this file gave each player a thread and wrote snapshots with blocking
sends: at 800 players the hub thread spent seconds inside a single `send` to
a client that had stopped reading, and every other player's world froze with
it. Here a slow client's snapshots are dropped instead — position frames are
state, not history, so skipping one costs that client a tick and costs the
room nothing.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import posixpath
import time
import traceback
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .hub import Hub
from .ws import (
    OP_CLOSE,
    OP_PING,
    OP_PONG,
    OP_TEXT,
    Framer,
    WSError,
    accept_key,
    build_frame,
    text_frame,
)

STATIC_ROOT = Path(__file__).resolve().parent / "static"
TICK_HZ = 20.0  # watcher rotation checks and peer position snapshots
SILENCE_TIMEOUT = 12.0  # seconds without any client frame before we hang up
HEADER_TIMEOUT = 20.0  # seconds to send a request line and headers
READ_CHUNK = 8192
LAG_BYTES = 128 * 1024  # queued bytes before a client stops getting snapshots
DEAD_BYTES = 1 << 20  # queued bytes before the connection is simply cut
BACKLOG = 512  # a link going around arrives as a burst of SYNs

mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/javascript", ".js")


class Conn:
    """Hub-facing handle for one websocket.

    `send` never blocks and never raises: it writes into the transport buffer
    and reports whether the frame went out. Clients that fall far enough
    behind are dropped, then cut.
    """

    __slots__ = ("_transport", "_writer", "closed", "dropped")

    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer
        self._transport = writer.transport
        self.closed = False
        self.dropped = 0

    def send(self, text: str) -> bool:
        return self.send_bytes(text_frame(text))

    def send_bytes(self, frame: bytes) -> bool:
        if self.closed:
            return False
        pending = self._transport.get_write_buffer_size()
        if pending > DEAD_BYTES:
            self.abort()
            return False
        if pending > LAG_BYTES:
            self.dropped += 1
            return False
        try:
            self._writer.write(frame)
        except (OSError, RuntimeError):
            self.closed = True
            return False
        return True

    def abort(self) -> None:
        self.closed = True
        self._transport.abort()

    def close(self, code: int = 1000) -> None:
        if self.closed:
            return
        self.send_bytes(build_frame(OP_CLOSE, code.to_bytes(2, "big")))
        self.closed = True


class StaticFiles:
    """Small read-through cache. The whole site is a few hundred kilobytes."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._cache: dict[Path, tuple[float, bytes, str]] = {}

    def get(self, path: Path) -> tuple[bytes, str] | None:
        try:
            stamp = path.stat().st_mtime
        except OSError:
            return None
        hit = self._cache.get(path)
        if hit is not None and hit[0] == stamp:
            return hit[1], hit[2]
        try:
            body = path.read_bytes()
        except OSError:
            return None
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self._cache[path] = (stamp, body, ctype)
        return body, ctype

    def resolve(self, route: str) -> Path | None:
        clean = posixpath.normpath(route).lstrip("/")
        target = (self.root / clean).resolve()
        if self.root not in target.parents or not target.is_file():
            return None
        return target


class Server:
    def __init__(self, hub: Hub, verbose: bool = False) -> None:
        self.hub = hub
        self.verbose = verbose
        self.static = StaticFiles(STATIC_ROOT)

    # -- HTTP --------------------------------------------------------------

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            sock = writer.get_extra_info("socket")
            if sock is not None:
                try:
                    sock.setsockopt(6, 1, 1)  # IPPROTO_TCP, TCP_NODELAY
                except OSError:
                    pass
            while True:
                try:
                    head = await asyncio.wait_for(
                        reader.readuntil(b"\r\n\r\n"), HEADER_TIMEOUT
                    )
                except (TimeoutError, asyncio.IncompleteReadError, ValueError, OSError):
                    return
                request = self._parse(head)
                if request is None:
                    self._respond(writer, HTTPStatus.BAD_REQUEST, b"bad request")
                    return
                method, target, headers = request
                length = int(headers.get("content-length") or 0)
                if length:
                    await reader.readexactly(min(length, 1 << 20))
                keep = await self.route(method, target, headers, reader, writer)
                if not keep:
                    return
                await writer.drain()
        except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
            pass
        except Exception:
            traceback.print_exc()
        finally:
            try:
                writer.close()
            except Exception:
                pass

    @staticmethod
    def _parse(head: bytes) -> tuple[str, str, dict[str, str]] | None:
        try:
            lines = head.decode("latin-1").split("\r\n")
            method, target, _version = lines[0].split(" ", 2)
        except ValueError:
            return None
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        return method.upper(), target, headers

    async def route(
        self,
        method: str,
        target: str,
        headers: dict[str, str],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> bool:
        """Answer one request. False means the connection is done or hijacked."""
        url = urlparse(target)
        route = unquote(url.path)
        query = parse_qs(url.query)
        if method not in ("GET", "HEAD"):
            self._respond(writer, HTTPStatus.METHOD_NOT_ALLOWED, b"GET only")
            return False

        if route in ("/ws/play", "/ws/watch"):
            if method != "GET":
                self._respond(writer, HTTPStatus.BAD_REQUEST, b"expected a websocket upgrade")
                return False
            await self._websocket(route, query, headers, reader, writer)
            return False

        if route == "/api/version":
            body = json.dumps({"version": __version__}).encode()
            self._respond(writer, HTTPStatus.OK, body, "application/json", method, "no-store")
        elif route == "/api/state":
            # The roster is opt-in: /api/state?full=1.
            full = query.get("full", ["0"])[0] not in ("0", "", "false")
            body = json.dumps({"version": __version__, **self.hub.stats(full)}).encode()
            self._respond(writer, HTTPStatus.OK, body, "application/json", method, "no-store")
        else:
            if route in ("/", "/play", "/index.html"):
                path = STATIC_ROOT / "index.html"
            elif route in ("/watch", "/watch.html"):
                path = STATIC_ROOT / "watch.html"
            else:
                path = self.static.resolve(route)
            hit = self.static.get(path) if path else None
            if hit is None:
                self._respond(writer, HTTPStatus.NOT_FOUND, b"no such thing in this maze")
                return headers.get("connection", "").lower() != "close"
            body, ctype = hit
            self._respond(writer, HTTPStatus.OK, body, ctype, method, "no-cache")
        return headers.get("connection", "").lower() != "close"

    @staticmethod
    def _respond(
        writer: asyncio.StreamWriter,
        status: HTTPStatus,
        body: bytes,
        ctype: str = "text/plain; charset=utf-8",
        method: str = "GET",
        cache: str = "no-store",
    ) -> None:
        head = (
            f"HTTP/1.1 {status.value} {status.phrase}\r\n"
            f"Server: mazegame/{__version__}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Cache-Control: {cache}\r\n"
            "Connection: keep-alive\r\n\r\n"
        ).encode("latin-1")
        try:
            writer.write(head if method == "HEAD" else head + body)
        except (OSError, RuntimeError):
            pass

    # -- WebSocket ---------------------------------------------------------

    async def _websocket(
        self,
        route: str,
        query: dict[str, list[str]],
        headers: dict[str, str],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        key = headers.get("sec-websocket-key")
        if not key or headers.get("upgrade", "").lower() != "websocket":
            self._respond(writer, HTTPStatus.BAD_REQUEST, b"expected a websocket upgrade")
            return
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
            ).encode("latin-1")
        )
        conn = Conn(writer)
        if route == "/ws/play":
            await self._play(conn, query, reader)
        else:
            await self._watch(conn, reader)

    async def _pump(self, conn: Conn, reader: asyncio.StreamReader, on_message) -> None:
        """Read frames until the peer goes quiet, dispatching text messages."""
        framer = Framer()
        try:
            while not conn.closed:
                # Clients heartbeat every 3s; silence means the tab is gone
                # (or frozen in the back/forward cache) and the slot is free.
                data = await asyncio.wait_for(reader.read(READ_CHUNK), SILENCE_TIMEOUT)
                if not data:
                    return
                for opcode, payload in framer.feed(data):
                    if opcode == OP_CLOSE:
                        conn.send_bytes(build_frame(OP_CLOSE, payload[:2]))
                        conn.closed = True
                        return
                    if opcode == OP_PING:
                        conn.send_bytes(build_frame(OP_PONG, payload))
                    elif opcode == OP_TEXT:
                        try:
                            message = json.loads(payload)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue
                        if isinstance(message, dict):
                            on_message(message)
        except (TimeoutError, WSError, OSError, asyncio.IncompleteReadError):
            pass
        finally:
            conn.closed = True

    async def _play(self, conn: Conn, query: dict[str, list[str]], reader) -> None:
        name = (query.get("name") or [None])[0]
        hub = self.hub
        player = hub.add_player(conn, name)
        self.log(f"player {player.pid} {player.name} joined")
        conn.send(json.dumps({
            "t": "welcome",
            "id": player.pid,
            "name": player.name,
            "players": len(hub.players),
            **hub.world(),
        }))

        def on_message(msg: dict) -> None:
            kind = msg.get("t")
            if kind == "pos":
                try:
                    hub.move_player(player, float(msg["x"]), float(msg["y"]), float(msg["a"]))
                except (KeyError, TypeError, ValueError):
                    pass
            elif kind == "escaped":
                hub.record_finish(player)

        try:
            await self._pump(conn, reader, on_message)
        finally:
            hub.drop_player(player)
            self.log(f"player {player.pid} {player.name} left")

    async def _watch(self, conn: Conn, reader) -> None:
        hub = self.hub
        watcher = hub.add_watcher(conn)
        self.log(f"watcher {watcher.wid} joined")

        def on_message(msg: dict) -> None:
            if msg.get("t") == "skip":
                hub.skip(watcher)

        try:
            await self._pump(conn, reader, on_message)
        finally:
            hub.drop_watcher(watcher)
            self.log(f"watcher {watcher.wid} left")

    # -- logging -----------------------------------------------------------

    def log(self, message: str) -> None:
        if self.verbose:
            print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


async def ticker(hub: Hub) -> None:
    """Rounds, watcher rotation and position snapshots, on a steady cadence.

    If a tick ever runs long the schedule is reset rather than caught up on,
    so a hiccup cannot turn into a burst of back-to-back snapshots.
    """
    period = 1.0 / TICK_HZ
    due = time.monotonic()
    while True:
        due += period
        now = time.monotonic()
        due = max(due, now)
        await asyncio.sleep(due - now)
        try:
            hub.tick()
        except Exception:
            traceback.print_exc()


async def serve(
    host: str = "127.0.0.1",
    port: int = 8080,
    verbose: bool = False,
    grace: float | None = None,
) -> tuple[asyncio.Server, Hub]:
    """Start listening. The caller drives `server.serve_forever()`."""
    hub = Hub(grace=grace) if grace is not None else Hub()
    app = Server(hub, verbose)
    server = await asyncio.start_server(app.handle, host, port, backlog=BACKLOG)
    asyncio.create_task(ticker(hub))
    return server, hub
