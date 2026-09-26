//! Shared game state: one maze for everyone, plus the spectator camera.
//!
//! Every player walks the same seeded maze and sees the others as they move.
//! The first player to touch the NixOS logo starts a countdown; when it
//! expires the whole world rolls over to a fresh maze. Only the seed and
//! positions cross the wire — clients rebuild the geometry themselves.
//!
//! The Pac-Man layer: a pack of ghosts that grows with the room (ten, plus
//! one per three players, at most 32) and four cherries are simulated here
//! (see `pac`), on a copy of the maze rebuilt from the same seed. Ghost
//! positions ride at the end of every snapshot. The text messages around
//! them:
//!
//! - `welcome`, `watch` and `world` carry `"cherries":[[tx,ty],…]`, tiles
//!   whose centre holds a cherry. `world` (a new round) also carries the
//!   last round's board, `"results":[…]` (first `RESULTS_TOP` escapes) and
//!   `"escaped":n`, and `"pause"`: seconds of `INTERMISSION` everyone waits
//!   on their spawn while it is shown.
//! - `{"t":"cherries","l":[…]}` to everyone when one is eaten (it reappears
//!   elsewhere at once), and `{"t":"power","ms":…}` to the eater.
//! - `{"t":"ate","ghost":id}` to a powered player who ran into a ghost.
//! - `{"t":"caught"}` to an unpowered one; the client sends itself back to
//!   its spawn, and the ghosts leave it alone for `SAFE_TIME`.
//! - `{"t":"bite"|"pop","ghost":id,"pid":p,"x":…,"y":…}` to everyone within
//!   `SIGHT` of a catch or a ghost being eaten, and to cameras riding someone
//!   that close, so they can play it where it happened. The catching ghost
//!   stands still chewing while the victim's card is up.
//!
//! The watcher rule: a watcher follows one player; when that player has not
//! moved for `IDLE_SWITCH`, the watcher is handed to the next player in join
//! order, preferring one that is currently moving.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::conn::Conn;
use crate::json;
use crate::pac::{Hit, Pac, Target};
use crate::sync::lock;
use crate::ws::{binary_frame, text_frame};

pub const IDLE_SWITCH: Duration = Duration::from_millis(2000);
pub const ROUND_GRACE: Duration = Duration::from_secs(120);
/// Two escapes by one player must be at least this far apart. The client's
/// escape card holds it still for 2.6 s, so this only stops a hostile client
/// parked in the logo from farming the event feed.
const ESCAPE_COOLDOWN: Duration = Duration::from_secs(2);
const MOVE_EPS: f32 = 0.015;
const TURN_EPS: f32 = 0.015;

/// How long a cherry powers its eater up.
const POWER_TIME: Duration = Duration::from_secs(8);
/// Ghosts ignore a player for this long after a catch, an escape or a new
/// round: the position on file is stale until the client's next report from
/// its fresh spot, and it must not be caught again for where it used to be.
const SAFE_TIME: Duration = Duration::from_secs(3);
/// Longest step the ghosts take in one go. A stalled tick must not let them
/// leap through a corridor, or through the player they were about to touch.
const MAX_STEP: Duration = Duration::from_millis(200);
/// Between rounds: the leaderboard is up and everyone stands on their new
/// spawn, so nobody gets a head start while the others are reading it.
const INTERMISSION: Duration = Duration::from_secs(7);
/// Escapes named on that leaderboard; the rest are a count.
const RESULTS_TOP: usize = 10;

/// Tiles per interest bucket edge while the room is small.
const BUCKET: f32 = 8.0;
/// Tighter buckets once frames are shared, so the list stays local.
const CROWD_BUCKET: f32 = 4.0;
/// Most bodies sent to one client. A body is 12 bytes, so this is cheap.
const PEER_LIMIT: usize = 96;
/// How far the interest search will reach for company, in tiles.
const SIGHT: f32 = 20.0;
/// Bodies close enough to be worth a slot on every single tick.
const PEER_NEAR: usize = 48;
/// The rest are refreshed on one tick in `FAR_EVERY`, staggered.
const FAR_EVERY: usize = 3;
/// Above this many players, one frame per bucket instead of one per player.
const PEER_EXACT_MAX: usize = 120;
/// Seconds between position snapshots in a quiet room.
const PEER_INTERVAL: Duration = Duration::from_millis(50);
/// Above this many players, half the snapshot rate.
const PEER_BUSY: usize = 150;
/// And above this, a third of it: the tick has a thousand sockets to write.
const PEER_CROWD: usize = 500;
/// Names remembered per viewer before the slate is wiped.
const KNOWN_CAP: usize = 1024;

/// Snapshot wire format: a body is twelve bytes rather than forty-odd
/// characters of JSON with the name repeated every tick. Names travel once
/// per viewer in a `names` message instead.
///
/// Layout, little-endian: head `u8 kind, u8 hz, u16 players, u32 clock`;
/// `u16 count` bodies of `u32 id, u16 x, u16 y, u16 angle, u8 flags, u8 age`;
/// then `u8 count` ghosts of `u8 id, u16 x, u16 y`, true at `clock`.
const PEERS_FRAME: u8 = 1;
const POS_SCALE: f32 = 1000.0;
const ANGLE_SCALE: f32 = 65536.0 / std::f32::consts::TAU;
/// Milliseconds per unit of the age byte, so 0-510 ms fits.
const AGE_STEP: u64 = 2;
/// Bits of a body's flags byte.
const FLAG_FINISHED: u8 = 1;
/// Walking on the ceiling.
const FLAG_FLIPPED: u8 = 2;
/// Holding cherry power: the ghosts run from this one.
const FLAG_POWERED: u8 = 4;

const ADJECTIVES: [&str; 14] = [
    "lost",
    "pure",
    "lazy",
    "eager",
    "hermetic",
    "sandboxed",
    "rolling",
    "derived",
    "pinned",
    "stale",
    "impure",
    "atomic",
    "nomadic",
    "curious",
];
const NOUNS: [&str; 12] = [
    "wanderer",
    "derivation",
    "snowflake",
    "closure",
    "hydra",
    "gnome",
    "rebuilder",
    "flake",
    "hopper",
    "linker",
    "spelunker",
    "daemon",
];

/// xorshift64*, seeded from the clock. Names and seeds are the only random
/// things here and neither wants a dependency.
fn entropy() -> u64 {
    static STATE: AtomicU64 = AtomicU64::new(0);
    let mut state = STATE.load(Ordering::Relaxed);
    if state == 0 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x2545_F491_4F6C_DD1D);
        state = nanos ^ 0x9E37_79B9_7F4A_7C15;
    }
    state ^= state >> 12;
    state ^= state << 25;
    state ^= state >> 27;
    STATE.store(state, Ordering::Relaxed);
    state.wrapping_mul(0x2545_F491_4F6C_DD1D)
}

fn new_seed() -> u32 {
    entropy() as u32
}

fn generated_name() -> String {
    let a = ADJECTIVES[(entropy() % ADJECTIVES.len() as u64) as usize];
    let n = NOUNS[(entropy() % NOUNS.len() as u64) as usize];
    format!("{a}-{n}")
}

/// Player-chosen name, or a generated one when nothing usable is given.
pub fn clean_name(raw: Option<&str>) -> String {
    let text: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control() && *c != '\u{2028}' && *c != '\u{2029}')
        .take(24)
        .collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        generated_name()
    } else {
        trimmed.to_string()
    }
}

/// Maps a client's clock onto ours.
///
/// The offset is the smallest (arrival − sent) seen: the packet that got
/// through fastest is the best estimate of the fixed part of the delay, and
/// everything above it is queueing — exactly the part that must not leak into
/// a position's timestamp. It creeps upward slowly so one freak packet cannot
/// pin it, and resets if the client's clock jumps.
#[derive(Default)]
struct SenderClock {
    offset: Option<f64>,
    last: f64,
}

/// Allowed drift between the two clocks, ms per ms: 50 ppm, well above what
/// real oscillators do.
const CLOCK_DRIFT: f64 = 0.000_05;
/// A position is never placed further back than this, whatever the clocks say.
const MAX_LAG_MS: f64 = 500.0;

impl SenderClock {
    /// How long ago, in our ms, a position sent at `sent` (their ms) was true.
    fn lag(&mut self, sent: f64, here: f64) -> f64 {
        if !sent.is_finite() {
            return 0.0;
        }
        let seen = here - sent;
        match self.offset {
            Some(offset) if seen >= offset && seen - offset < 2000.0 => {
                self.offset = Some(offset + (here - self.last).max(0.0) * CLOCK_DRIFT);
            }
            // First packet, a faster one, or the client's clock jumped.
            _ => self.offset = Some(seen),
        }
        self.last = here;
        let offset = self.offset.unwrap_or(seen);
        (seen - offset).clamp(0.0, MAX_LAG_MS)
    }
}

pub struct Player {
    pub pid: u32,
    pub name: String,
    pub conn: Arc<Conn>,
    x: f32,
    y: f32,
    a: f32,
    placed: bool,
    last_move: Instant,
    /// When this position was true. Snapshots go out on a fixed cadence but a
    /// body's last report can land anywhere inside the interval, and that
    /// wobble is what makes other players' walking look uneven: the client
    /// needs the age to place the sample on its own timeline.
    moved_at: Instant,
    clock: SenderClock,
    finished_at: Option<Instant>,
    place: Option<usize>,
    escapes: u32,
    last_escape: Option<Instant>,
    /// Walking on the ceiling. Purely the client's business; relayed so the
    /// others draw the pawn upside down.
    flipped: bool,
    /// Cherry power runs out at this moment.
    powered_until: Option<Instant>,
    /// Ghosts leave this player alone until this moment.
    safe_until: Option<Instant>,
    /// Names this viewer has already been told about, so a snapshot can be
    /// pure numbers.
    known: Vec<u32>,
}

impl Player {
    fn idle_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_move)
    }

    fn powered(&self, now: Instant) -> bool {
        self.powered_until.is_some_and(|until| now < until)
    }

    fn safe(&self, now: Instant) -> bool {
        self.safe_until.is_some_and(|until| now < until)
    }
}

pub struct Watcher {
    pub wid: u32,
    pub conn: Arc<Conn>,
    target: Option<u32>,
    since: Instant,
    known: Vec<u32>,
}

#[derive(Clone)]
struct Finisher {
    pid: u32,
    name: String,
    place: usize,
    /// Seconds into the round of the first escape.
    secs: f32,
    /// Trips through the logo this round, the first included.
    runs: u32,
}

impl Finisher {
    fn json(&self) -> String {
        format!(
            "{{\"name\":{},\"place\":{},\"secs\":{:.1},\"runs\":{}}}",
            json::quote(&self.name),
            self.place,
            self.secs,
            self.runs
        )
    }
}

/// The leaderboard the `world` message carries when a round ends: the first
/// `RESULTS_TOP` escapes in order, and how many escaped in all.
fn results_members(finishers: &[Finisher]) -> String {
    let top: Vec<String> = finishers
        .iter()
        .take(RESULTS_TOP)
        .map(Finisher::json)
        .collect();
    format!(
        "\"results\":[{}],\"escaped\":{}",
        top.join(","),
        finishers.len()
    )
}

#[derive(Clone, Copy, Default)]
pub struct Perf {
    pub build_ms: f32,
    pub send_ms: f32,
    pub frames: usize,
    pub slow: u64,
}

struct State {
    players: Vec<Player>, // join order, which is what the watcher rotates through
    watchers: Vec<Watcher>,
    seed: u32,
    round_started: Instant,
    deadline: Option<Instant>,
    finishers: Vec<Finisher>,
    peers_due: Instant,
    snapshot_seq: usize,
    perf: Perf,
    /// Ghosts and cherries of the current maze.
    pac: Pac,
    /// When the ghosts were last stepped.
    last_step: Instant,
}

pub struct Hub {
    state: Mutex<State>,
    ids: AtomicU32,
    grace: Duration,
    idle_switch: Duration,
    started: Instant,
}

/// A framed snapshot and the ids in it, so the names diff never has to
/// unpack the bytes again.
type Framed = (Arc<Vec<u8>>, Vec<u32>);

/// What a snapshot needs to know about one body, flattened out of `Player` so
/// the hot loops index a tuple instead of chasing fields, and so a player
/// moving mid-tick cannot tear a frame.
#[derive(Clone)]
struct Body {
    x: f32,
    y: f32,
    pid: u32,
    a: f32,
    finished: bool,
    flipped: bool,
    powered: bool,
    age: u8,
}

impl Hub {
    pub fn new(grace: Duration) -> Self {
        let now = Instant::now();
        let seed = new_seed();
        Self {
            state: Mutex::new(State {
                players: Vec::new(),
                watchers: Vec::new(),
                seed,
                round_started: now,
                deadline: None,
                finishers: Vec::new(),
                peers_due: now,
                snapshot_seq: 0,
                perf: Perf::default(),
                pac: Pac::new(seed),
                last_step: now,
            }),
            ids: AtomicU32::new(1),
            grace,
            idle_switch: IDLE_SWITCH,
            started: now,
        }
    }

    fn next_id(&self) -> u32 {
        self.ids.fetch_add(1, Ordering::Relaxed)
    }

    // -- the world ---------------------------------------------------------

    /// Everything a joining client needs to draw the current round, as JSON
    /// object members (no braces) so callers can splice them into a message.
    fn world_members(state: &State, now: Instant) -> String {
        let ends_in = match state.deadline {
            Some(deadline) => format!(
                "{:.2}",
                deadline.saturating_duration_since(now).as_secs_f32()
            ),
            None => "null".to_string(),
        };
        let finishers = state
            .finishers
            .iter()
            .map(Finisher::json)
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "\"seed\":{},\"ends_in\":{},\"finishers\":[{}],\"cherries\":{}",
            state.seed,
            ends_in,
            finishers,
            state.pac.cherries_json()
        )
    }

    // -- players -----------------------------------------------------------

    pub fn add_player(&self, conn: Arc<Conn>, name: Option<&str>) -> u32 {
        let now = Instant::now();
        let pid = self.next_id();
        let player = Player {
            pid,
            name: clean_name(name),
            conn: Arc::clone(&conn),
            x: 0.0,
            y: 0.0,
            a: 0.0,
            placed: false,
            last_move: now,
            moved_at: now,
            clock: SenderClock::default(),
            finished_at: None,
            place: None,
            escapes: 0,
            last_escape: None,
            flipped: false,
            powered_until: None,
            safe_until: None,
            known: Vec::new(),
        };
        // Queued while the lock is still held: the moment the player is in
        // the roster the tick can snapshot them, and a snapshot must not
        // reach the client ahead of the welcome that tells it who it is.
        // Lock order is always hub state, then a connection's own queue.
        let mut state = lock(&self.state);
        state.players.push(player);
        let count = state.players.len();
        let welcome = format!(
            "{{\"t\":\"welcome\",\"id\":{},\"name\":{},\"players\":{},{}}}",
            pid,
            json::quote(&state.players[count - 1].name),
            count,
            Self::world_members(&state, now)
        );
        conn.send_urgent(Arc::new(text_frame(&welcome)));
        pid
    }

    pub fn drop_player(&self, pid: u32) {
        let orphaned: Vec<u32> = {
            let mut state = lock(&self.state);
            state.players.retain(|p| p.pid != pid);
            state
                .watchers
                .iter_mut()
                .filter(|w| w.target == Some(pid))
                .map(|w| {
                    w.target = None;
                    w.wid
                })
                .collect()
        };
        for wid in orphaned {
            self.retarget(wid, "gone", false);
        }
    }

    /// Record a position. Returns true if it counts as movement.
    ///
    /// `sent` is the client's own clock (ms) when it sampled the position.
    /// Arrival time is the wrong timestamp: over a real uplink positions come
    /// in late and in bunches, and stamping them on arrival handed the
    /// spectator camera that jitter — measured on production with bots
    /// across the internet, the camera's speed varied by 120 % and stalled
    /// for up to 133 ms. The client clock is mapped onto ours through the
    /// least-delayed packet seen, so a late packet keeps the time it was true.
    ///
    /// Cherries are picked up here rather than on the tick: first come, first
    /// served is decided by whose report arrives first, not by who happened
    /// to be earlier in the roster.
    pub fn move_player(
        &self,
        pid: u32,
        x: f32,
        y: f32,
        a: f32,
        flipped: bool,
        sent: Option<f64>,
    ) -> bool {
        let now = Instant::now();
        let here = now.saturating_duration_since(self.started).as_secs_f64() * 1000.0;
        let (moved, ate) = {
            let mut state = lock(&self.state);
            let Some(player) = state.players.iter_mut().find(|p| p.pid == pid) else {
                return false;
            };
            let moved = !player.placed
                || (x - player.x).abs() > MOVE_EPS
                || (y - player.y).abs() > MOVE_EPS
                || wrap_angle(a - player.a).abs() > TURN_EPS;
            player.x = x;
            player.y = y;
            player.a = a;
            player.flipped = flipped;
            player.placed = true;
            player.moved_at = match sent {
                Some(sent) => {
                    let lag = player.clock.lag(sent, here);
                    now.checked_sub(Duration::from_secs_f64(lag / 1000.0))
                        .unwrap_or(now)
                }
                None => now,
            };
            if moved {
                player.last_move = now;
            }
            let ate = if state.pac.eat_cherry(x, y) {
                let player = state
                    .players
                    .iter_mut()
                    .find(|p| p.pid == pid)
                    .expect("found above, under the same lock");
                player.powered_until = Some(now + POWER_TIME);
                let eater = Arc::clone(&player.conn);
                let everyone: Vec<Arc<Conn>> = Self::audience(&state);
                let cherries =
                    format!("{{\"t\":\"cherries\",\"l\":{}}}", state.pac.cherries_json());
                Some((eater, everyone, cherries))
            } else {
                None
            };
            (moved, ate)
        };
        if let Some((eater, everyone, cherries)) = ate {
            let power = format!("{{\"t\":\"power\",\"ms\":{}}}", POWER_TIME.as_millis());
            eater.send_urgent(Arc::new(text_frame(&power)));
            let frame = Arc::new(text_frame(&cherries));
            for conn in everyone {
                conn.send_urgent(Arc::clone(&frame));
            }
        }
        moved
    }

    /// A player touched the logo. The first one starts the countdown.
    ///
    /// Later trips count too: after the escape card the client drops you back
    /// into the maze, so the logo is worth walking to again. Only the first
    /// escape takes a place, and only the first escape of the round arms the
    /// countdown.
    pub fn record_finish(&self, pid: u32) {
        let now = Instant::now();
        let frame = {
            let mut state = lock(&self.state);
            let round_started = state.round_started;
            let places = state.finishers.len();
            let Some(player) = state.players.iter_mut().find(|p| p.pid == pid) else {
                return;
            };
            if let Some(last) = player.last_escape {
                if now.saturating_duration_since(last) < ESCAPE_COOLDOWN {
                    return;
                }
            }
            player.last_escape = Some(now);
            // The escape card freezes the client for 2.6 s and then drops it
            // back into the maze; being caught while frozen would be absurd.
            player.safe_until = Some(now + SAFE_TIME);
            player.escapes += 1;
            let runs = player.escapes;
            let secs = now.saturating_duration_since(round_started).as_secs_f32();
            let name = player.name.clone();
            if player.finished_at.is_none() {
                player.finished_at = Some(now);
                player.place = Some(places + 1);
                // The log belongs to the round, not to the connection: a
                // winner who closes their tab must still be credited when the
                // maze rolls over.
                state.finishers.push(Finisher {
                    pid,
                    name: name.clone(),
                    place: places + 1,
                    secs,
                    runs,
                });
            } else if let Some(f) = state.finishers.iter_mut().find(|f| f.pid == pid) {
                f.runs = runs;
            }
            let place = state
                .players
                .iter()
                .find(|p| p.pid == pid)
                .and_then(|p| p.place)
                .unwrap_or(places + 1);
            let first = state.deadline.is_none();
            if first {
                state.deadline = Some(now + self.grace);
            }
            let ends_in = state
                .deadline
                .map(|d| d.saturating_duration_since(now).as_secs_f32())
                .unwrap_or(0.0);
            format!(
                "{{\"t\":\"finish\",\"id\":{},\"name\":{},\"place\":{},\"secs\":{:.1},\"runs\":{},\"first\":{},\"ends_in\":{:.2}}}",
                pid,
                json::quote(&name),
                place,
                secs,
                runs,
                first,
                ends_in
            )
        };
        self.broadcast(&frame);
    }

    /// The countdown ran out: announce the results and hand out a new maze.
    /// Everybody stands still on their new spawn for `INTERMISSION` while the
    /// leaderboard is up, so the round clock (and the ghosts' patience) only
    /// starts once the board is gone.
    fn new_round(&self) {
        let frame = {
            let mut state = lock(&self.state);
            let now = Instant::now();
            let winner = state.finishers.first().map(|f| f.name.clone());
            let results = results_members(&state.finishers);
            state.seed = new_seed();
            state.pac = Pac::new(state.seed);
            state.last_step = now;
            state.round_started = now + INTERMISSION;
            state.deadline = None;
            state.finishers.clear();
            for player in state.players.iter_mut() {
                player.finished_at = None;
                player.place = None;
                player.escapes = 0;
                player.last_escape = None;
                player.placed = false;
                player.last_move = now;
                player.powered_until = None;
                player.safe_until = Some(now + INTERMISSION.max(SAFE_TIME));
            }
            let winner = winner.map_or_else(|| "null".to_string(), |name| json::quote(&name));
            format!(
                "{{\"t\":\"world\",\"seed\":{},\"winner\":{},\"cherries\":{},{},\"pause\":{:.1}}}",
                state.seed,
                winner,
                state.pac.cherries_json(),
                results,
                INTERMISSION.as_secs_f32()
            )
        };
        self.broadcast(&frame);
    }

    // -- watchers ----------------------------------------------------------

    pub fn add_watcher(&self, conn: Arc<Conn>) -> u32 {
        let wid = self.next_id();
        {
            let mut state = lock(&self.state);
            state.watchers.push(Watcher {
                wid,
                conn,
                target: None,
                since: Instant::now(),
                known: Vec::new(),
            });
        }
        self.retarget(wid, "start", true);
        wid
    }

    pub fn drop_watcher(&self, wid: u32) {
        let previous = {
            let mut state = lock(&self.state);
            let previous = state
                .watchers
                .iter()
                .find(|w| w.wid == wid)
                .and_then(|w| w.target);
            state.watchers.retain(|w| w.wid != wid);
            previous
        };
        if let Some(pid) = previous {
            self.notify_watched(&[pid]);
        }
    }

    /// Viewer-requested switch to the next player.
    pub fn skip(&self, wid: u32) {
        self.retarget(wid, "skip", false);
    }

    fn retarget(&self, wid: u32, reason: &str, randomize: bool) {
        let now = Instant::now();
        let (previous, current) = {
            let mut state = lock(&self.state);
            let Some(index) = state.watchers.iter().position(|w| w.wid == wid) else {
                return;
            };
            let previous = state.watchers[index].target;
            let (payload, current) = if state.players.is_empty() {
                (
                    format!("{{\"t\":\"idle_pool\",\"reason\":\"{reason}\",\"players\":0}}"),
                    None,
                )
            } else {
                let Some(pick) =
                    Self::next_player(&state, previous, randomize, now, self.idle_switch)
                else {
                    return; // nobody else to switch to; keep watching
                };
                let player = state
                    .players
                    .iter()
                    .find(|p| p.pid == pick)
                    .expect("pick comes from this roster");
                let payload = format!(
                    "{{\"t\":\"watch\",\"reason\":\"{}\",\"players\":{},\"id\":{},\"name\":{},\"placed\":{},\"x\":{:.4},\"y\":{:.4},\"a\":{:.4},{}}}",
                    reason,
                    state.players.len(),
                    pick,
                    json::quote(&player.name),
                    player.placed,
                    player.x,
                    player.y,
                    player.a,
                    Self::world_members(&state, now)
                );
                (payload, Some(pick))
            };
            let watcher = &mut state.watchers[index];
            watcher.target = current;
            watcher.since = now;
            // Queued before the lock is released, for the same reason as the
            // welcome: the next snapshot is centred on the new target, and the
            // camera must know who that is before it arrives.
            watcher.conn.send_urgent(Arc::new(text_frame(&payload)));
            (previous, current)
        };
        let mut touched: Vec<u32> = Vec::new();
        touched.extend(previous);
        touched.extend(current);
        self.notify_watched(&touched);
    }

    fn next_player(
        state: &State,
        current: Option<u32>,
        randomize: bool,
        now: Instant,
        idle_switch: Duration,
    ) -> Option<u32> {
        if randomize {
            let fresh: Vec<u32> = state
                .players
                .iter()
                .filter(|p| p.idle_for(now) <= idle_switch)
                .map(|p| p.pid)
                .collect();
            let pool = if fresh.is_empty() {
                state.players.iter().map(|p| p.pid).collect()
            } else {
                fresh
            };
            if pool.is_empty() {
                return None;
            }
            return Some(pool[(entropy() % pool.len() as u64) as usize]);
        }
        let index = current
            .and_then(|pid| state.players.iter().position(|p| p.pid == pid))
            .map(|i| i + 1)
            .unwrap_or(0);
        let rotated: Vec<&Player> = state.players[index..]
            .iter()
            .chain(state.players[..index].iter())
            .filter(|p| Some(p.pid) != current)
            .collect();
        if rotated.is_empty() {
            return None;
        }
        let active = rotated.iter().find(|p| p.idle_for(now) <= idle_switch);
        Some(active.unwrap_or(&rotated[0]).pid)
    }

    /// Let players know how many cameras are pointed at them.
    fn notify_watched(&self, pids: &[u32]) {
        let frames: Vec<(Arc<Conn>, String)> = {
            let state = lock(&self.state);
            let mut seen: Vec<u32> = Vec::new();
            let mut out = Vec::new();
            for &pid in pids {
                if seen.contains(&pid) {
                    continue;
                }
                seen.push(pid);
                if let Some(player) = state.players.iter().find(|p| p.pid == pid) {
                    let count = state
                        .watchers
                        .iter()
                        .filter(|w| w.target == Some(pid))
                        .count();
                    out.push((
                        Arc::clone(&player.conn),
                        format!("{{\"t\":\"watched\",\"n\":{count}}}"),
                    ));
                }
            }
            out
        };
        for (conn, payload) in frames {
            conn.send_urgent(Arc::new(text_frame(&payload)));
        }
    }

    fn broadcast(&self, message: &str) {
        let frame = Arc::new(text_frame(message));
        let conns = Self::audience(&lock(&self.state));
        for conn in conns {
            conn.send_urgent(Arc::clone(&frame));
        }
    }

    /// Every player and watcher, to be written to once the lock is released.
    fn audience(state: &State) -> Vec<Arc<Conn>> {
        state
            .players
            .iter()
            .map(|p| Arc::clone(&p.conn))
            .chain(state.watchers.iter().map(|w| Arc::clone(&w.conn)))
            .collect()
    }

    // -- the clock ---------------------------------------------------------

    /// Hub thread: rolls the world over, moves the ghosts, rotates watchers,
    /// pushes peers.
    pub fn tick(&self) {
        let now = Instant::now();
        let rollover = {
            let state = lock(&self.state);
            state.deadline.is_some_and(|deadline| now >= deadline)
        };
        if rollover {
            self.new_round();
        }
        self.step_ghosts(now);

        let due: Vec<(u32, &'static str)> = {
            let state = lock(&self.state);
            let players = state.players.len();
            state
                .watchers
                .iter()
                .filter_map(|watcher| {
                    let player = watcher
                        .target
                        .and_then(|pid| state.players.iter().find(|p| p.pid == pid));
                    match player {
                        None => {
                            if watcher.target.is_none() && state.players.is_empty() {
                                None // nobody to watch yet; already told them so
                            } else if watcher.target.is_some() {
                                Some((watcher.wid, "gone"))
                            } else {
                                Some((watcher.wid, "joined"))
                            }
                        }
                        Some(player) => {
                            // Stillness only counts while we are pointed at
                            // them, so a roomful of idle players is a
                            // slideshow, not a strobe.
                            let stillness = player
                                .idle_for(now)
                                .min(now.saturating_duration_since(watcher.since));
                            if players > 1 && stillness > self.idle_switch {
                                Some((watcher.wid, "idle"))
                            } else {
                                None
                            }
                        }
                    }
                })
                .collect()
        };
        for (wid, reason) in due {
            self.retarget(wid, reason, false);
        }

        self.broadcast_peers(now);
    }

    /// Ghosts move by the time actually elapsed, so a late tick does not
    /// slow them down; touches are told to the players after unlocking.
    ///
    /// Besides the private `caught` / `ate` for the player involved, everyone
    /// within `SIGHT` of the touch (and every camera riding someone that
    /// close) hears a `bite` or a `pop` with the spot, so their client can
    /// play the chomp or the burst where it happened instead of a ghost or a
    /// player silently vanishing.
    fn step_ghosts(&self, now: Instant) {
        let told: Vec<(Arc<Conn>, String)> = {
            let mut state = lock(&self.state);
            let dt = now
                .saturating_duration_since(state.last_step)
                .min(MAX_STEP)
                .as_secs_f32();
            state.last_step = now;
            let targets: Vec<Target> = state
                .players
                .iter()
                .filter(|p| p.placed)
                .map(|p| Target {
                    pid: p.pid,
                    x: p.x,
                    y: p.y,
                    powered: p.powered(now),
                    safe: p.safe(now),
                })
                .collect();
            let hits = state.pac.step(dt, &targets);
            let mut told = Vec::new();
            for hit in hits {
                let (pid, ghost) = match hit {
                    Hit::Ate { pid, ghost } | Hit::Caught { pid, ghost } => (pid, ghost),
                };
                let Some(player) = state.players.iter_mut().find(|p| p.pid == pid) else {
                    continue;
                };
                let (x, y) = (player.x, player.y);
                let (private, kind) = match hit {
                    Hit::Ate { .. } => (format!("{{\"t\":\"ate\",\"ghost\":{ghost}}}"), "pop"),
                    Hit::Caught { .. } => {
                        player.safe_until = Some(now + SAFE_TIME);
                        ("{\"t\":\"caught\"}".to_string(), "bite")
                    }
                };
                told.push((Arc::clone(&player.conn), private));
                let public = format!(
                    "{{\"t\":\"{kind}\",\"ghost\":{ghost},\"pid\":{pid},\"x\":{x:.3},\"y\":{y:.3}}}"
                );
                let near = |px: f32, py: f32| (px - x).hypot(py - y) <= SIGHT;
                for p in state.players.iter().filter(|p| p.placed && near(p.x, p.y)) {
                    told.push((Arc::clone(&p.conn), public.clone()));
                }
                for w in &state.watchers {
                    let riding = w
                        .target
                        .and_then(|t| state.players.iter().find(|p| p.pid == t));
                    if riding.is_some_and(|p| near(p.x, p.y)) {
                        told.push((Arc::clone(&w.conn), public.clone()));
                    }
                }
            }
            told
        };
        for (conn, message) in told {
            conn.send_urgent(Arc::new(text_frame(&message)));
        }
    }

    /// Positions, but only the neighbours each client can actually see.
    ///
    /// Sending every position to every player is quadratic: at 560 players
    /// that was a 10 KB frame fanned out 560 times, 20 times a second. A
    /// bucket index bounds the candidate set, the frame is binary, and names
    /// travel once per viewer.
    ///
    /// Two regimes. While the room is small every client gets its own list,
    /// centred on itself. Past `PEER_EXACT_MAX` the frame is built once per
    /// `CROWD_BUCKET` cell and the same bytes go to everyone standing in it:
    /// 800 players cost ~160 frames instead of 800.
    fn broadcast_peers(&self, now: Instant) {
        let (count, interval, seq, bodies, roster, viewers, idle, watching, ghosts) = {
            let mut state = lock(&self.state);
            let count = state.players.len();
            if count == 0 && state.watchers.is_empty() {
                return;
            }
            let interval = snapshot_interval(count);
            if now < state.peers_due {
                return;
            }
            // Stay on the cadence instead of drifting a whole tick every time
            // the deadline lands just after a tick boundary.
            state.peers_due = (state.peers_due + interval).max(now);
            state.snapshot_seq += 1;
            let seq = state.snapshot_seq;

            let bodies: Vec<Body> = state
                .players
                .iter()
                .filter(|p| p.placed)
                .map(|p| Body {
                    x: p.x,
                    y: p.y,
                    pid: p.pid,
                    a: p.a,
                    finished: p.finished_at.is_some(),
                    flipped: p.flipped,
                    powered: p.powered(now),
                    age: (now.saturating_duration_since(p.moved_at).as_millis() as u64 / AGE_STEP)
                        .min(255) as u8,
                })
                .collect();
            // Names for whoever is in this snapshot: pulled once here so the
            // per-viewer diff below never has to touch the roster again.
            let roster: HashMap<u32, String> = state
                .players
                .iter()
                .filter(|p| p.placed)
                .map(|p| (p.pid, p.name.clone()))
                .collect();
            let viewers: Vec<(usize, f32, f32, u32)> = state
                .players
                .iter()
                .enumerate()
                .filter(|(_, p)| p.placed)
                .map(|(i, p)| (i, p.x, p.y, p.pid))
                .collect();
            let idle: Vec<Arc<Conn>> = state
                .players
                .iter()
                .filter(|p| !p.placed)
                .map(|p| Arc::clone(&p.conn))
                .collect();
            let watching: Vec<(usize, Option<u32>)> = state
                .watchers
                .iter()
                .enumerate()
                .map(|(i, w)| (i, w.target))
                .collect();
            // Stepped on this very tick, so they are true at the frame's clock.
            let ghosts = ghost_section(state.pac.ghosts());
            (
                count, interval, seq, bodies, roster, viewers, idle, watching, ghosts,
            )
        };

        let crowded = count > PEER_EXACT_MAX;
        let bucket = if crowded { CROWD_BUCKET } else { BUCKET };
        let hz = (1.0 / interval.as_secs_f32()).round().min(255.0) as u8;
        let clock = now.saturating_duration_since(self.started).as_millis() as u32;
        let head = frame_head(hz, count, clock);

        let mut buckets: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (index, body) in bodies.iter().enumerate() {
            buckets
                .entry(cell_of(body.x, body.y, bucket))
                .or_default()
                .push(index);
        }
        let rings = (SIGHT / bucket).ceil().max(1.0) as i32;

        // Names ride in a separate message, so a viewer is only told about a
        // body once. Everything below works on indices into `bodies`.
        let mut names: Vec<(Arc<Conn>, Arc<Vec<u8>>)> = Vec::new();
        let mut sends: Vec<(Arc<Conn>, Arc<Vec<u8>>)> = Vec::new();
        let empty = Arc::new(binary_frame(
            &[head.as_slice(), &[0, 0], ghosts.as_slice()].concat(),
        ));

        let build = |picked: &[usize]| -> Framed {
            let thinned = thin(picked, seq);
            let mut payload =
                Vec::with_capacity(head.len() + 2 + thinned.len() * 12 + ghosts.len());
            payload.extend_from_slice(&head);
            payload.extend_from_slice(&(thinned.len() as u16).to_le_bytes());
            for &index in &thinned {
                pack_body(&bodies[index], &mut payload);
            }
            payload.extend_from_slice(&ghosts);
            (
                Arc::new(binary_frame(&payload)),
                thinned.iter().map(|&i| bodies[i].pid).collect(),
            )
        };

        let mut shared: HashMap<(i32, i32), Framed> = HashMap::new();
        if crowded {
            for &cell in buckets.keys() {
                let centre = (
                    (cell.0 as f32 + 0.5) * bucket,
                    (cell.1 as f32 + 0.5) * bucket,
                );
                let mut pool = pool_at(&buckets, cell, rings);
                sort_by_distance(&mut pool, &bodies, centre.0, centre.1);
                pool.truncate(PEER_LIMIT);
                shared.insert(cell, build(&pool));
            }
        }

        {
            let mut state = lock(&self.state);
            for (index, x, y, pid) in viewers {
                let (frame, ids) = if crowded {
                    shared
                        .get(&cell_of(x, y, bucket))
                        .cloned()
                        .unwrap_or_else(|| (Arc::clone(&empty), Vec::new()))
                } else {
                    let mut pool = pool_at(&buckets, cell_of(x, y, bucket), rings);
                    pool.retain(|&i| bodies[i].pid != pid);
                    sort_by_distance(&mut pool, &bodies, x, y);
                    pool.truncate(PEER_LIMIT);
                    build(&pool)
                };
                let Some(player) = state.players.get_mut(index) else {
                    continue;
                };
                if let Some(frame) = fresh_names(&mut player.known, &ids, &roster) {
                    names.push((Arc::clone(&player.conn), frame));
                }
                sends.push((Arc::clone(&player.conn), frame));
            }
            for conn in idle {
                sends.push((conn, Arc::clone(&empty)));
            }
            for (index, target) in watching {
                let Some(pid) = target else { continue };
                let Some(body) = bodies.iter().find(|b| b.pid == pid) else {
                    continue;
                };
                // Centred on the target and never skipping it: the camera
                // needs the position of the very player it is riding, even in
                // a crowd where a shared list would have dropped them.
                let (bx, by) = (body.x, body.y);
                let mut pool = pool_at(&buckets, cell_of(bx, by, bucket), rings);
                sort_by_distance(&mut pool, &bodies, bx, by);
                pool.truncate(PEER_LIMIT);
                let (frame, ids) = build(&pool);
                let Some(watcher) = state.watchers.get_mut(index) else {
                    continue;
                };
                if let Some(frame) = fresh_names(&mut watcher.known, &ids, &roster) {
                    names.push((Arc::clone(&watcher.conn), frame));
                }
                sends.push((Arc::clone(&watcher.conn), frame));
            }
        }

        let built = Instant::now();
        for (conn, frame) in &names {
            conn.send_urgent(Arc::clone(frame));
        }
        for (conn, frame) in &sends {
            conn.send_bytes(Arc::clone(frame));
        }
        let done = Instant::now();
        let mut state = lock(&self.state);
        state.perf = Perf {
            build_ms: built.saturating_duration_since(now).as_secs_f32() * 1000.0,
            send_ms: done.saturating_duration_since(built).as_secs_f32() * 1000.0,
            frames: sends.len(),
            slow: state.perf.slow + u64::from(done.saturating_duration_since(now) > interval),
        };
    }

    // -- ops ---------------------------------------------------------------

    /// Ops snapshot. The per-player roster is opt-in: dumping 800 of them on
    /// every poll is real work on the threads that run the game.
    pub fn stats_json(&self, version: &str, full: bool) -> String {
        let now = Instant::now();
        let state = lock(&self.state);
        let dropped: u64 = state.players.iter().map(|p| p.conn.dropped()).sum();
        let mut out = format!(
            "{{\"version\":{},\"world\":{{{},\"age\":{:.1}}},\"perf\":{{\"build_ms\":{:.1},\"send_ms\":{:.1},\"frames\":{},\"slow\":{},\"players\":{},\"watchers\":{},\"dropped\":{},\"ghosts\":{},\"cherries\":{}}}",
            json::quote(version),
            Self::world_members(&state, now),
            now.saturating_duration_since(state.round_started)
                .as_secs_f32(),
            state.perf.build_ms,
            state.perf.send_ms,
            state.perf.frames,
            state.perf.slow,
            state.players.len(),
            state.watchers.len(),
            dropped,
            state.pac.living(),
            state.pac.cherries().len(),
        );
        if full {
            let players = state
                .players
                .iter()
                .map(|p| {
                    format!(
                        "{{\"id\":{},\"name\":{},\"x\":{:.4},\"y\":{:.4},\"a\":{:.4},\"idle\":{:.2},\"place\":{}}}",
                        p.pid,
                        json::quote(&p.name),
                        p.x,
                        p.y,
                        p.a,
                        p.idle_for(now).as_secs_f32(),
                        p.place.map(|v| v.to_string()).unwrap_or("null".into()),
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let watchers = state
                .watchers
                .iter()
                .map(|w| {
                    format!(
                        "{{\"id\":{},\"target\":{}}}",
                        w.wid,
                        w.target.map(|v| v.to_string()).unwrap_or("null".into())
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            out.push_str(&format!(
                ",\"players\":[{players}],\"watchers\":[{watchers}]"
            ));
        }
        out.push('}');
        out
    }
}

/// Seconds between position snapshots for a room this size.
///
/// Clients interpolate between snapshots and are told the rate, so a big room
/// trades update frequency for keeping up at all.
fn snapshot_interval(players: usize) -> Duration {
    if players <= PEER_BUSY {
        PEER_INTERVAL
    } else if players <= PEER_CROWD {
        PEER_INTERVAL * 2
    } else {
        PEER_INTERVAL * 3
    }
}

fn cell_of(x: f32, y: f32, bucket: f32) -> (i32, i32) {
    ((x / bucket).floor() as i32, (y / bucket).floor() as i32)
}

/// Bodies near a cell, widening a ring at a time until the list is full or
/// `SIGHT` is reached.
///
/// A fixed three-by-three window is anchored on the *cell*, not on the
/// viewer, so someone standing at a cell edge was only told about bodies
/// eight tiles ahead and players visibly popped in and out halfway down a
/// corridor. Widening instead means an empty corridor is reported to the
/// horizon, while a crowd fills the list from the nearest cells and costs no
/// more to compute.
fn pool_at(
    buckets: &HashMap<(i32, i32), Vec<usize>>,
    (bx, by): (i32, i32),
    rings: i32,
) -> Vec<usize> {
    let mut pool: Vec<usize> = buckets.get(&(bx, by)).cloned().unwrap_or_default();
    for r in 1..=rings {
        if pool.len() >= PEER_LIMIT {
            break;
        }
        for oy in -r..=r {
            let edge = oy.abs() == r;
            let xs: Vec<i32> = if edge {
                (-r..=r).collect()
            } else {
                vec![-r, r]
            };
            for ox in xs {
                if let Some(cell) = buckets.get(&(bx + ox, by + oy)) {
                    pool.extend_from_slice(cell);
                }
            }
        }
    }
    pool
}

fn sort_by_distance(pool: &mut [usize], bodies: &[Body], x: f32, y: f32) {
    pool.sort_unstable_by(|&a, &b| {
        let da = (bodies[a].x - x).powi(2) + (bodies[a].y - y).powi(2);
        let db = (bodies[b].x - x).powi(2) + (bodies[b].y - y).powi(2);
        da.total_cmp(&db)
    });
}

/// Every tick for the bodies close by, every `FAR_EVERY`th for the rest.
///
/// The nearest four dozen are what a player is actually looking at. A body
/// twenty tiles down a corridor is a few pixels tall, so spending a
/// twelve-byte slot on it every tick is waste: it gets a third of the rate,
/// staggered by its position in the list so each tick carries an even share.
/// Interpolation on the client is per body and learns the rate, so the
/// distant ones still glide rather than hop.
fn thin(picked: &[usize], seq: usize) -> Vec<usize> {
    if picked.len() <= PEER_NEAR {
        return picked.to_vec();
    }
    let phase = seq % FAR_EVERY;
    let mut out = picked[..PEER_NEAR].to_vec();
    out.extend(
        picked[PEER_NEAR..]
            .iter()
            .enumerate()
            .filter(|(i, _)| i % FAR_EVERY == phase)
            .map(|(_, &index)| index),
    );
    out
}

fn frame_head(hz: u8, count: usize, clock: u32) -> Vec<u8> {
    let mut head = Vec::with_capacity(8);
    head.push(PEERS_FRAME);
    head.push(hz);
    head.extend_from_slice(&(count.min(u16::MAX as usize) as u16).to_le_bytes());
    head.extend_from_slice(&clock.to_le_bytes());
    head
}

fn pack_body(body: &Body, out: &mut Vec<u8>) {
    out.extend_from_slice(&body.pid.to_le_bytes());
    out.extend_from_slice(&quantise(body.x).to_le_bytes());
    out.extend_from_slice(&quantise(body.y).to_le_bytes());
    let angle = body.a.rem_euclid(std::f32::consts::TAU) * ANGLE_SCALE;
    out.extend_from_slice(&((angle as u32 & 0xFFFF) as u16).to_le_bytes());
    let flags = [
        (body.finished, FLAG_FINISHED),
        (body.flipped, FLAG_FLIPPED),
        (body.powered, FLAG_POWERED),
    ]
    .iter()
    .filter(|(set, _)| *set)
    .fold(0, |flags, (_, bit)| flags | bit);
    out.push(flags);
    out.push(body.age);
}

/// The tail of every snapshot: living ghosts, `u8 id, u16 x, u16 y` each.
fn ghost_section(ghosts: impl Iterator<Item = (u8, f32, f32)>) -> Vec<u8> {
    let mut out = vec![0];
    for (id, x, y) in ghosts {
        out.push(id);
        out.extend_from_slice(&quantise(x).to_le_bytes());
        out.extend_from_slice(&quantise(y).to_le_bytes());
        out[0] += 1;
    }
    out
}

fn quantise(v: f32) -> u16 {
    (v * POS_SCALE).clamp(0.0, 65535.0) as u16
}

fn wrap_angle(angle: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    (angle + std::f32::consts::PI).rem_euclid(tau) - std::f32::consts::PI
}

/// The `names` message for whatever this viewer has not been told yet.
fn fresh_names(
    known: &mut Vec<u32>,
    ids: &[u32],
    roster: &HashMap<u32, String>,
) -> Option<Arc<Vec<u8>>> {
    let fresh: Vec<u32> = ids
        .iter()
        .copied()
        .filter(|id| !known.contains(id))
        .collect();
    if fresh.is_empty() {
        return None;
    }
    if known.len() > KNOWN_CAP {
        known.clear(); // a long session in a busy world; start over
    }
    known.extend_from_slice(&fresh);
    let pairs = fresh
        .iter()
        .filter_map(|id| {
            roster
                .get(id)
                .map(|name| format!("[{},{}]", id, json::quote(name)))
        })
        .collect::<Vec<_>>()
        .join(",");
    Some(Arc::new(text_frame(&format!(
        "{{\"t\":\"names\",\"l\":[{pairs}]}}"
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(pid: u32, x: f32, y: f32) -> Body {
        Body {
            x,
            y,
            pid,
            a: 0.0,
            finished: false,
            flipped: false,
            powered: false,
            age: 0,
        }
    }

    /// The browser decodes this with fixed offsets (`static/js/net.js`); any
    /// drift in order, width or endianness silently scrambles every pawn.
    #[test]
    fn snapshot_bytes_match_what_the_client_decodes() {
        let mut out = frame_head(10, 801, 0x0102_0304);
        out.extend_from_slice(&2u16.to_le_bytes());
        pack_body(
            &Body {
                x: 12.345,
                y: 0.5,
                pid: 0xAABB_CCDD,
                a: std::f32::consts::PI,
                finished: true,
                flipped: false,
                powered: true,
                age: 21,
            },
            &mut out,
        );
        pack_body(
            &Body {
                flipped: true,
                ..body(7, 1.0, 2.0)
            },
            &mut out,
        );
        out.extend_from_slice(&ghost_section([(0, 3.5, 4.25), (5, 49.5, 0.0)].into_iter()));
        assert_eq!(out.len(), 10 + 2 * 12 + 1 + 2 * 5);
        assert_eq!(out[0], PEERS_FRAME);
        assert_eq!(out[1], 10);
        assert_eq!(u16::from_le_bytes([out[2], out[3]]), 801);
        assert_eq!(
            u32::from_le_bytes([out[4], out[5], out[6], out[7]]),
            0x0102_0304
        );
        assert_eq!(u16::from_le_bytes([out[8], out[9]]), 2);
        let b = &out[10..];
        assert_eq!(u32::from_le_bytes([b[0], b[1], b[2], b[3]]), 0xAABB_CCDD);
        assert_eq!(u16::from_le_bytes([b[4], b[5]]), 12345);
        assert_eq!(u16::from_le_bytes([b[6], b[7]]), 500);
        // Half a turn is half the u16 range.
        let angle = u16::from_le_bytes([b[8], b[9]]);
        assert!((32767..=32769).contains(&angle), "{angle}");
        // Finished (bit 0) and powered (bit 2); the second body is flipped.
        assert_eq!(b[10], 0b101);
        assert_eq!(b[11], 21);
        assert_eq!(b[12 + 10], 0b010);
        // Ghosts: a count, then id and position each.
        let g = &out[10 + 24..];
        assert_eq!(g[0], 2);
        assert_eq!(g[1], 0);
        assert_eq!(u16::from_le_bytes([g[2], g[3]]), 3500);
        assert_eq!(u16::from_le_bytes([g[4], g[5]]), 4250);
        assert_eq!(g[6], 5);
        assert_eq!(u16::from_le_bytes([g[7], g[8]]), 49500);
        assert_eq!(u16::from_le_bytes([g[9], g[10]]), 0);
    }

    /// Positions outside the u16 range must clamp, not wrap to the far side of
    /// the maze.
    #[test]
    fn positions_clamp_at_the_edges_of_the_wire_range() {
        assert_eq!(quantise(-3.0), 0);
        assert_eq!(quantise(70.0), 65535);
    }

    /// A viewer at a cell edge looking down a corridor used to be told about
    /// bodies eight tiles ahead and no further.
    #[test]
    fn the_search_widens_until_it_reaches_distant_bodies() {
        let bodies: Vec<Body> = (0..20).map(|i| body(i, 1.0 + i as f32, 1.0)).collect();
        let mut buckets: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
        for (index, b) in bodies.iter().enumerate() {
            buckets
                .entry(cell_of(b.x, b.y, BUCKET))
                .or_default()
                .push(index);
        }
        let rings = (SIGHT / BUCKET).ceil() as i32;
        let pool = pool_at(&buckets, cell_of(0.5, 1.0, BUCKET), rings);
        let farthest = pool.iter().map(|&i| bodies[i].x).fold(0.0, f32::max);
        assert_eq!(pool.len(), 20);
        assert!(farthest > 16.0, "stopped at {farthest}");
    }

    /// Near bodies ride every snapshot; each far one turns up exactly once
    /// every `FAR_EVERY` snapshots, never twice and never not at all.
    #[test]
    fn far_bodies_are_staggered_not_starved() {
        let picked: Vec<usize> = (0..PEER_NEAR + 30).collect();
        let mut seen = vec![0usize; picked.len()];
        for seq in 0..FAR_EVERY {
            let frame = thin(&picked, seq);
            assert!(frame.starts_with(&picked[..PEER_NEAR]));
            for index in frame {
                seen[index] += 1;
            }
        }
        assert!(seen[..PEER_NEAR].iter().all(|&n| n == FAR_EVERY));
        assert!(seen[PEER_NEAR..].iter().all(|&n| n == 1), "{seen:?}");
    }

    /// A packet held up in a queue keeps the moment it was sampled: after
    /// one fast packet sets the baseline, later arrivals report exactly their
    /// extra delay, bunched arrivals get spread back out, and a client whose
    /// clock jumps is re-baselined instead of being placed seconds away.
    #[test]
    fn late_positions_keep_the_time_they_were_true() {
        let mut clock = SenderClock::default();
        // Sent every 50 ms of their clock, which runs 10 s behind ours.
        assert_eq!(clock.lag(0.0, 10_020.0), 0.0); // 20 ms trip, the baseline
        assert!((clock.lag(50.0, 10_070.0) - 0.0).abs() < 0.01);
        // Three positions stuck behind one another, delivered at once.
        let bunched: Vec<f64> = [100.0, 150.0, 200.0]
            .iter()
            .map(|&sent| clock.lag(sent, 10_230.0))
            .collect();
        assert!((bunched[0] - 110.0).abs() < 0.1, "{bunched:?}");
        assert!((bunched[1] - 60.0).abs() < 0.1, "{bunched:?}");
        assert!((bunched[2] - 10.0).abs() < 0.1, "{bunched:?}");
        // A faster trip than ever before lowers the baseline.
        assert_eq!(clock.lag(250.0, 10_260.0), 0.0);
        // A real stall is reported as one, up to the cap.
        assert!((clock.lag(300.0, 10_600.0) - 290.0).abs() < 0.1);
        assert_eq!(clock.lag(350.0, 12_000.0), MAX_LAG_MS);
        // Their clock restarts a minute later (a suspended laptop can do
        // this): re-baselined, not placed half a second in the past forever.
        assert_eq!(clock.lag(5.0, 70_000.0), 0.0);
        assert!((clock.lag(55.0, 70_050.0) - 0.0).abs() < 0.01);
        assert_eq!(clock.lag(f64::NAN, 70_100.0), 0.0);
    }

    /// A viewer is told a name once; repeats cost nothing on the wire.
    #[test]
    fn names_go_out_once_per_viewer() {
        let roster: HashMap<u32, String> = [(1, "a".to_string()), (2, "b\"c".to_string())].into();
        let mut known = Vec::new();
        let first = fresh_names(&mut known, &[1, 2], &roster).expect("both are new");
        let text = String::from_utf8_lossy(&first);
        assert!(
            text.contains(r#"[1,"a"]"#) && text.contains(r#"[2,"b\"c"]"#),
            "{text}"
        );
        assert!(fresh_names(&mut known, &[2, 1], &roster).is_none());
    }

    /// The end-of-round board names the first ten escapes in order, with
    /// their time and trips, and counts everyone who escaped.
    #[test]
    fn results_name_the_first_ten_and_count_the_rest() {
        let finishers: Vec<Finisher> = (1..=13)
            .map(|place| Finisher {
                pid: place as u32,
                name: format!("p{place}"),
                place,
                secs: place as f32 * 10.0,
                runs: if place == 1 { 3 } else { 1 },
            })
            .collect();
        let text = format!("{{{}}}", results_members(&finishers));
        assert!(
            text.starts_with(r#"{"results":[{"name":"p1","place":1,"secs":10.0,"runs":3},"#),
            "{text}"
        );
        assert!(
            text.contains(r#""name":"p10""#) && !text.contains(r#""name":"p11""#),
            "{text}"
        );
        assert!(text.ends_with(r#"],"escaped":13}"#), "{text}");
        assert_eq!(results_members(&[]), r#""results":[],"escaped":0"#);
    }
}
