//! The maze, rebuilt from the seed exactly as `static/js/maze.js` does it.
//!
//! The client has always been the only one who knew what the maze looked
//! like: the server handed out a seed and trusted positions. Ghosts change
//! that — they walk corridors the server has to know — so this is a
//! line-for-line port of `buildMaze`. Every PRNG draw must happen in the same
//! order and under the same conditions as in the JavaScript, or the ghosts
//! walk through walls the players can see. The parity test at the bottom pins
//! both sides to the same grids.

/// Tile kinds, as in the client's grid.
pub const EMPTY: u8 = 0;
pub const WALL: u8 = 1;
pub const EXIT: u8 = 2;

/// Cells per side; the grid is `2 * CELLS + 1` tiles across.
pub const CELLS: usize = 25;

/// How many dead ends get sealed into junctions, and how many extra walls are
/// punched out for loops. Must match the client's constants bit for bit.
const BRAID: f64 = 0.7;
const EXTRA_LOOPS: f64 = 0.06;
/// Spawns sit at least this fraction of the longest walk from the exit.
const SPAWN_BAND: f64 = 0.75;

/// North, east, south, west — the client's `DIRS`, in the client's order,
/// because the order decides which wall a braid punches out.
pub const DIRS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

/// The client's `mulberry32`: 32-bit state, one float in [0, 1) per call.
pub struct Mulberry32(u32);

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }

    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// `(rnd() * n) | 0` in the client: an index below `n`.
    pub fn below(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
    }
}

pub struct Maze {
    pub w: usize,
    pub h: usize,
    pub grid: Vec<u8>,
    /// The dead-end cell in front of the logo; standing here is escaping.
    pub approach: (usize, usize),
    /// Walking distance from `approach` over EMPTY tiles, -1 if unreachable.
    pub from_exit: Vec<i32>,
    /// The largest `from_exit` over all cells.
    pub longest: i32,
}

impl Maze {
    pub fn build(seed: u32) -> Self {
        Self::build_cells(seed, CELLS)
    }

    /// `buildMaze(seed, cells)`, minus the spawn list (spawns stay client
    /// side; the server only needs the band threshold).
    pub fn build_cells(seed: u32, cells: usize) -> Self {
        let mut rnd = Mulberry32::new(seed);
        let w = cells * 2 + 1;
        let h = cells * 2 + 1;
        let mut grid = vec![WALL; w * h];
        let at = |x: usize, y: usize| y * w + x;

        // Randomized Prim's, with the same swap-remove frontier as the client.
        let start_cx = rnd.below(cells);
        let start_cy = rnd.below(cells);
        let mut seen = vec![false; cells * cells];
        let mut frontier: Vec<(usize, usize, usize, usize)> = Vec::new();
        let visit = |cx: usize,
                     cy: usize,
                     seen: &mut Vec<bool>,
                     grid: &mut Vec<u8>,
                     frontier: &mut Vec<(usize, usize, usize, usize)>| {
            seen[cy * cells + cx] = true;
            grid[at(cx * 2 + 1, cy * 2 + 1)] = EMPTY;
            for (dx, dy) in DIRS {
                let nx = cx as i32 + dx;
                let ny = cy as i32 + dy;
                if nx < 0 || ny < 0 || nx >= cells as i32 || ny >= cells as i32 {
                    continue;
                }
                let (nx, ny) = (nx as usize, ny as usize);
                if seen[ny * cells + nx] {
                    continue;
                }
                frontier.push((nx, ny, cx, cy));
            }
        };
        visit(start_cx, start_cy, &mut seen, &mut grid, &mut frontier);
        while !frontier.is_empty() {
            let pick = rnd.below(frontier.len());
            let (cx, cy, from_x, from_y) = frontier.swap_remove(pick);
            if seen[cy * cells + cx] {
                continue;
            }
            grid[at(from_x + cx + 1, from_y + cy + 1)] = EMPTY;
            visit(cx, cy, &mut seen, &mut grid, &mut frontier);
        }

        let start = (start_cx * 2 + 1, start_cy * 2 + 1);
        let near = |x: usize, y: usize, (dx, dy): (i32, i32)| -> usize {
            at((x as i32 + dx) as usize, (y as i32 + dy) as usize)
        };
        let inner_wall = |grid: &[u8], x: usize, y: usize| {
            x > 0 && y > 0 && x < w - 1 && y < h - 1 && grid[at(x, y)] == WALL
        };
        let open_dirs = |grid: &[u8], x: usize, y: usize| -> Vec<(i32, i32)> {
            DIRS.into_iter()
                .filter(|&d| grid[near(x, y, d)] == EMPTY)
                .collect()
        };

        // Braid: the draw only happens for dead ends, as the client's `||`
        // short-circuits, and the second only when there is a wall to punch.
        for cy in 0..cells {
            for cx in 0..cells {
                let (tx, ty) = (cx * 2 + 1, cy * 2 + 1);
                if open_dirs(&grid, tx, ty).len() != 1 || rnd.next() > BRAID {
                    continue;
                }
                let options: Vec<(i32, i32)> = DIRS
                    .into_iter()
                    .filter(|&(dx, dy)| {
                        inner_wall(&grid, (tx as i32 + dx) as usize, (ty as i32 + dy) as usize)
                    })
                    .collect();
                if !options.is_empty() {
                    let d = options[rnd.below(options.len())];
                    grid[near(tx, ty, d)] = EMPTY;
                }
            }
        }

        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if x % 2 == y % 2 {
                    continue; // cells and pillars, not walls between cells
                }
                if !inner_wall(&grid, x, y) || rnd.next() > EXTRA_LOOPS {
                    continue;
                }
                grid[at(x, y)] = EMPTY;
            }
        }

        // The exit: the furthest dead end from the start, strictly greater
        // wins, scanning cells row by row as the client does.
        let dist = distances(&grid, w, h, start, i32::MAX);
        let mut best: Option<(usize, usize, (i32, i32))> = None;
        let mut best_d = -1;
        let mut farthest: Option<(usize, usize, i32)> = None;
        for cy in 0..cells {
            for cx in 0..cells {
                let (tx, ty) = (cx * 2 + 1, cy * 2 + 1);
                let d = dist[at(tx, ty)];
                if d < 0 || (tx, ty) == start {
                    continue;
                }
                if farthest.is_none_or(|f| d > f.2) {
                    farthest = Some((tx, ty, d));
                }
                let exits = open_dirs(&grid, tx, ty);
                if exits.len() != 1 {
                    continue;
                }
                if best.is_none() || d > best_d {
                    best = Some((tx, ty, exits[0]));
                    best_d = d;
                }
            }
        }
        let (tx, ty, open) = match best {
            Some(best) => best,
            None => {
                // Fully braided away: wall off the furthest cell until it is
                // a dead end.
                let (tx, ty, _) = farthest.unwrap_or((start.0, start.1, 0));
                let exits = open_dirs(&grid, tx, ty);
                let keep = exits.first().copied().unwrap_or((0, -1));
                for d in exits {
                    if d != keep {
                        grid[near(tx, ty, d)] = WALL;
                    }
                }
                (tx, ty, keep)
            }
        };
        grid[near(tx, ty, (-open.0, -open.1))] = EXIT;

        let from_exit = distances(&grid, w, h, (tx, ty), i32::MAX);
        let mut longest = 0;
        for cy in 0..cells {
            for cx in 0..cells {
                longest = longest.max(from_exit[at(cx * 2 + 1, cy * 2 + 1)]);
            }
        }
        Self {
            w,
            h,
            grid,
            approach: (tx, ty),
            from_exit,
            longest,
        }
    }

    /// Spawns are only ever this far or further from the exit.
    pub fn spawn_floor(&self) -> i32 {
        ((f64::from(self.longest) * SPAWN_BAND).floor() as i32).max(1)
    }

    /// The tile at integer coordinates; outside the grid is wall.
    pub fn tile(&self, x: i32, y: i32) -> u8 {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return WALL;
        }
        self.grid[y as usize * self.w + x as usize]
    }

    /// Walking distances from `(sx, sy)` over EMPTY tiles, giving up past
    /// `limit` steps. -1 means unreachable (or too far).
    pub fn distances(&self, (sx, sy): (i32, i32), limit: i32) -> Vec<i32> {
        if sx < 0 || sy < 0 || sx >= self.w as i32 || sy >= self.h as i32 {
            return vec![-1; self.w * self.h];
        }
        distances(
            &self.grid,
            self.w,
            self.h,
            (sx as usize, sy as usize),
            limit,
        )
    }
}

/// The client's `bfs`. The start counts as reached whatever it is made of,
/// then only EMPTY tiles are entered.
fn distances(grid: &[u8], w: usize, h: usize, (sx, sy): (usize, usize), limit: i32) -> Vec<i32> {
    let mut dist = vec![-1; w * h];
    let mut queue = Vec::with_capacity(w * h);
    let mut head = 0;
    dist[sy * w + sx] = 0;
    queue.push(sy * w + sx);
    while head < queue.len() {
        let cur = queue[head];
        head += 1;
        if dist[cur] >= limit {
            continue;
        }
        let (cx, cy) = ((cur % w) as i32, (cur / w) as i32);
        for (dx, dy) in DIRS {
            let (nx, ny) = (cx + dx, cy + dy);
            if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                continue;
            }
            let ni = ny as usize * w + nx as usize;
            if grid[ni] != EMPTY || dist[ni] != -1 {
                continue;
            }
            dist[ni] = dist[cur] + 1;
            queue.push(ni);
        }
    }
    dist
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FNV-1a over the grid bytes, as computed on the JavaScript side.
    fn fnv(grid: &[u8]) -> u32 {
        grid.iter().fold(0x811c_9dc5, |h, &b| {
            (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
        })
    }

    fn exit_tile(maze: &Maze) -> (usize, usize) {
        let at = maze.grid.iter().position(|&t| t == EXIT).expect("one exit");
        (at % maze.w, at / maze.w)
    }

    /// Seed, cells per side, FNV-1a of the grid, exit tile, approach cell and
    /// longest walk from the approach.
    type Case = (u32, usize, u32, (usize, usize), (usize, usize), i32);

    /// The parity contract with `static/js/maze.js`: values computed there
    /// with `buildMaze(seed, cells)` under Bun. If this fails the ghosts walk
    /// a different maze from the one on screen. The two small ones take the
    /// fully-braided fallback that walls off the furthest cell.
    #[test]
    fn mazes_match_the_client_byte_for_byte() {
        #[rustfmt::skip]
        let cases: [Case; 7] = [
            (0, 25, 0x5096_356d, (46, 43), (45, 43), 88),
            (1, 25, 0x505e_30e1, (15, 50), (15, 49), 90),
            (0xDEAD_BEEF, 25, 0xba80_a889, (1, 40), (1, 41), 94),
            (0xFFFF_FFFF, 25, 0x2c42_e715, (13, 44), (13, 45), 88),
            (123_456_789, 25, 0x2b2b_1af0, (45, 6), (45, 5), 100),
            (1, 3, 0x35be_3825, (1, 6), (1, 5), 8),
            (3, 5, 0x7b51_5e4c, (1, 10), (1, 9), 16),
        ];
        for (seed, cells, sum, exit, approach, longest) in cases {
            let maze = Maze::build_cells(seed, cells);
            assert_eq!(fnv(&maze.grid), sum, "grid of seed {seed:#x}/{cells}");
            assert_eq!(exit_tile(&maze), exit, "exit of seed {seed:#x}/{cells}");
            assert_eq!(
                maze.approach, approach,
                "approach of seed {seed:#x}/{cells}"
            );
            assert_eq!(maze.longest, longest, "longest of seed {seed:#x}/{cells}");
        }
    }

    #[test]
    fn walks_stop_at_the_limit() {
        let maze = Maze::build(7);
        let (ax, ay) = maze.approach;
        let near = maze.distances((ax as i32, ay as i32), 5);
        assert_eq!(near.iter().copied().max(), Some(5));
        assert_eq!(maze.distances((-1, 0), 5).iter().max(), Some(&-1));
    }
}
