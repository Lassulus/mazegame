"""Shared game state: one maze for everyone, plus the spectator camera.

Every player walks the same seeded maze and sees the others as they move. The
first player to touch the NixOS logo starts a countdown; when it expires the
whole world rolls over to a fresh maze.

The watcher rule: a watcher follows one player; when that player has not moved
for `IDLE_SWITCH` seconds, the watcher is handed to the next player in join
order (preferring one that is currently moving).
"""

from __future__ import annotations

import itertools
import json
import math
import random
import secrets
import threading
import time
from dataclasses import dataclass, field

IDLE_SWITCH = 2.0  # seconds of stillness before a watcher moves on
ROUND_GRACE = 120.0  # seconds between the first escape and the next maze
MOVE_EPS = 0.015  # world units
TURN_EPS = 0.015  # radians

_ADJECTIVES = (
    "lost", "pure", "lazy", "eager", "hermetic", "sandboxed", "rolling",
    "derived", "pinned", "stale", "impure", "atomic", "nomadic", "curious",
)
_NOUNS = (
    "wanderer", "derivation", "snowflake", "closure", "hydra", "gnome",
    "rebuilder", "flake", "hopper", "mole", "spelunker", "daemon",
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
    conn: object  # WebSocket
    x: float = 0.0
    y: float = 0.0
    a: float = 0.0
    placed: bool = False
    joined: float = field(default_factory=time.monotonic)
    last_move: float = field(default_factory=time.monotonic)
    finished_at: float | None = None
    place: int | None = None

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

    # -- the world ---------------------------------------------------------

    def roster(self) -> list[dict]:
        with self._lock:
            return [{"id": p.pid, "name": p.name} for p in self.players.values()]

    def world(self) -> dict:
        """Everything a joining client needs to draw the current round."""
        with self._lock:
            return {
                "seed": self.seed,
                "ends_in": self._ends_in(),
                "grace": self.grace,
                "finishers": self._finishers(),
            }

    def _ends_in(self) -> float | None:
        if self.deadline is None:
            return None
        return max(0.0, round(self.deadline - time.monotonic(), 2))

    def _finishers(self) -> list[dict]:
        done = sorted(
            (p for p in self.players.values() if p.finished_at is not None),
            key=lambda p: p.finished_at,
        )
        return [
            {
                "name": p.name,
                "place": p.place,
                "secs": round(p.finished_at - self.round_started, 1),
            }
            for p in done
        ]

    def record_finish(self, player: Player) -> None:
        """A player touched the logo. The first one starts the countdown."""
        with self._lock:
            if player.finished_at is not None:
                return  # already home; standing in the exit changes nothing
            now = time.monotonic()
            player.finished_at = now
            player.place = 1 + sum(
                1 for p in self.players.values() if p is not player and p.finished_at is not None
            )
            first = self.deadline is None
            if first:
                self.deadline = now + self.grace
            frame = json.dumps({
                "t": "finish",
                "id": player.pid,
                "name": player.name,
                "place": player.place,
                "secs": round(now - self.round_started, 1),
                "first": first,
                "ends_in": self._ends_in(),
            })
        self._broadcast(frame)

    def new_round(self) -> None:
        with self._lock:
            now = time.monotonic()
            self.seed = new_seed()
            self.round_started = now
            self.deadline = None
            for player in self.players.values():
                player.finished_at = None
                player.place = None
                player.placed = False
                player.last_move = now
            frame = json.dumps({"t": "world", "seed": self.seed})
        self._broadcast(frame)

    # -- players -----------------------------------------------------------

    def add_player(self, conn, name: str | None = None) -> Player:
        with self._lock:
            player = Player(pid=next(self._ids), name=clean_name(name), conn=conn)
            self.players[player.pid] = player
        self._broadcast_roster()
        return player

    def drop_player(self, player: Player) -> None:
        with self._lock:
            self.players.pop(player.pid, None)
            orphaned = [w for w in self.watchers.values() if w.target == player.pid]
            for watcher in orphaned:
                watcher.target = None
        for watcher in orphaned:
            self._retarget(watcher, reason="gone")
        self._broadcast_roster()

    def move_player(self, player: Player, x: float, y: float, a: float) -> bool:
        """Record a position. Returns True if it counts as movement."""
        now = time.monotonic()
        with self._lock:
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
        """One positional snapshot for everyone; clients filter themselves out."""
        with self._lock:
            if not self.players and not self.watchers:
                return
            frame = json.dumps({
                "t": "peers",
                "l": [
                    [p.pid, round(p.x, 3), round(p.y, 3), round(p.a, 3),
                     1 if p.finished_at is not None else 0]
                    for p in self.players.values()
                    if p.placed
                ],
            })
        self._broadcast(frame)

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

    def _broadcast_roster(self) -> None:
        with self._lock:
            frame = json.dumps({
                "t": "roster",
                "players": self.roster(),
            })
        self._broadcast(frame)

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

    def stats(self) -> dict:
        now = time.monotonic()
        with self._lock:
            return {
                "world": {
                    "seed": self.seed,
                    "age": round(now - self.round_started, 1),
                    "ends_in": self._ends_in(),
                    "finishers": self._finishers(),
                },
                "players": [
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
                ],
                "watchers": [
                    {"id": w.wid, "target": w.target} for w in self.watchers.values()
                ],
            }


def _wrap(angle: float) -> float:
    """Wrap radians into (-pi, pi]."""
    return (angle + math.pi) % (2 * math.pi) - math.pi
