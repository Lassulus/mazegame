# mazegame

A Windows 95 "Maze" screensaver you can actually play, in a browser tab.
Brick corridors, a pixelated raycaster, and an exit made of the NixOS snowflake.

Everyone shares one 51x51 maze and sees the other wanderers as coloured pawns
with name tags. The first player to touch the snowflake starts a two-minute
countdown; when it expires the whole world rolls over to a fresh maze and
everybody respawns together. Players who made it are drawn in NixOS blue.

Two pages:

- `/` — **play**: pick a name (blank gets you a generated one), then race the
  others to the logo.
- `/watch` — **maze cam**: rides along with one random player. When that player
  stops moving for 2 seconds, the camera cuts to the next player.

No build step, no dependencies: the server is Python standard library only
(including the WebSocket implementation) and the client is plain ES modules.

The running version is shown in the HUD and served at `/api/version`.
`mazegame/__init__.py` is the only place it is written down: `pyproject.toml`
and `flake.nix` both read `__version__` from there.

## Run

```sh
nix run .                       # or: nix run github:you/mazegame
python3 -m mazegame --port 8080 # straight from a checkout
```

Then open <http://127.0.0.1:8080/> to play and <http://127.0.0.1:8080/watch> to
watch. Bind publicly with `--host 0.0.0.0`.

`--grace SECONDS` changes the countdown that starts at the first escape
(default 120); handy when testing, since a round otherwise takes two minutes
to turn over.

## Hosting it on NixOS

`nixosModules.default` (alias: `nixosModules.mazegame`) ships a hardened
systemd unit — `DynamicUser`, `ProtectSystem=strict`, `SystemCallFilter=@system-service`,
`RestrictAddressFamilies=AF_INET AF_INET6`. The server keeps no state on disk,
so there is nothing to back up or migrate.

```nix
{
  inputs.mazegame.url = "github:you/mazegame";

  # in your host's modules list:
  imports = [ inputs.mazegame.nixosModules.default ];
  services.mazegame = {
    enable = true;
    host = "0.0.0.0";      # default 127.0.0.1
    port = 8080;           # default 8080
    openFirewall = true;   # default false
  };
}
```

| option | type | default | meaning |
| --- | --- | --- | --- |
| `services.mazegame.enable` | bool | `false` | run the server |
| `services.mazegame.package` | package | this flake's build | swap in your own build |
| `services.mazegame.host` | str | `"127.0.0.1"` | bind address |
| `services.mazegame.port` | port | `8080` | listen port |
| `services.mazegame.roundGrace` | int | `120` | seconds from first escape to the next maze |
| `services.mazegame.openFirewall` | bool | `false` | open the port |

Behind nginx, proxy `/ws/` and `/api/` to the port and pass the WebSocket
upgrade headers (`proxy_set_header Upgrade $http_upgrade; proxy_set_header
Connection "upgrade";`) or `/ws/play` and `/ws/watch` will fail to connect.

Hand the client itself to nginx rather than the game: the package exposes the
installed site as `pkgs.mazegame.static`, so the event loop never spends a
tick on a `.js` file. A crowd arriving costs six files each, and nginx serves
them roughly four times faster than the server does.

```nix
services.nginx.virtualHosts."maze.example.org" = {
  root = config.services.mazegame.package.static;
  locations."/" = {
    index = "index.html";
    tryFiles = "$uri $uri/ =404";
  };
  locations."= /watch".tryFiles = "/watch.html =404";
  locations."/ws/" = {
    proxyPass = "http://127.0.0.1:8080";
    proxyWebsockets = true;
    extraConfig = "proxy_read_timeout 1h;";
  };
  locations."/api/".proxyPass = "http://127.0.0.1:8080";
};
```

The server still serves the same files itself, so `python -m mazegame` alone
is a complete game — the split only matters under load.

`overlays.default` exposes `pkgs.mazegame` if you would rather wire the package
up yourself. `nix flake check` boots a VM, enables the module and talks to the
running service, so the unit is verified rather than assumed.

## Controls

| key | action |
| --- | --- |
| `W` `A` `S` `D` | walk and strafe |
| `Q` `E` / `←` `→` | turn |
| mouse (click to capture) | look |
| `shift` | run |
| `esc` | release the mouse |

There is nothing to fill in: you get a generated name like `pinned-hopper` the
moment the page connects. `/?name=whoever` overrides it for shared links and
tooling.

Walking is `WALK` = 1.7 tiles/s, running `RUN` = 2.8. A perfect run from a
spawn ~94 tiles out takes about 35 s sprinting, so a round comfortably fits
inside the two-minute countdown even after a few wrong turns.

Watcher page: `space` / `N` skips to the next player, `F` goes fullscreen.

On a phone the whole screen is one floating stick: put a thumb down anywhere,
push up/down to walk, sideways to turn, all the way forward to run. A
fullscreen button sits above the bottom bar, and the watcher page switches
players on any tap.

`/?seed=12345` pins a maze locally for testing; it detaches you from the shared
world, so use it for screenshots rather than racing.

## Rounds

One maze is live at a time. `hub.Hub` owns the seed; clients rebuild the
geometry from it with the same PRNG, so only positions cross the wire. When a
player reaches the exit the server records their place and time, broadcasts it,
and — for the first finisher only — arms a `ROUND_GRACE` (120 s) timer. Anyone
still walking keeps playing and can still finish 2nd, 3rd, … When the timer
expires every client gets `{"t":"world","seed":…}` and respawns.

Reaching the logo does not park you there: the escape card holds you still for
`WIN_DWELL` (2.6 s), then you are dropped back into the maze at a different
spawn. The logo re-arms with you, so you can run it again — the card counts
your trips (`ESCAPED ×3`) and the event feed says `escaped again · ×3`.

Only the first escape takes a place: `record_finish` appends to `finishers`
once per player, so the leaderboard is still the race, and only the first
escape of the round arms the countdown. Repeats are rate-limited server-side
by `ESCAPE_COOLDOWN` (2 s, just under the card dwell) so a client parked in
the logo cannot spam the feed. Your pawn stays NixOS blue once you are home.

Spawns are scattered: `spawnFor(maze, id)` picks a cell from the maze's spawn
pool with a PRNG seeded on the maze **and** the player id, so a hundred
players land on ~70 distinct cells up to 60 tiles apart. The pool only holds
cells at least `SPAWN_BAND` (75 %) of the longest walk away from the logo, so
scattering does not also hand out unequal races — measured across seeds, every
spawn is 68-94 tiles from the exit where the longest possible is 90-96.

Positions go out at 20 Hz (10 Hz above 150 players), but each client only gets
the neighbours around it, not the whole roster — see Scaling. Pawns are
billboards depth-tested against the wall pass, so a player behind a wall is
genuinely hidden rather than drawn on top.

## Scaling

Everything here is measured with synthetic clients against one process:

- **One event loop, no threads.** The server was thread-per-connection with
  blocking writes. At 800 players the hub thread spent *five seconds* inside
  a single `send` to a client that had stopped reading, every other player
  froze behind it, and 687 of 813 sampled thread-seconds (py-spy) sat blocked
  on the hub lock in `move_player`. `server.py` now runs one asyncio loop
  that owns every socket and the tick.
- **Snapshots are droppable.** `Conn.send` writes into the transport buffer
  and checks how much is queued: past `LAG_BYTES` (128 KB) a client stops
  getting snapshots, past `DEAD_BYTES` (1 MB) the socket is cut. A position
  frame is state, not history — skipping one costs that client a tick and
  costs the room nothing. `/api/state` reports `dropped`.
- **A short lock.** The hub copies the bodies it needs under the lock and
  selects, encodes and sends outside it. `move_player` takes no lock at all:
  it is 16k calls a second at 800 players, the writes are atomic under the
  GIL, and a reader that catches a new x with an old y is off by one frame of
  walking for one tick.
- **Interest management.** Sending every position to every player is
  quadratic: at 560 players that was a 10 KB frame fanned out 560 times, 20
  times a second — 114 MB/s. A bucket index bounds the candidate set and each
  client gets the `PEER_LIMIT` (20) nearest bodies, names inline.
- **Shared frames in a crowd.** Below `PEER_EXACT_MAX` (120) every client
  gets its own list centred on itself out of `BUCKET` (8 tile) cells. Above
  it, one frame is built per `CROWD_BUCKET` (4 tile) cell and the same bytes
  go to everyone standing there: 800 players cost ~160 frames instead of 800,
  13 ms instead of 77. The tighter cell also aims better than the per-bucket
  shortlist it replaces — of a player's eight nearest neighbours it misses
  3.7 % against the shortlist's 29.5 %. Spectators are always built exactly
  around their target, which is what keeps a camera from losing its player.
- **One encode per body.** A body serialises identically for every viewer, so
  each is encoded once per tick (hand-rolled, with the name JSON-escaped once
  at join) and frames are assembled by joining strings. This alone took 200
  players from 4.8 Hz to 9.8 Hz.
- **Cadence that scales.** `snapshot_interval` gives a quiet room 20 Hz, 150+
  players 10 Hz and 500+ players 6.7 Hz, because at 800 a tick costs ~20 ms
  to build and ~40 ms to write. The rate rides along in every snapshot as
  `hz` and clients pace their own position updates off it, so a crowded room
  also stops paying for 20 Hz of inbound traffic it would never forward.
- **Interpolation.** Snapshots arrive 7-20 times a second, frames are drawn
  60 times a second. `interp.js` glides every remote body (and the spectator
  camera) between the last two samples. Measured on the camera with 100
  players: snapping moved in 13 of 149 frames with jumps up to 0.16 tiles;
  interpolated moves in 145 of 149, biggest step 0.017.
- **No roster broadcast.** It was a 14 KB frame to everyone on every join —
  8 MB of traffic per player arriving. Names ride along in the peer entries
  instead, so a client learns a name exactly when it can see its owner.
- **Cheap ops endpoint.** `/api/state` answers with counters and tick timings
  (`build_ms`, `send_ms`, `frames`, `slow`, `dropped`); the per-player roster
  is behind `?full=1`, because serialising 800 players on every poll is real
  work on the loop that runs the game.
- **Accept backlog.** A link going around arrives as a burst of SYNs, so the
  listener uses a backlog of 512 rather than the stdlib's 5.
- **Limits.** One socket per player: the unit sets `LimitNOFILE = 65536`;
  systemd's default of 1024 otherwise caps the server at about a thousand
  players. nginx needs raising too — its default single worker with 512
  connections caps you at ~250 players, since a proxied websocket costs two
  connections.
- **Client fill budget.** A crowd standing in one room used to cost several
  full-screen sprite fills per frame. The renderer draws the nearest pawns
  within `PAWN_FILL_BUDGET` screenfuls (`MAX_PAWNS` cap), and the minimap's
  static layer is cached instead of repainting 2601 tiles every frame.

Measured on one core, players scattered and walking, snapshot gap seen by the
clients themselves:

| players | before | now |
| --- | --- | --- |
| 200 | 177 ms p50 | 92 ms p50, 162 ms p99 |
| 400 | 399 ms p50 | 97 ms p50, 196 ms p99 |
| 800 | 1666 ms p50, connections timing out | 146 ms p50, 289 ms p99, zero errors |
| 1200 | — | 243 ms p50, all 1200 connected |

## Maze shape

`maze.js` carves with randomized **Prim's** rather than a recursive
backtracker: Prim grows from a random frontier edge every step, so the layout
forks constantly instead of snaking down one long corridor.

A carved maze is still a tree — one route everywhere, every wrong turn a dead
end. Two passes fix that: `BRAID` (0.7) seals most dead ends by knocking a
second wall out of them, and `EXTRA_LOOPS` (0.06) punches random holes in the
remaining walls. A 25x25 maze then measures roughly 270 junctions, 145
independent loops and only ~35 dead ends, with the logo capping the dead end
furthest from the spawn *after* braiding — otherwise the shortcuts would
undercut the walk the exit was chosen for.

## How the watcher picks a player

The server tracks the last time each player's position or heading actually
changed (`hub.MOVE_EPS` / `hub.TURN_EPS`). Every 100 ms it re-evaluates each
watcher:

- target disconnected → cut immediately to the next player;
- target still for longer than `IDLE_SWITCH` (2 s) **and** watched for at least
  that long → cut to the next player in join order, preferring one that is
  currently moving.

The dwell requirement is what keeps a room full of idle players from strobing:
with nobody moving, the camera becomes a 2-second-per-player slideshow.

Players are told when a camera is on them ("ON CAMERA" badge, top left).

## Layout

```
mazegame/
  ws.py       RFC 6455 framing: incremental parser, no socket of its own
  hub.py      players, watchers, idle detection, switching policy, snapshots
  server.py   asyncio HTTP + /ws/play, /ws/watch, /api/state, the tick
  static/js/
    maze.js      seeded recursive-backtracker maze (25x25 cells = 51x51 tiles);
                 exit = furthest dead end from spawn
    textures.js  procedural brick/floor/ceiling, the NixOS logo panel and the
                 player pawn, pre-shaded into 24 brightness levels
    render.js    DDA raycaster, floor/ceiling casting, pawn sprites, minimap
    tags.js      pooled name tags above visible players
    play.js      input, collision, finish detection, round clock
    watch.js     spectator camera with interpolation and cut banners
```

Both pages generate the maze from the shared seed, so the wire only ever
carries `{id, x, y, a, finished}` tuples.

Clients heartbeat every 3 s; the server hangs up on a socket that goes quiet for
12 s, so a backgrounded or crashed tab cannot hold a slot in the camera rotation.
