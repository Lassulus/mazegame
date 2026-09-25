// Watcher view: ride along with one random player. The server hands us a new
// player when the current one stops moving for two seconds. The screen is
// meant for a wall or a projector, so it carries no HUD: just the maze, and a
// corner inviting whoever is looking at it to join.

import { buildMaze, rockAt } from "./maze.js";
import { Renderer, retroPixel, rollAngle, stepRoll } from "./render.js";
import {
  clockTime, liveGhosts, makeClock, makeTrack, pushSample, sampleTrack, syncGhosts,
} from "./interp.js";
import { FINISHED, FLIPPED, POWERED, createSocket } from "./net.js";
import { drawQr } from "./qr.js";

const PEER_TTL = 8; // snapshots a body may go unmentioned before it is dropped
// A camera that moves further than this in one frame has watched its player
// respawn or get sent home: every rock is back for the new trip.
const TELEPORT = 3; // tiles

const view = document.getElementById("view");
const elStandby = document.getElementById("standby");
const elPlaying = document.getElementById("playing");
const elPlayers = document.getElementById("players");
const elWatching = document.getElementById("watching");
const elTarget = document.getElementById("target");

const renderer = new Renderer(view, { pixel: retroPixel() });

const state = {
  maze: null,
  cam: { x: 1.5, y: 1.5, a: 0 },
  camTrack: makeTrack(),
  target: null,
  targetFlags: 0, // the watched player's snapshot flags: ceiling, cherry power
  flip: 0, // how far the view has turned over, 0..1
  taken: new Set(), // rocks the watched player has used on this trip
  peers: new Map(),
  ghosts: new Map(),
  cherries: [],
  clock: makeClock(), // maps the server's tick clock into local time
};
window.mazecam = state; // handy for the console and for smoke tests

function standby(on) {
  elStandby.classList.toggle("hidden", !on);
  elWatching.classList.toggle("hidden", on);
  document.body.classList.toggle("nosignal", on);
}

// Hidden at zero: the standby card already says the maze is empty.
function showPlayers(n) {
  elPlayers.textContent = n;
  elPlaying.classList.toggle("hidden", !n);
}

function setCherries(list) {
  state.cherries = (list || []).map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
}

const socket = createSocket("/ws/watch", {
  onMessage(msg) {
    if (msg.t === "watch") {
      state.target = { id: msg.id, name: msg.name };
      state.maze = buildMaze(msg.seed >>> 0);
      const spawn = msg.placed ? { x: msg.x, y: msg.y, a: msg.a } : state.maze.start;
      // A cut is a hard jump, not a glide: start a fresh track on the new body.
      state.camTrack = makeTrack(spawn.x, spawn.y, spawn.a);
      state.cam = { ...spawn };
      state.targetFlags = 0;
      state.flip = 0;
      state.taken.clear();
      state.peers.clear();
      state.ghosts.clear();
      setCherries(msg.cherries);
      document.title = `watching ${msg.name} · NixOS Maze`;
      elTarget.textContent = msg.name;
      standby(false);
      showPlayers(msg.players);
      document.body.classList.add("flash");
      setTimeout(() => document.body.classList.remove("flash"), 220);
    } else if (msg.t === "peers") {
      showPlayers(msg.n);
      applyPeers(msg);
    } else if (msg.t === "world") {
      state.maze = buildMaze(msg.seed >>> 0);
      state.taken.clear();
      state.ghosts.clear();
      setCherries(msg.cherries);
    } else if (msg.t === "cherries") {
      setCherries(msg.l);
    } else if (msg.t === "idle_pool") {
      state.target = null;
      state.maze = null;
      state.peers.clear();
      state.ghosts.clear();
      document.title = "NixOS Maze · watch";
      standby(true);
      showPlayers(0);
    }
  },
});

// The camera rides the watched player; everyone else is drawn as a pawn. Both
// are interpolated, so a 10 Hz feed still plays back as smooth motion.
function applyPeers(msg) {
  const arrived = performance.now();
  const now = clockTime(state.clock, msg.clock, arrived);
  for (const [id, x, y, a, flags, age] of msg.l) {
    if (state.target && id === state.target.id) {
      pushSample(state.camTrack, x, y, a, now - age, arrived);
      state.targetFlags = flags;
      continue;
    }
    let peer = state.peers.get(id);
    if (!peer) {
      peer = { id, track: makeTrack(x, y, a), x, y, a };
      state.peers.set(id, peer);
    }
    peer.finished = !!(flags & FINISHED);
    peer.flipped = !!(flags & FLIPPED);
    peer.seen = now;
    pushSample(peer.track, x, y, a, now - age, arrived);
  }
  syncGhosts(state.ghosts, msg.g, now, arrived);
  // A body that drops out of the nearest twenty for one tick is still there:
  // forgetting it immediately threw away its interpolation history. Much
  // longer than a few snapshots, though, and it really has walked away.
  // Distant bodies are refreshed on one tick in three, so the window has
  // to outlive a couple of their turns as well as ordinary list churn.
  const ttl = Math.max(900, (PEER_TTL * 1000) / (msg.hz || 10));
  for (const [id, peer] of state.peers) {
    if (now - peer.seen > ttl) state.peers.delete(id);
  }
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

// No visible controls, but whoever is at the keyboard can still steer it.
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
addEventListener("orientationchange", () => setTimeout(() => renderer.resize(), 120));
addEventListener("resize", () => renderer.resize());

// The code points at this very server, so it is right on any deployment.
drawQr(document.getElementById("qr"), new URL("/", location.href).href);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.maze) {
    const prev = state.cam;
    state.cam = sampleTrack(state.camTrack, now);
    if (Math.hypot(state.cam.x - prev.x, state.cam.y - prev.y) > TELEPORT) state.taken.clear();
    // The player's own client decides when a rock turns them over; the
    // camera only sees the result in the flags. Rocks it rides through are
    // gone, as they are for the player.
    const rock = rockAt(state.maze, state.cam.x, state.cam.y, state.taken);
    if (rock >= 0) state.taken.add(rock);
    state.flip = stepRoll(state.flip, !!(state.targetFlags & FLIPPED), dt);
    // No minimap and no name tags: a spectator should be as lost as the player.
    renderer.draw(state.maze, state.cam, {
      peers: livePeers(now),
      ghosts: liveGhosts(state.ghosts, now),
      cherries: state.cherries,
      rocks: state.maze.rocks.filter((_, i) => !state.taken.has(i)),
      roll: rollAngle(state.flip),
      now,
      // Ghosts look the way the watched player sees them.
      power: state.targetFlags & POWERED ? Infinity : 0,
    });
  }
  requestAnimationFrame(frame);
}

renderer.init().then(() => {
  standby(true);
  requestAnimationFrame(frame);
});
