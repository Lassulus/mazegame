//! Accept loop: HTTP on the way in, websockets once upgraded.
//!
//! A thread per connection, and a second thread per connection for writing
//! (see `conn`). That is two threads and one socket per player: Rust threads
//! parked on a read cost a stack and nothing else, and there is no global
//! interpreter lock for them to queue behind — which is exactly what made the
//! same design unusable in Python at 800 players.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use crate::conn::Conn;
use crate::http::{Request, StaticFiles, parse_request, respond};
use crate::hub::Hub;
use crate::json;
use crate::ws::{Framer, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, accept_key, build_frame};

/// Clients heartbeat every 3 s; silence means the tab is gone (or frozen in
/// the back/forward cache) and the slot must be freed.
const SILENCE: Duration = Duration::from_secs(12);
/// Time allowed to send a request line and headers.
const HEADER_TIMEOUT: Duration = Duration::from_secs(20);
const READ_CHUNK: usize = 8192;
const MAX_HEAD: usize = 16 * 1024;
/// Websockets held at once. Each costs a reader and a writer thread, and
/// systemd caps the unit at 8192 tasks: past that no thread can be had for
/// anything, /api included, so the last arrivals are turned away instead.
const MAX_SOCKETS: usize = 3000;

pub struct Server {
    pub hub: Arc<Hub>,
    pub statics: StaticFiles,
    pub version: &'static str,
    pub verbose: bool,
    sockets: AtomicUsize,
}

impl Server {
    pub fn new(hub: Arc<Hub>, static_root: PathBuf, version: &'static str, verbose: bool) -> Self {
        Self {
            hub,
            statics: StaticFiles::new(static_root),
            version,
            verbose,
            sockets: AtomicUsize::new(0),
        }
    }

    pub fn serve(self: Arc<Self>, listener: TcpListener) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let server = Arc::clone(&self);
            // Short-lived for HTTP, long-lived for a websocket; 256 KiB is
            // enough for either and a thousand players' worth is affordable.
            let spawned = thread::Builder::new()
                .name("ws-read".into())
                .stack_size(256 * 1024)
                .spawn(move || server.handle(stream));
            if spawned.is_err() {
                // Out of threads: refuse this one rather than die.
                continue;
            }
        }
    }

    fn log(&self, message: &str) {
        if self.verbose {
            println!("{message}");
        }
    }

    fn handle(&self, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let mut head = Vec::new();
        loop {
            let _ = stream.set_read_timeout(Some(HEADER_TIMEOUT));
            let Some(request) = read_head(&stream, &mut head) else {
                return;
            };
            if request.is_websocket_upgrade() && request.path.starts_with("/ws/") {
                self.upgrade(stream, request, head);
                return;
            }
            let keep = self.respond_http(&stream, &request);
            if !keep {
                return;
            }
        }
    }

    /// Answer one HTTP request. False means the connection is finished.
    fn respond_http(&self, stream: &TcpStream, request: &Request) -> bool {
        let mut out = stream;
        let head_only = request.method == "HEAD";
        if request.method != "GET" && request.method != "HEAD" {
            let _ = respond(
                &mut out,
                405,
                b"GET only",
                "text/plain; charset=utf-8",
                "no-store",
                head_only,
                self.version,
            );
            return false;
        }
        let route = request.path.as_str();
        let sent = match route {
            "/api/version" => {
                let body = format!("{{\"version\":{}}}", json::quote(self.version));
                respond(
                    &mut out,
                    200,
                    body.as_bytes(),
                    "application/json",
                    "no-store",
                    head_only,
                    self.version,
                )
            }
            "/api/state" => {
                // The roster is opt-in: /api/state?full=1.
                let full = matches!(request.param("full"), Some(v) if v != "0" && v != "false" && !v.is_empty());
                let body = self.hub.stats_json(self.version, full);
                respond(
                    &mut out,
                    200,
                    body.as_bytes(),
                    "application/json",
                    "no-store",
                    head_only,
                    self.version,
                )
            }
            "/ws/play" | "/ws/watch" => respond(
                &mut out,
                400,
                b"expected a websocket upgrade",
                "text/plain; charset=utf-8",
                "no-store",
                head_only,
                self.version,
            ),
            _ => {
                let file = match route {
                    "/" | "/play" | "/index.html" => self.statics.resolve("/index.html"),
                    "/watch" | "/watch.html" => self.statics.resolve("/watch.html"),
                    other => self.statics.resolve(other),
                };
                match file.and_then(|path| self.statics.get(&path)) {
                    Some((body, ctype)) => respond(
                        &mut out,
                        200,
                        &body,
                        ctype,
                        "no-cache",
                        head_only,
                        self.version,
                    ),
                    None => respond(
                        &mut out,
                        404,
                        b"no such thing in this maze",
                        "text/plain; charset=utf-8",
                        "no-store",
                        head_only,
                        self.version,
                    ),
                }
            }
        };
        sent.is_ok() && request.keep_alive()
    }

    fn upgrade(&self, stream: TcpStream, request: Request, spare: Vec<u8>) {
        let Some(key) = request.header("sec-websocket-key") else {
            return;
        };
        // Claim a slot and a writer before promising a websocket, so a full
        // server answers with a status the client can see.
        let Some(_slot) = Slot::take(&self.sockets) else {
            self.refuse(&stream);
            return;
        };
        let Ok(reader) = stream.try_clone() else {
            return;
        };
        let Some(conn) = Conn::new(stream) else {
            self.refuse(&reader);
            return;
        };
        let handshake = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            accept_key(key)
        );
        // Nothing is queued on `conn` until the hub hears of it below, so the
        // writer cannot get ahead of the handshake.
        if (&reader).write_all(handshake.as_bytes()).is_err() {
            conn.abort();
            return;
        }
        let _ = reader.set_read_timeout(Some(SILENCE));

        let watching = request.path == "/ws/watch";
        let name = request.param("name").map(str::to_string);
        if watching {
            let wid = self.hub.add_watcher(Arc::clone(&conn));
            self.log(&format!("watcher {wid} joined"));
            self.pump(reader, &conn, spare, |message| {
                if json::field(message, "t") == Some("skip") {
                    self.hub.skip(wid);
                }
            });
            self.hub.drop_watcher(wid);
            self.log(&format!("watcher {wid} left"));
        } else {
            let pid = self.hub.add_player(Arc::clone(&conn), name.as_deref());
            self.log(&format!("player {pid} joined"));
            self.pump(reader, &conn, spare, |message| {
                match json::field(message, "t") {
                    Some("pos") => {
                        if let (Some(x), Some(y), Some(a)) = (
                            json::number(message, "x"),
                            json::number(message, "y"),
                            json::number(message, "a"),
                        ) {
                            if x.is_finite() && y.is_finite() && a.is_finite() {
                                // `c` is the client's clock when it sampled
                                // the position; older clients leave it out.
                                // `f` is 1 while walking on the ceiling.
                                let sent =
                                    json::field(message, "c").and_then(|v| v.parse::<f64>().ok());
                                let flipped = json::number(message, "f") == Some(1.0);
                                self.hub.move_player(pid, x, y, a, flipped, sent);
                            }
                        }
                    }
                    Some("escaped") => self.hub.record_finish(pid),
                    _ => {} // pings and anything unknown: the read alone kept the slot
                }
            });
            self.hub.drop_player(pid);
            self.log(&format!("player {pid} left"));
        }
        conn.abort();
    }

    fn refuse(&self, stream: &TcpStream) {
        let _ = respond(
            &mut &*stream,
            503,
            b"the maze is full",
            "text/plain; charset=utf-8",
            "no-store",
            false,
            self.version,
        );
    }

    /// Read frames until the peer goes quiet, handing text messages over.
    fn pump<F: FnMut(&str)>(
        &self,
        mut reader: TcpStream,
        conn: &Arc<Conn>,
        spare: Vec<u8>,
        mut on_message: F,
    ) {
        let mut framer = Framer::new();
        let mut messages = Vec::new();
        let mut buffer = [0u8; READ_CHUNK];
        // Bytes the client pipelined behind its handshake.
        if !spare.is_empty() && framer.feed(&spare, &mut messages).is_err() {
            return;
        }
        loop {
            for (opcode, payload) in messages.drain(..) {
                match opcode {
                    OP_CLOSE => {
                        let echo = build_frame(OP_CLOSE, &payload[..payload.len().min(2)]);
                        conn.send_urgent(Arc::new(echo));
                        return;
                    }
                    OP_PING => {
                        conn.send_urgent(Arc::new(build_frame(OP_PONG, &payload)));
                    }
                    OP_TEXT => {
                        if let Ok(text) = std::str::from_utf8(&payload) {
                            on_message(text);
                        }
                    }
                    _ => {}
                }
            }
            if conn.is_closed() {
                return;
            }
            match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(n) => {
                    if framer.feed(&buffer[..n], &mut messages).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return, // timeout means silence, which means gone
            }
        }
    }
}

/// One of the `MAX_SOCKETS`, handed back on drop.
struct Slot<'a>(&'a AtomicUsize);

impl<'a> Slot<'a> {
    fn take(count: &'a AtomicUsize) -> Option<Self> {
        count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_SOCKETS).then_some(n + 1)
            })
            .ok()
            .map(|_| Self(count))
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Read one request head, leaving anything past the blank line in `spare`.
fn read_head(stream: &TcpStream, spare: &mut Vec<u8>) -> Option<Request> {
    let mut reader = stream;
    let mut buffer = [0u8; READ_CHUNK];
    loop {
        if let Some(at) = find_head_end(spare) {
            let request = parse_request(&spare[..at]);
            spare.drain(..at);
            return request;
        }
        if spare.len() > MAX_HEAD {
            return None;
        }
        match reader.read(&mut buffer) {
            Ok(0) => return None,
            Ok(n) => spare.extend_from_slice(&buffer[..n]),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|at| at + 4)
}
