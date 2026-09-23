//! HTTP/1.1 request parsing, static file cache and response writing.
//!
//! Only what this server actually speaks: GET/HEAD, fixed-length bodies that
//! get drained and ignored, and the upgrade handshake headers. No chunked
//! encoding, no content negotiation.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::sync::lock;
use std::time::SystemTime;

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn keep_alive(&self) -> bool {
        !self
            .header("connection")
            .is_some_and(|value| value.eq_ignore_ascii_case("close"))
    }

    pub fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
            && self
                .header("sec-websocket-key")
                .is_some_and(|k| !k.is_empty())
    }
}

/// Parse a request head (everything up to and including the blank line).
pub fn parse_request(head: &[u8]) -> Option<Request> {
    // Lossy is deliberate: a request line is ASCII plus percent escapes, and a
    // client that sends raw non-UTF-8 path bytes gets replacement characters
    // rather than a dropped connection.
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");

    let mut fields = lines.next()?.split(' ');
    let method = fields.next()?;
    let target = fields.next()?;
    // A bare "GET /" with no version is accepted; anything claiming a version
    // has to look like one, otherwise random line noise parses as a request.
    if let Some(version) = fields.next()
        && !version.starts_with("HTTP/")
    {
        return None;
    }
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    if !target.starts_with('/') {
        return None;
    }

    let (raw_path, raw_query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    let mut query = Vec::new();
    for item in raw_query.split('&').filter(|item| !item.is_empty()) {
        let (key, value) = item.split_once('=').unwrap_or((item, ""));
        query.push((decode(key, false), decode(value, true)));
    }

    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }

    Some(Request {
        method: method.to_ascii_uppercase(),
        path: decode(raw_path, false),
        query,
        headers,
    })
}

/// Percent-decode, optionally treating `+` as a space (query values only).
/// Truncated or non-hex escapes are copied through as written.
fn decode(input: &str, plus: bool) -> String {
    let bytes = input.as_bytes();
    if !bytes.contains(&b'%') && !(plus && bytes.contains(&b'+')) {
        return input.to_string();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' if plus => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js") => "text/javascript",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Path → (mtime it was read at, body).
type Cache = HashMap<PathBuf, (SystemTime, Arc<Vec<u8>>)>;

/// Read-through cache for the static site. The whole thing is a few hundred
/// kilobytes, so entries are never evicted; mtime is the only validity token.
pub struct StaticFiles {
    root: PathBuf,
    cache: Mutex<Cache>,
}

impl StaticFiles {
    pub fn new(root: PathBuf) -> Self {
        // Canonicalise once. `resolve` compares against this prefix, and a
        // relative or symlinked root would make every comparison fail.
        let root = root.canonicalize().unwrap_or(root);
        Self {
            root,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve a URL path inside the root, refusing anything that escapes it.
    pub fn resolve(&self, route: &str) -> Option<PathBuf> {
        // Collapse the route before it ever reaches the filesystem: `..` that
        // would climb past the root is dropped, not followed, so a traversal
        // attempt turns into a plain miss instead of a readable file.
        let mut parts: Vec<&str> = Vec::new();
        for segment in route.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        if parts.is_empty() {
            return None;
        }
        let mut target = self.root.clone();
        for part in parts {
            target.push(part);
        }
        // Canonicalise again anyway: a symlink inside the tree can still point
        // out of it.
        let target = target.canonicalize().ok()?;
        if target == self.root || !target.starts_with(&self.root) || !target.is_file() {
            return None;
        }
        Some(target)
    }

    /// Body and content type for a resolved path, `None` if it went away.
    pub fn get(&self, path: &Path) -> Option<(Arc<Vec<u8>>, &'static str)> {
        let stamp = fs::metadata(path).ok()?.modified().ok()?;
        let ctype = content_type(path);
        {
            let cache = lock(&self.cache);
            if let Some((seen, body)) = cache.get(path)
                && *seen == stamp
            {
                return Some((Arc::clone(body), ctype));
            }
        }
        // Read with the lock released: a cold entry must not stall every other
        // connection behind one disk read.
        let body = Arc::new(fs::read(path).ok()?);
        lock(&self.cache).insert(path.to_path_buf(), (stamp, Arc::clone(&body)));
        Some((body, ctype))
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    }
}

/// Write a complete HTTP/1.1 response. `head_only` omits the body (HEAD).
pub fn respond(
    out: &mut impl Write,
    status: u16,
    body: &[u8],
    content_type: &str,
    cache: &str,
    head_only: bool,
    server: &str,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Server: {server}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {length}\r\n\
         Cache-Control: {cache}\r\n\
         Connection: keep-alive\r\n\r\n",
        reason = reason(status),
        length = body.len(),
    );
    // One buffer, one write: separate header writes show up on the wire as
    // separate small packets and the client stalls waiting for the body.
    let mut buf = Vec::with_capacity(head.len() + if head_only { 0 } else { body.len() });
    buf.extend_from_slice(head.as_bytes());
    if !head_only {
        buf.extend_from_slice(body);
    }
    out.write_all(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::FileTimes;
    use std::time::Duration;

    const GET_HEAD: &[u8] = b"GET /js/play.js?v=2 HTTP/1.1\r\n\
        Host: maze.example:8080\r\n\
        User-Agent: curl/8.0\r\n\
        Accept: */*\r\n\
        Connection: keep-alive\r\n\
        \r\n";

    fn temp_root(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("mazegame-http-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("js")).unwrap();
        dir
    }

    #[test]
    fn realistic_get_head_parses() {
        let request = parse_request(GET_HEAD).unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/js/play.js");
        assert_eq!(request.header("host"), Some("maze.example:8080"));
        assert_eq!(request.header("user-agent"), Some("curl/8.0"));
        assert_eq!(request.header("x-missing"), None);
        assert_eq!(request.param("v"), Some("2"));
        assert!(request.keep_alive());
    }

    #[test]
    fn connection_close_ends_keep_alive() {
        let head = b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert!(!request.keep_alive());
        // Absent header means keep-alive under HTTP/1.1.
        let bare = parse_request(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert!(bare.keep_alive());
    }

    #[test]
    fn query_is_split_and_decoded() {
        let head = b"GET /ws/play?name=a%20b&x=1 HTTP/1.1\r\nHost: x\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert_eq!(request.path, "/ws/play");
        assert_eq!(request.param("name"), Some("a b"));
        assert_eq!(request.param("x"), Some("1"));
        assert_eq!(request.param("nope"), None);
    }

    #[test]
    fn plus_is_a_space_in_values_only() {
        let head = b"GET /?a+b=c+d&e=%zz%2 HTTP/1.1\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert_eq!(request.param("a+b"), Some("c d"));
        // Broken escapes survive as typed rather than eating following bytes.
        assert_eq!(request.param("e"), Some("%zz%2"));
    }

    #[test]
    fn percent_encoded_path_decodes() {
        let head = b"GET /img/nix%20snowflake%2Ffoo.svg HTTP/1.1\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert_eq!(request.path, "/img/nix snowflake/foo.svg");
    }

    #[test]
    fn websocket_upgrade_detected() {
        let head = b"GET /ws/play HTTP/1.1\r\n\
            Host: x\r\n\
            Upgrade: WebSocket\r\n\
            Connection: Upgrade\r\n\
            Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
            Sec-WebSocket-Version: 13\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert!(request.is_websocket_upgrade());
        assert_eq!(
            request.header("sec-websocket-key"),
            Some("dGhlIHNhbXBsZSBub25jZQ==")
        );

        let keyless = b"GET /ws/play HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
        assert!(!parse_request(keyless).unwrap().is_websocket_upgrade());
        assert!(!parse_request(GET_HEAD).unwrap().is_websocket_upgrade());
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_request(b"").is_none());
        assert!(parse_request(b"not a request\r\n\r\n").is_none());
        assert!(parse_request(b"GET\r\n\r\n").is_none());
        assert!(parse_request(b"\x00\x01\x02\r\n\r\n").is_none());
        assert!(parse_request(b"GET relative HTTP/1.1\r\n\r\n").is_none());
    }

    #[test]
    fn junk_header_lines_are_ignored() {
        let head = b"GET / HTTP/1.1\r\nHost: x\r\nnonsense\r\nAccept: */*\r\n\r\n";
        let request = parse_request(head).unwrap();
        assert_eq!(request.headers.len(), 2);
        assert_eq!(request.header("accept"), Some("*/*"));
    }

    #[test]
    fn resolve_stays_inside_the_root() {
        let root = temp_root("resolve");
        fs::write(root.join("js/play.js"), b"export const x = 1;\n").unwrap();

        let files = StaticFiles::new(root.clone());
        let hit = files.resolve("/js/play.js").unwrap();
        assert!(hit.ends_with("js/play.js"));
        assert_eq!(files.resolve("/./js/../js/play.js"), Some(hit));

        assert_eq!(files.resolve("/../../etc/passwd"), None);
        assert_eq!(files.resolve("//etc/passwd"), None);
        assert_eq!(files.resolve("/js"), None); // a directory is not a file
        assert_eq!(files.resolve("/"), None);
        assert_eq!(files.resolve("/js/missing.js"), None);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn get_caches_until_mtime_moves() {
        let root = temp_root("cache");
        let path = root.join("js/play.js");
        fs::write(&path, b"one").unwrap();

        let files = StaticFiles::new(root.clone());
        let target = files.resolve("/js/play.js").unwrap();

        let (first, ctype) = files.get(&target).unwrap();
        assert_eq!(&first[..], b"one");
        assert_eq!(ctype, "text/javascript");

        let (second, _) = files.get(&target).unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        // Rewriting within the same filesystem timestamp tick would look
        // unchanged, so move the mtime explicitly.
        fs::write(&path, b"two!").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        let later = SystemTime::now() + Duration::from_secs(3600);
        file.set_times(FileTimes::new().set_modified(later))
            .unwrap();
        drop(file);

        let (third, _) = files.get(&target).unwrap();
        assert_eq!(&third[..], b"two!");
        assert!(!Arc::ptr_eq(&first, &third));

        fs::remove_file(&path).unwrap();
        assert!(files.get(&target).is_none());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn content_types_cover_the_site() {
        assert_eq!(
            content_type(Path::new("/a/index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("/a/style.css")), "text/css");
        assert_eq!(content_type(Path::new("/a/flake.svg")), "image/svg+xml");
        assert_eq!(content_type(Path::new("/a/wall.png")), "image/png");
        assert_eq!(content_type(Path::new("/a/favicon.ico")), "image/x-icon");
        assert_eq!(
            content_type(Path::new("/a/LICENSE")),
            "application/octet-stream"
        );
    }

    #[test]
    fn respond_writes_status_headers_and_body() {
        let mut out = Vec::new();
        respond(
            &mut out,
            200,
            b"hello",
            "text/plain; charset=utf-8",
            "no-store",
            false,
            "mazegame/2.0.0",
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
        assert!(text.contains("\r\nContent-Length: 5\r\n"), "{text}");
        assert!(text.contains("\r\nServer: mazegame/2.0.0\r\n"), "{text}");
        assert!(
            text.contains("\r\nContent-Type: text/plain; charset=utf-8\r\n"),
            "{text}"
        );
        assert!(text.contains("\r\nCache-Control: no-store\r\n"), "{text}");
        assert!(
            text.contains("\r\nConnection: keep-alive\r\n\r\n"),
            "{text}"
        );
        assert!(text.ends_with("\r\n\r\nhello"), "{text}");
    }

    #[test]
    fn head_only_keeps_the_length_but_drops_the_body() {
        let mut out = Vec::new();
        respond(&mut out, 200, b"hello", "text/css", "no-cache", true, "s").unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("\r\nContent-Length: 5\r\n"), "{text}");
        assert!(text.ends_with("\r\n\r\n"), "{text}");
        assert!(!text.contains("hello"), "{text}");
    }

    #[test]
    fn error_statuses_carry_their_reason() {
        for (status, phrase) in [
            (400u16, "400 Bad Request"),
            (404, "404 Not Found"),
            (405, "405 Method Not Allowed"),
            (500, "500 Internal Server Error"),
        ] {
            let mut out = Vec::new();
            respond(&mut out, status, b"x", "text/plain", "no-store", false, "s").unwrap();
            let text = String::from_utf8(out).unwrap();
            assert!(
                text.starts_with(&format!("HTTP/1.1 {phrase}\r\n")),
                "{text}"
            );
        }
    }
}
