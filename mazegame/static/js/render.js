// Textured raycaster: the Windows 95 "Maze" look, done with a DDA grid walk
// and per-pixel writes into an ImageData buffer.

import { EMPTY, EXIT, tileAt } from "./maze.js";
import { LEVELS, loadTextures } from "./textures.js";

const FOG_DIST = 14; // tiles until full darkness
const MAX_STEPS = 128;
const MIN_PLANE = 0.75; // ~74 degrees horizontal, the narrowest we allow

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
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(maze, cam) {
    if (!this.tex || !this.w) return;
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
      if (tile === EMPTY) continue;

      const perp = Math.max(0.0001, side === 0 ? sideX - ddx : sideY - ddy);
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

    this.ctx.putImageData(this.image, 0, 0);
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
}

function clampLevel(level) {
  return level < 0 ? 0 : level > LEVELS - 1 ? LEVELS - 1 : level;
}

export function drawMinimap(canvas, maze, cam, { visited = null, scale = 6 } = {}) {
  const ctx = canvas.getContext("2d");
  const size = Math.min(canvas.width / maze.w, canvas.height / maze.h);
  const s = scale ? Math.min(scale, size) : size;
  const offX = (canvas.width - maze.w * s) / 2;
  const offY = (canvas.height - maze.h * s) / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < maze.h; y++) {
    for (let x = 0; x < maze.w; x++) {
      const tile = maze.grid[y * maze.w + x];
      const known = !visited || visited.has(y * maze.w + x);
      if (!known) continue;
      if (tile === EXIT) ctx.fillStyle = "#7ebae4"; // the snowflake stays NixOS blue
      else if (tile === EMPTY) ctx.fillStyle = "rgba(240,214,190,0.12)";
      else ctx.fillStyle = "rgba(178,74,54,0.5)";
      ctx.fillRect(offX + x * s, offY + y * s, s, s);
    }
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
