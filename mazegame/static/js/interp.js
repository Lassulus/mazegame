// Entity interpolation. Positions arrive 10-20 times a second; frames are
// drawn 60 times a second. Snapping to each snapshot is what makes a crowd
// look like a slideshow, so every remote body is played back as a short glide
// between the last two samples.

const MIN_STEP = 60; // ms, clamps the glide when snapshots bunch up
const MAX_STEP = 300; // ms, and when they arrive late

export function makeTrack(x = 0, y = 0, a = 0) {
  return {
    fx: x, fy: y, fa: a, // where the glide starts
    tx: x, ty: y, ta: a, // where it ends
    start: 0,
    dur: 100,
    last: 0,
    seeded: false,
  };
}

export function wrapAngle(angle) {
  return ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

/** Feed a fresh sample; the glide re-aims from wherever we are right now. */
export function pushSample(track, x, y, a, now) {
  if (!track.seeded) {
    track.fx = track.tx = x;
    track.fy = track.ty = y;
    track.fa = track.ta = a;
    track.seeded = true;
    track.start = now;
    track.last = now;
    return;
  }
  const here = sampleTrack(track, now);
  track.fx = here.x;
  track.fy = here.y;
  track.fa = here.a;
  track.tx = x;
  track.ty = y;
  // Keep the target angle on the same turn as the current one, so a wrap
  // from +pi to -pi spins the short way instead of whipping round.
  track.ta = here.a + wrapAngle(a - here.a);
  track.dur = Math.min(MAX_STEP, Math.max(MIN_STEP, now - track.last));
  track.start = now;
  track.last = now;
}

export function sampleTrack(track, now) {
  const t = track.dur > 0 ? Math.min(1, (now - track.start) / track.dur) : 1;
  return {
    x: track.fx + (track.tx - track.fx) * t,
    y: track.fy + (track.ty - track.fy) * t,
    a: track.fa + (track.ta - track.fa) * t,
  };
}
