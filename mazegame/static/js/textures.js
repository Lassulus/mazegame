// Procedural textures, pre-shaded into brightness levels so the raycaster can
// pick a lookup table per column/row instead of doing per-pixel math.

import { mulberry32 } from "./maze.js";

export const LEVELS = 24;
const FOG = [16, 11, 13]; // colour distance fades into

const pack = (r, g, b) =>
  ((0xff000000 | (clamp(b) << 16) | (clamp(g) << 8) | clamp(r)) >>> 0);

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function shadeAll(pixels, size, { floor = 0, emissive = false } = {}) {
  const shift = Math.log2(size) | 0;
  const levels = [];
  for (let i = 0; i < LEVELS; i++) {
    let f = i / (LEVELS - 1);
    f = Math.pow(f, 1.3); // keep near surfaces bright, fall off fast in depth
    if (emissive) f = 0.6 + 0.4 * f; // the snowflake is a beacon, not a wall
    f = Math.max(f, floor);
    const out = new Uint32Array(pixels.length);
    for (let p = 0; p < pixels.length; p++) {
      const c = pixels[p];
      const r = c & 0xff;
      const g = (c >>> 8) & 0xff;
      const b = (c >>> 16) & 0xff;
      out[p] = pack(
        r * f + FOG[0] * (1 - f),
        g * f + FOG[1] * (1 - f),
        b * f + FOG[2] * (1 - f),
      );
    }
    levels.push(out);
  }
  return { size, shift, mask: size - 1, levels };
}

function brickTexture(size = 64) {
  const rnd = mulberry32(0xb21ce5);
  const px = new Uint32Array(size * size);
  const brickH = 8;
  const brickW = 32;
  const rows = size / brickH;
  const cols = size / brickW;
  const mortar = [134, 126, 116];
  const clay = [168, 64, 46];

  // Per-brick brightness and fired-clay hue wobble, stable across frames.
  const shade = new Float32Array(rows * cols);
  const warm = new Float32Array(rows * cols);
  for (let i = 0; i < shade.length; i++) {
    shade[i] = 0.78 + rnd() * 0.42;
    warm[i] = rnd() * 2 - 1;
  }

  for (let y = 0; y < size; y++) {
    const row = (y / brickH) | 0;
    const offset = row % 2 ? brickW / 2 : 0;
    const inRowY = y % brickH;
    for (let x = 0; x < size; x++) {
      const bx = (x + offset) % size;
      const inRowX = bx % brickW;
      let r;
      let g;
      let b;
      if (inRowY < 1 || inRowX < 2) {
        const n = rnd() * 12 - 6;
        [r, g, b] = [mortar[0] + n, mortar[1] + n, mortar[2] + n];
      } else {
        const brick = row * cols + ((bx / brickW) | 0);
        const k = shade[brick];
        const w = warm[brick];
        const grad = 1 - (inRowY / brickH) * 0.28; // light falls from above
        const n = rnd() * 18 - 9;
        r = clay[0] * k * grad + w * 14 + n;
        g = clay[1] * k * grad + w * 9 + n;
        b = clay[2] * k * grad + w * 6 + n;
      }
      px[y * size + x] = pack(r, g, b);
    }
  }
  return px;
}

function floorTexture(size = 64) {
  const rnd = mulberry32(0xf100f);
  const px = new Uint32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const checker = ((x >> 5) ^ (y >> 5)) & 1;
      const base = checker ? 86 : 70; // worn sandstone flagstones
      const grout = x % 32 < 2 || y % 32 < 2 ? -26 : 0;
      const n = rnd() * 12 - 6;
      px[y * size + x] = pack(base + 6 + n + grout, base - 4 + n + grout, base - 16 + n + grout);
    }
  }
  return px;
}

function ceilingTexture(size = 64) {
  const rnd = mulberry32(0xcee1);
  const px = new Uint32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const beam = y % 32 < 3 ? 16 : 0; // dark timber joists
      const n = rnd() * 8 - 4;
      px[y * size + x] = pack(58 + n + beam, 45 + n + beam, 40 + n + beam);
    }
  }
  return px;
}

function logoTexture(img, size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const bg = ctx.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, "#16243b");
  bg.addColorStop(1, "#0b1220");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const glow = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.52);
  glow.addColorStop(0, "rgba(126,186,228,0.55)");
  glow.addColorStop(1, "rgba(126,186,228,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = "#5277c3";
  ctx.lineWidth = size * 0.035;
  ctx.strokeRect(size * 0.05, size * 0.05, size * 0.9, size * 0.9);
  ctx.strokeStyle = "rgba(126,186,228,0.4)";
  ctx.lineWidth = size * 0.012;
  ctx.strokeRect(size * 0.11, size * 0.11, size * 0.78, size * 0.78);

  const pad = size * 0.17;
  ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);

  const data = ctx.getImageData(0, 0, size, size).data;
  return new Uint32Array(data.buffer.slice(0));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

export async function loadTextures() {
  const logo = await loadImage("/img/nix-snowflake.svg");
  return {
    logo,
    wall: shadeAll(brickTexture(), 64),
    floor: shadeAll(floorTexture(), 64),
    ceiling: shadeAll(ceilingTexture(), 64),
    exit: shadeAll(logoTexture(logo), 256, { emissive: true, floor: 0.35 }),
  };
}
