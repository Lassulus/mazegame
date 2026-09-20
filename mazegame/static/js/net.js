// Tiny reconnecting JSON-over-WebSocket client.

const HEARTBEAT_MS = 3000; // server drops sockets that go quiet

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
