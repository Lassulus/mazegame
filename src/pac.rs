//! Ghosts and cherries: the Pac-Man half of the maze.
//!
//! Ghosts are shared, so they live here and not in the clients: a pack that
//! grows with the room walks the corridors tile by tile, chases whoever
//! strays close and scatters from anyone holding a cherry. Everything is
//! stepped with an explicit `dt` and drawn from a PRNG seeded by the maze
//! seed — no clocks inside — so the whole thing can be driven second by
//! second from a test.

use crate::maze::{DIRS, EMPTY, Maze, Mulberry32};

/// Ghosts in an empty or quiet world. Six was too few to ever meet one: a
/// room of thirty players split them between itself and whole stretches of
/// maze went unhaunted. Ten meets a lone runner about three times on the way
/// to the logo.
pub const GHOSTS_BASE: usize = 10;
/// One more ghost for every this many players…
const PLAYERS_PER_GHOST: usize = 3;
/// …up to this many. Every living ghost rides every snapshot at five bytes.
pub const GHOSTS_MAX: usize = 32;
/// Surplus ghosts are only retired past this margin, so players coming and
/// going do not make the pack flicker.
const RETIRE_SLACK: usize = 2;
pub const CHERRIES: usize = 4;

/// How many ghosts a room of `players` gets.
pub fn pack_size(players: usize) -> usize {
    (GHOSTS_BASE + players / PLAYERS_PER_GHOST).min(GHOSTS_MAX)
}

/// Ghosts start and respawn in the middle band of the maze: far enough from
/// the logo that the finish is not a gauntlet, and short of the spawn band so
/// nobody opens their eyes on a ghost.
const GHOST_BAND: (f64, f64) = (0.20, 0.65);
/// Initial ghosts try to stand at least this far from one another, in tiles.
const GHOST_SPACING: f32 = 8.0;
/// A respawning ghost tries to appear at least this far from every player.
const RESPAWN_CLEARANCE: f32 = 10.0;
/// Random picks tried before settling for the best one seen.
const PICK_TRIES: usize = 32;
/// Dead ghosts come back after this many seconds.
const RESPAWN_SECS: f32 = 6.0;
/// A ghost that catches someone stands over them this long, chewing, so
/// everyone nearby sees what happened. Matches the victim's "caught" card.
const FEED_SECS: f32 = 1.4;

/// A player is noticed within this straight-line distance…
const SIGHT: f32 = 9.0;
/// …and only if the walk to them is at most this many tiles, so a ghost does
/// not "see" someone through a wall who is really half the maze away.
const REACH: i32 = 14;
/// Tiles per second. Players walk 1.7 and run 2.8: a chase can be outrun but
/// not out-walked, and a fleeing ghost is easy prey.
const CHASE_SPEED: f32 = 1.9;
const WANDER_SPEED: f32 = 1.5;
const FLEE_SPEED: f32 = 1.2;
/// A ghost this close to a player (centre to centre) has touched them.
const TOUCH: f32 = 0.5;

/// Cherries keep this walk away from the logo, so power is not a reward for
/// finishing.
const CHERRY_EXIT_GAP: i32 = 4;
/// An eaten cherry reappears at least this far from whoever ate it.
const CHERRY_RESPAWN_GAP: f32 = 8.0;
/// Reach for picking a cherry up, from the cherry's tile centre.
const CHERRY_REACH: f32 = 0.5;

/// What the ghosts need to know about one placed player.
#[derive(Clone, Copy)]
pub struct Target {
    pub pid: u32,
    pub x: f32,
    pub y: f32,
    pub powered: bool,
    /// Just caught, just escaped or just respawned: ghosts ignore them.
    pub safe: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Hit {
    /// A powered player ran into ghost `ghost`, which is now dead.
    Ate { pid: u32, ghost: u8 },
    /// A ghost caught an unpowered player, who goes back to their spawn.
    Caught { pid: u32, ghost: u8 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Chase,
    Wander,
    Flee,
}

impl Mode {
    fn speed(self) -> f32 {
        match self {
            Mode::Chase => CHASE_SPEED,
            Mode::Wander => WANDER_SPEED,
            Mode::Flee => FLEE_SPEED,
        }
    }
}

struct Ghost {
    id: u8,
    /// The tile centre it left…
    from: (i32, i32),
    /// …the one it is heading for (equal to `from` when standing still)…
    to: (i32, i32),
    /// …and how far along, 0 to 1.
    progress: f32,
    /// The last step taken, kept after arriving so the next decision knows
    /// which way is back. `None` for a ghost that has just appeared.
    dir: Option<(i32, i32)>,
    mode: Mode,
    /// Seconds until it comes back; `None` while it is alive.
    dead_for: Option<f32>,
    /// Seconds left chewing the last catch, standing still; 0 when free.
    feeding: f32,
}

impl Ghost {
    fn position(&self) -> (f32, f32) {
        let lerp = |a: i32, b: i32| a as f32 + (b - a) as f32 * self.progress + 0.5;
        (lerp(self.from.0, self.to.0), lerp(self.from.1, self.to.1))
    }
}

pub struct Pac {
    maze: Maze,
    rng: Mulberry32,
    ghosts: Vec<Ghost>,
    cherries: Vec<(i32, i32)>,
    /// Cells a ghost may appear on.
    ghost_cells: Vec<(i32, i32)>,
    /// Cells a cherry may appear on.
    cherry_cells: Vec<(i32, i32)>,
    /// Ceiling on the pack whatever the room; tests pin it to watch one ghost.
    pack_cap: usize,
}

impl Pac {
    /// The ghosts and cherries of the maze built from `seed`.
    pub fn new(seed: u32) -> Self {
        Self::with_maze(Maze::build(seed), seed)
    }

    fn with_maze(maze: Maze, seed: u32) -> Self {
        let ghost_cells = ghost_cells(&maze);
        let cherry_cells: Vec<(i32, i32)> = cells(&maze)
            .filter(|&(x, y)| {
                let d = maze.from_exit[y as usize * maze.w + x as usize];
                d >= CHERRY_EXIT_GAP && (x as usize, y as usize) != maze.approach
            })
            .collect();
        let mut pac = Self {
            maze,
            // Not the maze's own stream: that one is spent on the layout.
            rng: Mulberry32::new(seed ^ 0x9AC0_A11E),
            ghosts: Vec::new(),
            cherries: Vec::new(),
            ghost_cells,
            cherry_cells,
            pack_cap: GHOSTS_MAX,
        };
        for _ in 0..GHOSTS_BASE {
            pac.add_ghost(GHOST_SPACING, &[]);
        }
        for _ in 0..CHERRIES {
            let free: Vec<(i32, i32)> = pac
                .cherry_cells
                .iter()
                .copied()
                .filter(|c| !pac.cherries.contains(c))
                .collect();
            if free.is_empty() {
                break;
            }
            let cell = free[pac.rng.below(free.len())];
            pac.cherries.push(cell);
        }
        pac
    }

    /// Living ghosts as `(id, x, y)`.
    pub fn ghosts(&self) -> impl Iterator<Item = (u8, f32, f32)> + '_ {
        self.ghosts
            .iter()
            .filter(|g| g.dead_for.is_none())
            .map(|g| {
                let (x, y) = g.position();
                (g.id, x, y)
            })
    }

    pub fn living(&self) -> usize {
        self.ghosts.iter().filter(|g| g.dead_for.is_none()).count()
    }

    /// Cherry tiles; each cherry sits at the tile's centre.
    pub fn cherries(&self) -> &[(i32, i32)] {
        &self.cherries
    }

    /// `[[tx,ty],…]`, as the wire carries them.
    pub fn cherries_json(&self) -> String {
        let cells: Vec<String> = self
            .cherries
            .iter()
            .map(|(x, y)| format!("[{x},{y}]"))
            .collect();
        format!("[{}]", cells.join(","))
    }

    /// A player stands at `(x, y)`. If that is on a cherry it is eaten and
    /// reappears somewhere at least `CHERRY_RESPAWN_GAP` away, so the eater
    /// cannot simply stand still and farm it.
    pub fn eat_cherry(&mut self, x: f32, y: f32) -> bool {
        let Some(index) = self
            .cherries
            .iter()
            .position(|&(tx, ty)| (tx as f32 + 0.5 - x).hypot(ty as f32 + 0.5 - y) <= CHERRY_REACH)
        else {
            return false;
        };
        let eaten = self.cherries[index];
        let far = |&(cx, cy): &(i32, i32)| (cx as f32 + 0.5 - x).hypot(cy as f32 + 0.5 - y);
        let free: Vec<(i32, i32)> = self
            .cherry_cells
            .iter()
            .copied()
            .filter(|c| *c != eaten && !self.cherries.contains(c))
            .collect();
        let clear: Vec<(i32, i32)> = free
            .iter()
            .copied()
            .filter(|c| far(c) >= CHERRY_RESPAWN_GAP)
            .collect();
        let next = if clear.is_empty() {
            // A maze too small to honour the gap: as far as it goes.
            free.iter()
                .copied()
                .max_by(|a, b| far(a).total_cmp(&far(b)))
        } else {
            Some(clear[self.rng.below(clear.len())])
        };
        match next {
            Some(cell) => self.cherries[index] = cell,
            None => {
                self.cherries.remove(index);
            }
        }
        true
    }

    /// Advance the ghosts by `dt` seconds and report who touched whom.
    pub fn step(&mut self, dt: f32, players: &[Target]) -> Vec<Hit> {
        self.fit_pack(players);
        for index in 0..self.ghosts.len() {
            match self.ghosts[index].dead_for {
                Some(left) if left - dt > 0.0 => self.ghosts[index].dead_for = Some(left - dt),
                Some(_) => self.respawn(index, players),
                // Chewing: stands still over its catch while the chomp plays.
                None if self.ghosts[index].feeding > 0.0 => {
                    self.ghosts[index].feeding = (self.ghosts[index].feeding - dt).max(0.0);
                }
                None => self.walk(index, dt, players),
            }
        }
        self.contacts(players)
    }

    /// Grow or shrink the pack towards `pack_size`, one ghost per step. A new
    /// ghost appears well away from every player; a surplus one is taken from
    /// the dead first, then from whichever wanderer is furthest from anyone,
    /// so nobody watches a ghost blink out of existence.
    fn fit_pack(&mut self, players: &[Target]) {
        let want = pack_size(players.len()).min(self.pack_cap);
        let near: Vec<(f32, f32)> = players.iter().map(|p| (p.x, p.y)).collect();
        if self.ghosts.len() < want {
            self.add_ghost(RESPAWN_CLEARANCE, &near);
        } else if self.ghosts.len() > want + RETIRE_SLACK {
            let alone = |g: &Ghost| {
                let (x, y) = g.position();
                near.iter()
                    .map(|&(px, py)| (px - x).hypot(py - y))
                    .fold(f32::INFINITY, f32::min)
            };
            let retire = self
                .ghosts
                .iter()
                .position(|g| g.dead_for.is_some())
                .or_else(|| {
                    self.ghosts
                        .iter()
                        .enumerate()
                        .filter(|(_, g)| g.mode == Mode::Wander)
                        .max_by(|(_, a), (_, b)| alone(a).total_cmp(&alone(b)))
                        .map(|(i, _)| i)
                });
            if let Some(index) = retire {
                self.ghosts.swap_remove(index);
            }
        }
    }

    /// A fresh ghost on the lowest free id, at least `clearance` from `avoid`
    /// and from the ghosts already out.
    fn add_ghost(&mut self, clearance: f32, avoid: &[(f32, f32)]) {
        let Some(id) = (0..=u8::MAX).find(|id| self.ghosts.iter().all(|g| g.id != *id)) else {
            return;
        };
        let mut avoid = avoid.to_vec();
        avoid.extend(self.ghosts.iter().map(Ghost::position));
        let cell = self.pick_far(&avoid, clearance);
        self.ghosts.push(Ghost {
            id,
            from: cell,
            to: cell,
            progress: 0.0,
            dir: None,
            mode: Mode::Wander,
            dead_for: None,
            feeding: 0.0,
        });
    }

    fn respawn(&mut self, index: usize, players: &[Target]) {
        let near: Vec<(f32, f32)> = players.iter().map(|p| (p.x, p.y)).collect();
        let cell = self.pick_far(&near, RESPAWN_CLEARANCE);
        let ghost = &mut self.ghosts[index];
        ghost.from = cell;
        ghost.to = cell;
        ghost.progress = 0.0;
        ghost.dir = None;
        ghost.mode = Mode::Wander;
        ghost.dead_for = None;
        ghost.feeding = 0.0;
    }

    /// Tile to tile. Time left over after reaching a centre is spent on the
    /// next corridor, at whatever speed the new decision calls for.
    fn walk(&mut self, index: usize, dt: f32, players: &[Target]) {
        let mut time = dt;
        loop {
            let ghost = &mut self.ghosts[index];
            if ghost.to != ghost.from {
                let speed = ghost.mode.speed();
                let need = (1.0 - ghost.progress) / speed;
                if time < need {
                    ghost.progress += time * speed;
                    return;
                }
                time -= need;
                ghost.from = ghost.to;
                ghost.progress = 0.0;
            }
            let (at, came) = (ghost.from, ghost.dir);
            let (mode, next) = self.decide(at, came, players);
            let ghost = &mut self.ghosts[index];
            ghost.mode = mode;
            let Some((dx, dy)) = next else {
                return; // walled in: nothing to do
            };
            ghost.to = (at.0 + dx, at.1 + dy);
            ghost.dir = Some((dx, dy));
        }
    }

    /// At a tile centre: which way next. Never back the way it came unless
    /// the corridor ends, as in Pac-Man — it is what makes a ghost read as
    /// going somewhere instead of jittering.
    fn decide(
        &mut self,
        (x, y): (i32, i32),
        came: Option<(i32, i32)>,
        players: &[Target],
    ) -> (Mode, Option<(i32, i32)>) {
        let open: Vec<(i32, i32)> = DIRS
            .into_iter()
            .filter(|&(dx, dy)| self.maze.tile(x + dx, y + dy) == EMPTY)
            .collect();
        let onward: Vec<(i32, i32)> = open
            .iter()
            .copied()
            .filter(|&(dx, dy)| came != Some((-dx, -dy)))
            .collect();
        let options = if onward.is_empty() { open } else { onward };
        if options.is_empty() {
            return (Mode::Wander, None);
        }
        let Some((target, field)) = self.quarry((x, y), players) else {
            return (Mode::Wander, Some(options[self.rng.below(options.len())]));
        };
        let mode = if target.powered {
            Mode::Flee
        } else {
            Mode::Chase
        };
        let score = |&(dx, dy): &(i32, i32)| {
            let d = field[((y + dy) as usize) * self.maze.w + (x + dx) as usize];
            let d = if d < 0 { i32::MAX / 2 } else { d };
            if mode == Mode::Flee { -d } else { d }
        };
        let best = options.iter().map(score).min().unwrap_or(0);
        let tied: Vec<(i32, i32)> = options.into_iter().filter(|o| score(o) == best).collect();
        (mode, Some(tied[self.rng.below(tied.len())]))
    }

    /// The player this ghost is interested in, with walking distances from
    /// them: the nearest by path among those in sight and in reach.
    fn quarry(&self, (x, y): (i32, i32), players: &[Target]) -> Option<(Target, Vec<i32>)> {
        let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
        let mut seen = players
            .iter()
            .filter(|p| !p.safe && (p.x - cx).hypot(p.y - cy) <= SIGHT)
            .peekable();
        seen.peek()?;
        let from_ghost = self.maze.distances((x, y), REACH);
        let target = seen
            .filter_map(|p| {
                let d = self.distance_at(&from_ghost, p.x, p.y)?;
                (d <= REACH).then_some((d, *p))
            })
            .min_by_key(|(d, _)| *d)?
            .1;
        let field = self
            .maze
            .distances((target.x.floor() as i32, target.y.floor() as i32), i32::MAX);
        Some((target, field))
    }

    fn distance_at(&self, field: &[i32], x: f32, y: f32) -> Option<i32> {
        let (tx, ty) = (x.floor() as i32, y.floor() as i32);
        if tx < 0 || ty < 0 || tx >= self.maze.w as i32 || ty >= self.maze.h as i32 {
            return None;
        }
        let d = field[ty as usize * self.maze.w + tx as usize];
        (d >= 0).then_some(d)
    }

    /// Touches this step. A player takes at most one hit per step, and ghosts
    /// ignore anyone marked safe. A ghost still chewing its last catch bites
    /// no one else, but can itself be eaten.
    fn contacts(&mut self, players: &[Target]) -> Vec<Hit> {
        let mut hits = Vec::new();
        for player in players.iter().filter(|p| !p.safe) {
            let touched = self.ghosts.iter_mut().find(|g| {
                let (gx, gy) = g.position();
                g.dead_for.is_none()
                    && (player.powered || g.feeding <= 0.0)
                    && (gx - player.x).hypot(gy - player.y) <= TOUCH
            });
            let Some(ghost) = touched else { continue };
            if player.powered {
                ghost.dead_for = Some(RESPAWN_SECS);
                ghost.feeding = 0.0;
                hits.push(Hit::Ate {
                    pid: player.pid,
                    ghost: ghost.id,
                });
            } else {
                ghost.feeding = FEED_SECS;
                hits.push(Hit::Caught {
                    pid: player.pid,
                    ghost: ghost.id,
                });
            }
        }
        hits
    }

    /// A ghost cell at least `clearance` from everything in `avoid`, or the
    /// roomiest of `PICK_TRIES` random picks if none is.
    fn pick_far(&mut self, avoid: &[(f32, f32)], clearance: f32) -> (i32, i32) {
        let room = |&(x, y): &(i32, i32)| {
            avoid
                .iter()
                .map(|&(ax, ay)| (x as f32 + 0.5 - ax).hypot(y as f32 + 0.5 - ay))
                .fold(f32::INFINITY, f32::min)
        };
        let mut best: Option<((i32, i32), f32)> = None;
        for _ in 0..PICK_TRIES {
            let cell = self.ghost_cells[self.rng.below(self.ghost_cells.len())];
            let space = room(&cell);
            if space >= clearance {
                return cell;
            }
            if best.is_none_or(|(_, s)| space > s) {
                best = Some((cell, space));
            }
        }
        best.map(|(cell, _)| cell).unwrap_or(self.ghost_cells[0])
    }
}

/// Every cell (odd tile coordinates) that is floor.
fn cells(maze: &Maze) -> impl Iterator<Item = (i32, i32)> + '_ {
    (1..maze.h as i32)
        .step_by(2)
        .flat_map(move |y| (1..maze.w as i32).step_by(2).map(move |x| (x, y)))
        .filter(|&(x, y)| maze.tile(x, y) == EMPTY)
}

/// The middle band, capped below the spawn band. Never empty: a degenerate
/// maze falls back to every cell.
fn ghost_cells(maze: &Maze) -> Vec<(i32, i32)> {
    let longest = f64::from(maze.longest);
    let low = (longest * GHOST_BAND.0).ceil() as i32;
    let high = ((longest * GHOST_BAND.1).floor() as i32).min(maze.spawn_floor() - 1);
    let band: Vec<(i32, i32)> = cells(maze)
        .filter(|&(x, y)| {
            let d = maze.from_exit[y as usize * maze.w + x as usize];
            d >= low.max(1) && d <= high
        })
        .collect();
    if band.is_empty() {
        cells(maze).collect()
    } else {
        band
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 0.05;

    fn player(pid: u32, (x, y): (f32, f32), powered: bool) -> Target {
        Target {
            pid,
            x,
            y,
            powered,
            safe: false,
        }
    }

    fn open_around(maze: &Maze, (x, y): (i32, i32)) -> usize {
        DIRS.iter()
            .filter(|(dx, dy)| maze.tile(x + dx, y + dy) == EMPTY)
            .count()
    }

    /// Pac with only ghost 0 left, so nothing else wanders into the scene.
    fn lone_ghost(seed: u32) -> Pac {
        let mut pac = Pac::new(seed);
        pac.ghosts.truncate(1);
        pac.pack_cap = 1;
        pac
    }

    /// Ghosts walk corridors only, and turn back only where a corridor ends —
    /// whether wandering, chasing or fleeing.
    #[test]
    fn ghosts_keep_to_corridors_and_only_turn_back_at_dead_ends() {
        for seed in [0, 1, 0xFFFF_FFFF] {
            let mut pac = Pac::new(seed);
            let floor = pac.maze.spawn_floor();
            for g in &pac.ghosts {
                let d = pac.maze.from_exit[g.from.1 as usize * pac.maze.w + g.from.0 as usize];
                assert!(
                    d > 0 && d < floor,
                    "ghost {} starts {d} from the exit",
                    g.id
                );
            }
            // Someone in the ghosts' midst to chase or run from, powered half
            // the time.
            let lure = pac.ghosts[0].position();
            let mut last: Vec<Option<(i32, i32)>> = vec![None; pac.ghosts.len()];
            let mut modes = Vec::new();
            for tick in 0..6000 {
                let players = [player(1, lure, tick % 2000 < 1000)];
                pac.step(DT, &players);
                for (i, g) in pac.ghosts.iter().enumerate() {
                    if !modes.contains(&g.mode) {
                        modes.push(g.mode);
                    }
                    assert_eq!(pac.maze.tile(g.from.0, g.from.1), EMPTY);
                    assert_eq!(pac.maze.tile(g.to.0, g.to.1), EMPTY);
                    let (x, y) = g.position();
                    assert_eq!(pac.maze.tile(x.floor() as i32, y.floor() as i32), EMPTY);
                    if let (Some((px, py)), Some(d)) = (last[i], g.dir) {
                        if d == (-px, -py) {
                            assert_eq!(open_around(&pac.maze, g.from), 1, "ghost {i} reversed");
                        }
                    }
                    last[i] = if g.dead_for.is_some() { None } else { g.dir };
                }
            }
            assert_eq!(modes.len(), 3, "only saw {modes:?}");
        }
    }

    /// A ghost that sees a player walks straight down the shortest path: the
    /// distance never grows, and it arrives about as fast as it can walk.
    #[test]
    fn a_chasing_ghost_closes_in_on_a_player_standing_still() {
        let mut pac = lone_ghost(3);
        let start = pac.ghosts[0].from;
        let around = pac.maze.distances(start, REACH);
        let spot = (0..pac.maze.h as i32)
            .flat_map(|y| (0..pac.maze.w as i32).map(move |x| (x, y)))
            .find(|&(x, y)| {
                let d = around[y as usize * pac.maze.w + x as usize];
                let straight = ((x - start.0) as f32).hypot((y - start.1) as f32);
                (8..=REACH).contains(&d) && straight <= SIGHT - 0.5
            })
            .expect("somewhere in reach to stand");
        let target = player(1, (spot.0 as f32 + 0.5, spot.1 as f32 + 0.5), false);
        let field = pac.maze.distances(spot, i32::MAX);
        let w = pac.maze.w;
        let walk = |g: &Ghost| field[g.to.1 as usize * w + g.to.0 as usize];
        let initial = field[start.1 as usize * pac.maze.w + start.0 as usize];
        let mut previous = initial;
        let budget = (initial as f32 + 1.0) / CHASE_SPEED;
        let mut elapsed = 0.0;
        loop {
            let hits = pac.step(DT, &[target]);
            elapsed += DT;
            if matches!(hits[..], [Hit::Caught { pid: 1, .. }]) {
                break;
            }
            let now = walk(&pac.ghosts[0]);
            assert!(now <= previous, "walked away: {previous} -> {now}");
            assert_eq!(pac.ghosts[0].mode, Mode::Chase);
            previous = now;
            assert!(
                elapsed < budget,
                "{initial} tiles took more than {budget} s"
            );
        }
    }

    /// A powered player eats a ghost on touch; it is gone for six seconds and
    /// comes back well away from them.
    #[test]
    fn powered_contact_eats_the_ghost_until_it_respawns() {
        let mut pac = lone_ghost(5);
        let eater = player(7, pac.ghosts[0].position(), true);
        assert_eq!(pac.step(0.01, &[eater]), [Hit::Ate { pid: 7, ghost: 0 }]);
        assert_eq!(pac.living(), 0);
        for _ in 0..11 {
            assert!(pac.step(0.5, &[eater]).is_empty());
            assert_eq!(pac.ghosts().count(), 0, "back before 6 s");
        }
        pac.step(0.5, &[eater]);
        let (_, x, y) = pac.ghosts().next().expect("back after 6 s");
        assert!((x - eater.x).hypot(y - eater.y) >= RESPAWN_CLEARANCE);
    }

    /// Without power a touch is a catch, once per player per step, and a
    /// player marked safe is not caught at all.
    #[test]
    fn unpowered_contact_is_a_catch() {
        let mut pac = Pac::new(9);
        let spot = pac.ghosts[0].position();
        // Two ghosts on the same player still make one catch.
        let second = pac.ghosts[0].from;
        pac.ghosts[1].from = second;
        pac.ghosts[1].to = second;
        pac.ghosts[1].progress = 0.0;
        let mut victim = player(3, spot, false);
        victim.safe = true;
        assert!(pac.step(0.0, &[victim]).is_empty());
        victim.safe = false;
        assert_eq!(pac.step(0.0, &[victim]), [Hit::Caught { pid: 3, ghost: 0 }]);
        assert_eq!(pac.living(), GHOSTS_BASE);
    }

    /// A ghost that catches someone stands over them chewing for
    /// `FEED_SECS`, bites nobody else meanwhile but can itself be eaten, and
    /// then goes back to hunting.
    #[test]
    fn a_catch_holds_the_ghost_in_place_while_it_chews() {
        let mut pac = lone_ghost(9);
        let spot = pac.ghosts[0].position();
        let victim = player(3, spot, false);
        assert_eq!(pac.step(0.0, &[victim]), [Hit::Caught { pid: 3, ghost: 0 }]);
        let bystander = player(4, spot, false);
        for _ in 0..(FEED_SECS / DT) as usize - 2 {
            assert!(pac.step(DT, &[bystander]).is_empty(), "bit while chewing");
            assert_eq!(pac.ghosts[0].position(), spot, "moved while chewing");
        }
        let caught =
            (0..4).any(|_| pac.step(DT, &[bystander]) == [Hit::Caught { pid: 4, ghost: 0 }]);
        assert!(caught, "never bit again after chewing");

        let eater = player(5, pac.ghosts[0].position(), true);
        assert!(pac.ghosts[0].feeding > 0.0);
        assert_eq!(pac.step(0.0, &[eater]), [Hit::Ate { pid: 5, ghost: 0 }]);
    }

    /// The pack grows with the room, one ghost a step, up to the cap; new
    /// ghosts keep their distance and take distinct ids. When the room
    /// empties it only shrinks once the surplus passes the slack.
    #[test]
    fn the_pack_follows_the_room() {
        let mut pac = Pac::new(5);
        assert_eq!(pac.ghosts.len(), GHOSTS_BASE);
        let crowd: Vec<Target> = (0..30)
            .map(|i| player(i, (1.5 + (i % 5) as f32 * 2.0, 1.5), false))
            .map(|p| Target { safe: true, ..p })
            .collect();
        assert_eq!(pack_size(30), GHOSTS_BASE + 10);
        pac.step(DT, &crowd);
        assert_eq!(pac.ghosts.len(), GHOSTS_BASE + 1, "one ghost a step");
        for _ in 0..40 {
            pac.step(DT, &crowd);
        }
        assert_eq!(pac.ghosts.len(), pack_size(30));
        let mut ids: Vec<u8> = pac.ghosts.iter().map(|g| g.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), pack_size(30));
        assert_eq!(pack_size(10_000), GHOSTS_MAX);

        // Down to 24 players: 18 wanted, 20 out, inside the slack.
        pac.step(DT, &crowd[..24]);
        assert_eq!(pac.ghosts.len(), pack_size(30));
        // Everyone gone: back to the base pack.
        for _ in 0..40 {
            pac.step(DT, &[]);
        }
        assert_eq!(pac.ghosts.len(), GHOSTS_BASE + RETIRE_SLACK);
    }

    /// A cherry is eaten from its tile and reappears at least eight tiles
    /// from the eater, never on another cherry or in front of the logo.
    #[test]
    fn an_eaten_cherry_respawns_far_from_the_eater() {
        let mut pac = Pac::new(11);
        assert_eq!(pac.cherries().len(), CHERRIES);
        assert!(!pac.eat_cherry(-5.0, -5.0));
        for round in 0..40 {
            let (tx, ty) = pac.cherries()[round % CHERRIES];
            let (x, y) = (tx as f32 + 0.3, ty as f32 + 0.6);
            assert!(pac.eat_cherry(x, y));
            let cherries = pac.cherries().to_vec();
            assert_eq!(cherries.len(), CHERRIES);
            let fresh = cherries[round % CHERRIES];
            assert!(
                (fresh.0 as f32 + 0.5 - x).hypot(fresh.1 as f32 + 0.5 - y) >= CHERRY_RESPAWN_GAP
            );
            let (ax, ay) = pac.maze.approach;
            assert_ne!(fresh, (ax as i32, ay as i32));
            assert_eq!(pac.maze.tile(fresh.0, fresh.1), EMPTY);
            let mut unique = cherries.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(unique.len(), CHERRIES, "{cherries:?}");
        }
    }
}
