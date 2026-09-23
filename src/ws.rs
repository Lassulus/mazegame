//! Minimal RFC 6455 WebSocket framing. Standard library only.
//!
//! Only what the maze game needs: text frames, ping/pong, close. No
//! extensions, no compression, server role only. Parsing is incremental and
//! buffer driven — there is no socket in here, the reader thread owns it.

use std::fmt;

const GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const OP_CONT: u8 = 0x0;
pub const OP_TEXT: u8 = 0x1;
pub const OP_BIN: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;

pub const MAX_PAYLOAD: usize = 1 << 20;

/// Protocol violation. The only cure is closing the connection, so the
/// message is a static string for the log line and nothing else.
#[derive(Debug)]
pub struct WsError(pub &'static str);

impl fmt::Display for WsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for WsError {}

/// Compute the Sec-WebSocket-Accept response value.
pub fn accept_key(client_key: &str) -> String {
    let mut buf = Vec::with_capacity(client_key.len() + GUID.len());
    buf.extend_from_slice(client_key.trim().as_bytes());
    buf.extend_from_slice(GUID);
    base64(&sha1(&buf))
}

/// One unmasked server frame, header and body in a single buffer.
pub fn build_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let n = payload.len();
    let mut frame = Vec::with_capacity(n + 10);
    frame.push(0x80 | opcode);
    if n < 126 {
        frame.push(n as u8);
    } else if n < (1 << 16) {
        frame.push(126);
        frame.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(n as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    frame
}

pub fn text_frame(text: &str) -> Vec<u8> {
    build_frame(OP_TEXT, text.as_bytes())
}

/// Snapshots go out as binary: eleven bytes a body, no JSON to parse.
pub fn binary_frame(payload: &[u8]) -> Vec<u8> {
    build_frame(OP_BIN, payload)
}

/// Turns a byte stream into complete messages.
pub struct Framer {
    buf: Vec<u8>,
    parts: Vec<u8>,
    /// Opcode of the fragmented message in progress, 0 when idle.
    kind: u8,
}

impl Framer {
    pub fn new() -> Self {
        Framer {
            buf: Vec::new(),
            parts: Vec::new(),
            kind: 0,
        }
    }

    /// Feed a chunk read from the socket; push every message that completed in
    /// it as `(opcode, payload)`. Text/binary arrive whole with continuations
    /// joined; control frames pass straight through. Partial frames stay
    /// buffered for the next call.
    pub fn feed(&mut self, data: &[u8], out: &mut Vec<(u8, Vec<u8>)>) -> Result<(), WsError> {
        self.buf.extend_from_slice(data);
        // Consume by cursor and compact once at the end: draining per frame
        // memmoves the whole tail for every message in a batched read.
        let mut pos = 0usize;
        let result = loop {
            let buf = &self.buf[pos..];
            if buf.len() < 2 {
                break Ok(());
            }
            let first = buf[0];
            let second = buf[1];
            let fin = first & 0x80 != 0;
            let opcode = first & 0x0F;
            let masked = second & 0x80 != 0;
            let mut length = u64::from(second & 0x7F);
            let mut offset = 2usize;
            if length == 126 {
                if buf.len() < 4 {
                    break Ok(());
                }
                length = u64::from(u16::from_be_bytes([buf[2], buf[3]]));
                offset = 4;
            } else if length == 127 {
                if buf.len() < 10 {
                    break Ok(());
                }
                length = u64::from_be_bytes(buf[2..10].try_into().unwrap());
                offset = 10;
            }
            if length > MAX_PAYLOAD as u64 {
                break Err(WsError("payload too large"));
            }
            let length = length as usize;
            if !masked {
                // Clients must mask; browsers always do.
                break Err(WsError("unmasked client frame"));
            }
            if buf.len() < offset + 4 {
                break Ok(());
            }
            let mask: [u8; 4] = buf[offset..offset + 4].try_into().unwrap();
            offset += 4;
            let end = offset + length;
            if buf.len() < end {
                break Ok(());
            }
            let mut payload = buf[offset..end].to_vec();
            pos += end;
            unmask(&mut payload, mask);

            if opcode & 0x8 != 0 {
                // Control frames are never fragmented and never large.
                if !fin || length > 125 {
                    break Err(WsError("bad control frame"));
                }
                out.push((opcode, payload));
                continue;
            }
            match opcode {
                OP_CONT => {
                    if self.kind == 0 {
                        break Err(WsError("continuation without start"));
                    }
                    self.parts.extend_from_slice(&payload);
                }
                OP_TEXT | OP_BIN => {
                    if self.kind != 0 {
                        break Err(WsError("nested data frame"));
                    }
                    if fin {
                        // Unfragmented, the common case: hand the buffer over
                        // as is instead of copying it through `parts`.
                        out.push((opcode, payload));
                        continue;
                    }
                    self.kind = opcode;
                    self.parts.extend_from_slice(&payload);
                }
                _ => break Err(WsError("unsupported opcode")),
            }
            if fin {
                out.push((self.kind, std::mem::take(&mut self.parts)));
                self.kind = 0;
            }
        };
        if pos > 0 {
            self.buf.drain(..pos);
        }
        result
    }
}

impl Default for Framer {
    fn default() -> Self {
        Self::new()
    }
}

fn unmask(payload: &mut [u8], mask: [u8; 4]) {
    let mut chunks = payload.chunks_exact_mut(4);
    for chunk in &mut chunks {
        chunk[0] ^= mask[0];
        chunk[1] ^= mask[1];
        chunk[2] ^= mask[2];
        chunk[3] ^= mask[3];
    }
    for (i, byte) in chunks.into_remainder().iter_mut().enumerate() {
        *byte ^= mask[i];
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b1 = u32::from(chunk[0]);
        let b2 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b3 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b1 << 16) | (b2 << 8) | b3;
        out.push(B64[(n >> 18) as usize & 0x3F] as char);
        out.push(B64[(n >> 12) as usize & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut chunks = data.chunks_exact(64);
    for block in &mut chunks {
        sha1_block(&mut h, block.try_into().unwrap());
    }
    // Tail: the 0x80 terminator plus the 64 bit length may or may not fit in
    // the same block, so lay out two and hash however many are used.
    let rest = chunks.remainder();
    let mut tail = [0u8; 128];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] = 0x80;
    let used = if rest.len() + 9 > 64 { 128 } else { 64 };
    let bits = (data.len() as u64).wrapping_mul(8);
    tail[used - 8..used].copy_from_slice(&bits.to_be_bytes());
    for block in tail[..used].chunks_exact(64) {
        sha1_block(&mut h, block.try_into().unwrap());
    }

    let mut out = [0u8; 20];
    for (word, slot) in h.iter().zip(out.chunks_exact_mut(4)) {
        slot.copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn sha1_block(h: &mut [u32; 5], block: &[u8; 64]) {
    let mut w = [0u32; 80];
    for (word, src) in w.iter_mut().zip(block.chunks_exact(4)) {
        *word = u32::from_be_bytes(src.try_into().unwrap());
    }
    for i in 16..80 {
        w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
    }

    let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
    for (i, &wi) in w.iter().enumerate() {
        let (f, k) = match i {
            0..20 => ((b & c) | (!b & d), 0x5A82_7999),
            20..40 => (b ^ c ^ d, 0x6ED9_EBA1),
            40..60 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
            _ => (b ^ c ^ d, 0xCA62_C1D6),
        };
        let temp = a
            .rotate_left(5)
            .wrapping_add(f)
            .wrapping_add(e)
            .wrapping_add(k)
            .wrapping_add(wi);
        e = d;
        d = c;
        c = b.rotate_left(30);
        b = a;
        a = temp;
    }

    h[0] = h[0].wrapping_add(a);
    h[1] = h[1].wrapping_add(b);
    h[2] = h[2].wrapping_add(c);
    h[3] = h[3].wrapping_add(d);
    h[4] = h[4].wrapping_add(e);
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASK: [u8; 4] = [0x37, 0xFA, 0x21, 0x3D];

    /// Re-emit a server frame the way a browser would send it: mask bit set,
    /// key inserted, payload XORed. Exercises `build_frame`'s header forms.
    fn mask_frame(frame: &[u8], key: [u8; 4]) -> Vec<u8> {
        let header = match frame[1] & 0x7F {
            126 => 4,
            127 => 10,
            _ => 2,
        };
        let mut out = Vec::with_capacity(frame.len() + 4);
        out.extend_from_slice(&frame[..header]);
        out[1] |= 0x80;
        out.extend_from_slice(&key);
        out.extend(
            frame[header..]
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ key[i % 4]),
        );
        out
    }

    fn drain(framer: &mut Framer, data: &[u8]) -> Vec<(u8, Vec<u8>)> {
        let mut out = Vec::new();
        framer.feed(data, &mut out).expect("feed");
        out
    }

    #[test]
    fn rfc6455_accept_key_vector() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        // Headers arrive with the CRLF still attached often enough to matter.
        assert_eq!(
            accept_key("  dGhlIHNhbXBsZSBub25jZQ==\r\n"),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn sha1_and_base64_known_vectors() {
        assert_eq!(
            sha1(b"abc"),
            [
                0xA9, 0x99, 0x3E, 0x36, 0x47, 0x06, 0x81, 0x6A, 0xBA, 0x3E, 0x25, 0x71, 0x78, 0x50,
                0xC2, 0x6C, 0x9C, 0xD0, 0xD8, 0x9D
            ]
        );
        // Padding boundaries: 55 bytes is the last length whose terminator and
        // 64 bit length still fit one block, 56 forces a second, 64 leaves no
        // remainder at all.
        assert_eq!(
            sha1(&[b'a'; 55]),
            [
                0xC1, 0xC8, 0xBB, 0xDC, 0x22, 0x79, 0x6E, 0x28, 0xC0, 0xE1, 0x51, 0x63, 0xD2, 0x08,
                0x99, 0xB6, 0x56, 0x21, 0xD6, 0x5A
            ]
        );
        assert_eq!(
            sha1(&[b'a'; 56]),
            [
                0xC2, 0xDB, 0x33, 0x0F, 0x60, 0x83, 0x85, 0x4C, 0x99, 0xD4, 0xB5, 0xBF, 0xB6, 0xE8,
                0xF2, 0x9F, 0x20, 0x1B, 0xE6, 0x99
            ]
        );
        assert_eq!(
            sha1(&[b'a'; 64]),
            [
                0x00, 0x98, 0xBA, 0x82, 0x4B, 0x5C, 0x16, 0x42, 0x7B, 0xD7, 0xA1, 0x12, 0x2A, 0x5A,
                0x44, 0x2A, 0x25, 0xEC, 0x64, 0x4D
            ]
        );
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn round_trip_7bit_length() {
        let frame = text_frame("hello");
        assert_eq!(&frame[..2], &[0x81, 5]);
        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &mask_frame(&frame, MASK)),
            vec![(OP_TEXT, b"hello".to_vec())]
        );
    }

    #[test]
    fn round_trip_16bit_length() {
        let payload = vec![0xA5u8; 4096];
        let frame = binary_frame(&payload);
        assert_eq!(&frame[..4], &[0x82, 126, 0x10, 0x00]);
        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &mask_frame(&frame, MASK)),
            vec![(OP_BIN, payload)]
        );
    }

    #[test]
    fn round_trip_64bit_length() {
        let payload: Vec<u8> = (0..70 * 1024).map(|i| (i % 251) as u8).collect();
        let frame = binary_frame(&payload);
        assert_eq!(frame[1], 127);
        assert_eq!(&frame[2..10], &(payload.len() as u64).to_be_bytes());
        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &mask_frame(&frame, MASK)),
            vec![(OP_BIN, payload)]
        );
    }

    #[test]
    fn message_split_across_three_feeds() {
        let wire = mask_frame(&text_frame("split me apart"), MASK);
        let mut framer = Framer::new();
        // First cut lands inside the header, second inside the payload.
        assert!(drain(&mut framer, &wire[..1]).is_empty());
        assert!(drain(&mut framer, &wire[1..7]).is_empty());
        assert_eq!(
            drain(&mut framer, &wire[7..]),
            vec![(OP_TEXT, b"split me apart".to_vec())]
        );
    }

    #[test]
    fn two_messages_in_one_feed() {
        let mut wire = mask_frame(&text_frame("one"), MASK);
        wire.extend_from_slice(&mask_frame(&text_frame("two"), [1, 2, 3, 4]));
        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &wire),
            vec![(OP_TEXT, b"one".to_vec()), (OP_TEXT, b"two".to_vec())]
        );
    }

    #[test]
    fn fragmented_text_message_is_joined() {
        let mut wire = mask_frame(&build_frame(OP_TEXT, b"frag"), MASK);
        wire[0] &= 0x7F; // clear FIN on the opener
        let mut middle = mask_frame(&build_frame(OP_CONT, b"ment"), MASK);
        middle[0] &= 0x7F;
        wire.extend_from_slice(&middle);
        wire.extend_from_slice(&mask_frame(&build_frame(OP_CONT, b"ed!"), MASK));

        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &wire),
            vec![(OP_TEXT, b"fragmented!".to_vec())]
        );
        // A fresh message after the fragmented one still works.
        assert_eq!(
            drain(&mut framer, &mask_frame(&text_frame("after"), MASK)),
            vec![(OP_TEXT, b"after".to_vec())]
        );
    }

    #[test]
    fn control_frames_pass_through() {
        let mut wire = mask_frame(&build_frame(OP_PING, b"pingdata"), MASK);
        wire.extend_from_slice(&mask_frame(&build_frame(OP_CLOSE, &[0x03, 0xE8]), MASK));
        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &wire),
            vec![
                (OP_PING, b"pingdata".to_vec()),
                (OP_CLOSE, vec![0x03, 0xE8]),
            ]
        );
    }

    #[test]
    fn control_frame_interleaved_in_fragmented_message() {
        let mut wire = mask_frame(&build_frame(OP_TEXT, b"a"), MASK);
        wire[0] &= 0x7F;
        wire.extend_from_slice(&mask_frame(&build_frame(OP_PING, b""), MASK));
        wire.extend_from_slice(&mask_frame(&build_frame(OP_CONT, b"b"), MASK));
        let mut framer = Framer::new();
        assert_eq!(
            drain(&mut framer, &wire),
            vec![(OP_PING, Vec::new()), (OP_TEXT, b"ab".to_vec())]
        );
    }

    fn err(wire: &[u8]) -> String {
        let mut framer = Framer::new();
        let mut out = Vec::new();
        framer
            .feed(wire, &mut out)
            .expect_err("expected protocol error")
            .0
            .to_string()
    }

    #[test]
    fn unmasked_client_frame_is_rejected() {
        assert_eq!(err(&text_frame("nope")), "unmasked client frame");
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let mut wire = vec![0x82, 0x80 | 127];
        wire.extend_from_slice(&((MAX_PAYLOAD as u64) + 1).to_be_bytes());
        wire.extend_from_slice(&MASK);
        assert_eq!(err(&wire), "payload too large");

        // The 16 bit form stays under the cap, so it must still parse.
        let mut ok = vec![0x82, 0x80 | 126, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00];
        ok.extend(std::iter::repeat_n(0u8, 0xFFFF));
        let mut framer = Framer::new();
        assert_eq!(drain(&mut framer, &ok).len(), 1);
    }

    #[test]
    fn continuation_without_start_is_rejected() {
        let wire = mask_frame(&build_frame(OP_CONT, b"orphan"), MASK);
        assert_eq!(err(&wire), "continuation without start");
    }

    #[test]
    fn nested_data_frame_is_rejected() {
        let mut wire = mask_frame(&build_frame(OP_TEXT, b"first"), MASK);
        wire[0] &= 0x7F;
        wire.extend_from_slice(&mask_frame(&text_frame("second"), MASK));
        assert_eq!(err(&wire), "nested data frame");
    }

    #[test]
    fn bad_control_frames_are_rejected() {
        let mut fragmented = mask_frame(&build_frame(OP_PING, b"x"), MASK);
        fragmented[0] &= 0x7F;
        assert_eq!(err(&fragmented), "bad control frame");

        let long = mask_frame(&build_frame(OP_CLOSE, &[0u8; 126]), MASK);
        assert_eq!(err(&long), "bad control frame");
    }

    #[test]
    fn unknown_opcode_is_rejected() {
        let wire = mask_frame(&build_frame(0x3, b"reserved"), MASK);
        assert_eq!(err(&wire), "unsupported opcode");
    }
}
