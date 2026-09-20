// Phone controls. One thumb is enough: the floating stick on the left half
// steers (X) and walks (Y). Dragging anywhere on the right half also turns the
// view, for players who want a second thumb on it.

const STICK_R = 58; // px of travel for full deflection
const LOOK_SENS = 0.0055; // radians per css pixel
const BOOST_AT = 0.92; // stick deflection that counts as running

export const isTouch =
  matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

export function createTouchControls(surface, { base, thumb } = {}) {
  const ctl = {
    forward: 0, // -1..1
    steer: 0, // -1..1, scaled by the player's turn rate
    boost: false,
    used: false,
    turn: 0, // radians banked by right-half drags
    takeTurn() {
      const t = ctl.turn;
      ctl.turn = 0;
      return t;
    },
  };

  let moveId = null;
  let lookId = null;
  let originX = 0;
  let originY = 0;
  let lastLookX = 0;

  const place = (el, x, y) => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  function showStick(x, y) {
    if (!base) return;
    place(base, x, y);
    place(thumb, x, y);
    base.classList.add("on");
    thumb.classList.add("on");
  }

  function hideStick() {
    if (!base) return;
    base.classList.remove("on");
    thumb.classList.remove("on");
  }

  function release() {
    moveId = null;
    ctl.forward = 0;
    ctl.steer = 0;
    ctl.boost = false;
    hideStick();
  }

  surface.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch") return;
      const leftHalf = e.clientX < innerWidth * 0.5;
      if (leftHalf && moveId === null) {
        moveId = e.pointerId;
        originX = e.clientX;
        originY = e.clientY;
        showStick(originX, originY);
      } else if (!leftHalf && lookId === null) {
        lookId = e.pointerId;
        lastLookX = e.clientX;
      } else {
        return;
      }
      ctl.used = true;
      surface.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    { passive: false },
  );

  surface.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerId === moveId) {
        let dx = e.clientX - originX;
        let dy = e.clientY - originY;
        const len = Math.hypot(dx, dy);
        if (len > STICK_R) {
          dx = (dx * STICK_R) / len;
          dy = (dy * STICK_R) / len;
        }
        if (thumb) place(thumb, originX + dx, originY + dy);
        ctl.steer = dx / STICK_R;
        ctl.forward = -dy / STICK_R;
        // Only a hard forward shove counts as running.
        ctl.boost = -dy / STICK_R > BOOST_AT;
        e.preventDefault();
      } else if (e.pointerId === lookId) {
        ctl.turn += (e.clientX - lastLookX) * LOOK_SENS;
        lastLookX = e.clientX;
        e.preventDefault();
      }
    },
    { passive: false },
  );

  const end = (e) => {
    if (e.pointerId === moveId) release();
    else if (e.pointerId === lookId) lookId = null;
  };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
  addEventListener("blur", () => {
    release();
    lookId = null;
  });

  return ctl;
}

export function wireFullscreen(button) {
  if (!button) return;
  button.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      /* iOS Safari refuses; the page still works without it */
    }
  });
}
