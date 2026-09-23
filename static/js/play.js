// Player view: everyone walks the same maze, sees each other, and races the
// countdown that starts when the first player reaches the NixOS logo.

import { WIN_DWELL, buildMaze, solid, spawnFor } from "./maze.js";
import { Renderer, drawMinimap, retroPixel } from "./render.js";
import { createSocket } from "./net.js";
import { createTags } from "./tags.js";
import { clockTime, makeClock, makeTrack, pushSample, sampleTrack } from "./interp.js";
import { createTouchControls, isTouch, wireFullscreen } from "./touch.js";
import { showVersion } from "./version.js";

const WALK = 1.7; // tiles/second
const RUN = 2.8;
const TURN = 2.5; // radians/second
const MOUSE = 0.0022;
const RADIUS = 0.24;
const SEND_HZ = 20; // until the server says otherwise in its snapshots
const WIN_DIST = 0.9;
// A body may miss a few snapshots to interest-list churn and still be there;
// much longer than that and it has genuinely walked out of range, so holding
// on to it would leave a pawn standing in an empty corridor.
const PEER_TTL = 8; // snapshots a body may go unmentioned before it is dropped

const view = document.getElementById("view");
const minimap = document.getElementById("minimap");
const elTime = document.getElementById("time");
const elRound = document.getElementById("round");
const elPlayers = document.getElementById("players");
const elEvents = document.getElementById("events");
const elLabels = document.getElementById("labels");
const elWatched = document.getElementById("watched");
const elWatchers = document.getElementById("watchers");
const elStatus = document.getElementById("status");
const elOverlay = document.getElementById("overlay");
const elOverlayText = document.getElementById("overlay-text");
const elName = document.getElementById("playername");

const renderer = new Renderer(view, { pixel: retroPixel() });
const keys = new Set();
const visited = new Set();

const params = new URLSearchParams(location.search);
const pinnedSeed = params.has("seed") ? Number(params.get("seed")) >>> 0 : null;

const state = {
  maze: null,
  cam: { x: 1.5, y: 1.5, a: 0 },
  finished: false, // banked a place this round (pawn turns NixOS blue)
  escapes: 0, // times through the logo this round; you may go again
  holdUntil: 0, // frozen while the escape card is up
  respawns: 0,
  startedAt: performance.now(), // round clock in the HUD
  runStartedAt: performance.now(), // this trip's clock, reset on every spawn
  id: null,
  names: new Map(), // player id -> name
  peers: new Map(), // player id -> { id, x, y, a, finished }
  endsAt: null, // performance.now() deadline for the world rollover
  sendHz: SEND_HZ, // position updates per second, paced by the server
  clock: makeClock(), // maps the server's tick clock into local time
};
state.renderer = renderer;
window.mazegame = state; // handy for the console and for smoke tests

function setMaze(seed) {
  state.maze = buildMaze(pinnedSeed ?? seed >>> 0);
  state.startedAt = performance.now();
  state.finished = false;
  state.escapes = 0;
  state.holdUntil = 0;
  state.respawns = 0;
  visited.clear();
  // Own corner of the map, jittered so two players sharing one never stack.
  placeAt(spawnFor(state.maze, state.id));
}

function markVisited() {
  const { maze, cam } = state;
  const cx = Math.floor(cam.x);
  const cy = Math.floor(cam.y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= maze.w || y >= maze.h) continue;
      visited.add(y * maze.w + x);
    }
  }
}

// -- networking ---------------------------------------------------------

let socket = null;

// Blank name is intentional: the server hands out a random one.
function connect(name) {
  const query = name ? `?name=${encodeURIComponent(name)}` : "";
  socket = createSocket(`/ws/play${query}`, {
    onStatus(text, kind) {
      elStatus.textContent = text;
      elStatus.dataset.kind = kind;
    },
    onMessage(msg) {
      if (msg.t === "welcome") {
        state.id = msg.id;
        elName.textContent = msg.name;
        document.title = `${msg.name} · NixOS Maze`;
        elPlayers.textContent = msg.players;
        applyWorld(msg);
        for (const f of msg.finishers) note(`${f.name} escaped · ${ordinal(f.place)}`);
      } else if (msg.t === "world") {
        setMaze(msg.seed);
        state.endsAt = null;
        note(msg.winner ? `new maze · ${msg.winner} won the last one` : "new maze");
      } else if (msg.t === "peers") {
        applyPeers(msg);
      } else if (msg.t === "finish") {
        state.endsAt = performance.now() + msg.ends_in * 1000;
        const who = msg.id === state.id ? "you" : msg.name;
        note(
          msg.runs > 1
            ? `${who} escaped again · ×${msg.runs}`
            : `${who} escaped · ${ordinal(msg.place)} · ${msg.secs}s`,
        );
      } else if (msg.t === "names") {
        for (const [id, name] of msg.l) state.names.set(id, name);
      } else if (msg.t === "watched") {
        elWatchers.textContent = msg.n;
        elWatched.classList.toggle("hidden", msg.n === 0);
      }
    },
  });
}

function applyWorld(world) {
  setMaze(world.seed);
  state.endsAt = world.ends_in === null ? null : performance.now() + world.ends_in * 1000;
}

// The server only sends the neighbours in view; names arrive once, in their
// own message, the first time a body shows up.
function applyPeers(msg) {
  elPlayers.textContent = msg.n;
  // Pace our own updates off the room's: a crowded room snapshots at 10 Hz,
  // and sending far more than that is work the server throws away. Twice the
  // snapshot rate, though, keeps each snapshot close to a fresh sample —
  // sending at exactly the tick rate beats against it and makes everyone
  // else's walk look uneven.
  if (msg.hz) state.sendHz = Math.min(SEND_HZ, msg.hz * 2);
  // Snapshots are laid out on the server's clock, not on their arrival time.
  const arrived = performance.now();
  const now = clockTime(state.clock, msg.clock, arrived);
  for (const [id, x, y, a, finished, age] of msg.l) {
    if (id === state.id) continue; // that one is us
    let peer = state.peers.get(id);
    if (!peer) {
      peer = { id, track: makeTrack(x, y, a), x, y, a, finished: !!finished };
      state.peers.set(id, peer);
    }
    peer.finished = !!finished;
    peer.seen = now;
    // `age` is how stale the body was when the tick sampled it, so the sample
    // lands where it belongs on the timeline instead of on the tick boundary.
    pushSample(peer.track, x, y, a, now - age, arrived);
  }
  // Interest lists churn at the edges: in a crowd a body drops out of the
  // nearest twenty for a tick and comes straight back. Forgetting it on the
  // first miss threw away its interpolation history and made pawns blink.
  // Distant bodies are refreshed on one tick in three, so the window has
  // to outlive a couple of their turns as well as ordinary list churn.
  const ttl = Math.max(900, (PEER_TTL * 1000) / (msg.hz || 10));
  for (const [id, peer] of state.peers) {
    if (now - peer.seen > ttl) state.peers.delete(id);
  }
}

// Bodies are drawn where interpolation says they are right now, not where the
// last snapshot left them.
function livePeers(now) {
  const out = [];
  for (const peer of state.peers.values()) {
    const at = sampleTrack(peer.track, now);
    peer.x = at.x;
    peer.y = at.y;
    peer.a = at.a;
    out.push(peer);
  }
  return out;
}

function ordinal(place) {
  const suffix = ["th", "st", "nd", "rd"][place % 10 > 3 || (place % 100) - place % 10 === 10 ? 0 : place % 10];
  return `${place}${suffix}`;
}

function note(text) {
  const line = document.createElement("div");
  line.className = "event";
  line.textContent = text;
  elEvents.prepend(line);
  while (elEvents.children.length > 4) elEvents.lastChild.remove();
  setTimeout(() => line.remove(), 9000);
}

let lastSent = 0;
function pushPosition(now) {
  if (!socket || now - lastSent < 1000 / state.sendHz) return;
  lastSent = now;
  // `c` is when this position was true on our clock. The server maps it onto
  // its own, so a packet that sat in a queue on the way still plays back at
  // the moment it happened instead of when it finally arrived.
  socket.send({ t: "pos", x: state.cam.x, y: state.cam.y, a: state.cam.a, c: Math.round(now) });
}

// -- input ---------------------------------------------------------------

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
]);

// WASD are also letters: never swallow them while a field has focus.
const typing = (e) => !!(e.target && e.target.closest && e.target.closest("input, textarea"));

addEventListener("keydown", (e) => {
  if (typing(e)) return;
  if (MOVE_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === "Escape") document.exitPointerLock();
});
addEventListener("keyup", (e) => {
  if (typing(e)) return;
  keys.delete(e.code);
});
addEventListener("blur", () => keys.clear());

// Clicking the view grabs the mouse; no card, no crosshair, just the maze.
view.addEventListener("click", () => {
  if (!isTouch) view.requestPointerLock();
});
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement === view) state.cam.a += e.movementX * MOUSE;
});

const touchpad = document.getElementById("touchpad");
const touch = createTouchControls(touchpad, {
  base: document.getElementById("stick"),
  thumb: document.getElementById("stick-thumb"),
});
wireFullscreen(document.getElementById("fullscreen"));

function showOverlay(text, kind) {
  elOverlayText.innerHTML = text;
  elOverlay.dataset.kind = kind;
  elOverlay.classList.remove("hidden");
}
function hideOverlay() {
  elOverlay.classList.add("hidden");
}

// -- simulation ----------------------------------------------------------

function blocked(maze, x, y) {
  return (
    solid(maze, x - RADIUS, y - RADIUS) ||
    solid(maze, x + RADIUS, y - RADIUS) ||
    solid(maze, x - RADIUS, y + RADIUS) ||
    solid(maze, x + RADIUS, y + RADIUS)
  );
}

function step(dt) {
  const { maze, cam } = state;
  // Frozen only while the escape card is up, not for the rest of the round.
  if (!maze || performance.now() < state.holdUntil) return;

  const fast = keys.has("ShiftLeft") || keys.has("ShiftRight") || touch.boost;
  const speed = (fast ? RUN : WALK) * dt;
  let forward = touch.forward;
  let strafe = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) forward += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= 1;
  if (keys.has("KeyD")) strafe += 1;
  if (keys.has("KeyA")) strafe -= 1;
  if (keys.has("ArrowLeft") || keys.has("KeyQ")) cam.a -= TURN * dt;
  if (keys.has("ArrowRight") || keys.has("KeyE")) cam.a += TURN * dt;
  cam.a += touch.steer * TURN * dt;

  const mag = Math.hypot(forward, strafe);
  if (mag > 0.02) {
    // Analog sticks keep their magnitude; keys (mag 1 or sqrt2) clamp to full.
    const scale = (Math.min(1, mag) / mag) * speed;
    const dirX = Math.cos(cam.a);
    const dirY = Math.sin(cam.a);
    const dx = (dirX * forward - dirY * strafe) * scale;
    const dy = (dirY * forward + dirX * strafe) * scale;
    if (!blocked(maze, cam.x + dx, cam.y)) cam.x += dx;
    if (!blocked(maze, cam.x, cam.y + dy)) cam.y += dy;
    markVisited();
  }

  // No one-shot gate: every trip through the logo counts. The dwell freeze
  // above keeps the same arrival from firing twice.
  if (Math.hypot(cam.x - maze.exit.x, cam.y - maze.exit.y) < WIN_DIST) win();
}

function win() {
  const now = performance.now();
  state.finished = true;
  state.escapes++;
  state.holdUntil = now + WIN_DWELL;
  const secs = (now - state.runStartedAt) / 1000;
  const again = state.escapes > 1;
  showOverlay(
    `<strong>ESCAPED${again ? ` &times;${state.escapes}` : ""}</strong><br>` +
      `${secs.toFixed(1)}s · ${state.spawnDist} tiles from your spawn` +
      `<br><small>${
        again
          ? "go again — the maze changes when the countdown ends"
          : "back into the maze — it changes when the countdown ends"
      }</small>`,
    "won",
  );
  socket && socket.send({ t: "escaped" });
  setTimeout(() => {
    hideOverlay();
    // Dropped back in somewhere else so there is still a maze to wander,
    // and another run at the logo for anyone who wants it.
    placeAt(spawnFor(state.maze, (state.id || 1) * 101 + ++state.respawns));
  }, WIN_DWELL);
}

function placeAt(spawn) {
  state.cam = {
    x: spawn.x + (Math.random() - 0.5) * 0.5,
    y: spawn.y + (Math.random() - 0.5) * 0.5,
    a: spawn.a,
  };
  state.spawnDist = spawn.dist;
  state.runStartedAt = performance.now();
  markVisited();
}

function clock(secs) {
  const whole = Math.max(0, Math.floor(secs));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const drawTags = createTags(elLabels);

// -- main loop -----------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  if (state.maze) {
    const peers = livePeers(now);
    const labels = renderer.draw(state.maze, state.cam, peers) || [];
    drawTags(labels, state.names, view.clientWidth / renderer.w || 1);
    drawMinimap(minimap, state.maze, state.cam, { visited, scale: 4, peers });
    pushPosition(now);
    elTime.textContent = clock((now - state.startedAt) / 1000);
    elRound.textContent = state.endsAt === null ? "open" : clock((state.endsAt - now) / 1000);
  }
  requestAnimationFrame(frame);
}

addEventListener("resize", () => renderer.resize());
addEventListener("orientationchange", () => setTimeout(() => renderer.resize(), 120));

// -- joining -------------------------------------------------------------

// No name prompt: the server hands out a name the moment you connect. The
// `name` query parameter still overrides it for shared links and tooling.
renderer.init().then(() => {
  if (!state.maze) setMaze((Math.random() * 2 ** 32) >>> 0);
  document.body.classList.toggle("touch", isTouch);
  showVersion(document.getElementById("version"));
  requestAnimationFrame(frame);
  connect(params.get("name") || "");
});
