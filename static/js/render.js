// Textured raycaster: the Windows 95 "Maze" look, done with a DDA grid walk
// and per-pixel writes into an ImageData buffer.

import { EMPTY, EXIT, tileAt } from "./maze.js";
import {
  CHERRY_RED, CHERRY_SHINE, CHERRY_STEM, GHOST_BODY, GHOST_PUPIL, GHOST_WHITE,
  LEVELS, PAWN_SHADES, ROCK_FRAMES, ROCK_SHADES, loadTextures,
} from "./textures.js";

const FOG_DIST = 14; // tiles until full darkness
const MAX_STEPS = 128;
const MIN_PLANE = 0.75; // ~74 degrees horizontal, the narrowest we allow
const PAWN_HEIGHT = 0.72; // world units, a bit shorter than a wall
const FINISHED_COLOR = [126, 186, 228]; // NixOS blue for players who escaped
const NEAR_PAWN = 0.45; // closer than this a sprite is just a wall of colour
const MAX_SPRITES = 64; // hard cap on sprites per frame
const SPRITE_FILL_BUDGET = 2.5; // screenfuls of sprite fill allowed per frame
const GHOST_HEIGHT = 0.62;
const GHOST_HOVER = 0.06; // ghosts float a hair above the floor
const GHOST_STEP_MS = 170; // how often the hem swaps frames
const CHERRY_SIZE = 0.26;
// Rocks hang at eye height, so they look the same from the floor and from
// the ceiling.
const ROCK_SIZE = 0.34;
const ROCK_SPIN = 0.6; // turns per second
const FLASH_MS = 2000; // frightened ghosts blink white for the last of the power

// Blinky, Pinky, Inky, Clyde, and two more for a maze this size.
export const GHOST_COLORS = [
  [255, 32, 32], [255, 170, 230], [40, 230, 255], [255, 170, 70], [90, 240, 110], [190, 120, 255],
];

const SPRITE_PAWN = 0;
const SPRITE_GHOST = 1;
const SPRITE_CHERRY = 2;
const SPRITE_ROCK = 3;

// Stable per-player hue: golden-angle spacing keeps neighbours distinct.
export function playerColor(id) {
  const h = ((id * 137.508) % 360) / 360;
  const s = 0.62;
  const l = 0.6;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

// One packed colour per shade step, rebuilt per pawn per frame (16 entries).
const rampScratch = new Uint32Array(PAWN_SHADES);
function colorRamp(r, g, b, fog) {
  for (let i = 1; i < PAWN_SHADES; i++) {
    const k = (fog * i) / (PAWN_SHADES - 1);
    rampScratch[i] =
      (0xff000000 | (((b * k) | 0) << 16) | (((g * k) | 0) << 8) | ((r * k) | 0)) >>> 0;
  }
  return rampScratch;
}

// Palettes for the sprites whose indices are colour roles, not brightness:
// fully lit colours per index, fogged into `rampScratch` at draw time.
function shadeRange(palette, from, to, [r, g, b], low) {
  for (let i = from; i <= to; i++) {
    const k = low + ((1 - low) * (i - from)) / Math.max(1, to - from);
    palette[i] = [r * k, g * k, b * k];
  }
  return palette;
}
function ghostPalette(body, face, pupil) {
  const palette = shadeRange(new Array(PAWN_SHADES).fill(null), 1, GHOST_BODY, body, 0.3);
  palette[GHOST_WHITE] = face;
  palette[GHOST_PUPIL] = pupil;
  return palette;
}
const GHOST_PALETTES = GHOST_COLORS.map((c) => ghostPalette(c, [236, 236, 255], [30, 48, 210]));
const SCARED_PALETTE = ghostPalette([36, 52, 225], [255, 200, 165], [0, 0, 0]);
const FLASH_PALETTE = ghostPalette([236, 236, 246], [230, 40, 40], [0, 0, 0]);
const CHERRY_PALETTE = shadeRange(new Array(PAWN_SHADES).fill(null), 1, CHERRY_RED, [228, 22, 44], 0.3);
shadeRange(CHERRY_PALETTE, CHERRY_RED + 1, CHERRY_STEM, [96, 176, 64], 0.45);
CHERRY_PALETTE[CHERRY_SHINE] = [255, 240, 240];
const ROCK_PALETTE = shadeRange(new Array(PAWN_SHADES).fill(null), 1, ROCK_SHADES, [196, 196, 204], 0.12);

function paletteRamp(palette, fog) {
  for (let i = 1; i < PAWN_SHADES; i++) {
    const c = palette[i];
    if (!c) continue;
    rampScratch[i] =
      (0xff000000 | (((c[2] * fog) | 0) << 16) | (((c[1] * fog) | 0) << 8) | ((c[0] * fog) | 0)) >>> 0;
  }
  return rampScratch;
}

// Phones have few CSS pixels to spare; keep the chunky look without turning
// the view into confetti.
export const retroPixel = () => (Math.min(innerWidth, innerHeight) < 600 ? 2 : 3);

// Turning over, like the screensaver: half a turn about the line of sight,
// eased at both ends. Progress runs 0 (feet on the floor) to 1 (on the
// ceiling); the angle is what `draw` takes as `roll`.
const ROLL_TIME = 0.9; // seconds for the half turn
export function stepRoll(progress, upside, dt) {
  const step = dt / ROLL_TIME;
  return upside ? Math.min(1, progress + step) : Math.max(0, progress - step);
}
export const rollAngle = (progress) => Math.PI * progress * progress * (3 - 2 * progress);

export class Renderer {
  constructor(canvas, { pixel = 3, maxWidth = 640, fov = 1.15 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.pixel = pixel;
    this.maxWidth = maxWidth;
    this.fov = fov;
    this.w = 0;
    this.h = 0;
    this.tex = null;
  }

  async init() {
    this.tex = await loadTextures();
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(160, rect.width || this.canvas.clientWidth || 640);
    const cssH = Math.max(120, rect.height || this.canvas.clientHeight || 360);
    const w = Math.min(this.maxWidth, Math.max(160, Math.round(cssW / this.pixel)));
    const h = Math.max(120, Math.round((w * cssH) / cssW));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.px = new Uint32Array(this.image.data.buffer);
    this.zbuf = new Float32Array(w);
    this.ctx.imageSmoothingEnabled = false;
    // The rolled view (walking on the ceiling, and the turn getting there) is
    // rendered upright here and rotated onto the visible canvas.
    this.back = document.createElement("canvas");
    this.back.width = w;
    this.back.height = h;
    this.backCtx = this.back.getContext("2d", { alpha: false });
  }

  /**
   * `scene`: `peers` (other players), `ghosts` ({id, x, y}), `cherries` and
   * `rocks` ({x, y, kind}), `roll` (radians the view is turned about its own
   * axis; pi is upside down), `now` (ms, drives animation) and `power` (ms of
   * cherry power the viewer has left; ghosts look frightened while it lasts).
   */
  draw(maze, cam, scene = {}) {
    if (!this.tex || !this.w) return [];
    const { w, h, px } = this;
    // Vertical FOV is fixed on wide screens; on a portrait phone that would
    // leave a peephole, so the horizontal FOV gets a floor instead.
    let tanV = Math.tan(this.fov / 2);
    let planeLen = tanV * (w / h);
    if (planeLen < MIN_PLANE) {
      planeLen = MIN_PLANE;
      tanV = (planeLen * h) / w;
    }
    const lineScale = h / (2 * tanV);
    const dirX = Math.cos(cam.a);
    const dirY = Math.sin(cam.a);
    const planeX = -dirY * planeLen;
    const planeY = dirX * planeLen;
    const half = h / 2;

    this.#drawFloorCeiling(maze, cam, dirX, dirY, planeX, planeY, lineScale, half);

    const wallTex = this.tex.wall;
    const exitTex = this.tex.exit;

    for (let x = 0; x < w; x++) {
      const camX = (2 * x) / w - 1;
      const rdx = dirX + planeX * camX;
      const rdy = dirY + planeY * camX;
      let mapX = Math.floor(cam.x);
      let mapY = Math.floor(cam.y);
      const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      let stepX;
      let stepY;
      let sideX;
      let sideY;
      if (rdx < 0) {
        stepX = -1;
        sideX = (cam.x - mapX) * ddx;
      } else {
        stepX = 1;
        sideX = (mapX + 1 - cam.x) * ddx;
      }
      if (rdy < 0) {
        stepY = -1;
        sideY = (cam.y - mapY) * ddy;
      } else {
        stepY = 1;
        sideY = (mapY + 1 - cam.y) * ddy;
      }

      let side = 0;
      let tile = EMPTY;
      for (let step = 0; step < MAX_STEPS; step++) {
        if (sideX < sideY) {
          sideX += ddx;
          mapX += stepX;
          side = 0;
        } else {
          sideY += ddy;
          mapY += stepY;
          side = 1;
        }
        tile = tileAt(maze, mapX, mapY);
        if (tile !== EMPTY) break;
      }
      if (tile === EMPTY) {
        this.zbuf[x] = 1e9;
        continue;
      }

      const perp = Math.max(0.0001, side === 0 ? sideX - ddx : sideY - ddy);
      this.zbuf[x] = perp;
      const tex = tile === EXIT ? exitTex : wallTex;

      let wallX = side === 0 ? cam.y + perp * rdy : cam.x + perp * rdx;
      wallX -= Math.floor(wallX);
      let texX = (wallX * tex.size) | 0;
      if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) texX = tex.size - 1 - texX;

      let level = LEVELS - 1 - Math.round((perp / FOG_DIST) * (LEVELS - 1));
      if (side === 1) level -= 2;
      level = level < 0 ? 0 : level > LEVELS - 1 ? LEVELS - 1 : level;
      const lut = tex.levels[level];

      const lineH = lineScale / perp;
      const top = half - lineH / 2;
      const y0 = Math.max(0, Math.ceil(top));
      const y1 = Math.min(h - 1, Math.floor(top + lineH));
      const stepTex = tex.size / lineH;
      let texPos = (y0 - top) * stepTex;
      const shift = tex.shift;
      const mask = tex.mask;
      let offset = y0 * w + x;
      for (let y = y0; y <= y1; y++) {
        px[offset] = lut[((texPos & mask) << shift) | texX];
        texPos += stepTex;
        offset += w;
      }
    }

    const labels = this.#drawSprites(cam, scene, dirX, dirY, planeX, planeY, lineScale, half);
    return this.#present(labels, scene.roll || 0);
  }

  // Upright views go straight to the canvas. A rolled one is turned about the
  // centre and zoomed just enough that the corners never show: at a quarter
  // turn a wide screen is covered by its own height, and at a half turn the
  // zoom is back to one, so upside down is pixel for pixel.
  #present(labels, roll) {
    if (Math.abs(roll) < 1e-3) {
      this.ctx.putImageData(this.image, 0, 0);
      return labels;
    }
    const { w, h, ctx } = this;
    this.backCtx.putImageData(this.image, 0, 0);
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const zoom = Math.max(
      (w * Math.abs(cos) + h * Math.abs(sin)) / w,
      (w * Math.abs(sin) + h * Math.abs(cos)) / h,
    );
    const a = zoom * cos;
    const b = zoom * sin;
    const e = w / 2 - (a * w) / 2 + (b * h) / 2;
    const f = h / 2 - (b * w) / 2 - (a * h) / 2;
    ctx.setTransform(a, b, -b, a, e, f);
    ctx.drawImage(this.back, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Name tags follow their pawns round, and past a quarter turn a head
    // that was up is down, so the tag moves to the other side of it.
    for (const label of labels) {
      const { x, y } = label;
      label.x = a * x - b * y + e;
      label.y = b * x + a * y + f;
      if (cos < 0) label.below = !label.below;
    }
    return labels;
  }

  #drawFloorCeiling(maze, cam, dirX, dirY, planeX, planeY, lineScale, half) {
    const { w, h, px } = this;
    const floorTex = this.tex.floor;
    const ceilTex = this.tex.ceiling;
    const eye = 0.5 * lineScale;

    for (let y = Math.floor(half) + 1; y < h; y++) {
      const p = y - half;
      const rowDist = eye / p;
      const level = clampLevel(LEVELS - 1 - Math.round((rowDist / FOG_DIST) * (LEVELS - 1)));
      const fl = floorTex.levels[level];
      const cl = ceilTex.levels[clampLevel(level - 1)];
      const stepX = (rowDist * 2 * planeX) / w;
      const stepY = (rowDist * 2 * planeY) / w;
      let fx = cam.x + rowDist * (dirX - planeX);
      let fy = cam.y + rowDist * (dirY - planeY);
      let low = y * w;
      let high = (h - y - 1) * w;
      for (let x = 0; x < w; x++) {
        const tx = (fx * 64) & 63;
        const ty = (fy * 64) & 63;
        const idx = (ty << 6) | tx;
        px[low + x] = fl[idx];
        px[high + x] = cl[idx];
        fx += stepX;
        fy += stepY;
      }
    }
    // The exact horizon row(s) the loop skipped.
    const horizon = Math.floor(half) * w;
    const darkFloor = floorTex.levels[0];
    for (let x = 0; x < w; x++) px[horizon + x] = darkFloor[0];
  }

  // Billboards — other players, ghosts, cherries and the grey rocks — each
  // depth-tested per column against the wall pass. Returns screen positions
  // of the pawns so the page can hang name tags on them.
  #drawSprites(cam, scene, dirX, dirY, planeX, planeY, lineScale, half) {
    const labels = [];
    const { peers = [], ghosts = [], cherries = [], rocks = [], now = 0, power = 0 } = scene;
    if (!peers.length && !ghosts.length && !cherries.length && !rocks.length) return labels;
    const { w, h, px, tex } = this;
    const invDet = 1 / (planeX * dirY - dirX * planeY);

    // Project first, then spend a fill budget on the nearest sprites. A crowd
    // in one room would otherwise cost several full-screen fills per frame
    // and stall a phone into an unresponsive tab. The budget is in pixels, so
    // it lets a hundred distant pawns through while still cutting a wall of
    // enormous near ones; the count cap is only a backstop.
    const visible = [];
    // `size` is world height; `lift` is where its bottom sits, in world units
    // below eye level (0.5 is the floor, negative is above the eye).
    const add = (kind, item, x, y, sprite, shades, size, lift, rotated) => {
      const relX = x - cam.x;
      const relY = y - cam.y;
      const depth = invDet * (-planeY * relX + planeX * relY);
      if (depth <= NEAR_PAWN || depth > FOG_DIST) return;
      const camX = invDet * (dirY * relX - dirX * relY);
      const screenX = (w / 2) * (1 + camX / depth);
      const height = (size * lineScale) / depth;
      const width = height * (sprite.w / sprite.h);
      if (screenX + width / 2 < 0 || screenX - width / 2 > w) return;
      const top = half + (lift * lineScale) / depth - height;
      visible.push({ kind, item, depth, screenX, width, height, top, sprite, shades, rotated });
    };

    for (const p of peers) {
      // Someone walking on the ceiling hangs from it, head down.
      const lift = p.flipped ? -0.5 + PAWN_HEIGHT : 0.5;
      add(SPRITE_PAWN, p, p.x, p.y, tex.pawn, tex.pawn.shades, PAWN_HEIGHT, lift, !!p.flipped);
    }
    const scared = power > 0;
    const sheet = scared ? tex.scared : tex.ghost;
    const hem = (now / GHOST_STEP_MS) | 0;
    for (const g of ghosts) {
      const sprite = sheet[(hem + g.id) & 1];
      add(SPRITE_GHOST, g, g.x, g.y, sprite, sprite.shades, GHOST_HEIGHT, 0.5 - GHOST_HOVER, false);
    }
    for (const c of cherries) {
      const bob = 0.03 * (1 + Math.sin(now / 260 + c.x * 3.1 + c.y));
      add(SPRITE_CHERRY, c, c.x, c.y, tex.cherry, tex.cherry.shades, CHERRY_SIZE, 0.46 - bob, false);
    }
    for (const r of rocks) {
      const sheet = tex.rocks[r.kind % tex.rocks.length];
      const turn = (now / 1000) * ROCK_SPIN + r.x * 0.13 + r.y * 0.07;
      const frame = Math.floor((turn - Math.floor(turn)) * ROCK_FRAMES) % ROCK_FRAMES;
      add(SPRITE_ROCK, r, r.x, r.y, sheet, sheet.frames[frame], ROCK_SIZE, ROCK_SIZE / 2, false);
    }
    if (!visible.length) return labels;

    visible.sort((a, b) => a.depth - b.depth); // nearest first, for the budget
    let budget = w * h * SPRITE_FILL_BUDGET;
    let count = 0;
    while (count < visible.length && count < MAX_SPRITES) {
      const v = visible[count];
      budget -= Math.min(w, v.width) * Math.min(h, v.height);
      if (budget < 0 && count > 0) break;
      count++;
    }
    const drawList = visible.slice(0, count).reverse(); // paint far to near
    const flash = power > 0 && power < FLASH_MS && ((now / 220) | 0) % 2 === 1;

    for (const v of drawList) {
      const { kind, item, depth, screenX, width, height, top, sprite, shades, rotated } = v;
      const x0 = Math.max(0, Math.ceil(screenX - width / 2));
      const x1 = Math.min(w - 1, Math.floor(screenX + width / 2));
      const y0 = Math.max(0, Math.ceil(top));
      const y1 = Math.min(h - 1, Math.floor(top + height));
      if (x1 < x0 || y1 < y0) continue;

      // Everything keeps a floor of light so it stays readable down a dark
      // corridor; ghosts most of all, since they are the ones to watch for.
      const fade = 1 - depth / FOG_DIST;
      let ramp;
      if (kind === SPRITE_PAWN) {
        const [cr, cg, cb] = item.finished ? FINISHED_COLOR : playerColor(item.id);
        ramp = colorRamp(cr, cg, cb, Math.max(0.42, fade));
      } else if (kind === SPRITE_GHOST) {
        const palette = scared
          ? flash ? FLASH_PALETTE : SCARED_PALETTE
          : GHOST_PALETTES[item.id % GHOST_PALETTES.length];
        ramp = paletteRamp(palette, Math.max(0.55, fade));
      } else if (kind === SPRITE_CHERRY) {
        ramp = paletteRamp(CHERRY_PALETTE, Math.max(0.45, fade));
      } else {
        ramp = paletteRamp(ROCK_PALETTE, Math.max(0.3, fade));
      }
      const left = screenX - width / 2;
      const colStep = sprite.w / width;
      const rowStep = sprite.h / height;
      let drawn = false;

      for (let x = x0; x <= x1; x++) {
        if (depth >= this.zbuf[x]) continue;
        let sx = ((x - left) * colStep) | 0;
        if (sx < 0 || sx >= sprite.w) continue;
        if (rotated) sx = sprite.w - 1 - sx;
        let texRow = (y0 - top) * rowStep;
        let offset = y0 * w + x;
        for (let y = y0; y <= y1; y++, texRow += rowStep, offset += w) {
          let sy = texRow | 0;
          if (sy < 0 || sy >= sprite.h) continue;
          if (rotated) sy = sprite.h - 1 - sy;
          const shade = shades[sy * sprite.w + sx];
          if (shade === 0) continue; // transparent
          px[offset] = ramp[shade];
          drawn = true;
        }
      }
      if (drawn && kind === SPRITE_PAWN) {
        // The tag hangs off the head: above an upright pawn, below one on
        // the ceiling.
        labels.push({ id: item.id, x: screenX, y: rotated ? top + height : top, depth, below: rotated });
      }
    }
    return labels;
  }
}

function clampLevel(level) {
  return level < 0 ? 0 : level > LEVELS - 1 ? LEVELS - 1 : level;
}

// The maze layer only changes when a new tile is discovered, so it is painted
// into an offscreen canvas and blitted. Repainting 2601 tiles every frame cost
// ~13 ms on a phone-class CPU all by itself.
const mapCache = new WeakMap();

export function drawMinimap(
  canvas, maze, cam, { visited = null, scale = 6, peers = [], ghosts = [], cherries = [] } = {},
) {
  const ctx = canvas.getContext("2d");
  const size = Math.min(canvas.width / maze.w, canvas.height / maze.h);
  const s = scale ? Math.min(scale, size) : size;
  const offX = (canvas.width - maze.w * s) / 2;
  const offY = (canvas.height - maze.h * s) / 2;

  let cache = mapCache.get(canvas);
  const known = visited ? visited.size : -1;
  if (!cache || cache.seed !== maze.seed || cache.known !== known || cache.s !== s) {
    if (!cache) {
      cache = { layer: document.createElement("canvas") };
      mapCache.set(canvas, cache);
    }
    cache.seed = maze.seed;
    cache.known = known;
    cache.s = s;
    cache.layer.width = canvas.width;
    cache.layer.height = canvas.height;
    const lc = cache.layer.getContext("2d");
    lc.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        const tile = maze.grid[y * maze.w + x];
        if (visited && !visited.has(y * maze.w + x)) continue;
        if (tile === EXIT) lc.fillStyle = "#7ebae4"; // the snowflake stays NixOS blue
        else if (tile === EMPTY) lc.fillStyle = "rgba(240,214,190,0.12)";
        else lc.fillStyle = "rgba(178,74,54,0.5)";
        lc.fillRect(offX + x * s, offY + y * s, s, s);
      }
    }
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cache.layer, 0, 0);

  for (const p of peers) {
    const [r, g, b] = playerColor(p.id);
    ctx.fillStyle = `rgb(${r | 0} ${g | 0} ${b | 0})`;
    ctx.fillRect(offX + p.x * s - 1, offY + p.y * s - 1, Math.max(2, s), Math.max(2, s));
  }

  // Ghosts and cherries only where you have been: the map remembers, it does
  // not scout ahead.
  const seen = (x, y) => !visited || visited.has((y | 0) * maze.w + (x | 0));
  ctx.fillStyle = "#ff2a44";
  for (const c of cherries) {
    if (!seen(c.x, c.y)) continue;
    ctx.beginPath();
    ctx.arc(offX + c.x * s, offY + c.y * s, Math.max(1.5, s * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
  for (const g of ghosts) {
    if (!seen(g.x, g.y)) continue;
    const [r, gr, b] = GHOST_COLORS[g.id % GHOST_COLORS.length];
    ctx.fillStyle = `rgb(${r} ${gr} ${b})`;
    ctx.fillRect(offX + g.x * s - s * 0.5, offY + g.y * s - s * 0.5, Math.max(2, s), Math.max(2, s));
  }

  ctx.fillStyle = "#ffcc66";
  ctx.beginPath();
  ctx.arc(offX + cam.x * s, offY + cam.y * s, Math.max(1.6, s * 0.34), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffcc66";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(offX + cam.x * s, offY + cam.y * s);
  ctx.lineTo(offX + (cam.x + Math.cos(cam.a) * 1.6) * s, offY + (cam.y + Math.sin(cam.a) * 1.6) * s);
  ctx.stroke();
}
