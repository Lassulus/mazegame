//! One websocket connection, from the hub's side.
//!
//! Every send goes through a per-connection queue drained by that connection's
//! own writer thread. The hub thread must never touch the socket: it builds
//! hundreds of frames a tick, and a single client that has stopped reading
//! would otherwise block the whole world inside one `write`. The Python
//! version of this server did exactly that and spent five seconds in one send
//! at 800 players.
//!
//! Snapshots are state, not history, so when a client falls behind its queue
//! is trimmed rather than grown: skipping a position frame costs that client
//! one tick and costs the room nothing.

use std::io::Write;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::sync::{lock, wait};
use std::thread;

/// Queued frames tolerated before snapshots start being dropped.
const LAG_FRAMES: usize = 16;
/// Queued bytes tolerated before the connection is written off entirely.
const DEAD_BYTES: usize = 1 << 20;

struct Queue {
    frames: Vec<Arc<Vec<u8>>>,
    bytes: usize,
    closed: bool,
}

pub struct Conn {
    stream: TcpStream,
    queue: Mutex<Queue>,
    wake: Condvar,
    closed: AtomicBool,
    dropped: AtomicU64,
}

impl Conn {
    /// Take over a socket and start its writer thread. `None` means no thread
    /// could be had: a connection nobody writes to must not join the maze.
    pub fn new(stream: TcpStream) -> Option<Arc<Self>> {
        let conn = Arc::new(Self {
            stream,
            queue: Mutex::new(Queue {
                frames: Vec::new(),
                bytes: 0,
                closed: false,
            }),
            wake: Condvar::new(),
            closed: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
        });
        let writer = Arc::clone(&conn);
        // 64 KiB is plenty for a loop that only calls write_all, and at a
        // thousand players the default 2 MiB of stack reservation each starts
        // to matter.
        thread::Builder::new()
            .name("ws-write".into())
            .stack_size(64 * 1024)
            .spawn(move || writer.pump())
            .ok()?;
        Some(conn)
    }

    /// Queue an already-framed message. `false` means it was not taken.
    pub fn send_bytes(&self, frame: Arc<Vec<u8>>) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        let mut queue = lock(&self.queue);
        if queue.closed {
            return false;
        }
        if queue.bytes > DEAD_BYTES {
            drop(queue);
            self.abort();
            return false;
        }
        if queue.frames.len() >= LAG_FRAMES {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        queue.bytes += frame.len();
        queue.frames.push(frame);
        self.wake.notify_one();
        true
    }

    /// Queue a message that must not be dropped: welcome, world, finish.
    /// A client this far behind is dead anyway, so it is cut instead.
    pub fn send_urgent(&self, frame: Arc<Vec<u8>>) -> bool {
        if self.closed.load(Ordering::Relaxed) {
            return false;
        }
        let mut queue = lock(&self.queue);
        if queue.closed {
            return false;
        }
        if queue.bytes > DEAD_BYTES {
            drop(queue);
            self.abort();
            return false;
        }
        queue.bytes += frame.len();
        queue.frames.push(frame);
        self.wake.notify_one();
        true
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Stop writing and tear the socket down. Safe to call from any thread and
    /// more than once; the reader thread notices through its own read failing.
    pub fn abort(&self) {
        self.closed.store(true, Ordering::Relaxed);
        {
            let mut queue = lock(&self.queue);
            queue.closed = true;
            queue.frames.clear();
            queue.bytes = 0;
        }
        self.wake.notify_all();
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    fn pump(&self) {
        let mut batch: Vec<Arc<Vec<u8>>> = Vec::new();
        loop {
            {
                let mut queue = lock(&self.queue);
                while queue.frames.is_empty() && !queue.closed {
                    queue = wait(&self.wake, queue);
                }
                if queue.closed && queue.frames.is_empty() {
                    return;
                }
                batch.append(&mut queue.frames);
                queue.bytes = 0;
            }
            // One syscall for whatever piled up while the last write was in
            // flight: with a tick pushing frames at every connection at once,
            // that is regularly two or three frames.
            let mut out = Vec::with_capacity(batch.iter().map(|f| f.len()).sum());
            for frame in batch.drain(..) {
                out.extend_from_slice(&frame);
            }
            let mut sock = &self.stream;
            if sock.write_all(&out).is_err() || sock.flush().is_err() {
                self.abort();
                return;
            }
        }
    }
}
