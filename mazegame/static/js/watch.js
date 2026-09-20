// Watcher view: ride along with one random player. The server hands us a new
// player when the current one stops moving for two seconds.

import { buildMaze } from "./maze.js";
import { Renderer, retroPixel } from "./render.js";
import { makeTrack, pushSample, sampleTrack, wrapAngle } from "./interp.js";
import { createSocket } from "./net.js";
import { createTags } from "./tags.js";
import { isTouch, wireFullscreen } from "./touch.js";
import { showVersion } from "./version.js";

const IDLE_LIMIT = 2000; // must match hub.IDLE_SWITCH

const view = document.getElementById("view");
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
  camTrack: makeTrack(),
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
      // A cut is a hard jump, not a glide: start a fresh track on the new body.
      state.camTrack = makeTrack(spawn.x, spawn.y, spawn.a);
      state.cam = { ...spawn };
      state.lastPos = { ...spawn };
      state.peers.clear();
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
      applyPeers(msg);
    } else if (msg.t === "world") {
      state.maze = buildMaze(msg.seed >>> 0);
      state.endsAt = null;
      banner(msg.winner ? `NEW MAZE · ${msg.winner.toUpperCase()} WON` : "NEW MAZE", "win");
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

// The camera rides the watched player; everyone else is drawn as a pawn. Both
// are interpolated, so a 10 Hz feed still plays back as smooth motion.
function applyPeers(msg) {
  state.players = msg.n;
  elPlayers.textContent = msg.n;
  const now = performance.now();
  const seen = new Set();
  for (const [id, x, y, a, finished, name] of msg.l) {
    if (name) state.names.set(id, name);
    if (state.target && id === state.target.id) {
      const moved =
        Math.abs(x - state.lastPos.x) > 0.015 ||
        Math.abs(y - state.lastPos.y) > 0.015 ||
        Math.abs(wrapAngle(a - state.lastPos.a)) > 0.015;
      if (moved) state.lastMove = now;
      state.lastPos = { x, y, a };
      pushSample(state.camTrack, x, y, a, now);
      continue;
    }
    seen.add(id);
    let peer = state.peers.get(id);
    if (!peer) {
      peer = { id, track: makeTrack(x, y, a), x, y, a, finished: !!finished };
      state.peers.set(id, peer);
    }
    peer.finished = !!finished;
    pushSample(peer.track, x, y, a, now);
  }
  for (const id of [...state.peers.keys()]) if (!seen.has(id)) state.peers.delete(id);
}

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



const drawTags = createTags(document.getElementById("labels"));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (state.maze) {
    state.cam = sampleTrack(state.camTrack, now);
    const peers = livePeers(now);
    const labels = renderer.draw(state.maze, state.cam, peers) || [];
    drawTags(labels, state.names, view.clientWidth / renderer.w || 1);
    // No minimap here on purpose: a spectator should be as lost as the player.
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
