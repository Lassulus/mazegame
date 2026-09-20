// Player view: walk a seeded maze, find the NixOS logo, get a new maze.

import { WIN_DWELL, buildMaze, solid } from "./maze.js";
import { Renderer, drawMinimap, retroPixel } from "./render.js";
import { createSocket } from "./net.js";
import { createTouchControls, isTouch, wireFullscreen } from "./touch.js";

const WALK = 2.7; // tiles/second
const RUN = 4.3;
const TURN = 2.5; // radians/second
const MOUSE = 0.0022;
const RADIUS = 0.24;
const SEND_HZ = 20;
const WIN_DIST = 0.9;

const MOUSE_HINT = "click to grab the mouse";
const TOUCH_HINT = "drag the left side to walk and steer";

const view = document.getElementById("view");
const minimap = document.getElementById("minimap");
const elTime = document.getElementById("time");
const elEscapes = document.getElementById("escapes");
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
  won: false,
  startedAt: performance.now(),
  escapes: 0,
};
window.mazegame = state; // handy for the console and for smoke tests

function setMaze(seed) {
  state.maze = buildMaze(pinnedSeed ?? seed >>> 0);
  state.cam = { ...state.maze.start };
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

const socket = createSocket("/ws/play" + (params.get("name") ? `?name=${encodeURIComponent(params.get("name"))}` : ""), {
  onStatus(text, kind) {
    elStatus.textContent = text;
    elStatus.dataset.kind = kind;
  },
  onMessage(msg) {
    if (msg.t === "welcome") {
      elName.textContent = msg.name;
      document.title = `${msg.name} · NixOS Maze`;
      setMaze(msg.seed);
    } else if (msg.t === "seed") {
      respawn(msg.seed);
    } else if (msg.t === "watched") {
      elWatchers.textContent = msg.n;
      elWatched.classList.toggle("hidden", msg.n === 0);
    }
  },
});

let lastSent = 0;
function pushPosition(now) {
  if (now - lastSent < 1000 / SEND_HZ) return;
  lastSent = now;
  socket.send({ t: "pos", x: state.cam.x, y: state.cam.y, a: state.cam.a });
}

// -- input ---------------------------------------------------------------

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
]);

addEventListener("keydown", (e) => {
  if (MOVE_KEYS.has(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === "Escape") document.exitPointerLock();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

view.addEventListener("click", () => {
  if (!isTouch) view.requestPointerLock();
});
elOverlay.addEventListener("click", () => {
  if (isTouch) hideOverlay();
  else view.requestPointerLock();
});
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === view;
  document.body.classList.toggle("locked", locked);
  if (locked && !state.won) hideOverlay();
  else if (!state.won && !isTouch) showOverlay(MOUSE_HINT, "paused");
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
touchpad.addEventListener("pointerdown", () => {
  if (!state.won) hideOverlay();
});

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
  state.escapes += 1;
  elEscapes.textContent = state.escapes;
  const secs = (state.wonAt - state.startedAt) / 1000;
  showOverlay(
    `<strong>ESCAPED</strong><br>${secs.toFixed(1)}s · ${state.maze.length} tiles of corridor<br><small>next maze…</small>`,
    "won",
  );
  // Offline fallback: no server means no seed handout, so pick our own.
  if (!socket.send({ t: "escaped" })) respawn((Math.random() * 2 ** 32) >>> 0);
}

// Let the escape card breathe, and swap mazes exactly when watchers do.
function respawn(seed) {
  const wait = Math.max(0, WIN_DWELL - (performance.now() - state.wonAt));
  setTimeout(() => {
    setMaze(seed);
    hideOverlay();
  }, wait);
}

// -- main loop -----------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  if (state.maze) {
    renderer.draw(state.maze, state.cam);
    drawMinimap(minimap, state.maze, state.cam, { visited, scale: 6 });
    pushPosition(now);
    const secs = state.won ? 0 : (now - state.startedAt) / 1000;
    if (!state.won) {
      elTime.textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
    }
  }
  requestAnimationFrame(frame);
}

addEventListener("resize", () => renderer.resize());
addEventListener("orientationchange", () => setTimeout(() => renderer.resize(), 120));

renderer.init().then(() => {
  if (!state.maze) setMaze((Math.random() * 2 ** 32) >>> 0);
  document.body.classList.toggle("touch", isTouch);
  showOverlay(isTouch ? TOUCH_HINT : MOUSE_HINT, "paused");
  requestAnimationFrame(frame);
});
