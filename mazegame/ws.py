"""Minimal RFC 6455 WebSocket server framing on top of blocking socket files.

Only what the maze game needs: text frames, ping/pong, close. No extensions,
no compression, no client role.
"""

from __future__ import annotations

import base64
import hashlib
import struct
import threading

_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BIN = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WSError(Exception):
    """Protocol violation or transport failure."""


def accept_key(client_key: str) -> str:
    """Compute the Sec-WebSocket-Accept response value."""
    digest = hashlib.sha1(client_key.strip().encode("ascii") + _GUID).digest()
    return base64.b64encode(digest).decode("ascii")


class WebSocket:
    """One upgraded connection. `send` is thread safe, `recv` is not."""

    MAX_PAYLOAD = 1 << 20

    def __init__(self, rfile, wfile) -> None:
        self._rfile = rfile
        self._wfile = wfile
        self._send_lock = threading.Lock()
        self.closed = False

    # -- receiving ---------------------------------------------------------

    def _read_exact(self, n: int) -> bytes:
        buf = self._rfile.read(n)
        if buf is None or len(buf) != n:
            raise WSError("connection closed mid-frame")
        return buf

    def recv(self) -> str | None:
        """Block for the next text message. Returns None once peer closes."""
        parts: list[bytes] = []
        started = False
        while True:
            head = self._read_exact(2)
            fin = head[0] & 0x80
            opcode = head[0] & 0x0F
            masked = head[1] & 0x80
            length = head[1] & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            if length > self.MAX_PAYLOAD:
                raise WSError("payload too large")
            mask = self._read_exact(4) if masked else None
            payload = self._read_exact(length) if length else b""
            if mask is not None:
                payload = bytes(byte ^ mask[i & 3] for i, byte in enumerate(payload))

            if opcode == OP_CLOSE:
                self._send_frame(OP_CLOSE, payload[:2])
                self.closed = True
                return None
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CONT:
                if not started:
                    raise WSError("continuation without start")
                parts.append(payload)
            elif opcode in (OP_TEXT, OP_BIN):
                if started:
                    raise WSError("nested data frame")
                started = True
                parts.append(payload)
            else:
                raise WSError(f"unsupported opcode {opcode:#x}")

            if fin:
                data = b"".join(parts)
                parts = []
                started = False
                # Binary frames are not part of the protocol; skip them.
                if opcode in (OP_TEXT, OP_CONT):
                    return data.decode("utf-8", "replace")

    # -- sending -----------------------------------------------------------

    def _send_frame(self, opcode: int, payload: bytes) -> bool:
        if self.closed:
            return False
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, n)
        elif n < (1 << 16):
            header = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        with self._send_lock:
            if self.closed:
                return False
            try:
                self._wfile.write(header + payload)
                self._wfile.flush()
                return True
            except (OSError, ValueError):
                # ValueError: the reader thread already tore the socket down
                # ("I/O operation on closed file"). Either way the peer is gone
                # and a broadcast must not blow up on its way round the room.
                self.closed = True
                return False

    def send(self, text: str) -> bool:
        """Send one text frame. False means the peer is gone."""
        return self._send_frame(OP_TEXT, text.encode("utf-8"))

    def close(self, code: int = 1000) -> None:
        self._send_frame(OP_CLOSE, struct.pack("!H", code))
        self.closed = True
