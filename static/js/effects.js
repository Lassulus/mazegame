// Ghost-and-player touches, played where they happened. The server tells
// everyone nearby about a catch (`bite`) or a ghost being eaten (`pop`); the
// pages keep them here for a moment and mark up the frame: the ghost snaps
// its jaws over its catch while the victim sinks into it, and an eaten ghost
// shrinks away blinking and leaves its eyes floating up out of the floor.

// As long as the ghost stands chewing on the server and the victim's own
// "caught" card holds it before the walk home.
export const BITE_MS = 1400;
// The victim stays out of sight a little past the bite, until its first
// report from its spawn has replaced the one on top of the ghost; otherwise
// its pawn would be seen gliding home through the walls.
const HIDE_MS = BITE_MS + 600;
export const POP_MS = 1500;

export function addEffect(effects, msg, now) {
  effects.push({ kind: msg.t, ghost: msg.ghost, pid: msg.pid, x: msg.x, y: msg.y, at: now });
}

/**
 * Mark this frame's ghosts (`chomp`) and pawns (`gulp`, 0..1 swallowed) and
 * return the pops in flight as `{ id, x, y, t }` for the renderer.
 */
export function applyEffects(effects, now, ghosts, peers) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    if (now - e.at > (e.kind === "bite" ? HIDE_MS : POP_MS)) effects.splice(i, 1);
  }
  for (const g of ghosts) g.chomp = false;
  for (const p of peers) p.gulp = 0;
  const pops = [];
  for (const e of effects) {
    const age = now - e.at;
    if (e.kind === "bite") {
      if (age < BITE_MS) {
        for (const g of ghosts) if (g.id === e.ghost) g.chomp = true;
      }
      for (const p of peers) if (p.id === e.pid) p.gulp = Math.min(1, age / BITE_MS);
    } else {
      pops.push({ id: e.ghost, x: e.x, y: e.y, t: age / POP_MS });
    }
  }
  return pops;
}

/** Where the ghost involved in `e` is: its latest report, or the touch spot. */
export function ghostSpot(ghosts, e) {
  const g = ghosts.get(e.ghost);
  if (!g) return { x: e.x, y: e.y };
  const last = g.track.x.length - 1;
  return { x: g.track.x[last], y: g.track.y[last] };
}
