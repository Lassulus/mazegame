// The end-of-round board: who escaped, in order, shown to everyone while they
// wait on their new spawn for the next maze to open. The server sends the
// first ten in the `world` message that starts the next round, with the
// total count and how long the pause lasts.

const MEDALS = ["gold", "silver", "bronze"];

let hideTimer = 0;
let tickTimer = 0;

function clock(secs) {
  const whole = Math.max(0, Math.floor(secs));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function cell(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Show the board in `el` for the pause the message asks for; `me` (a name)
 * is highlighted. Returns the pause in ms, 0 if there is nothing to show.
 */
export function showResults(el, msg, { me = null } = {}) {
  const pause = (msg.pause || 0) * 1000;
  const results = msg.results || [];
  if (!el || !results.length || pause <= 0) return 0;
  clearTimeout(hideTimer);
  clearInterval(tickTimer);

  const panel = document.createElement("div");
  panel.className = "results-panel";
  panel.append(cell("div", "results-title", "round over"));
  const escaped = msg.escaped || results.length;
  panel.append(cell("div", "results-sub", `${escaped} escaped`));

  const list = document.createElement("ol");
  list.className = "results-list";
  for (const r of results) {
    const row = document.createElement("li");
    row.className = `results-row ${MEDALS[r.place - 1] || ""}`;
    if (me && r.name === me) row.classList.add("me");
    row.append(
      cell("span", "results-place", String(r.place)),
      cell("span", "results-name", r.name),
      cell("span", "results-runs", r.runs > 1 ? `×${r.runs}` : ""),
      cell("span", "results-time", clock(r.secs)),
    );
    list.append(row);
  }
  panel.append(list);
  if (escaped > results.length) panel.append(cell("div", "results-more", `+ ${escaped - results.length} more`));

  const next = cell("div", "results-next", "");
  panel.append(next);
  const ends = performance.now() + pause;
  const tick = () => {
    next.textContent = `next maze in ${Math.max(1, Math.ceil((ends - performance.now()) / 1000))}`;
  };
  tick();
  tickTimer = setInterval(tick, 250);

  el.replaceChildren(panel);
  el.classList.remove("hidden");
  hideTimer = setTimeout(() => {
    clearInterval(tickTimer);
    el.classList.add("hidden");
  }, pause);
  return pause;
}
