// Watcher view: ride along with one random player. The server hands us a new
// player when the current one stops moving for two seconds. The screen is
// meant for a wall or a projector, so it carries no HUD: just the maze, and a
// corner inviting whoever is looking at it to join.

import { buildMaze } from "./maze.js";
import { Renderer, retroPixel } from "./render.js";
import { clockTime, makeClock, makeTrack, pushSample, sampleTrack } from "./interp.js";
import { createSocket } from "./net.js";
import { qrSvg } from "./qr.js";

const PEER_TTL = 8; // snapshots a body may go unmentioned before it is dropped

const view = document.getElementById("view");
const elStandby = document.getElementById("standby");

const renderer = new Renderer(view, { pixel: retroPixel() });

const state = {
  maze: null,
  cam: { x: 1.5, y: 1.5, a: 0 },
  camTrack: makeTrack(),
  target: null,
  peers: new Map(),
  clock: makeClock(), // maps the server's tick clock into local time
};
window.mazecam = state; // handy for the console and for smoke tests

function standby(on) {
  elStandby.classList.toggle("hidden", !on);
  document.body.classList.toggle("nosignal", on);
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
      state.peers.clear();
      document.title = `watching ${msg.name} · NixOS Maze`;
      standby(false);
      document.body.classList.add("flash");
      setTimeout(() => document.body.classList.remove("flash"), 220);
    } else if (msg.t === "peers") {
      applyPeers(msg);
    } else if (msg.t === "world") {
      state.maze = buildMaze(msg.seed >>> 0);
    } else if (msg.t === "idle_pool") {
      state.target = null;
      state.maze = null;
      state.peers.clear();
      document.title = "NixOS Maze · watch";
      standby(true);
    }
  },
});

// The camera rides the watched player; everyone else is drawn as a pawn. Both
// are interpolated, so a 10 Hz feed still plays back as smooth motion.
function applyPeers(msg) {
  const arrived = performance.now();
  const now = clockTime(state.clock, msg.clock, arrived);
  for (const [id, x, y, a, finished, age] of msg.l) {
    if (state.target && id === state.target.id) {
      pushSample(state.camTrack, x, y, a, now - age, arrived);
      continue;
    }
    let peer = state.peers.get(id);
    if (!peer) {
      peer = { id, track: makeTrack(x, y, a), x, y, a, finished: !!finished };
      state.peers.set(id, peer);
    }
    peer.finished = !!finished;
    peer.seen = now;
    pushSample(peer.track, x, y, a, now - age, arrived);
  }
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
document.getElementById("qr").innerHTML = qrSvg(new URL("/", location.href).href);

function frame(now) {
  if (state.maze) {
    state.cam = sampleTrack(state.camTrack, now);
    // No minimap and no name tags: a spectator should be as lost as the player.
    renderer.draw(state.maze, state.cam, livePeers(now));
  }
  requestAnimationFrame(frame);
}

renderer.init().then(() => {
  standby(true);
  requestAnimationFrame(frame);
});
