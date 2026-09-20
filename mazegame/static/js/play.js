// Player view: everyone walks the same maze, sees each other, and races the
// countdown that starts when the first player reaches the NixOS logo.

import { WIN_DWELL, buildMaze, solid } from "./maze.js";
import { Renderer, drawMinimap, retroPixel } from "./render.js";
import { createSocket } from "./net.js";
import { createTags } from "./tags.js";
import { createTouchControls, isTouch, wireFullscreen } from "./touch.js";
import { showVersion } from "./version.js";

const WALK = 2.7; // tiles/second
const RUN = 4.3;
const TURN = 2.5; // radians/second
const MOUSE = 0.0022;
const RADIUS = 0.24;
const SEND_HZ = 20;
const WIN_DIST = 0.9;

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
  won: false, // reached the logo this round
  startedAt: performance.now(),
  id: null,
  names: new Map(), // player id -> name
  peers: new Map(), // player id -> { id, x, y, a, finished }
  endsAt: null, // performance.now() deadline for the world rollover
};
window.mazegame = state; // handy for the console and for smoke tests

function setMaze(seed) {
  state.maze = buildMaze(pinnedSeed ?? seed >>> 0);
  // Everyone starts on the same tile, jittered so pawns do not stack.
  state.cam = {
    x: state.maze.start.x + (Math.random() - 0.5) * 0.5,
    y: state.maze.start.y + (Math.random() - 0.5) * 0.5,
    a: state.maze.start.a,
  };
  state.startedAt = performance.now();
  state.won = false;
  visited.clear();
  markVisited();
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
        applyRoster(msg.roster);
        applyWorld(msg);
        for (const f of msg.finishers) note(`${f.name} escaped · ${ordinal(f.place)}`);
      } else if (msg.t === "world") {
        setMaze(msg.seed);
        state.endsAt = null;
        note("new maze");
      } else if (msg.t === "roster") {
        applyRoster(msg.players);
      } else if (msg.t === "peers") {
        applyPeers(msg.l);
      } else if (msg.t === "finish") {
        state.endsAt = performance.now() + msg.ends_in * 1000;
        const who = msg.id === state.id ? "you" : msg.name;
        note(`${who} escaped · ${ordinal(msg.place)} · ${msg.secs}s`);
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

function applyRoster(list) {
  state.names = new Map(list.map((p) => [p.id, p.name]));
  elPlayers.textContent = list.length;
  for (const id of [...state.peers.keys()]) {
    if (!state.names.has(id)) state.peers.delete(id);
  }
}

function applyPeers(list) {
  const seen = new Set();
  for (const [id, x, y, a, finished] of list) {
    if (id === state.id) continue; // that one is us
    seen.add(id);
    state.peers.set(id, { id, x, y, a, finished: !!finished });
  }
  for (const id of [...state.peers.keys()]) if (!seen.has(id)) state.peers.delete(id);
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
  if (!socket || now - lastSent < 1000 / SEND_HZ) return;
  lastSent = now;
  socket.send({ t: "pos", x: state.cam.x, y: state.cam.y, a: state.cam.a });
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
  if (!maze || state.won) return;

  const fast = keys.has("ShiftLeft") || keys.has("ShiftRight") || touch.boost;
  const speed = (fast ? RUN : WALK) * dt;
  let forward = touch.forward;
  let strafe = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) forward += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= 1;
  if (keys.has("KeyD")) strafe += 1;
  if (keys.has("KeyA")) strafe -= 1;
  if (keys.has("KeyE")) strafe += 1;
  if (keys.has("KeyQ")) strafe -= 1;
  if (keys.has("ArrowLeft")) cam.a -= TURN * dt;
  if (keys.has("ArrowRight")) cam.a += TURN * dt;
  cam.a += touch.takeTurn() + touch.steer * TURN * dt;

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

  if (Math.hypot(cam.x - maze.exit.x, cam.y - maze.exit.y) < WIN_DIST) win();
}

function win() {
  if (state.won) return;
  state.won = true;
  state.wonAt = performance.now();
  const secs = (state.wonAt - state.startedAt) / 1000;
  showOverlay(
    `<strong>ESCAPED</strong><br>${secs.toFixed(1)}s · ${state.maze.length} tiles of corridor` +
      `<br><small>keep wandering — the maze changes when the countdown ends</small>`,
    "won",
  );
  setTimeout(hideOverlay, WIN_DWELL);
  socket && socket.send({ t: "escaped" });
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
    const peers = [...state.peers.values()];
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

const elJoin = document.getElementById("join");
const elJoinForm = document.getElementById("join-form");
const elJoinName = document.getElementById("join-name");
const NAME_KEY = "mazegame.name";

function join(name) {
  const clean = name.trim().slice(0, 24);
  if (clean) localStorage.setItem(NAME_KEY, clean);
  else localStorage.removeItem(NAME_KEY);
  elJoin.classList.add("hidden");
  connect(clean);

  if (!isTouch) {
    const lock = view.requestPointerLock();
    if (lock && lock.catch) lock.catch(() => {}); // refused if unfocused; harmless
  }
}

elJoinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  join(elJoinName.value);
});

renderer.init().then(() => {
  if (!state.maze) setMaze((Math.random() * 2 ** 32) >>> 0);
  document.body.classList.toggle("touch", isTouch);
  showVersion(document.getElementById("version"));
  requestAnimationFrame(frame);

  // A name in the URL is an explicit choice (shared links, kiosks): skip the
  // card. Otherwise ask, pre-filled with whatever this browser used last.
  if (params.has("name")) {
    join(params.get("name"));
  } else {
    elJoinName.value = localStorage.getItem(NAME_KEY) || "";
    elJoin.classList.remove("hidden");
    elJoinName.focus();
  }
});
