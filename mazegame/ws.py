"""Minimal RFC 6455 WebSocket framing. Standard library only.

Only what the maze game needs: text frames, ping/pong, close. No extensions,
no compression, no client role. Parsing is incremental and buffer driven so a
single event loop can own every connection — there is no socket in here.
"""

from __future__ import annotations

import base64
import hashlib
import struct

_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BIN = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_PAYLOAD = 1 << 20


class WSError(Exception):
    """Protocol violation or transport failure."""


def accept_key(client_key: str) -> str:
    """Compute the Sec-WebSocket-Accept response value."""
    digest = hashlib.sha1(client_key.strip().encode("ascii") + _GUID).digest()
    return base64.b64encode(digest).decode("ascii")


def build_frame(opcode: int, payload: bytes) -> bytes:
    """One unmasked server frame, header and body in a single buffer."""
    n = len(payload)
    if n < 126:
        header = struct.pack("!BB", 0x80 | opcode, n)
    elif n < (1 << 16):
        header = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return header + payload


def text_frame(text: str) -> bytes:
    return build_frame(OP_TEXT, text.encode("utf-8"))


class Framer:
    """Turns a byte stream into complete messages.

    `feed` returns `(opcode, payload)` for every message that finished in the
    chunk: text and binary arrive whole with continuations already joined,
    control frames pass straight through. Anything still partial stays in the
    buffer for the next chunk.
    """

    __slots__ = ("_buf", "_kind", "_parts")

    def __init__(self) -> None:
        self._buf = bytearray()
        self._parts: list[bytes] = []
        self._kind = 0  # opcode of the fragmented message in progress

    def feed(self, data: bytes) -> list[tuple[int, bytes]]:
        buf = self._buf
        buf += data
        out: list[tuple[int, bytes]] = []
        while True:
            if len(buf) < 2:
                return out
            first, second = buf[0], buf[1]
            fin = first & 0x80
            opcode = first & 0x0F
            masked = second & 0x80
            length = second & 0x7F
            offset = 2
            if length == 126:
                if len(buf) < 4:
                    return out
                length = struct.unpack_from("!H", buf, 2)[0]
                offset = 4
            elif length == 127:
                if len(buf) < 10:
                    return out
                length = struct.unpack_from("!Q", buf, 2)[0]
                offset = 10
            if length > MAX_PAYLOAD:
                raise WSError("payload too large")
            if masked:
                if len(buf) < offset + 4:
                    return out
                mask = bytes(buf[offset:offset + 4])
                offset += 4
            else:
                # Clients must mask; browsers always do.
                raise WSError("unmasked client frame")
            end = offset + length
            if len(buf) < end:
                return out
            payload = bytes(buf[offset:end])
            del buf[:end]
            if length:
                # Widening to int lets one C-level XOR do the whole payload.
                keystream = (mask * (length // 4 + 1))[:length]
                payload = (
                    int.from_bytes(payload, "big") ^ int.from_bytes(keystream, "big")
                ).to_bytes(length, "big")

            if opcode & 0x8:  # control frames are never fragmented
                if not fin or length > 125:
                    raise WSError("bad control frame")
                out.append((opcode, payload))
                continue
            if opcode == OP_CONT:
                if not self._kind:
                    raise WSError("continuation without start")
                self._parts.append(payload)
            elif opcode in (OP_TEXT, OP_BIN):
                if self._kind:
                    raise WSError("nested data frame")
                self._kind = opcode
                self._parts.append(payload)
            else:
                raise WSError(f"unsupported opcode {opcode:#x}")
            if fin:
                out.append((self._kind, b"".join(self._parts)))
                self._parts.clear()
                self._kind = 0
