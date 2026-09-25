//! Entry point: `mazegame --port 8080`.
//!
//! A Windows 95 style maze you play in a browser tab; the exit is the NixOS
//! logo. The server owns the seed, the round clock and everybody's position —
//! the geometry itself is rebuilt client side from the seed, so only positions
//! cross the wire.

mod conn;
mod http;
mod hub;
mod json;
mod maze;
mod net;
mod pac;
mod sync;
mod ws;

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use hub::{Hub, ROUND_GRACE};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Watcher rotation checks and peer position snapshots.
const TICK_HZ: f32 = 20.0;

struct Args {
    host: String,
    port: u16,
    grace: Duration,
    static_root: PathBuf,
    quiet: bool,
}

fn usage() -> String {
    format!(
        "mazegame {VERSION}\n\n\
         usage: mazegame [options]\n\n\
         options:\n\
         \x20 --host ADDR        bind address (default: 127.0.0.1)\n\
         \x20 --port PORT        listen port (default: 8080)\n\
         \x20 --grace SECONDS    seconds from the first escape to the next maze (default: 120)\n\
         \x20 --static DIR       directory holding the browser client\n\
         \x20 -q, --quiet        suppress join/leave logging\n\
         \x20 -h, --help         this\n"
    )
}

/// The client lives next to the binary in the store (`share/mazegame/static`)
/// and next to the sources in a checkout, so a bare `cargo run` also works.
fn default_static_root() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin) = exe.parent() {
            candidates.push(bin.join("../share/mazegame/static"));
        }
    }
    candidates.push(PathBuf::from("static"));
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/static"
    )));
    candidates
        .into_iter()
        .find(|path| path.join("index.html").is_file())
        .unwrap_or_else(|| PathBuf::from("static"))
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        host: "127.0.0.1".into(),
        port: 8080,
        grace: ROUND_GRACE,
        static_root: default_static_root(),
        quiet: false,
    };
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        let mut value = || argv.next().ok_or_else(|| format!("{arg} wants a value"));
        match arg.as_str() {
            "--host" => args.host = value()?,
            "--port" => {
                args.port = value()?
                    .parse()
                    .map_err(|_| "--port wants a number".to_string())?;
            }
            "--grace" => {
                let secs: f32 = value()?
                    .parse()
                    .map_err(|_| "--grace wants a number".to_string())?;
                if secs.is_nan() || secs <= 0.0 {
                    return Err("--grace wants a positive number".into());
                }
                args.grace = Duration::from_secs_f32(secs);
            }
            "--static" => args.static_root = PathBuf::from(value()?),
            "-q" | "--quiet" => args.quiet = true,
            "-h" | "--help" => {
                print!("{}", usage());
                std::process::exit(0);
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(args)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(problem) => {
            eprintln!("mazegame: {problem}\n\n{}", usage());
            return ExitCode::FAILURE;
        }
    };

    if !args.static_root.join("index.html").is_file() {
        eprintln!(
            "mazegame: no client at {} (pass --static DIR)",
            args.static_root.display()
        );
        return ExitCode::FAILURE;
    }

    let hub = Arc::new(Hub::new(args.grace));
    let listener = match TcpListener::bind((args.host.as_str(), args.port)) {
        Ok(listener) => listener,
        Err(problem) => {
            eprintln!(
                "mazegame: cannot bind {}:{}: {problem}",
                args.host, args.port
            );
            return ExitCode::FAILURE;
        }
    };

    let ticker = Arc::clone(&hub);
    thread::Builder::new()
        .name("hub-tick".into())
        .spawn(move || tick_forever(ticker))
        .expect("the hub thread is the game; without it there is nothing to serve");

    let shown = if args.host.contains(':') {
        format!("[{}]", args.host)
    } else {
        args.host.clone()
    };
    println!(
        "mazegame: play at http://{shown}:{}/  watch at http://{shown}:{}/watch",
        args.port, args.port
    );

    let server = Arc::new(net::Server::new(
        hub,
        args.static_root,
        VERSION,
        !args.quiet,
    ));
    server.serve(listener);
    ExitCode::SUCCESS
}

/// Rounds, watcher rotation and position snapshots, on a steady cadence.
///
/// Sleeping the *remainder* of the period, not the whole period: a fixed sleep
/// plus the work silently halves the update rate. If a tick ever runs long the
/// schedule resets rather than being caught up on, so a hiccup cannot turn
/// into a burst of back-to-back snapshots.
fn tick_forever(hub: Arc<Hub>) {
    let period = Duration::from_secs_f32(1.0 / TICK_HZ);
    let mut due = Instant::now();
    loop {
        due += period;
        let now = Instant::now();
        if due < now {
            due = now;
        }
        thread::sleep(due.saturating_duration_since(now));
        hub.tick();
    }
}
