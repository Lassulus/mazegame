// Tiny reconnecting WebSocket client. Control traffic is JSON; position
// snapshots arrive as binary, twelve bytes a body plus five a ghost, and are
// decoded here so the pages only ever see `{ t: "peers", … }`.

const HEARTBEAT_MS = 3000; // server drops sockets that go quiet
const PEERS_FRAME = 1;
const POS_SCALE = 1000; // world units per unit of the u16 position field
const ANGLE_SCALE = (Math.PI * 2) / 65536;
const BODY = 12; // bytes: u32 id, u16 x, u16 y, u16 angle, u8 flags, u8 age
const GHOST = 5; // bytes: u8 id, u16 x, u16 y
const HEAD = 10; // bytes: u8 type, u8 hz, u16 players, u32 tick clock, u16 count
const AGE_STEP = 2; // ms per unit of the age field

// Bits of a body's flags byte.
export const FINISHED = 1; // escaped this round (drawn NixOS blue)
export const FLIPPED = 2; // walking on the ceiling
export const POWERED = 4; // ate a cherry and can eat ghosts

// { t, hz, n, clock, l: [[id, x, y, angle, flags, age], …], g: [[id, x, y], …] }.
// Names are not in here — they arrive once, in their own message — and
// every body carries how stale it was when the snapshot went out, so
// playback can put it where it actually was rather than where the tick
// happened to catch it. Ghosts follow the bodies: every living one, every
// frame, true at the tick itself.
function decodePeers(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < HEAD || view.getUint8(0) !== PEERS_FRAME) return null;
  const hz = view.getUint8(1);
  const n = view.getUint16(2, true);
  const clock = view.getUint32(4, true);
  const count = view.getUint16(8, true);
  const list = new Array(count);
  for (let i = 0; i < count; i++) {
    const at = HEAD + i * BODY;
    list[i] = [
      view.getUint32(at, true),
      view.getUint16(at + 4, true) / POS_SCALE,
      view.getUint16(at + 6, true) / POS_SCALE,
      view.getUint16(at + 8, true) * ANGLE_SCALE,
      view.getUint8(at + 10),
      view.getUint8(at + 11) * AGE_STEP,
    ];
  }
  let at = HEAD + count * BODY;
  const ghosts = [];
  if (at < view.byteLength) {
    const living = view.getUint8(at++);
    for (let i = 0; i < living && at + GHOST <= view.byteLength; i++, at += GHOST) {
      ghosts.push([
        view.getUint8(at),
        view.getUint16(at + 1, true) / POS_SCALE,
        view.getUint16(at + 3, true) / POS_SCALE,
      ]);
    }
  }
  return { t: "peers", hz, n, clock, l: list, g: ghosts };
}

export function createSocket(path, { onMessage, onOpen, onStatus } = {}) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  let socket = null;
  let closed = false;
  let backoff = 400;
  let beat = null;

  const status = (text, kind) => onStatus && onStatus(text, kind);

  function open() {
    if (closed) return;
    status("connecting…", "pending");
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      backoff = 400;
      status("live", "ok");
      clearInterval(beat);
      beat = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send('{"t":"ping"}');
      }, HEARTBEAT_MS);
      onOpen && onOpen();
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const msg = decodePeers(event.data);
        if (msg) onMessage && onMessage(msg);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage && onMessage(msg);
    };
    socket.onclose = () => {
      clearInterval(beat);
      if (closed) return;
      status("offline — retrying", "bad");
      setTimeout(open, backoff);
      backoff = Math.min(5000, backoff * 1.8);
    };
    socket.onerror = () => socket && socket.close();
  }

  open();

  // Leaving the page must free the slot immediately, otherwise a watcher
  // could keep following a tab that is no longer there.
  addEventListener("pagehide", () => {
    closed = true;
    clearInterval(beat);
    socket && socket.close();
  });

  return {
    send(payload) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
        return true;
      }
      return false;
    },
    get live() {
      return !!socket && socket.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      socket && socket.close();
    },
  };
}
