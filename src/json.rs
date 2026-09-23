//! Just enough JSON for the control messages.
//!
//! Everything the server emits is assembled from known shapes, so there is no
//! serialiser here — only string quoting, which is the one place a player's
//! chosen name could break a frame. Positions go out as binary; this is for
//! the handful of text messages around them.

/// A JSON string literal, quotes included, escaped per RFC 8259.
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // Control characters, and the two line separators that are legal
            // JSON but illegal JavaScript source.
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One field out of a flat JSON object, without building a parser: the client
/// only ever sends `{"t":"pos","x":…,"y":…,"a":…}` and `{"t":"skip"}`.
pub fn field<'a>(message: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("\"{name}\"");
    let at = message.find(&needle)? + needle.len();
    let rest = message[at..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    if let Some(inner) = rest.strip_prefix('"') {
        let end = inner.find('"')?;
        return Some(&inner[..end]);
    }
    let end = rest
        .find([',', '}', ' ', '\n', '\r', '\t'])
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

pub fn number(message: &str, name: &str) -> Option<f32> {
    field(message, name)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_escape_what_would_break_a_frame() {
        assert_eq!(quote("plain"), "\"plain\"");
        assert_eq!(quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(quote("line\nbreak"), "\"line\\nbreak\"");
        assert_eq!(quote("\u{2028}"), "\"\\u2028\"");
        assert_eq!(quote("bell\u{07}"), "\"bell\\u0007\"");
    }

    #[test]
    fn fields_come_out_of_client_messages() {
        let msg = r#"{"t": "pos", "x": 12.5, "y": -3, "a": 0.75}"#;
        assert_eq!(field(msg, "t"), Some("pos"));
        assert_eq!(number(msg, "x"), Some(12.5));
        assert_eq!(number(msg, "y"), Some(-3.0));
        assert_eq!(number(msg, "a"), Some(0.75));
        assert_eq!(field(msg, "missing"), None);
    }

    #[test]
    fn a_name_cannot_smuggle_out_of_its_string() {
        // A player called `","t":"world` must not be able to forge a message.
        let forged = quote("\",\"t\":\"world");
        assert!(!forged[1..forged.len() - 1].contains("\",\""));
    }
}
