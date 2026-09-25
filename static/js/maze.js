// Deterministic maze generation. Player and watcher must agree on the layout
// from the seed alone, so everything here is pure and PRNG-driven.

export const EMPTY = 0;
export const WALL = 1;
export const EXIT = 2;

// 25x25 cells -> 51x51 tiles, five times the floor area of the original 11x11.
export const CELLS = 25;

// How long the "escaped" card stays on screen. The world itself only rolls
// over when the server says so (2 minutes after the first escape).
export const WIN_DWELL = 2600;

// Tuning for how maze-y the maze is: how many dead ends get sealed into
// junctions, and how many extra walls are punched out to create loops.
const BRAID = 0.7;
const EXTRA_LOOPS = 0.06;
// Spawns must be at least this fraction of the longest walk away from the
// exit, so scattering players does not also hand out unequal races.
const SPAWN_BAND = 0.75;
// The screensaver's grey rocks: touch one and the world turns upside down,
// touch another and it turns back. Placed from their own PRNG stream so the
// walls stay byte-identical to the server's copy of this generator.
const ROCKS = 8;
const ROCK_SPACING = 8; // tiles, Chebyshev, between two rocks
export const ROCK_KINDS = 4; // tetrahedron, octahedron, icosahedron, dodecahedron
export const ROCK_REACH = 0.45; // tiles from a rock's centre that count as touching it

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function buildMaze(seed, cells = CELLS) {
  const rnd = mulberry32(seed);
  const w = cells * 2 + 1;
  const h = cells * 2 + 1;
  const grid = new Uint8Array(w * h).fill(WALL);
  const at = (x, y) => y * w + x;

  // Randomized Prim's: grows the tree from a random frontier wall each step,
  // which forks constantly instead of snaking like a backtracker does.
  const startCX = (rnd() * cells) | 0;
  const startCY = (rnd() * cells) | 0;
  const seen = new Uint8Array(cells * cells);
  const frontier = []; // [cellX, cellY, fromX, fromY]

  const visit = (cx, cy) => {
    seen[cy * cells + cx] = 1;
    grid[at(cx * 2 + 1, cy * 2 + 1)] = EMPTY;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) continue;
      if (seen[ny * cells + nx]) continue;
      frontier.push([nx, ny, cx, cy]);
    }
  };

  visit(startCX, startCY);
  while (frontier.length) {
    const pick = (rnd() * frontier.length) | 0;
    const [cx, cy, fromX, fromY] = frontier[pick];
    frontier[pick] = frontier[frontier.length - 1];
    frontier.pop();
    if (seen[cy * cells + cx]) continue;
    grid[at(fromX + cx + 1, fromY + cy + 1)] = EMPTY; // the wall between them
    visit(cx, cy);
  }

  const startTX = startCX * 2 + 1;
  const startTY = startCY * 2 + 1;

  // A perfect maze is a tree: one route anywhere, every wrong turn a dead end.
  // Braid most dead ends shut and punch extra holes, so the place has real
  // junctions, shortcuts and loops instead of one long snake.
  const isInnerWall = (x, y) =>
    x > 0 && y > 0 && x < w - 1 && y < h - 1 && grid[at(x, y)] === WALL;

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const tx = cx * 2 + 1;
      const ty = cy * 2 + 1;
      const open = DIRS.filter(([dx, dy]) => grid[at(tx + dx, ty + dy)] === EMPTY);
      if (open.length !== 1 || rnd() > BRAID) continue;
      const options = DIRS.filter(([dx, dy]) => isInnerWall(tx + dx, ty + dy));
      if (options.length) {
        const [dx, dy] = options[(rnd() * options.length) | 0];
        grid[at(tx + dx, ty + dy)] = EMPTY;
      }
    }
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (x % 2 === y % 2) continue; // cells and pillars, not walls between cells
      if (!isInnerWall(x, y) || rnd() > EXTRA_LOOPS) continue;
      grid[at(x, y)] = EMPTY;
    }
  }

  // Pick the exit from the braided layout, so the walk there is the real
  // shortest route and not a tree distance the shortcuts already undercut.
  const dist = bfs(grid, w, h, startTX, startTY);
  let best = null;
  let farthest = null;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const tx = cx * 2 + 1;
      const ty = cy * 2 + 1;
      const d = dist[at(tx, ty)];
      if (d < 0 || (tx === startTX && ty === startTY)) continue;
      if (!farthest || d > farthest.d) farthest = { tx, ty, d };
      const exits = DIRS.filter(([dx, dy]) => grid[at(tx + dx, ty + dy)] === EMPTY);
      if (exits.length !== 1) continue;
      if (!best || d > best.d) best = { tx, ty, d, open: exits[0] };
    }
  }
  if (!best) {
    // Fully braided away: wall off the furthest cell until it is a dead end.
    const { tx, ty, d } = farthest || { tx: startTX, ty: startTY, d: 0 };
    const exits = DIRS.filter(([dx, dy]) => grid[at(tx + dx, ty + dy)] === EMPTY);
    const keep = exits[0] || [0, -1];
    for (const [dx, dy] of exits) {
      if (dx !== keep[0] || dy !== keep[1]) grid[at(tx + dx, ty + dy)] = WALL;
    }
    best = { tx, ty, d, open: keep };
  }

  const exitX = best.tx - best.open[0];
  const exitY = best.ty - best.open[1];
  grid[at(exitX, exitY)] = EXIT;

  // Spawns are scattered, but only over cells that are a comparable walk from
  // the logo: a purely random spawn hands one player a ten-tile stroll and the
  // next a seventy-tile trek, which is no way to run a race.
  const fromExit = bfs(grid, w, h, best.tx, best.ty);
  let longest = 0;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const d = fromExit[at(cx * 2 + 1, cy * 2 + 1)];
      if (d > longest) longest = d;
    }
  }
  const floor = Math.max(1, Math.floor(longest * SPAWN_BAND));
  const spawns = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const tx = cx * 2 + 1;
      const ty = cy * 2 + 1;
      const d = fromExit[at(tx, ty)];
      if (d < floor) continue;
      const look = DIRS.find(([dx, dy]) => grid[at(tx + dx, ty + dy)] === EMPTY) || [1, 0];
      spawns.push({ x: tx + 0.5, y: ty + 0.5, a: Math.atan2(look[1], look[0]), dist: d });
    }
  }
  if (!spawns.length) {
    const look = DIRS.find(([dx, dy]) => grid[at(startTX + dx, startTY + dy)] === EMPTY) || [1, 0];
    spawns.push({
      x: startTX + 0.5, y: startTY + 0.5,
      a: Math.atan2(look[1], look[0]), dist: dist[at(best.tx, best.ty)],
    });
  }
  spawns.sort((p, q) => q.dist - p.dist);

  return {
    seed,
    w,
    h,
    grid,
    spawns,
    // The furthest spawn, used when a client has no identity of its own yet.
    start: spawns[0],
    exit: { x: exitX + 0.5, y: exitY + 0.5, face: [-best.open[0], -best.open[1]] },
    // Standing here means you touched the logo.
    exitApproach: { x: best.tx + 0.5, y: best.ty + 0.5 },
    length: longest,
    rocks: placeRocks(seed, cells, w, fromExit, spawns),
  };
}

// Rocks go anywhere between the spawn band and the logo, never on a spawn
// (you would flip the moment you arrive) and never right at the exit.
function placeRocks(seed, cells, w, fromExit, spawns) {
  const rnd = mulberry32((seed ^ 0x0f11_9ed5) >>> 0);
  const taken = new Set(spawns.map((s) => ((s.y - 0.5) * w + (s.x - 0.5)) | 0));
  const candidates = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const tx = cx * 2 + 1;
      const ty = cy * 2 + 1;
      const d = fromExit[ty * w + tx];
      if (d < 4 || taken.has(ty * w + tx)) continue;
      candidates.push([tx, ty]);
    }
  }
  const rocks = [];
  while (candidates.length && rocks.length < ROCKS) {
    const pick = (rnd() * candidates.length) | 0;
    const [tx, ty] = candidates[pick];
    candidates[pick] = candidates[candidates.length - 1];
    candidates.pop();
    const crowded = rocks.some(
      (r) => Math.max(Math.abs(r.x - 0.5 - tx), Math.abs(r.y - 0.5 - ty)) < ROCK_SPACING,
    );
    if (crowded) continue;
    rocks.push({ x: tx + 0.5, y: ty + 0.5, kind: rocks.length % ROCK_KINDS });
  }
  return rocks;
}

/** Index of the rock touched at (x, y), skipping ones already used; -1 if none. */
export function rockAt(maze, x, y, taken) {
  for (let i = 0; i < maze.rocks.length; i++) {
    if (taken.has(i)) continue;
    const r = maze.rocks[i];
    if (Math.hypot(r.x - x, r.y - y) < ROCK_REACH) return i;
  }
  return -1;
}

/**
 * Step back from (fromX, fromY) through (x, y) by up to `dist`, stopping short
 * of walls, and face it. Used to pull a camera off a ghost that has just
 * caught its player, so the chomp is in view instead of inside the lens.
 * Straight back is often straight into a wall — the ghost came at you from
 * the side of a corridor — so unless `straight` is set, the four corridor
 * directions are tried too and whichever ends furthest from (fromX, fromY)
 * wins.
 */
export function standBack(maze, x, y, fromX, fromY, dist, { straight = false, radius = 0.2 } = {}) {
  const clear = (px, py) =>
    !solid(maze, px - radius, py - radius) && !solid(maze, px + radius, py - radius) &&
    !solid(maze, px - radius, py + radius) && !solid(maze, px + radius, py + radius);
  const walk = (dx, dy) => {
    let bx = x;
    let by = y;
    for (let s = 0.05; s <= dist; s += 0.05) {
      const nx = x + dx * s;
      const ny = y + dy * s;
      if (!clear(nx, ny)) break;
      bx = nx;
      by = ny;
    }
    return [bx, by];
  };
  const len = Math.hypot(x - fromX, y - fromY);
  const away = len < 1e-3 ? [1, 0] : [(x - fromX) / len, (y - fromY) / len];
  const tries = straight ? [away] : [away, [1, 0], [-1, 0], [0, 1], [0, -1]];
  let best = null;
  for (const [dx, dy] of tries) {
    const [bx, by] = walk(dx, dy);
    const reach = Math.hypot(bx - fromX, by - fromY);
    if (!best || reach > best.reach + 0.05) best = { x: bx, y: by, reach };
  }
  return { x: best.x, y: best.y, a: Math.atan2(fromY - best.y, fromX - best.x) };
}

/** Deterministic per-player spawn: same maze, different corner each. */
export function spawnFor(maze, id) {
  const rnd = mulberry32((maze.seed ^ Math.imul(id || 1, 0x9e3779b1)) >>> 0);
  return maze.spawns[(rnd() * maze.spawns.length) | 0];
}

function bfs(grid, w, h, sx, sy) {
  const dist = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  dist[sy * w + sx] = 0;
  queue[tail++] = sy * w + sx;
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (grid[ni] !== EMPTY || dist[ni] !== -1) continue;
      dist[ni] = dist[cur] + 1;
      queue[tail++] = ni;
    }
  }
  return dist;
}

export function tileAt(maze, x, y) {
  if (x < 0 || y < 0 || x >= maze.w || y >= maze.h) return WALL;
  return maze.grid[(y | 0) * maze.w + (x | 0)];
}

export function solid(maze, x, y) {
  return tileAt(maze, x, y) !== EMPTY;
}
