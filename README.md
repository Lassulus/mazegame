# mazegame

A Windows 95 "Maze" screensaver you can actually play, in a browser tab.
Brick corridors, a pixelated raycaster, and an exit made of the NixOS snowflake.

Two pages:

- `/` — **play**: pick a name (blank gets you a generated one), then wander a
  seeded maze until you reach the logo and get a new one.
- `/watch` — **maze cam**: rides along with one random player. When that player
  stops moving for 2 seconds, the camera cuts to the next player.

No build step, no dependencies: the server is Python standard library only
(including the WebSocket implementation) and the client is plain ES modules.

## Run

```sh
nix run .                       # or: nix run github:you/mazegame
python3 -m mazegame --port 8080 # straight from a checkout
```

Then open <http://127.0.0.1:8080/> to play and <http://127.0.0.1:8080/watch> to
watch. Bind publicly with `--host 0.0.0.0`.

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

On a phone the left half of the screen is a floating stick: push up/down to
walk, sideways to turn, all the way forward to run. One thumb is enough;
dragging on the right half also turns if you prefer two. A fullscreen button
sits above the bottom bar, and the watcher page switches players on any tap.

`/?seed=12345` pins a specific maze, which is handy for racing a friend on the
same layout.

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
    maze.js      seeded recursive-backtracker maze; exit = furthest dead end
    textures.js  procedural brick/floor/ceiling + the NixOS logo panel,
                 pre-shaded into 24 brightness levels
    render.js    DDA raycaster, floor/ceiling casting, minimap
    play.js      input, collision, win condition
    watch.js     spectator camera with interpolation and cut banners
```

Both pages generate the maze from the same seed with the same PRNG, so the
watcher only receives `{x, y, a}` updates (20 Hz) rather than any geometry.

Clients heartbeat every 3 s; the server hangs up on a socket that goes quiet for
12 s, so a backgrounded or crashed tab cannot hold a slot in the camera rotation.
