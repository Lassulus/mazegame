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
  const length = best.d;

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
    length,
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
