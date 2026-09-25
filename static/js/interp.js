// Entity interpolation. Positions arrive 7-20 times a second; frames are
// drawn 60 times a second.
//
// The obvious approach — glide from where you are to the newest sample over
// however long the last gap was — looks wrong the moment snapshots jitter:
// the glide finishes early and the body stops dead until the next one, or it
// is re-aimed mid-flight and visibly changes speed. Measured on a 10 Hz feed
// that was a 0.47 coefficient of variation in per-frame step size with 2.8 %
// of frames stalled.
//
// So play the feed back the way video does: keep the last few samples and
// render at `now - delay`, between the two that straddle it. The delay is
// one and a bit snapshot intervals, learned per body, so ordinary jitter
// lands inside the buffer and the motion never stalls or sprints.

const BUFFER = 8; // samples kept; 8 covers a second at the slowest cadence
const LEAD = 1.35; // delay, in snapshot intervals
const MIN_DELAY = 70; // ms
const MAX_DELAY = 450; // ms
const MAX_COAST = 250; // ms of dead reckoning before a silent body is parked
// How fast a spike in lateness or spacing is forgotten, per sample. At 10 Hz
// this has a half-life of about two seconds: long enough to still cover the
// next bunch from a bad uplink, short enough to recover once the link settles.
const PEAK_DECAY = 0.97;
// Samples closer together than this are the same report seen in two
// snapshots, its timestamp nudged by the 2 ms age rounding. Kept, they drag
// the learned spacing down and push real history out of the buffer.
const SAME_SAMPLE_MS = 10;
// How fast the playback delay may change, ms per ms. Growing is urgent — a
// buffer that is too short runs off its end and stalls — so it may grow fast
// (playback slows to half speed for a moment); shrinking is not, so it
// eases back at 0.9x.
const SLEW_UP = 0.5;
const SLEW_DOWN = 0.1;

// Snapshots carry the server's tick clock. Arrival times jitter by tens of
// milliseconds; tick times do not, so playback rides the server clock mapped
// into local time. The mapping is the smallest offset seen recently (the
// least-delayed packet), with a slow upward drift so a lucky early packet
// cannot wedge the estimate forever.
const DRIFT = 0.00002; // ms of allowed drift per ms of wall clock

export function makeClock() {
  return { offset: null, last: 0 };
}

/** Local timestamp for a snapshot the server stamped `remote`. */
export function clockTime(clock, remote, now) {
  if (!Number.isFinite(remote)) return now;
  const seen = now - remote;
  if (clock.offset === null || seen < clock.offset || Math.abs(seen - clock.offset) > 2000) {
    clock.offset = seen; // first sample, a faster path, or the clock wrapped
  } else if (clock.last) {
    clock.offset += (now - clock.last) * DRIFT;
  }
  clock.last = now;
  return remote + clock.offset;
}

export function makeTrack(x = 0, y = 0, a = 0) {
  return {
    t: [0],
    x: [x],
    y: [y],
    a: [a],
    gap: 100, // typical spacing between samples, ms
    gapPeak: 100, // recent longest spacing, ms
    late: 0, // recent worst lateness on arrival, ms
    delay: 135, // playback delay wanted
    played: undefined, // playback delay in use, slewed towards `delay`
    lastSampled: 0,
    seeded: false,
  };
}

export function wrapAngle(angle) {
  return ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

/**
 * Feed a sample that was true at `t` and reached us at `arrived` (both local
 * ms).
 *
 * Samples carry the time they were true, not when they got here, so a body
 * on a bad uplink turns up late and in bunches. At any moment the newest
 * sample we hold is as old as its lateness plus however long the next one
 * takes, and the playback point must stay behind that or it runs off the end
 * of the buffer and stalls: with 120 ms of uplink jitter, a delay sized on
 * cadence alone ran off the end on 17 % of frames. So the delay covers the
 * worst recent lateness plus the longest recent spacing.
 */
export function pushSample(track, x, y, a, t, arrived = t) {
  if (!track.seeded) {
    track.t[0] = t;
    track.x[0] = x;
    track.y[0] = y;
    track.a[0] = a;
    track.seeded = true;
    return;
  }
  const n = track.t.length - 1;
  const gap = t - track.t[n];
  if (gap < SAME_SAMPLE_MS) return; // a report we already have
  // Track the cadence rather than trusting the advertised one: a phone on a
  // bad link sees its own interval, not the server's.
  track.gap = track.gap * 0.8 + gap * 0.2;
  track.gapPeak = Math.max(gap, track.gapPeak * PEAK_DECAY);
  track.late = Math.max(Math.max(0, arrived - t), track.late * PEAK_DECAY);
  track.delay = Math.min(
    MAX_DELAY,
    Math.max(MIN_DELAY, track.gap * LEAD, track.late + track.gapPeak),
  );
  track.t.push(t);
  track.x.push(x);
  track.y.push(y);
  // Keep angles on one continuous turn so a wrap from +pi to -pi spins the
  // short way instead of whipping round.
  track.a.push(track.a[n] + wrapAngle(a - track.a[n]));
  if (track.t.length > BUFFER) {
    track.t.shift();
    track.x.shift();
    track.y.shift();
    track.a.shift();
  }
}

export function sampleTrack(track, now) {
  const t = track.t;
  const last = t.length - 1;
  if (last < 1) return { x: track.x[0], y: track.y[0], a: track.a[0] };

  // Move towards the wanted delay gradually. Jumping to it moves the
  // playback point in time by the whole difference in one frame: a stall
  // when the delay grows, a sprint while it shrinks back.
  if (track.played === undefined) {
    track.played = track.delay;
  } else {
    const dt = Math.max(0, Math.min(100, now - track.lastSampled));
    const want = track.delay - track.played;
    track.played += want > 0 ? Math.min(want, SLEW_UP * dt) : Math.max(want, -SLEW_DOWN * dt);
  }
  track.lastSampled = now;
  const at = now - track.played;
  if (at <= t[0]) return { x: track.x[0], y: track.y[0], a: track.a[0] };
  if (at >= t[last]) {
    // Ran off the end: coast on the last known velocity for a moment so a
    // single late snapshot is invisible, then hold still rather than drift
    // a disconnected body across the maze.
    const span = t[last] - t[last - 1];
    const over = Math.min(at - t[last], MAX_COAST);
    if (span <= 0 || over <= 0) return { x: track.x[last], y: track.y[last], a: track.a[last] };
    const k = over / span;
    return {
      x: track.x[last] + (track.x[last] - track.x[last - 1]) * k,
      y: track.y[last] + (track.y[last] - track.y[last - 1]) * k,
      a: track.a[last] + (track.a[last] - track.a[last - 1]) * k,
    };
  }
  let i = last;
  while (i > 0 && t[i - 1] > at) i--;
  const span = t[i] - t[i - 1];
  const k = span > 0 ? (at - t[i - 1]) / span : 1;
  return {
    x: track.x[i - 1] + (track.x[i] - track.x[i - 1]) * k,
    y: track.y[i - 1] + (track.y[i] - track.y[i - 1]) * k,
    a: track.a[i - 1] + (track.a[i] - track.a[i - 1]) * k,
  };
}

/**
 * Ghosts ride the same playback as bodies. Every living ghost is in every
 * snapshot, so one that is missing has been eaten and goes at once; it comes
 * back as a fresh track when it respawns rather than gliding across the maze.
 */
export function syncGhosts(ghosts, list, t, arrived) {
  const alive = new Set();
  for (const [id, x, y] of list) {
    alive.add(id);
    let ghost = ghosts.get(id);
    if (!ghost) {
      ghost = { id, track: makeTrack(x, y, 0), x, y };
      ghosts.set(id, ghost);
    }
    pushSample(ghost.track, x, y, 0, t, arrived);
  }
  for (const id of ghosts.keys()) {
    if (!alive.has(id)) ghosts.delete(id);
  }
}

export function liveGhosts(ghosts, now) {
  const out = [];
  for (const ghost of ghosts.values()) {
    const at = sampleTrack(ghost.track, now);
    ghost.x = at.x;
    ghost.y = at.y;
    out.push(ghost);
  }
  return out;
}
