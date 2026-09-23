// Phone controls: one floating stick, anywhere on the screen. Wherever the
// thumb lands becomes the centre; up/down walks, sideways steers.

const STICK_R = 58; // px of travel for full deflection
const BOOST_AT = 0.92; // stick deflection that counts as running

export const isTouch =
  matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

export function createTouchControls(surface, { base, thumb } = {}) {
  const ctl = {
    forward: 0, // -1..1
    steer: 0, // -1..1, scaled by the player's turn rate
    boost: false,
    used: false,
  };

  let moveId = null;
  let originX = 0;
  let originY = 0;

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
      if (e.pointerType !== "touch" || moveId !== null) return;
      moveId = e.pointerId;
      originX = e.clientX;
      originY = e.clientY;
      showStick(originX, originY);
      ctl.used = true;
      surface.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    { passive: false },
  );

  surface.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerId !== moveId) return;
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
    },
    { passive: false },
  );

  const end = (e) => {
    if (e.pointerId === moveId) release();
  };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
  addEventListener("blur", release);

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
