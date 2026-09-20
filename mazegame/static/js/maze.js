// Deterministic maze generation. Player and watcher must agree on the layout
// from the seed alone, so everything here is pure and PRNG-driven.

export const EMPTY = 0;
export const WALL = 1;
export const EXIT = 2;

export const CELLS = 11; // cells per side -> 23x23 tile grid

// How long the "escaped" card stays up before the next maze appears. Shared so
// the spectator camera swaps mazes at the same moment the player does.
export const WIN_DWELL = 1800;

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

  // Recursive backtracker (the classic "perfect maze" carve).
  const startCX = (rnd() * cells) | 0;
  const startCY = (rnd() * cells) | 0;
  const seen = new Uint8Array(cells * cells);
  const stack = [[startCX, startCY]];
  seen[startCY * cells + startCX] = 1;
  grid[at(startCX * 2 + 1, startCY * 2 + 1)] = EMPTY;

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const open = [];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) continue;
      if (seen[ny * cells + nx]) continue;
      open.push([nx, ny, dx, dy]);
    }
    if (!open.length) {
      stack.pop();
      continue;
    }
    const [nx, ny, dx, dy] = open[(rnd() * open.length) | 0];
    grid[at(cx * 2 + 1 + dx, cy * 2 + 1 + dy)] = EMPTY;
    grid[at(nx * 2 + 1, ny * 2 + 1)] = EMPTY;
    seen[ny * cells + nx] = 1;
    stack.push([nx, ny]);
  }

  const startTX = startCX * 2 + 1;
  const startTY = startCY * 2 + 1;
  const dist = bfs(grid, w, h, startTX, startTY);

  // The exit is the wall capping the dead end furthest from the spawn, so the
  // logo always faces you down a corridor.
  let best = null;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const tx = cx * 2 + 1;
      const ty = cy * 2 + 1;
      if (tx === startTX && ty === startTY) continue;
      const exits = DIRS.filter(([dx, dy]) => grid[at(tx + dx, ty + dy)] === EMPTY);
      if (exits.length !== 1) continue;
      const d = dist[at(tx, ty)];
      if (d < 0) continue;
      if (!best || d > best.d) best = { tx, ty, d, open: exits[0] };
    }
  }
  if (!best) best = { tx: startTX, ty: startTY, d: 0, open: [0, -1] };

  const exitX = best.tx - best.open[0];
  const exitY = best.ty - best.open[1];
  grid[at(exitX, exitY)] = EXIT;

  // Face the spawn down an open corridor.
  const look = DIRS.find(([dx, dy]) => grid[at(startTX + dx, startTY + dy)] === EMPTY) || [1, 0];

  return {
    seed,
    w,
    h,
    grid,
    start: { x: startTX + 0.5, y: startTY + 0.5, a: Math.atan2(look[1], look[0]) },
    exit: { x: exitX + 0.5, y: exitY + 0.5, face: [-best.open[0], -best.open[1]] },
    // Standing here means you touched the logo.
    exitApproach: { x: best.tx + 0.5, y: best.ty + 0.5 },
    length: best.d,
  };
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
