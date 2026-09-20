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
const MAX_DELAY = 400; // ms
const MAX_COAST = 250; // ms of dead reckoning before a silent body is parked


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
    gap: 100,
    delay: 135,
    seeded: false,
  };
}

export function wrapAngle(angle) {
  return ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

/** Feed a fresh sample. */
export function pushSample(track, x, y, a, now) {
  if (!track.seeded) {
    track.t[0] = now;
    track.x[0] = x;
    track.y[0] = y;
    track.a[0] = a;
    track.seeded = true;
    return;
  }
  const n = track.t.length - 1;
  const gap = now - track.t[n];
  if (gap <= 0) return; // two snapshots in the same millisecond: keep the first
  // Track the cadence rather than trusting the advertised one: a phone on a
  // bad link sees its own interval, not the server's.
  track.gap = track.gap * 0.8 + gap * 0.2;
  track.delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, track.gap * LEAD));
  track.t.push(now);
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

  const at = now - track.delay;
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
