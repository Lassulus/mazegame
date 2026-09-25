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

// Windows 95 3D Maze bricks: four fat courses per wall, joints of near-white
// mortar a quarter as thick as a course. Each joint is split across the
// edges of the bricks it separates, so tiles meet with the same width.
function brickTexture(size = 64) {
  const rnd = mulberry32(0xb21ce5);
  const px = new Uint32Array(size * size);
  const brickH = 16;
  const brickW = 32;
  const joint = 2; // mortar per brick edge; 4 px between neighbours
  const rows = size / brickH;
  const cols = size / brickW;
  const mortar = [230, 228, 220];
  const clay = [178, 50, 34];

  // Per-brick brightness and fired-clay hue wobble, stable across frames.
  const shade = new Float32Array(rows * cols);
  const warm = new Float32Array(rows * cols);
  for (let i = 0; i < shade.length; i++) {
    shade[i] = 0.88 + rnd() * 0.24;
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
      if (inRowY < joint || inRowY >= brickH - joint || inRowX < joint || inRowX >= brickW - joint) {
        const n = rnd() * 10 - 5;
        [r, g, b] = [mortar[0] + n, mortar[1] + n, mortar[2] + n];
      } else {
        const brick = row * cols + ((bx / brickW) | 0);
        const k = shade[brick];
        const w = warm[brick];
        const grad = 1 - ((inRowY - joint) / (brickH - 2 * joint)) * 0.22; // light falls from above
        const n = rnd() * 16 - 8;
        r = clay[0] * k * grad + w * 12 + n;
        g = clay[1] * k * grad + w * 7 + n;
        b = clay[2] * k * grad + w * 5 + n;
      }
      px[y * size + x] = pack(r, g, b);
    }
  }
  return px;
}

// Flat yellow ground: only a faint grain, no stones or grout lines.
function floorTexture(size = 64) {
  const rnd = mulberry32(0xf100f);
  const px = new Uint32Array(size * size);
  for (let i = 0; i < px.length; i++) {
    const n = rnd() * 8 - 4;
    px[i] = pack(222 + n, 188 + n, 72 + n * 0.5);
  }
  return px;
}

// The screensaver's "asbestos" ceiling tile at its original scale: light grey
// board peppered with white and dark-grey pinholes, a white bevel on the top
// and left of every tile and a two-pixel shadow on the bottom and right, rows
// staggered by half a tile.
function ceilingTexture(size = 64) {
  const rnd = mulberry32(0xcee1);
  const px = new Uint32Array(size * size);
  const cell = 1; // texels per original pixel
  const tile = 16; // original pixels per tile
  const grid = size / cell;
  const light = 192;
  const dark = 128;
  const white = 255;
  const tone = new Uint8Array(grid * grid);
  for (let v = 0; v < grid; v++) {
    const offset = ((v / tile) | 0) % 2 ? tile / 2 : 0;
    const ty = v % tile;
    for (let u = 0; u < grid; u++) {
      const tx = (u + offset) % tile;
      let c;
      if (tx >= tile - 2 || ty >= tile - 2) c = dark;
      else if (tx === 0 || ty === 0) c = white;
      else {
        const r = rnd();
        c = r < 0.5 ? light : r < 0.75 ? dark : white;
      }
      tone[v * grid + u] = c;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = tone[((y / cell) | 0) * grid + ((x / cell) | 0)];
      px[y * size + x] = pack(c, c, c);
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

// The other wanderers. Shading is quantised into PAWN_SHADES steps so the
// raycaster's inner loop is a table lookup instead of three multiplies: 0
// means transparent, 1..PAWN_SHADES-1 index a per-player colour ramp.
export const PAWN_SHADES = 16;

function pawnSprite(w = 32, h = 48) {
  const rnd = mulberry32(0x9a17);
  const mask = new Uint8Array(w * h);
  const lum = new Float32Array(w * h);
  const headY = 10;
  const headR = 7.2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - w / 2;
      const head = Math.hypot(dx, y + 0.5 - headY) <= headR;
      // Shoulders flare out under the head, hem is widest at the floor.
      const bodyTop = headY + headR - 2;
      const t = (y - bodyTop) / (h - bodyTop);
      const halfWidth = 4.5 + 6.5 * Math.min(1, Math.max(0, t)) ** 0.7;
      const body = y >= bodyTop && y < h - 1 && Math.abs(dx) <= halfWidth;
      if (!head && !body) continue;
      mask[y * w + x] = 1;
      const round = 1 - Math.abs(dx) / (head ? headR : halfWidth + 0.001);
      const shade = 0.55 + 0.45 * Math.sqrt(Math.max(0, round));
      lum[y * w + x] = (head ? shade * 1.15 : shade) * (0.94 + rnd() * 0.12);
    }
  }

  // One pixel of dark outline so a pawn never melts into the brickwork.
  const outline = new Uint8Array(mask);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!outline[y * w + x]) continue;
      const edge =
        x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
        !outline[y * w + x - 1] || !outline[y * w + x + 1] ||
        !outline[(y - 1) * w + x] || !outline[(y + 1) * w + x];
      if (edge) lum[y * w + x] = 0.16;
    }
  }

  const shades = new Uint8Array(w * h);
  for (let i = 0; i < shades.length; i++) {
    if (!mask[i]) continue;
    const step = Math.round(lum[i] * (PAWN_SHADES - 1));
    shades[i] = Math.max(1, Math.min(PAWN_SHADES - 1, step));
  }
  return { w, h, shades };
}

// Sprites below share the pawn's scheme — 0 is transparent, anything else
// indexes a small palette the renderer fogs per frame — but the index means
// a colour role rather than a brightness, so one sprite carries a body, eyes
// and pupils in a single table lookup.
export const GHOST_BODY = 11; // 1..11: body shading, dark to lit
export const GHOST_WHITE = 12; // eyes (the pale face when frightened)
export const GHOST_PUPIL = 13;

// The arcade ghost: a dome, straight sides and a hem of wavy points that
// swap between two frames as it moves.
function ghostSprite(scared, frame, w = 32, h = 34) {
  const shades = new Uint8Array(w * h);
  const cx = w / 2;
  const r = w / 2 - 2;
  const domeY = r + 1;
  const hem = h - 5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      let inside;
      if (y + 0.5 < domeY) inside = Math.hypot(dx, y + 0.5 - domeY) <= r;
      else if (y < hem) inside = Math.abs(dx) <= r;
      else {
        // Four points along the hem, shifted half a point on the other frame.
        const period = (2 * r) / 4;
        const phase = ((dx + r + (frame ? period / 2 : 0)) % period) / period;
        const tooth = 1 - Math.abs(phase * 2 - 1); // 0 at a notch, 1 at a point
        inside = Math.abs(dx) <= r && y - hem < tooth * 5;
      }
      if (!inside) continue;
      const round = Math.sqrt(Math.max(0, 1 - Math.abs(dx) / r));
      const lit = 0.45 + 0.55 * round - (y / h) * 0.15;
      shades[y * w + x] = Math.max(1, Math.min(GHOST_BODY, Math.round(lit * GHOST_BODY)));
    }
  }
  const paint = (x0, y0, x1, y1, index) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) shades[y * w + x] = index;
  };
  const ellipse = (ex, ey, rx, ry, index) => {
    for (let y = Math.floor(ey - ry); y <= ey + ry; y++) {
      for (let x = Math.floor(ex - rx); x <= ex + rx; x++) {
        if (((x + 0.5 - ex) / rx) ** 2 + ((y + 0.5 - ey) / ry) ** 2 <= 1) shades[y * w + x] = index;
      }
    }
  };
  if (scared) {
    // Frightened: two small square eyes and a zigzag mouth.
    paint(10, 12, 13, 15, GHOST_WHITE);
    paint(19, 12, 22, 15, GHOST_WHITE);
    for (let x = 6; x < 26; x++) {
      const y = 21 + (((x - 6) >> 1) % 2);
      shades[y * w + x] = GHOST_WHITE;
    }
  } else {
    ellipse(10.5, 13, 4, 5, GHOST_WHITE);
    ellipse(21.5, 13, 4, 5, GHOST_WHITE);
    ellipse(10.5, 15, 2.2, 2.2, GHOST_PUPIL);
    ellipse(21.5, 15, 2.2, 2.2, GHOST_PUPIL);
  }
  return { w, h, shades };
}

export const CHERRY_RED = 7; // 1..7: fruit shading
export const CHERRY_STEM = 10; // 8..10: stem shading
export const CHERRY_SHINE = 11;

// Two cherries on forked stems, the arcade bonus fruit.
function cherrySprite(w = 24, h = 24) {
  const shades = new Uint8Array(w * h);
  const stem = (x0, y0, x1, y1) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // A little bow in each stem.
      const x = x0 + (x1 - x0) * t + Math.sin(t * Math.PI) * 1.5;
      const y = y0 + (y1 - y0) * t;
      for (let k = 0; k < 2; k++) {
        const px = Math.round(x) + k;
        const py = Math.round(y);
        if (px >= 0 && px < w && py >= 0 && py < h) shades[py * w + px] = 8 + k + (t < 0.3 ? 1 : 0);
      }
    }
  };
  stem(6, 14, 16, 2);
  stem(16, 15, 16, 2);
  for (let x = 14; x < 21; x++) shades[2 * w + x] = x < 17 ? 10 : 9; // the leaf-ish knot
  const ball = (bx, by, br) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - bx, y + 0.5 - by) / br;
        if (d > 1) continue;
        // Lit from the upper left, with a white glint.
        const lx = (x + 0.5 - (bx - br * 0.4)) / br;
        const ly = (y + 0.5 - (by - br * 0.4)) / br;
        if (Math.hypot(lx, ly) < 0.22) {
          shades[y * w + x] = CHERRY_SHINE;
          continue;
        }
        const lit = 1 - 0.55 * Math.min(1, Math.hypot(lx, ly) / 1.4);
        shades[y * w + x] = d > 0.88 ? 1 : Math.max(2, Math.round(lit * CHERRY_RED));
      }
    }
  };
  ball(6.5, 17, 5.8);
  ball(16.5, 18, 5.8);
  return { w, h, shades };
}

export const ROCK_SHADES = 15; // 1..15: grey, dark to lit
export const ROCK_FRAMES = 48;

// The screensaver's grey Platonic solids, flat-shaded and spinning. Each is
// a vertex set plus face normals; a face is every vertex that lies furthest
// along its normal, which spares writing out twenty triangles by hand.
function solids() {
  const phi = (1 + Math.sqrt(5)) / 2;
  const signs = (v) => {
    let out = [[]];
    for (const c of v) out = out.flatMap((p) => (c === 0 ? [[...p, 0]] : [[...p, c], [...p, -c]]));
    return out;
  };
  const cyclic = (v) => [v, [v[1], v[2], v[0]], [v[2], v[0], v[1]]].flatMap(signs);
  const tetra = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  const octa = cyclic([1, 0, 0]);
  const cube = signs([1, 1, 1]);
  const icosa = cyclic([0, 1, phi]);
  // Duals must share an orientation: the icosahedron's face centres are
  // these dodecahedron vertices, and the other way round.
  const dodeca = [...cube, ...cyclic([0, phi, 1 / phi])];
  return [
    { verts: tetra, normals: tetra.map(([x, y, z]) => [-x, -y, -z]) },
    { verts: octa, normals: cube },
    { verts: icosa, normals: dodeca },
    { verts: dodeca, normals: icosa },
  ].map(({ verts, normals }) => {
    const radius = Math.hypot(...verts[0]);
    const unit = verts.map((v) => v.map((c) => c / radius));
    const faces = normals.map((n) => {
      const len = Math.hypot(...n);
      const dots = unit.map((v) => (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / len);
      const best = Math.max(...dots);
      return {
        normal: n.map((c) => c / len),
        verts: unit.filter((_, i) => dots[i] > best - 1e-6),
      };
    });
    return faces;
  });
}

function rockSprites(size = 40) {
  const light = [-0.45, 0.65, -0.62];
  const lightLen = Math.hypot(...light);
  const L = light.map((c) => c / lightLen);
  const tilt = 0.5;
  const scale = size * 0.46;
  return solids().map((faces) => {
    const frames = [];
    for (let f = 0; f < ROCK_FRAMES; f++) {
      const spin = (f / ROCK_FRAMES) * Math.PI * 2;
      // Spin about the vertical, then tip it towards the viewer so the top
      // faces catch the light as they come round.
      const rot = ([x, y, z]) => {
        const x1 = x * Math.cos(spin) + z * Math.sin(spin);
        const z1 = -x * Math.sin(spin) + z * Math.cos(spin);
        const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt);
        const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
        return [x1, y2, z2];
      };
      const shades = new Uint8Array(size * size);
      for (const face of faces) {
        const n = rot(face.normal);
        if (n[2] >= 0) continue; // facing away (the viewer looks down +z)
        const lit = 0.28 + 0.72 * Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
        // Orthographic, y up; vertices sorted round the centroid so any
        // convex face fills the same way whatever order the set came in.
        const pts = face.verts.map((v) => {
          const [x, y] = rot(v);
          return [size / 2 + x * scale, size / 2 - y * scale];
        });
        const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        pts.sort((p, q) => Math.atan2(p[1] - my, p[0] - mx) - Math.atan2(q[1] - my, q[0] - mx));
        const shade = Math.max(2, Math.min(ROCK_SHADES, Math.round(lit * ROCK_SHADES)));
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            let edge = Infinity;
            let inside = true;
            for (let i = 0; i < pts.length; i++) {
              const [ax, ay] = pts[i];
              const [bx, by] = pts[(i + 1) % pts.length];
              const len = Math.hypot(bx - ax, by - ay) || 1;
              const d = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / len;
              if (d < 0) {
                inside = false;
                break;
              }
              edge = Math.min(edge, d);
            }
            if (!inside) continue;
            // A dark seam along every edge keeps the facets readable.
            shades[y * size + x] = edge < 0.8 ? 1 : shade;
          }
        }
      }
      frames.push(shades);
    }
    return { w: size, h: size, frames };
  });
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
    // 128px keeps the snowflake crisp at wall scale; 256 cost 6 MB of LUTs.
    exit: shadeAll(logoTexture(logo, 128), 128, { emissive: true, floor: 0.35 }),
    pawn: pawnSprite(),
    ghost: [0, 1].map((f) => ghostSprite(false, f)),
    scared: [0, 1].map((f) => ghostSprite(true, f)),
    cherry: cherrySprite(),
    rocks: rockSprites(),
  };
}
