// Watcher view: ride along with one random player. The server hands us a new
// player when the current one stops moving for two seconds.

import { buildMaze } from "./maze.js";
import { Renderer, drawMinimap, retroPixel } from "./render.js";
import { createSocket } from "./net.js";
import { createTags } from "./tags.js";
import { isTouch, wireFullscreen } from "./touch.js";
import { showVersion } from "./version.js";

const IDLE_LIMIT = 2000; // must match hub.IDLE_SWITCH
const SMOOTH = 16; // camera catch-up rate

const view = document.getElementById("view");
const minimap = document.getElementById("minimap");
const elName = document.getElementById("target");
const elPlayers = document.getElementById("players");
const elIdleBar = document.getElementById("idlebar");
const elIdleText = document.getElementById("idletext");
const elBanner = document.getElementById("banner");
const elRound = document.getElementById("round");
const elStatus = document.getElementById("status");
const elStandby = document.getElementById("standby");

const renderer = new Renderer(view, { pixel: retroPixel() });

const state = {
  maze: null,
  cam: { x: 1.5, y: 1.5, a: 0 },
  want: { x: 1.5, y: 1.5, a: 0 },
  lastPos: { x: 0, y: 0, a: 0 },
  target: null,
  lastMove: performance.now(),
  players: 0,
  names: new Map(),
  peers: new Map(),
  endsAt: null,
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
      state.target = { id: msg.id, name: msg.name };
      state.maze = buildMaze(msg.seed >>> 0);
      const spawn = msg.placed ? { x: msg.x, y: msg.y, a: msg.a } : state.maze.start;
      state.want = { ...spawn };
      state.cam = { ...spawn };
      state.lastMove = performance.now();
      state.players = msg.players;
      state.endsAt = msg.ends_in === null ? null : performance.now() + msg.ends_in * 1000;
      elName.textContent = msg.name;
      elPlayers.textContent = msg.players;
      document.title = `watching ${msg.name} · NixOS Maze`;
      standby(false);
      banner(REASONS[msg.reason] || "SWITCHING", msg.reason === "idle" ? "idle" : "cut");
      document.body.classList.add("flash");
      setTimeout(() => document.body.classList.remove("flash"), 220);
    } else if (msg.t === "peers") {
      applyPeers(msg.l);
    } else if (msg.t === "roster") {
      state.names = new Map(msg.players.map((p) => [p.id, p.name]));
      state.players = msg.players.length;
      elPlayers.textContent = state.players;
    } else if (msg.t === "world") {
      state.maze = buildMaze(msg.seed >>> 0);
      state.endsAt = null;
      banner("NEW MAZE", "win");
    } else if (msg.t === "finish") {
      state.endsAt = performance.now() + msg.ends_in * 1000;
      banner(`${msg.name.toUpperCase()} ESCAPED`, "win");
    } else if (msg.t === "idle_pool") {
      state.target = null;
      state.maze = null;
      state.players = 0;
      state.peers.clear();
      elName.textContent = "—";
      elPlayers.textContent = "0";
      elIdleBar.style.width = "0%";
      elIdleText.textContent = "—";
      document.title = "NixOS Maze · watch";
      standby(true);
    }
  },
});

// The camera rides the watched player; everyone else is drawn as a pawn.
function applyPeers(list) {
  const seen = new Set();
  for (const [id, x, y, a, finished] of list) {
    if (state.target && id === state.target.id) {
      state.want = { x, y, a };
      const moved =
        Math.abs(x - state.lastPos.x) > 0.015 ||
        Math.abs(y - state.lastPos.y) > 0.015 ||
        Math.abs(wrap(a - state.lastPos.a)) > 0.015;
      if (moved) state.lastMove = performance.now();
      state.lastPos = { x, y, a };
      continue;
    }
    seen.add(id);
    state.peers.set(id, { id, x, y, a, finished: !!finished });
  }
  for (const id of [...state.peers.keys()]) if (!seen.has(id)) state.peers.delete(id);
}

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

function clock(secs) {
  const whole = Math.max(0, Math.floor(secs));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function wrap(angle) {
  return ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

const drawTags = createTags(document.getElementById("labels"));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (state.maze) {
    const k = 1 - Math.exp(-dt * SMOOTH);
    state.cam.x += (state.want.x - state.cam.x) * k;
    state.cam.y += (state.want.y - state.cam.y) * k;
    state.cam.a += wrap(state.want.a - state.cam.a) * k;
    const peers = [...state.peers.values()];
    const labels = renderer.draw(state.maze, state.cam, peers) || [];
    drawTags(labels, state.names, view.clientWidth / renderer.w || 1);
    drawMinimap(minimap, state.maze, state.cam, { scale: 4, peers });
    elRound.textContent = state.endsAt === null ? "open" : clock((state.endsAt - now) / 1000);

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
  showVersion(document.getElementById("version"));
  requestAnimationFrame(frame);
});
