"""Shared game state: one maze for everyone, plus the spectator camera.

Every player walks the same seeded maze and sees the others as they move. The
first player to touch the NixOS logo starts a countdown; when it expires the
whole world rolls over to a fresh maze.

The watcher rule: a watcher follows one player; when that player has not moved
for `IDLE_SWITCH` seconds, the watcher is handed to the next player in join
order (preferring one that is currently moving).
"""

from __future__ import annotations

import heapq
import itertools
import json
import math
import random
import secrets
import struct
import threading
import time
from dataclasses import dataclass, field

from .ws import binary_frame, text_frame

# Snapshot wire format. A body is eleven bytes — id, x, y, angle, flags —
# instead of forty-odd characters of JSON, and names travel once per viewer
# in a `names` message rather than on every tick. At 800 players that is the
# difference between 4.6 KB/s and 1.4 KB/s per client.
PEERS_FRAME = 1
POS_SCALE = 1000  # world units per unit of the u16 position field
TAU = 2 * math.pi
ANGLE_SCALE = 65536 / TAU
KNOWN_CAP = 1024  # names remembered per viewer before the slate is wiped
_PEERS_HEAD = struct.Struct("<BBHI")  # type, hz, players in the room, tick clock
AGE_STEP = 2  # ms per unit of the u8 age field, so 0-510 ms fits
_BODY = struct.Struct("<IHHHBB")  # id, x, y, angle, flags, age

IDLE_SWITCH = 2.0  # seconds of stillness before a watcher moves on
ROUND_GRACE = 120.0  # seconds between the first escape and the next maze
ESCAPE_COOLDOWN = 2.0  # seconds between two escapes by one player (under the 2.6 s card dwell)
MOVE_EPS = 0.015  # world units
TURN_EPS = 0.015  # radians
BUCKET = 8  # tiles per interest bucket edge while the room is small
CROWD_BUCKET = 4  # tighter buckets once frames are shared, so the list stays local
PEER_LIMIT = 96  # most neighbours sent per client; a body is 12 bytes on the wire
SIGHT = 20.0  # tiles: how far the interest search will reach for company
PEER_NEAR = 48  # bodies close enough to be worth a slot on every single tick
FAR_EVERY = 3  # the rest are refreshed on one tick in three, staggered
PEER_INTERVAL = 0.05  # seconds between position snapshots in a quiet room
PEER_BUSY = 150  # above this many players, halve the snapshot rate
PEER_CROWD = 500  # above this, a third of it: the tick has 1200 sockets to write
PEER_EXACT_MAX = 120  # above this, one frame per bucket instead of one per player


def snapshot_interval(players: int) -> float:
    """Seconds between position snapshots for a room this size.

    Clients interpolate between snapshots and are told the rate, so a big room
    trades update frequency for keeping up at all: at 800 players a tick costs
    roughly 45 ms to build and 40 ms to write, which does not fit in 100 ms.
    """
    if players <= PEER_BUSY:
        return PEER_INTERVAL
    if players <= PEER_CROWD:
        return PEER_INTERVAL * 2
    return PEER_INTERVAL * 3


_ADJECTIVES = (
    "lost", "pure", "lazy", "eager", "hermetic", "sandboxed", "rolling",
    "derived", "pinned", "stale", "impure", "atomic", "nomadic", "curious",
)
_NOUNS = (
    "wanderer", "derivation", "snowflake", "closure", "hydra", "gnome",
    "rebuilder", "flake", "hopper", "linker", "spelunker", "daemon",
)


def _name() -> str:
    return f"{random.choice(_ADJECTIVES)}-{random.choice(_NOUNS)}"


def clean_name(raw: str | None) -> str:
    """Player-chosen name, or a generated one when nothing usable is given."""
    text = "".join(ch for ch in (raw or "") if ch.isprintable() and ch not in "\u2028\u2029")
    return text.strip()[:24] or _name()


def new_seed() -> int:
    return secrets.randbelow(1 << 32)


@dataclass
class Player:
    pid: int
    name: str
    conn: object  # Conn
    x: float = 0.0
    y: float = 0.0
    a: float = 0.0
    placed: bool = False
    joined: float = field(default_factory=time.monotonic)
    last_move: float = field(default_factory=time.monotonic)
    finished_at: float | None = None  # first escape; fixes the place
    place: int | None = None
    escapes: int = 0
    last_escape: float = 0.0
    moved_at: float = field(default_factory=time.monotonic)  # when x/y/a last arrived
    # Names this viewer has already been told about, so a snapshot can be
    # pure numbers.
    known: set[int] = field(default_factory=set)

    def idle_for(self, now: float) -> float:
        return now - self.last_move


@dataclass
class Watcher:
    wid: int
    conn: object  # Conn
    target: int | None = None
    since: float = field(default_factory=time.monotonic)  # last switch
    known: set[int] = field(default_factory=set)


class Hub:
    def __init__(self, idle_switch: float = IDLE_SWITCH, grace: float = ROUND_GRACE) -> None:
        self.idle_switch = idle_switch
        self.grace = grace
        self._lock = threading.RLock()
        self._ids = itertools.count(1)
        self.players: dict[int, Player] = {}  # insertion order == join order
        self.watchers: dict[int, Watcher] = {}
        self.seed = new_seed()
        self.round_started = time.monotonic()
        self.deadline: float | None = None  # set by the first escape
        self.finishers: list[dict] = []  # this round's escapes, survives disconnects
        self._peers_due = 0.0
        self._snapshot_seq = 0
        # Ops: how long the hub thread spends picking/encoding frames versus
        # pushing them out, so a slow room can be diagnosed from /api/state
        # instead of guessed at.
        self.perf = {"build_ms": 0.0, "send_ms": 0.0, "frames": 0, "slow": 0}

    # -- the world ---------------------------------------------------------

    def world(self) -> dict:
        """Everything a joining client needs to draw the current round."""
        with self._lock:
            return {
                "seed": self.seed,
                "ends_in": self._ends_in(),
                "grace": self.grace,
                "finishers": list(self.finishers),
            }

    def _ends_in(self) -> float | None:
        if self.deadline is None:
            return None
        return max(0.0, round(self.deadline - time.monotonic(), 2))

    def record_finish(self, player: Player) -> None:
        """A player touched the logo. The first one starts the countdown.

        Later trips count too: after the escape card the client drops you back
        into the maze, so the logo is worth walking to again. Only the first
        escape takes a place, and only the first escape of the round arms the
        countdown.
        """
        with self._lock:
            now = time.monotonic()
            # A client that never respawns cannot farm escapes by standing in
            # the logo: one trip per dwell, at most.
            if now - player.last_escape < ESCAPE_COOLDOWN:
                return
            player.last_escape = now
            player.escapes += 1
            secs = round(now - self.round_started, 1)
            if player.finished_at is None:
                player.finished_at = now
                # The log belongs to the round, not to the connection: a winner
                # who closes their tab must still be credited when the maze
                # rolls over.
                player.place = len(self.finishers) + 1
                self.finishers.append({
                    "name": player.name,
                    "place": player.place,
                    "secs": secs,
                })
            first = self.deadline is None
            if first:
                self.deadline = now + self.grace
            frame = json.dumps({
                "t": "finish",
                "id": player.pid,
                "name": player.name,
                "place": player.place,
                "secs": secs,
                "runs": player.escapes,
                "first": first,
                "ends_in": self._ends_in(),
            })
        self._broadcast(frame)

    def new_round(self) -> None:
        with self._lock:
            now = time.monotonic()
            winner = self.finishers[0]["name"] if self.finishers else None
            self.seed = new_seed()
            self.round_started = now
            self.deadline = None
            self.finishers = []
            for player in self.players.values():
                player.finished_at = None
                player.place = None
                player.escapes = 0
                player.last_escape = 0.0
                player.placed = False
                player.last_move = now
            frame = json.dumps({"t": "world", "seed": self.seed, "winner": winner})
        self._broadcast(frame)

    # -- players -----------------------------------------------------------

    def add_player(self, conn, name: str | None = None) -> Player:
        with self._lock:
            player = Player(pid=next(self._ids), name=clean_name(name), conn=conn)
            self.players[player.pid] = player
        return player

    def drop_player(self, player: Player) -> None:
        with self._lock:
            self.players.pop(player.pid, None)
            orphaned = [w for w in self.watchers.values() if w.target == player.pid]
            for watcher in orphaned:
                watcher.target = None
        for watcher in orphaned:
            self._retarget(watcher, reason="gone")

    def move_player(self, player: Player, x: float, y: float, a: float) -> bool:
        """Record a position. Returns True if it counts as movement.

        Deliberately lock-free. This runs on the connection thread, twenty
        times a second per player, so at 800 players it is 16k lock
        acquisitions a second all queueing behind whatever the hub thread is
        doing — that convoy, not the arithmetic, is what used to stall the
        world. The writes are plain attribute stores, atomic under the GIL,
        and a reader that catches a new x with an old y is off by one frame of
        walking for one tick. Nothing here is structural: joins, drops and
        round transitions still take the lock.
        """
        now = time.monotonic()
        moved = (
            not player.placed
            or abs(x - player.x) > MOVE_EPS
            or abs(y - player.y) > MOVE_EPS
            or abs(_wrap(a - player.a)) > TURN_EPS
        )
        player.x, player.y, player.a, player.placed = x, y, a, True
        # When this position was true. Snapshots go out on a fixed cadence but
        # a body's last report can be anywhere inside the interval, and that
        # wobble is what made other players' walking look uneven: the client
        # needs the age to place the sample on its own timeline.
        player.moved_at = now
        if moved:
            player.last_move = now
        return moved

    # -- watchers ----------------------------------------------------------

    def add_watcher(self, conn) -> Watcher:
        with self._lock:
            watcher = Watcher(wid=next(self._ids), conn=conn)
            self.watchers[watcher.wid] = watcher
        self._retarget(watcher, reason="start", randomize=True)
        return watcher

    def drop_watcher(self, watcher: Watcher) -> None:
        with self._lock:
            self.watchers.pop(watcher.wid, None)
            previous = watcher.target
            watcher.target = None
        self._notify_watched(previous)

    def skip(self, watcher: Watcher) -> None:
        """Viewer-requested switch to the next player."""
        self._retarget(watcher, reason="skip")

    # -- the clock ---------------------------------------------------------

    def tick(self) -> None:
        """Hub thread: rolls the world over, rotates watchers, pushes peers."""
        now = time.monotonic()
        with self._lock:
            rollover = self.deadline is not None and now >= self.deadline
        if rollover:
            self.new_round()

        with self._lock:
            due = []
            for watcher in self.watchers.values():
                player = self.players.get(watcher.target) if watcher.target else None
                if player is None:
                    if watcher.target is None and not self.players:
                        continue  # nobody to watch yet; already told them so
                    due.append((watcher, "gone" if watcher.target else "joined"))
                elif len(self.players) > 1 and min(
                    player.idle_for(now), now - watcher.since
                ) > self.idle_switch:
                    # Stillness only counts while we are pointed at them, so a
                    # roomful of idle players is a slideshow, not a strobe.
                    due.append((watcher, "idle"))
        for watcher, reason in due:
            self._retarget(watcher, reason=reason)

        self.broadcast_peers()

    def broadcast_peers(self) -> None:
        """Positions, but only the neighbours each client can actually see.

        Sending every position to every player is quadratic: at 560 players
        that was a 10 KB frame fanned out 560 times, 20 times a second. A
        bucket index bounds the candidate set, each client gets the
        `PEER_LIMIT` nearest bodies, and the frame is **binary**: eleven bytes
        a body instead of forty-odd characters of JSON, with names sent once
        per viewer instead of on every tick.

        Two regimes. While the room is small every client gets its own list,
        centred on itself, out of a wide (`BUCKET`) neighbourhood — exact, and
        cheap because there are few clients. Past `PEER_EXACT_MAX` the frame is
        built once per `CROWD_BUCKET` cell and the same bytes go to everyone
        standing in it: 800 players cost ~160 frames instead of 800.

        Watchers always get an exact list centred on their target, and never
        skipping it: the camera needs the position of the very player it is
        riding. There are a handful of watchers, so exactness there is free.

        The lock is held only for the snapshot. Selecting and encoding frames
        takes tens of milliseconds, and doing that inside the lock put every
        position update of every player behind it.
        """
        now = time.monotonic()
        with self._lock:
            count = len(self.players)
            if not count and not self.watchers:
                return
            interval = snapshot_interval(count)
            if now < self._peers_due:
                return
            # Stay on the cadence instead of drifting a whole tick every time
            # the deadline lands just after a tick boundary.
            self._peers_due = max(now, self._peers_due + interval)
            self._snapshot_seq += 1
            # Flat tuples, not Player objects: everything below reads a frozen
            # copy, so a player moving mid-tick cannot tear a frame and the
            # hot loops index instead of chasing attributes.
            bodies = [
                (p.x, p.y, p.pid, p.a, 1 if p.finished_at is not None else 0, p.name, p.moved_at)
                for p in self.players.values()
                if p.placed
            ]
            viewers = [(p, p.x, p.y, p.pid) for p in self.players.values() if p.placed]
            idle = [p.conn for p in self.players.values() if not p.placed]
            watching = [(w, w.target) for w in self.watchers.values()]

        crowded = count > PEER_EXACT_MAX
        bucket = CROWD_BUCKET if crowded else BUCKET
        at = {b[2]: b for b in bodies}
        buckets: dict[tuple[int, int], list[tuple]] = {}
        for b in bodies:
            buckets.setdefault((int(b[0] // bucket), int(b[1] // bucket)), []).append(b)

        # The tick clock rides along so clients can lay snapshots on an even
        # timeline instead of on their own arrival times, which jitter.
        head = _PEERS_HEAD.pack(
            PEERS_FRAME,
            min(255, round(1 / interval)),
            min(65535, count),
            int(now * 1000) & 0xFFFFFFFF,
        )
        empty = binary_frame(head + b"\x00\x00")
        # A body packs identically for every viewer, so pack each one once per
        # tick and assemble frames by joining bytes.
        packed: dict[int, bytes] = {}

        def pack(q: tuple) -> bytes:
            hit = packed.get(q[2])
            if hit is None:
                hit = _BODY.pack(
                    q[2] & 0xFFFFFFFF,
                    min(65535, max(0, int(q[0] * POS_SCALE))),
                    min(65535, max(0, int(q[1] * POS_SCALE))),
                    int((q[3] % TAU) * ANGLE_SCALE) & 0xFFFF,
                    q[4],
                    min(255, max(0, int((now - q[6]) * 1000 / AGE_STEP))),
                )
                packed[q[2]] = hit
            return hit

        def build(near: list[tuple]) -> tuple[bytes, tuple[int, ...]]:
            frame = binary_frame(
                head + len(near).to_bytes(2, "little") + b"".join([pack(q) for q in near])
            )
            return frame, tuple(q[2] for q in near)

        rings = max(1, math.ceil(SIGHT / bucket))

        def pool_at(bx: int, by: int) -> list[tuple]:
            """Bodies near a cell, widening a ring at a time until the list is
            full or `SIGHT` is reached.

            A fixed three-by-three window is anchored on the *cell*, not on
            the viewer, so someone standing at a cell edge could only be told
            about bodies eight tiles ahead and players visibly popped in and
            out halfway down a corridor. Widening instead means an empty
            corridor is reported to the horizon, while a crowd fills the list
            from the nearest cells and costs no more to compute.
            """
            pool: list[tuple] = list(buckets.get((bx, by), ()))
            for r in range(1, rings + 1):
                if len(pool) >= PEER_LIMIT:
                    break
                for oy in range(-r, r + 1):
                    edge = r if abs(oy) == r else None
                    for ox in (range(-r, r + 1) if edge else (-r, r)):
                        pool.extend(buckets.get((bx + ox, by + oy), ()))
            return pool

        def thin(near: list[tuple]) -> list[tuple]:
            """Every tick for the bodies close by, every `FAR_EVERY`th for the
            rest.

            The nearest two dozen are what a player is actually looking at.
            A body twenty tiles down a corridor is a few pixels tall, so
            spending a twelve-byte slot on it sixty times a minute is waste:
            it gets a third of the rate, staggered by its position in the
            list so each tick carries an even share. Interpolation on the
            client is per body and learns the rate, so the distant ones still
            glide rather than hop.
            """
            if len(near) <= PEER_NEAR:
                return near
            out = near[:PEER_NEAR]
            phase = self._snapshot_seq % FAR_EVERY
            out.extend(q for i, q in enumerate(near[PEER_NEAR:]) if i % FAR_EVERY == phase)
            return out

        def around(x: float, y: float, skip: int | None) -> tuple[bytes, tuple[int, ...]]:
            pool = pool_at(int(x // bucket), int(y // bucket))
            return build(
                thin(
                    heapq.nsmallest(
                        PEER_LIMIT,
                        (q for q in pool if q[2] != skip),
                        key=lambda q: (q[0] - x) ** 2 + (q[1] - y) ** 2,
                    )
                )
            )

        sends: list[tuple] = []
        named: list[tuple] = []

        def queue(viewer, frame: bytes, ids: tuple[int, ...]) -> None:
            """Send the frame, and any names this viewer has not been told."""
            sends.append((viewer.conn, frame))
            known = viewer.known
            fresh = [i for i in ids if i not in known]
            if fresh:
                if len(known) > KNOWN_CAP:
                    known.clear()  # a long session in a busy world; start over
                known.update(fresh)
                named.append((
                    viewer.conn,
                    text_frame(json.dumps({
                        "t": "names",
                        "l": [[i, at[i][5]] for i in fresh if i in at],
                    })),
                ))

        if crowded:
            shared: dict[tuple[int, int], tuple[bytes, tuple[int, ...]]] = {}
            for cell in buckets:
                pool = pool_at(*cell)
                cx = (cell[0] + 0.5) * bucket
                cy = (cell[1] + 0.5) * bucket
                pool = (
                    heapq.nsmallest(
                        PEER_LIMIT, pool, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2
                    )
                    if len(pool) > PEER_LIMIT
                    else sorted(pool, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2)
                )
                shared[cell] = build(thin(pool))
            for player, x, y, _pid in viewers:
                queue(player, *shared[(int(x // bucket), int(y // bucket))])
        else:
            for player, x, y, pid in viewers:
                queue(player, *around(x, y, pid))
        sends += [(conn, empty) for conn in idle]
        for watcher, target in watching:
            body = at.get(target) if target else None
            if body is None:
                continue
            queue(watcher, *around(body[0], body[1], None))

        built = time.monotonic()
        for conn, frame in named:
            conn.send_bytes(frame)
        for conn, frame in sends:
            conn.send_bytes(frame)
        done = time.monotonic()
        self.perf = {
            "build_ms": round((built - now) * 1000, 1),
            "send_ms": round((done - built) * 1000, 1),
            "frames": len(sends),
            "slow": self.perf["slow"] + (1 if done - now > interval else 0),
        }

    # -- plumbing ----------------------------------------------------------

    def _retarget(self, watcher: Watcher, reason: str, randomize: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            previous = watcher.target
            order = list(self.players.values())
            if not order:
                watcher.target = None
                watcher.since = now
                payload = {"t": "idle_pool", "reason": reason, "players": 0}
            else:
                pick = self._next_player(order, watcher.target, randomize, now)
                if pick is None:
                    return
                watcher.target = pick.pid
                watcher.since = now
                payload = {
                    "t": "watch",
                    "reason": reason,
                    "players": len(order),
                    "id": pick.pid,
                    "name": pick.name,
                    "placed": pick.placed,
                    "x": round(pick.x, 4),
                    "y": round(pick.y, 4),
                    "a": round(pick.a, 4),
                    **self.world(),
                }
        watcher.conn.send(json.dumps(payload))
        self._notify_watched(previous, watcher.target)

    def _next_player(
        self, order: list[Player], current: int | None, randomize: bool, now: float
    ) -> Player | None:
        if randomize:
            fresh = [p for p in order if p.idle_for(now) <= self.idle_switch]
            return random.choice(fresh or order)
        index = next((i for i, p in enumerate(order) if p.pid == current), -1)
        rotated = order[index + 1:] + order[: index + 1]
        others = [p for p in rotated if p.pid != current]
        if not others:
            return None  # nobody else to switch to; keep watching
        active = [p for p in others if p.idle_for(now) <= self.idle_switch]
        return (active or others)[0]

    def _broadcast(self, frame: str) -> None:
        with self._lock:
            conns = [p.conn for p in self.players.values()]
            conns += [w.conn for w in self.watchers.values()]
        for conn in conns:
            conn.send(frame)

    def _notify_watched(self, *pids: int | None) -> None:
        """Let players know how many cameras are pointed at them."""
        with self._lock:
            frames = []
            for pid in {pid for pid in pids if pid}:
                player = self.players.get(pid)
                if player is None:
                    continue
                count = sum(1 for w in self.watchers.values() if w.target == pid)
                frames.append((player.conn, json.dumps({"t": "watched", "n": count})))
        for conn, frame in frames:
            conn.send(frame)

    def stats(self, full: bool = False) -> dict:
        """Ops snapshot. The per-player roster is opt-in: dumping 800 of them
        on every poll is real work on the same loop that runs the game."""
        now = time.monotonic()
        with self._lock:
            out = {
                "world": {
                    "seed": self.seed,
                    "age": round(now - self.round_started, 1),
                    "ends_in": self._ends_in(),
                    "finishers": list(self.finishers),
                },
                "perf": {
                    **self.perf,
                    "players": len(self.players),
                    "watchers": len(self.watchers),
                    "dropped": sum(getattr(p.conn, "dropped", 0) for p in self.players.values()),
                },
            }
            if full:
                out["players"] = [
                    {
                        "id": p.pid,
                        "name": p.name,
                        "x": round(p.x, 4),
                        "y": round(p.y, 4),
                        "a": round(p.a, 4),
                        "idle": round(p.idle_for(now), 2),
                        "place": p.place,
                    }
                    for p in self.players.values()
                ]
                out["watchers"] = [
                    {"id": w.wid, "target": w.target} for w in self.watchers.values()
                ]
            return out


def _wrap(angle: float) -> float:
    """Wrap radians into (-pi, pi]."""
    return (angle + math.pi) % (2 * math.pi) - math.pi
