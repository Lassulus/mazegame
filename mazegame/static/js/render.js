// Textured raycaster: the Windows 95 "Maze" look, done with a DDA grid walk
// and per-pixel writes into an ImageData buffer.

import { EMPTY, EXIT, tileAt } from "./maze.js";
import { LEVELS, PAWN_SHADES, loadTextures } from "./textures.js";

const FOG_DIST = 14; // tiles until full darkness
const MAX_STEPS = 128;
const MIN_PLANE = 0.75; // ~74 degrees horizontal, the narrowest we allow
const PAWN_HEIGHT = 0.72; // world units, a bit shorter than a wall
const FINISHED_COLOR = [126, 186, 228]; // NixOS blue for players who escaped
const NEAR_PAWN = 0.45; // closer than this a pawn is just a wall of colour
const MAX_PAWNS = 10; // hard cap on sprites per frame
const PAWN_FILL_BUDGET = 0.9; // screenfuls of sprite fill allowed per frame

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

// Phones have few CSS pixels to spare; keep the chunky look without turning
// the view into confetti.
export const retroPixel = () => (Math.min(innerWidth, innerHeight) < 600 ? 2 : 3);

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
  }

  draw(maze, cam, peers = []) {
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

    const labels = this.#drawPeers(cam, peers, dirX, dirY, planeX, planeY, lineScale, half);
    this.ctx.putImageData(this.image, 0, 0);
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

  // Billboarded pawns for the other players, depth-tested per column against
  // the wall pass. Returns screen positions so the page can hang name tags.
  #drawPeers(cam, peers, dirX, dirY, planeX, planeY, lineScale, half) {
    const labels = [];
    if (!peers.length) return labels;
    const { w, h, px } = this;
    const sprite = this.tex.pawn;
    const invDet = 1 / (planeX * dirY - dirX * planeY);

    // Project first, then spend a fixed fill budget on the nearest pawns. A
    // crowd in one room would otherwise cost several full-screen fills per
    // frame and stall a phone into an unresponsive tab.
    const visible = [];
    for (const p of peers) {
      const relX = p.x - cam.x;
      const relY = p.y - cam.y;
      const depth = invDet * (-planeY * relX + planeX * relY);
      if (depth <= NEAR_PAWN || depth > FOG_DIST) continue;
      const camX = invDet * (dirY * relX - dirX * relY);
      const screenX = (w / 2) * (1 + camX / depth);
      const height = (PAWN_HEIGHT * lineScale) / depth;
      const width = height * (sprite.w / sprite.h);
      if (screenX + width / 2 < 0 || screenX - width / 2 > w) continue;
      visible.push({ p, depth, screenX, width, height, floorY: half + (0.5 * lineScale) / depth });
    }
    if (!visible.length) return labels;

    visible.sort((a, b) => a.depth - b.depth); // nearest first, for the budget
    let budget = w * h * PAWN_FILL_BUDGET;
    let count = 0;
    while (count < visible.length && count < MAX_PAWNS) {
      const v = visible[count];
      budget -= Math.min(w, v.width) * Math.min(h, v.height);
      if (budget < 0 && count > 0) break;
      count++;
    }
    const drawList = visible.slice(0, count).reverse(); // paint far to near

    for (const { p, depth, screenX, width, height, floorY } of drawList) {
      const top = floorY - height;
      const x0 = Math.max(0, Math.ceil(screenX - width / 2));
      const x1 = Math.min(w - 1, Math.floor(screenX + width / 2));
      const y0 = Math.max(0, Math.ceil(top));
      const y1 = Math.min(h - 1, Math.floor(floorY));
      if (x1 < x0 || y1 < y0) continue;

      const [cr, cg, cb] = p.finished ? FINISHED_COLOR : playerColor(p.id);
      // Pawns keep a floor of light so they stay readable down a dark corridor.
      const fog = Math.max(0.42, 1 - depth / FOG_DIST);
      const ramp = colorRamp(cr, cg, cb, fog);
      const left = screenX - width / 2;
      const colStep = sprite.w / width;
      const rowStep = sprite.h / height;
      const shades = sprite.shades;
      let drawn = false;

      for (let x = x0; x <= x1; x++) {
        if (depth >= this.zbuf[x]) continue;
        const sx = ((x - left) * colStep) | 0;
        if (sx < 0 || sx >= sprite.w) continue;
        let texRow = (y0 - top) * rowStep;
        let offset = y0 * w + x;
        for (let y = y0; y <= y1; y++, texRow += rowStep, offset += w) {
          const sy = texRow | 0;
          if (sy < 0 || sy >= sprite.h) continue;
          const shade = shades[sy * sprite.w + sx];
          if (shade === 0) continue; // transparent
          px[offset] = ramp[shade];
          drawn = true;
        }
      }
      if (drawn) labels.push({ id: p.id, x: screenX, y: top, depth });
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

export function drawMinimap(canvas, maze, cam, { visited = null, scale = 6, peers = [] } = {}) {
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
