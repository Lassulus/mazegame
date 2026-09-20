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

Behind nginx, proxy `/` to the port and pass the WebSocket upgrade headers
(`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`)
or `/ws/play` and `/ws/watch` will fail to connect.

`overlays.default` exposes `pkgs.mazegame` if you would rather wire the package
up yourself. `nix flake check` boots a VM, enables the module and talks to the
running service, so the unit is verified rather than assumed.

## Controls

| key | action |
| --- | --- |
| `W` `A` `S` `D` / arrows | move and turn |
| mouse (click to capture) | look |
| `shift` | run |
| `esc` | release the mouse |

Your name is asked once per browser and remembered in `localStorage`; leave the
field empty for a generated one like `pinned-hopper`. `/?name=whoever` skips the
card entirely, which is what shared links and kiosks want.

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
expires every client gets `{"t":"world","seed":…}` and respawns on the shared
spawn tile, jittered so pawns do not stack.

Positions go out at 20 Hz (10 Hz above 60 players), but each client only gets
the neighbours around it, not the whole roster — see Scaling. Pawns are
billboards depth-tested against the wall pass, so a player behind a wall is
genuinely hidden rather than drawn on top.

## Scaling

Everything here is measured with synthetic clients against one process:

- **Interest management.** Sending every position to every player is
  quadratic: at 560 players that was a 10 KB frame fanned out 560 times, 20
  times a second — 114 MB/s. A bucket index (`BUCKET` = 8 tiles) bounds the
  candidate set and each client gets the `PEER_LIMIT` (20) nearest bodies
  **centred on itself**, names inline. Above `PEER_EXACT_MAX` players the
  candidates are shortlisted per bucket first. A spectator's list is always
  built exactly around its target: a shared per-bucket list drops whoever is
  furthest from the bucket's middle, which in a crowd is precisely the player
  the camera is following, and the view freezes.
- **One encode per body.** A body serialises identically for every viewer, so
  each is `json.dumps`-ed once per tick and frames are assembled by joining
  strings. This alone took 200 players from 4.8 Hz to 9.8 Hz.
- **Tick cadence.** The hub thread sleeps the *remainder* of its period. A
  fixed 50 ms sleep plus 30 ms of work silently halves the update rate.
- **Interpolation.** Snapshots arrive 10-20 times a second, frames are drawn
  60 times a second. `interp.js` glides every remote body (and the spectator
  camera) between the last two samples. Measured on the camera with 100
  players: snapping moved in 13 of 149 frames with jumps up to 0.16 tiles;
  interpolated moves in 145 of 149, biggest step 0.017.
- **No roster broadcast.** It was a 14 KB frame to everyone on every join —
  8 MB of traffic per player arriving. Names ride along in the peer entries
  instead, so a client learns a name exactly when it can see its owner.
- **Accept backlog.** `socketserver` listens with a backlog of 5, so a crowd
  arriving at once had connections refused by the kernel. `MazeServer` sets
  `request_queue_size = 256`.
- **Limits.** One socket and one thread per player, so the unit sets
  `LimitNOFILE = 65536` and `TasksMax = 8192`; systemd's default of 1024 file
  descriptors otherwise caps the server at about a thousand players. nginx
  needs raising too — its default single worker with 512 connections caps you
  at ~250 players, since a proxied websocket costs two connections.
- **Client fill budget.** A crowd standing in one room used to cost several
  full-screen sprite fills per frame. The renderer draws the nearest pawns
  within `PAWN_FILL_BUDGET` screenfuls (`MAX_PAWNS` cap), and the minimap's
  static layer is cached instead of repainting 2601 tiles every frame.

Measured on one core with every player piled into the same room (the worst
case for interest management): **100 players at 19.3 Hz, 200 at 9.8 Hz, 1000
connected with zero refused connections**, ~76 % CPU, 64 MB RSS, page served
in 3 ms throughout.

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
  ws.py       RFC 6455 framing (text frames, ping/pong, close)
  hub.py      players, watchers, idle detection, switching policy
  server.py   HTTP static routes + /ws/play, /ws/watch, /api/state
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
