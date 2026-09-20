// Watcher view: ride along with one random player. The server hands us a new
// player when the current one stops moving for two seconds.

import { WIN_DWELL, buildMaze } from "./maze.js";
import { Renderer, drawMinimap, retroPixel } from "./render.js";
import { createSocket } from "./net.js";
import { isTouch, wireFullscreen } from "./touch.js";

const IDLE_LIMIT = 2000; // must match hub.IDLE_SWITCH
const SMOOTH = 16; // camera catch-up rate

const view = document.getElementById("view");
const minimap = document.getElementById("minimap");
const elName = document.getElementById("target");
const elPlayers = document.getElementById("players");
const elEscapes = document.getElementById("escapes");
const elIdleBar = document.getElementById("idlebar");
const elIdleText = document.getElementById("idletext");
const elBanner = document.getElementById("banner");
const elStatus = document.getElementById("status");
const elStandby = document.getElementById("standby");

const renderer = new Renderer(view, { pixel: retroPixel() });

const state = {
  maze: null,
  cam: { x: 1.5, y: 1.5, a: 0 },
  want: { x: 1.5, y: 1.5, a: 0 },
  target: null,
  lastMove: performance.now(),
  players: 0,
};
window.mazecam = state; // handy for the console and for smoke tests

const REASONS = {
  start: "TUNING IN",
  idle: "IDLE — NEXT PLAYER",
  gone: "PLAYER LEFT — NEXT",
  joined: "TUNING IN",
  skip: "SKIPPED",
};

function banner(text, tone = "cut") {
  elBanner.textContent = text;
  elBanner.dataset.tone = tone;
  elBanner.classList.remove("hidden");
  clearTimeout(banner.timer);
  banner.timer = setTimeout(() => elBanner.classList.add("hidden"), 1600);
}

function standby(on) {
  elStandby.classList.toggle("hidden", !on);
  document.body.classList.toggle("nosignal", on);
}

const socket = createSocket("/ws/watch", {
  onStatus(text, kind) {
    elStatus.textContent = text;
    elStatus.dataset.kind = kind;
  },
  onMessage(msg) {
    if (msg.t === "watch") {
      state.target = { id: msg.id, name: msg.name, escapes: msg.escapes };
      state.maze = buildMaze(msg.seed >>> 0);
      const spawn = msg.placed ? { x: msg.x, y: msg.y, a: msg.a } : state.maze.start;
      state.want = { ...spawn };
      state.cam = { ...spawn };
      state.lastMove = performance.now();
      state.players = msg.players;
      elName.textContent = msg.name;
      elEscapes.textContent = msg.escapes;
      elPlayers.textContent = msg.players;
      document.title = `watching ${msg.name} · NixOS Maze`;
      standby(false);
      banner(REASONS[msg.reason] || "SWITCHING", msg.reason === "idle" ? "idle" : "cut");
      document.body.classList.add("flash");
      setTimeout(() => document.body.classList.remove("flash"), 220);
    } else if (msg.t === "pos") {
      state.want = { x: msg.x, y: msg.y, a: msg.a };
      if (msg.m) state.lastMove = performance.now();
    } else if (msg.t === "escaped") {
      if (state.target) state.target.escapes = msg.escapes;
      elEscapes.textContent = msg.escapes;
      banner("ESCAPED THE MAZE", "win");
      // The player is still staring at their escape card; swap when they do.
      const held = state.target && state.target.id;
      setTimeout(() => {
        if (!state.target || state.target.id !== held) return;
        state.maze = buildMaze(msg.seed >>> 0);
        state.want = { ...state.maze.start };
        state.cam = { ...state.maze.start };
        state.lastMove = performance.now();
      }, WIN_DWELL);
    } else if (msg.t === "idle_pool") {
      state.target = null;
      state.maze = null;
      state.players = 0;
      elName.textContent = "—";
      elPlayers.textContent = "0";
      elIdleBar.style.width = "0%";
      elIdleText.textContent = "—";
      document.title = "NixOS Maze · watch";
      standby(true);
    } else if (msg.t === "roster") {
      state.players = msg.players;
      elPlayers.textContent = msg.players;
    }
  },
});

addEventListener("keydown", (e) => {
  if (e.code === "Space" || e.code === "KeyN") {
    e.preventDefault();
    socket.send({ t: "skip" });
  } else if (e.code === "KeyF") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});
view.addEventListener("click", () => socket.send({ t: "skip" }));
wireFullscreen(document.getElementById("fullscreen"));
document.body.classList.toggle("touch", isTouch);
addEventListener("orientationchange", () => setTimeout(() => renderer.resize(), 120));

function wrap(angle) {
  return ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (state.maze) {
    const k = 1 - Math.exp(-dt * SMOOTH);
    state.cam.x += (state.want.x - state.cam.x) * k;
    state.cam.y += (state.want.y - state.cam.y) * k;
    state.cam.a += wrap(state.want.a - state.cam.a) * k;
    renderer.draw(state.maze, state.cam);
    drawMinimap(minimap, state.maze, state.cam, { scale: 5 });

    const idle = now - state.lastMove;
    const ratio = Math.min(1, idle / IDLE_LIMIT);
    elIdleBar.style.width = `${ratio * 100}%`;
    elIdleBar.dataset.hot = ratio > 0.6 ? "1" : "0";
    elIdleText.textContent =
      idle < 250 ? "moving" : `still ${(idle / 1000).toFixed(1)}s`;
  }
  requestAnimationFrame(frame);
}

addEventListener("resize", () => renderer.resize());

renderer.init().then(() => {
  standby(true);
  requestAnimationFrame(frame);
});
