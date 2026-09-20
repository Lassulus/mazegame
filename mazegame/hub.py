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
import threading
import time
from dataclasses import dataclass, field

from .ws import text_frame

IDLE_SWITCH = 2.0  # seconds of stillness before a watcher moves on
ROUND_GRACE = 120.0  # seconds between the first escape and the next maze
ESCAPE_COOLDOWN = 2.0  # seconds between two escapes by one player (under the 2.6 s card dwell)
MOVE_EPS = 0.015  # world units
TURN_EPS = 0.015  # radians
BUCKET = 8  # tiles per interest bucket edge while the room is small
CROWD_BUCKET = 4  # tighter buckets once frames are shared, so the list stays local
PEER_LIMIT = 20  # neighbours sent per client
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

    def __post_init__(self) -> None:
        # Names never change, so escape once instead of on every snapshot.
        self.tag = json.dumps(self.name)

    def idle_for(self, now: float) -> float:
        return now - self.last_move


@dataclass
class Watcher:
    wid: int
    conn: object  # WebSocket
    target: int | None = None
    since: float = field(default_factory=time.monotonic)  # last switch


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

        Sending every player to every player is quadratic: 500 players meant a
        10 KB frame fanned out 500 times, 20 times a second. A bucket index
        keeps the candidate set local.

        Two regimes. While the room is small every client gets its own list,
        centred on itself, out of a wide (`BUCKET`) neighbourhood — exact, and
        cheap because there are few clients. Past `PEER_EXACT_MAX` the frame is
        built once per `CROWD_BUCKET` cell and the same bytes go to everyone
        standing in it: 800 players cost ~160 frames instead of 800, and the
        tighter cell keeps that shared list genuinely local. Measured on 800
        scattered players, the shared list misses 3.7 % of a player's eight
        nearest neighbours against 29.5 % for the per-bucket shortlist it
        replaces, at a third of the CPU.

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
            # Flat tuples, not Player objects: everything below reads a frozen
            # copy, so a player moving mid-tick cannot tear a frame and the
            # hot loops index instead of chasing attributes.
            bodies = [
                (p.x, p.y, p.pid, p.a, 1 if p.finished_at is not None else 0, p.tag)
                for p in self.players.values()
                if p.placed
            ]
            targets = [(p.conn, p.x, p.y, p.pid) for p in self.players.values() if p.placed]
            idle = [p.conn for p in self.players.values() if not p.placed]
            watching = [(w.conn, w.target) for w in self.watchers.values()]

        crowded = count > PEER_EXACT_MAX
        bucket = CROWD_BUCKET if crowded else BUCKET
        at = {b[2]: b for b in bodies}
        buckets: dict[tuple[int, int], list[tuple]] = {}
        for b in bodies:
            buckets.setdefault((int(b[0] // bucket), int(b[1] // bucket)), []).append(b)

        # Clients pace their own updates off this: no point sending 20 Hz of
        # position into a room that only snapshots at 10.
        prefix = f'{{"t":"peers","n":{count},"hz":{round(1 / interval)},"l":['
        empty = text_frame(prefix + "]}")
        # A body serialises to the same JSON no matter who is looking at it, so
        # encode each one once per tick and assemble frames by joining strings.
        # json.dumps per client is what caps the tick rate once a couple of
        # hundred people are connected. Names ride along, so clients never need
        # a roster broadcast.
        entry: dict[int, str] = {}

        def encode(q: tuple) -> str:
            hit = entry.get(q[2])
            if hit is None:
                # Hand-rolled instead of json.dumps: same bytes without the
                # list allocation, and the name was escaped once at join.
                hit = f"[{q[2]},{round(q[0], 3)},{round(q[1], 3)},{round(q[3], 3)},{q[4]},{q[5]}]"
                entry[q[2]] = hit
            return hit

        def pool_at(bx: int, by: int) -> list[tuple]:
            pool: list[tuple] = []
            for oy in (-1, 0, 1):
                for ox in (-1, 0, 1):
                    pool.extend(buckets.get((bx + ox, by + oy), ()))
            return pool

        def frame_around(x: float, y: float, skip: int | None) -> bytes:
            pool = pool_at(int(x // bucket), int(y // bucket))
            near = heapq.nsmallest(
                PEER_LIMIT,
                (q for q in pool if q[2] != skip),
                key=lambda q: (q[0] - x) ** 2 + (q[1] - y) ** 2,
            )
            return text_frame(prefix + ",".join([encode(q) for q in near]) + "]}")

        sends: list[tuple] = []
        if crowded:
            shared: dict[tuple[int, int], bytes] = {}
            for cell in buckets:
                pool = pool_at(*cell)
                if len(pool) > PEER_LIMIT:
                    cx = (cell[0] + 0.5) * bucket
                    cy = (cell[1] + 0.5) * bucket
                    pool = heapq.nsmallest(
                        PEER_LIMIT, pool, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2
                    )
                shared[cell] = text_frame(prefix + ",".join([encode(q) for q in pool]) + "]}")
            for conn, x, y, _pid in targets:
                sends.append((conn, shared[(int(x // bucket), int(y // bucket))]))
        else:
            sends = [(conn, frame_around(x, y, pid)) for conn, x, y, pid in targets]
        sends += [(conn, empty) for conn in idle]
        for conn, target in watching:
            body = at.get(target) if target else None
            if body is None:
                continue
            sends.append((conn, frame_around(body[0], body[1], None)))

        built = time.monotonic()
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
