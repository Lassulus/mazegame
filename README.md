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
  stops moving for 2 seconds, the camera cuts to the next player. Made for a
  wall or a projector, it shows nothing but the maze and, in one corner, how
  many are playing, a QR code to this server and a button to join.

No build step for the client and no dependencies for the server: the server
is a Rust binary built from the standard library alone (HTTP, the WebSocket
framing and SHA-1 for the handshake included), and the client is plain ES
modules.

The running version is shown in the player's HUD and served at `/api/version`.
`Cargo.toml` is the only place it is written down: the binary reads it at
compile time and `flake.nix` parses it.

## Run

```sh
nix run .                       # or: nix run github:you/mazegame
cargo run --release -- --port 8080   # straight from a checkout
```

Then open <http://127.0.0.1:8080/> to play and <http://127.0.0.1:8080/watch> to
watch. Bind publicly with `--host 0.0.0.0`.

`--grace SECONDS` changes the countdown that starts at the first escape
(default 120); handy when testing, since a round otherwise takes two minutes
to turn over. `--static DIR` points at the client; it defaults to the
installed copy next to the binary, then `./static`, so neither `nix run` nor
`cargo run` needs it.

`nix develop` gives cargo, clippy, rustfmt and rust-analyzer; `cargo test`
covers the framing, the HTTP layer and the snapshot wire format.

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

The server still serves the same files itself, so the binary alone is a
complete game — the split only matters under load.

`overlays.default` exposes `pkgs.mazegame` if you would rather wire the package
up yourself. `nix flake check` boots a VM, enables the module and talks to the
running service — including a real websocket handshake whose snapshot is
decoded and checked — so the unit is verified rather than assumed.

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

Watcher page: `space` / `N` or a click skips to the next player, `F` goes
fullscreen; none of it is on screen.

On a phone the whole screen is one floating stick: put a thumb down anywhere,
push up/down to walk, sideways to turn, all the way forward to run. A
fullscreen button sits above the bottom bar, and the watcher page switches
players on any tap. The watcher's QR code is left out on small screens; nobody
scans the screen they are holding.

`/?seed=12345` pins a maze locally for testing; it detaches you from the shared
world, so use it for screenshots rather than racing.

## Rounds

One maze is live at a time. `Hub` (`src/hub.rs`) owns the seed; clients rebuild the
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

- **Written in Rust, a reader and a writer thread per connection.** The
  Python server was thread-per-connection with blocking writes; at 800
  players its hub thread spent *five seconds* inside a single `send` to a
  client that had stopped reading, every other player froze behind it, and
  687 of 813 sampled thread-seconds (py-spy) sat blocked on the hub lock. An
  asyncio rewrite fixed the stall; the Rust rewrite removes the interpreter
  from the budget. The hub thread never touches a socket: every frame goes
  into a per-connection queue (`src/conn.rs`) drained by that connection's
  own writer thread, which coalesces whatever piled up into one `write`.
  Parked threads cost a stack (64-256 KiB each) and nothing else — there is
  no interpreter lock for them to queue behind.
- **Snapshots are droppable.** Past `LAG_FRAMES` (16) queued frames a client
  stops getting position snapshots; past `DEAD_BYTES` (1 MB) the socket is
  cut. A position frame is state, not history — skipping one costs that client
  a tick and costs the room nothing. Welcome, world, finish and names messages
  go through `send_urgent` and are never dropped. `/api/state` reports
  `dropped`.
- **A short lock.** One mutex guards the world. The snapshot copies the bodies
  it needs under it and selects, packs and queues outside it; a position
  update is a lookup and four stores.
- **Binary snapshots.** A body is twelve bytes — `u32` id, `u16` x, `u16` y,
  `u16` angle, flags, age — not forty-odd characters of JSON with the name
  repeated every tick. Names go out once per viewer in a `names` message and
  the server remembers who has been told (`Player.known`). At 200 players
  that took a client from 7.0 KB/s to 3.1 KB/s, at 600 from 4.6 to 1.8, while
  carrying 28 neighbours instead of 20.
- **Interest management.** Sending every position to every player is
  quadratic: at 560 players that was a 10 KB frame fanned out 560 times, 20
  times a second — 114 MB/s. A bucket index bounds the candidate set and each
  client is told about the `PEER_LIMIT` (96) nearest bodies.
- **The search widens instead of using a fixed window.** A three-by-three
  bucket window is anchored on the *cell*, not on the viewer, so standing at a
  cell edge you were only told about bodies eight tiles ahead — down a long
  corridor players visibly popped in and out halfway along. `pool_at` now adds
  a ring at a time until the list is full or `SIGHT` (20 tiles) is reached:
  28 players strung down one corridor used to arrive as 14, now all 28 do, the
  farthest 19.6 tiles away. An empty corridor is reported to the horizon; a
  crowd fills the list from the nearest cells and costs no more to compute.
- **Distant bodies at a third of the rate.** The nearest `PEER_NEAR` (48) are
  in every snapshot; the rest are staggered across `FAR_EVERY` (3) ticks, so
  each frame carries an even share. A body twenty tiles down a corridor is a
  few pixels tall and its interpolation learns its own rate. That halved the
  cost of the wider lists: 800 packed players went from 7.2 KB/s per client to
  4.8, for five times the visibility of the old 20-body window at the same
  4.6 KB/s it used to cost.
- **Shared frames in a crowd.** Below `PEER_EXACT_MAX` (120) every client
  gets its own list centred on itself out of `BUCKET` (8 tile) cells. Above
  it, one frame is built per `CROWD_BUCKET` (4 tile) cell and the same bytes
  go to everyone standing there: 800 players cost ~160 frames instead of 800,
  13 ms instead of 77. The tighter cell also aims better than the per-bucket
  shortlist it replaces — of a player's eight nearest neighbours it misses
  3.7 % against the shortlist's 29.5 %. Spectators are always built exactly
  around their target, which is what keeps a camera from losing its player.
- **One pack per body.** A body packs identically for every viewer, so it is
  packed once per tick and frames are assembled by joining bytes.
- **Cadence that scales.** `snapshot_interval` gives a quiet room 20 Hz, 150+
  players 10 Hz and 500+ players 6.7 Hz, because at 800 a tick costs ~20 ms
  to build and ~40 ms to write. The rate rides along in every snapshot as
  `hz`; clients send their own position at twice it (capped at 20 Hz), which
  keeps every snapshot close to a fresh sample without flooding the loop.
- **Playback, not chasing.** Snapshots arrive 7-20 times a second, frames are
  drawn 60 times a second. `interp.js` keeps the last few samples per body and
  renders at `now - delay` — one and a bit snapshot intervals behind, learned
  per body — between the two samples that straddle that instant. Two things
  make the timeline honest: the server stamps each snapshot with its tick
  clock (so arrival jitter is discarded) and each body with its `age` in
  milliseconds (so a position reported 40 ms before the tick is placed 40 ms
  back, not on the tick boundary).

  Measured against a body walking a constant 1.5 tiles/s in a 150-player
  room, per-frame speed as the client rendered it:

  | | old glide | buffered playback |
  | --- | --- | --- |
  | 5th-95th percentile | 0.51-2.37 tiles/s | 1.35-1.54 |
  | coefficient of variation | 0.39 | 0.10 |
  | frames stalled | 31 % (worst run) | 0 % |
- **Positions keep the time they were true.** The `age` above was measured
  from when a position *reached the server*, which is only honest if the
  player's uplink is. Over a real one — Wi-Fi, a phone — positions arrive late
  and in bunches, and the spectator camera inherited all of it: on production,
  with bots across the internet, the camera's speed varied by 120 % and it
  stood still for up to 133 ms at a time, at 10 players as at 150. Clients now
  send their own clock with every position (`c`); the server maps it onto its
  own through the least-delayed packet it has seen (`SenderClock`), so a
  position that sat in a queue on the way keeps the moment it happened. The
  client's playback delay then covers the worst recent lateness plus the
  longest recent gap between samples, grows quickly when that rises and eases
  back slowly, and drops the duplicate a snapshot produces when a body sent
  nothing new. A bot walking a constant 1.5 tiles/s behind 120 ms of
  simulated uplink jitter, as the camera rendered it:

  | | arrival time | sender's clock |
  | --- | --- | --- |
  | coefficient of variation | 0.95 | 0.17 |
  | 95th percentile speed | 4.44 tiles/s | 1.67 |
  | longest freeze | 117 ms | 0 ms |

  The price is latency on a bad link: the camera rides such a player about a
  quarter of a second behind instead of a tenth.
- **Bodies persist across churn.** An interest list is the nearest 28, so in
  a crowd a body drops out for a tick and comes straight back. Deleting it on
  the first miss threw away its interpolation history and made pawns blink;
  clients now keep one for three snapshots, which is long enough to bridge
  churn and short enough that a body which really walked away does not linger
  as a statue.
- **No roster broadcast.** It was a 14 KB frame to everyone on every join —
  8 MB of traffic per player arriving.
- **Cheap ops endpoint.** `/api/state` answers with counters and tick timings
  (`build_ms`, `send_ms`, `frames`, `slow`, `dropped`); the per-player roster
  is behind `?full=1`, because serialising 800 players on every poll is real
  work under the lock the game runs on.
- **Accept backlog.** A link going around arrives as a burst of SYNs. `std`
  listens with a backlog of 128 and offers no knob, so a burst beyond it waits
  for the kernel's one-second SYN retry rather than being refused: 1500
  simultaneous handshakes all succeeded, p50 132 ms, p99 1.09 s. The accept
  thread only spawns a reader, so the queue drains as fast as it fills.
- **Limits.** One socket and two threads per player: the unit sets
  `LimitNOFILE = 65536` and `TasksMax = 8192`;
  systemd's default of 1024 otherwise caps the server at about a thousand
  players. nginx needs raising too — its default single worker with 512
  connections caps you at ~250 players, since a proxied websocket costs two
  connections.
- **Client fill budget.** A crowd standing in one room could cost several
  full-screen sprite fills per frame, so the renderer spends a budget of
  `PAWN_FILL_BUDGET` (2.5) screenfuls on the nearest pawns. The budget is in
  pixels, which lets a hundred distant pawns through while still cutting a
  wall of enormous near ones; `MAX_PAWNS` (64) is only a backstop. It used to
  be a hard cap of ten, which is what made a crowd churn in and out of
  existence as bodies swapped depth order. The minimap's static layer is
  cached instead of repainting 2601 tiles every frame.

Snapshot gap seen by the clients themselves, players scattered and walking.
The first two columns are the Python server before and after the event loop;
the last is this one:

| players | Python, threads | Python, asyncio | Rust |
| --- | --- | --- | --- |
| 200 | 177 ms p50 | 92 ms p50, 162 ms p99 | |
| 400 | 399 ms p50 | 97 ms p50, 196 ms p99 | 100 ms p50, 106 ms p99 |
| 800 | 1666 ms p50, connections timing out | 146 ms p50, 289 ms p99 | 150 ms p50, 159 ms p99 |
| 1200 | — | 243 ms p50, all 1200 connected | |

Side by side on one laptop, 800 players packed into a 22-tile radius, same
bots: Python spent 19.7 ms building and 8.9 ms queueing each snapshot with a
201 ms p99 gap; Rust spends 2.5 ms and 3.9 ms with a 159 ms p99, in 41 MB.
Watching a player at 800 the spectator camera moved at a steady pace (speed
CV 0.08, 5th-95th percentile within ±2 %) with no frame over 17 ms and no
freeze, and a manual cut lands on the next player in 32-48 ms.

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
src/
  main.rs     flags, the tick thread, the listener
  net.rs      accept loop, HTTP routing, websocket upgrade and read loop
  conn.rs     per-connection write queue and writer thread; drops snapshots
              for clients that fall behind
  hub.rs      players, watchers, rounds, idle detection, switching policy,
              interest search and the binary snapshot format
  http.rs     request parsing, static file cache, response writer
  ws.rs       RFC 6455 framing: incremental parser, SHA-1 + base64 handshake
  json.rs     string quoting for control messages; field lookup for the two
              message shapes clients send
  sync.rs     lock helpers without poisoning ceremony
static/
  js/
    maze.js      seeded Prim maze (25x25 cells = 51x51 tiles), braided;
                 exit = furthest dead end from the spawn band
    textures.js  procedural brick/floor/ceiling, the NixOS logo panel and the
                 player pawn, pre-shaded into 24 brightness levels
    render.js    DDA raycaster, floor/ceiling casting, pawn sprites, minimap
    net.js       reconnecting socket; decodes binary snapshots
    interp.js    buffered playback on the server's tick clock
    tags.js      pooled name tags above visible players
    play.js      input, collision, finish detection, round clock
    watch.js     spectator camera with interpolation, no HUD
    qr.js        QR encoder (byte mode, level M, versions 1-6) for the
                 watcher's join code
```

Both pages generate the maze from the shared seed, so the wire only ever
carries twelve-byte bodies and, once per viewer, names.

Clients heartbeat every 3 s; the server hangs up on a socket that goes quiet for
12 s, so a backgrounded or crashed tab cannot hold a slot in the camera rotation.
