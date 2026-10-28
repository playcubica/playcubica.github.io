import { hash3i, mulberry32 } from '../../shared/rng';

// Original 16×16 pixel-art textures, painted procedurally from a fixed per-texture
// seed (so they are identical on every machine). No DOM needed: paints into RGBA arrays.

export const TEX_SIZE = 16;

type RGB = [number, number, number];

export class Pixmap {
  readonly data = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 4);

  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= TEX_SIZE || y >= TEX_SIZE) return;
    const i = (y * TEX_SIZE + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }

  get(x: number, y: number): RGB {
    const i = (y * TEX_SIZE + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  alpha(x: number, y: number): number {
    return this.data[(y * TEX_SIZE + x) * 4 + 3];
  }
}

type Rand = () => number;

function shade(c: RGB, f: number): RGB {
  return [c[0] * f, c[1] * f, c[2] * f];
}

/** Fills with a base colour, jittering brightness per pixel. */
function speckle(p: Pixmap, r: Rand, base: RGB, variance: number, alpha = 255): void {
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      p.set(x, y, shade(base, 1 + (r() * 2 - 1) * variance), alpha);
    }
  }
}

/** Scatters small blobs of a colour. */
function blobs(p: Pixmap, r: Rand, color: RGB, count: number, size: number, variance = 0.1): void {
  for (let n = 0; n < count; n++) {
    let x = Math.floor(r() * TEX_SIZE);
    let y = Math.floor(r() * TEX_SIZE);
    for (let s = 0; s < size; s++) {
      p.set(x, y, shade(color, 1 + (r() * 2 - 1) * variance));
      if (r() < 0.5) x += r() < 0.5 ? -1 : 1;
      else y += r() < 0.5 ? -1 : 1;
    }
  }
}

const STONE: RGB = [122, 124, 128];
const DIRT: RGB = [126, 88, 60];
const GRASS: RGB = [98, 158, 58];

function stone(p: Pixmap, r: Rand): void {
  speckle(p, r, STONE, 0.07);
  blobs(p, r, shade(STONE, 0.78), 7, 4, 0.05);
  blobs(p, r, shade(STONE, 1.12), 5, 3, 0.04);
}

function dirt(p: Pixmap, r: Rand): void {
  speckle(p, r, DIRT, 0.1);
  blobs(p, r, shade(DIRT, 0.72), 8, 2);
  blobs(p, r, [150, 120, 90], 4, 1);
}

function ore(color: RGB, accent: RGB) {
  return (p: Pixmap, r: Rand) => {
    stone(p, r);
    for (let n = 0; n < 5; n++) {
      const cx = 2 + Math.floor(r() * 12);
      const cy = 2 + Math.floor(r() * 12);
      p.set(cx, cy, color);
      p.set(cx + 1, cy, shade(color, 0.85));
      p.set(cx, cy + 1, shade(color, 0.75));
      if (r() < 0.6) p.set(cx + 1, cy + 1, accent);
      if (r() < 0.4) p.set(cx - 1, cy, shade(color, 0.9));
    }
  };
}

function plantBase(p: Pixmap): void {
  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) p.data[i * 4 + 3] = 0;
}

function stem(p: Pixmap, x: number, top: number, color: RGB): void {
  for (let y = top; y < TEX_SIZE; y++) p.set(x, y, shade(color, 0.85 + (y / TEX_SIZE) * 0.2));
}

function logSide(bark: RGB) {
  return (p: Pixmap, r: Rand) => {
    speckle(p, r, bark, 0.06);
    for (let x = 0; x < TEX_SIZE; x++) {
      if (r() < 0.35) {
        const dark = shade(bark, 0.7);
        const y = Math.floor(r() * TEX_SIZE);
        const len = 3 + Math.floor(r() * 8);
        for (let k = 0; k < len; k++) p.set(x, (y + k) % TEX_SIZE, dark);
      }
    }
  };
}

function logTop(core: RGB, bark: RGB) {
  return (p: Pixmap, r: Rand) => {
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (d > 6.5) p.set(x, y, shade(bark, 0.9 + r() * 0.15));
        else p.set(x, y, shade(core, (Math.floor(d) % 2 === 0 ? 1 : 0.86) + r() * 0.05));
      }
    }
  };
}

function foliage(base: RGB, holes: number) {
  return (p: Pixmap, r: Rand) => {
    speckle(p, r, base, 0.16);
    blobs(p, r, shade(base, 0.7), 6, 3);
    blobs(p, r, shade(base, 1.2), 4, 2);
    for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) if (r() < holes) p.data[i * 4 + 3] = 0;
  };
}

function planks(base: RGB) {
  return (p: Pixmap, r: Rand) => {
    for (let y = 0; y < TEX_SIZE; y++) {
      const board = y >> 2;
      const seam = y % 4 === 3;
      for (let x = 0; x < TEX_SIZE; x++) {
        const joint = x === ((board * 5 + 3) % TEX_SIZE);
        const grain = 0.94 + Math.sin((x + board * 7) * 0.9) * 0.03 + r() * 0.05;
        p.set(x, y, seam || joint ? shade(base, 0.68) : shade(base, grain * (board % 2 ? 0.95 : 1)));
      }
    }
  };
}

function brickStone(p: Pixmap, r: Rand, base: RGB): void {
  for (let y = 0; y < TEX_SIZE; y++) {
    const row = y >> 2;
    for (let x = 0; x < TEX_SIZE; x++) {
      const mortar = y % 4 === 3 || (x + (row % 2) * 4) % 8 === 7;
      p.set(x, y, mortar ? shade(base, 0.62) : shade(base, 0.92 + r() * 0.14));
    }
  }
}

function furnaceMouth(p: Pixmap, lit: boolean): void {
  for (let y = 8; y <= 13; y++) for (let x = 4; x <= 11; x++) {
    const edge = y === 8 || x === 4 || x === 11;
    if (edge) p.set(x, y, [60, 56, 54]);
    else if (lit) p.set(x, y, y >= 11 ? [255, 190, 60] : y === 10 ? [240, 120, 30] : [120, 40, 20]);
    else p.set(x, y, [26, 24, 24]);
  }
  for (let x = 3; x <= 12; x++) p.set(x, 7, [96, 92, 88]);
}

const PAINTERS: Record<string, (p: Pixmap, r: Rand) => void> = {
  stone,
  dirt,
  grass_top(p, r) {
    speckle(p, r, GRASS, 0.12);
    blobs(p, r, shade(GRASS, 0.78), 6, 3);
    blobs(p, r, [128, 176, 70], 4, 2);
  },
  grass_side(p, r) {
    dirt(p, r);
    for (let x = 0; x < TEX_SIZE; x++) {
      const depth = 3 + (r() < 0.5 ? 1 : 0) + (r() < 0.2 ? 2 : 0);
      for (let y = 0; y < depth; y++) p.set(x, y, shade(GRASS, 0.9 + r() * 0.2 - y * 0.03));
    }
  },
  sand(p, r) {
    speckle(p, r, [222, 208, 160], 0.05);
    blobs(p, r, [204, 186, 138], 6, 2, 0.03);
  },
  gravel(p, r) {
    speckle(p, r, [128, 122, 118], 0.08);
    blobs(p, r, [92, 88, 86], 9, 4, 0.08);
    blobs(p, r, [168, 160, 152], 7, 3, 0.05);
  },
  clay(p, r) {
    speckle(p, r, [158, 164, 178], 0.04);
    blobs(p, r, [140, 146, 162], 5, 3, 0.03);
  },
  dunestone_top(p, r) {
    speckle(p, r, [214, 196, 146], 0.04);
  },
  dunestone_side(p, r) {
    for (let y = 0; y < TEX_SIZE; y++) {
      const band = y % 5 === 4 ? 0.82 : y % 5 === 0 ? 1.06 : 0.95;
      for (let x = 0; x < TEX_SIZE; x++) p.set(x, y, shade([214, 196, 146], band + (r() * 2 - 1) * 0.03));
    }
  },
  snow(p, r) {
    speckle(p, r, [238, 244, 250], 0.025);
    blobs(p, r, [214, 226, 240], 4, 3, 0.02);
  },
  frost_turf_side(p, r) {
    dirt(p, r);
    for (let x = 0; x < TEX_SIZE; x++) {
      const depth = 2 + (r() < 0.5 ? 1 : 0) + (r() < 0.25 ? 2 : 0);
      for (let y = 0; y < depth; y++) p.set(x, y, shade([236, 242, 250], 0.95 + r() * 0.05));
    }
  },
  ice(p, r) {
    speckle(p, r, [150, 192, 240], 0.05, 200);
    for (let k = 0; k < 3; k++) {
      const off = Math.floor(r() * TEX_SIZE);
      for (let t = 0; t < 6; t++) p.set((off + t) % TEX_SIZE, (off * 3 + t) % TEX_SIZE, [214, 234, 255], 220);
    }
  },
  corerock(p, r) {
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const v = r();
        p.set(x, y, v < 0.3 ? [34, 32, 40] : v < 0.7 ? [70, 68, 76] : [108, 104, 112]);
      }
    }
  },
  water(p, r) {
    speckle(p, r, [46, 98, 196], 0.06, 175);
    for (let y = 1; y < TEX_SIZE; y += 4) {
      const off = Math.floor(r() * 8);
      for (let t = 0; t < 5; t++) p.set((off + t + y) % TEX_SIZE, y, [96, 150, 232], 185);
    }
  },
  ashwood_log_side: logSide([156, 142, 118]),
  ashwood_log_top: logTop([196, 166, 112], [138, 124, 102]),
  ashwood_leaves: foliage([74, 138, 52], 0.22),
  frostpine_log_side: logSide([92, 62, 44]),
  frostpine_log_top: logTop([150, 112, 72], [80, 54, 38]),
  frostpine_needles: foliage([44, 98, 76], 0.18),
  cactus_side(p, r) {
    speckle(p, r, [62, 132, 54], 0.06);
    for (let y = 0; y < TEX_SIZE; y++) {
      for (const x of [3, 8, 12]) p.set(x, y, [44, 104, 40]);
    }
    for (let n = 0; n < 8; n++) p.set(Math.floor(r() * 16), Math.floor(r() * 16), [230, 226, 190]);
  },
  cactus_top(p, r) {
    speckle(p, r, [74, 146, 62], 0.05);
    for (let t = 2; t < 14; t++) {
      p.set(t, 7, [52, 112, 46]);
      p.set(7, t, [52, 112, 46]);
    }
  },
  coal_ore: ore([34, 34, 36], [70, 70, 74]),
  iron_ore: ore([206, 164, 132], [232, 200, 170]),
  gold_ore: ore([246, 210, 64], [255, 244, 160]),
  diamond_ore: ore([96, 226, 222], [210, 255, 252]),
  lumen_crystal(p, r) {
    speckle(p, r, [236, 196, 96], 0.06);
    for (let n = 0; n < 6; n++) {
      const cx = 1 + Math.floor(r() * 13);
      const cy = 1 + Math.floor(r() * 13);
      p.set(cx, cy, [255, 250, 210]);
      p.set(cx + 1, cy, [255, 236, 160]);
      p.set(cx, cy + 1, [255, 236, 160]);
      p.set(cx + 1, cy + 1, [214, 140, 60]);
    }
  },
  tall_grass(p, r) {
    plantBase(p);
    for (let n = 0; n < 7; n++) {
      let x = 2 + Math.floor(r() * 12);
      const top = 3 + Math.floor(r() * 8);
      for (let y = TEX_SIZE - 1; y >= top; y--) {
        p.set(x, y, shade(GRASS, 0.8 + ((TEX_SIZE - y) / TEX_SIZE) * 0.4));
        if (r() < 0.15) x += r() < 0.5 ? -1 : 1;
      }
    }
  },
  sunbloom(p, r) {
    plantBase(p);
    stem(p, 7, 6, [70, 130, 48]);
    p.set(6, 11, [70, 130, 48]);
    p.set(8, 9, [70, 130, 48]);
    const petals: RGB = [250, 186, 40];
    for (const [dx, dy] of [[0, -2], [-2, 0], [2, 0], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      p.set(7 + dx, 4 + dy, shade(petals, 0.9 + r() * 0.2));
    }
    p.set(7, 4, [150, 70, 30]);
  },
  bluebell(p, r) {
    plantBase(p);
    stem(p, 8, 4, [60, 122, 60]);
    for (const [bx, by] of [[6, 5], [10, 7], [6, 9]]) {
      p.set(bx, by, shade([96, 120, 230], 0.9 + r() * 0.2));
      p.set(bx, by + 1, [70, 90, 210]);
      p.set(bx + (bx < 8 ? 1 : -1), by, [60, 122, 60]);
    }
  },
  dry_scrub(p, r) {
    plantBase(p);
    const twig: RGB = [122, 88, 52];
    const branch = (x: number, y: number, dx: number, len: number) => {
      for (let k = 0; k < len; k++) {
        p.set(x, y, shade(twig, 0.85 + r() * 0.3));
        y--;
        if (r() < 0.6) x += dx;
      }
    };
    branch(7, 15, 0, 6);
    branch(7, 11, -1, 6);
    branch(8, 12, 1, 7);
    branch(7, 9, 1, 4);
  },
  ashwood_planks: planks([184, 160, 120]),
  frostpine_planks: planks([118, 82, 56]),
  rubblestone(p, r) {
    speckle(p, r, [108, 108, 112], 0.05);
    // Irregular cobbles separated by dark mortar lines.
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const cell = ((x + (y >> 2) * 3) >> 2) + (y >> 2) * 7;
        if (x % 4 === ((y >> 2) * 3) % 4 || y % 4 === 0) p.set(x, y, [70, 70, 74]);
        else p.set(x, y, shade([118, 118, 124], 0.85 + ((cell * 37) % 10) / 40 + r() * 0.06));
      }
    }
  },
  glass(p) {
    plantBase(p);
    for (let t = 0; t < TEX_SIZE; t++) {
      for (const [x, y] of [[t, 0], [t, 15], [0, t], [15, t]]) p.set(x, y, [214, 232, 240]);
    }
    for (let t = 0; t < 4; t++) {
      p.set(3 + t, 6 - t, [240, 250, 255]);
      p.set(9 + t, 12 - t, [240, 250, 255]);
    }
  },
  workbench_top(p, r) {
    planks([186, 150, 100])(p, r);
    for (let t = 0; t < TEX_SIZE; t++) {
      p.set(t, 0, [110, 80, 50]); p.set(t, 15, [110, 80, 50]); p.set(0, t, [110, 80, 50]); p.set(15, t, [110, 80, 50]);
    }
    // Tools laid out on the bench: a saw blade and a mallet.
    for (let x = 3; x <= 9; x++) p.set(x, 4, [190, 194, 200]);
    for (let x = 3; x <= 9; x += 2) p.set(x, 5, [150, 154, 160]);
    for (let y = 8; y <= 12; y++) p.set(11, y, [96, 66, 36]);
    for (let x = 9; x <= 13; x++) { p.set(x, 7, [130, 96, 58]); p.set(x, 8, [130, 96, 58]); }
  },
  workbench_side(p, r) {
    planks([178, 142, 94])(p, r);
    for (let x = 0; x < TEX_SIZE; x++) { p.set(x, 0, [120, 88, 54]); p.set(x, 1, [150, 116, 74]); }
    for (let y = 4; y < 14; y++) { p.set(2, y, [96, 70, 44]); p.set(13, y, [96, 70, 44]); }
    for (let x = 4; x <= 11; x++) p.set(x, 8, [96, 70, 44]);
  },
  furnace_top: (p, r) => brickStone(p, r, [118, 112, 108]),
  furnace_side: (p, r) => brickStone(p, r, [124, 118, 112]),
  furnace_front(p, r) {
    brickStone(p, r, [124, 118, 112]);
    furnaceMouth(p, false);
  },
  furnace_front_lit(p, r) {
    brickStone(p, r, [124, 118, 112]);
    furnaceMouth(p, true);
  },
  chest_top(p, r) {
    planks([160, 112, 60])(p, r);
    for (let t = 0; t < TEX_SIZE; t++) { p.set(t, 0, [90, 60, 30]); p.set(t, 15, [90, 60, 30]); p.set(0, t, [90, 60, 30]); p.set(15, t, [90, 60, 30]); }
  },
  chest_side(p, r) {
    planks([160, 112, 60])(p, r);
    for (let t = 0; t < TEX_SIZE; t++) { p.set(t, 0, [90, 60, 30]); p.set(t, 15, [90, 60, 30]); p.set(t, 5, [90, 60, 30]); }
  },
  chest_front(p, r) {
    PAINTERS.chest_side(p, r);
    for (let y = 4; y <= 8; y++) for (let x = 6; x <= 9; x++) p.set(x, y, y === 4 || y === 8 || x === 6 || x === 9 ? [70, 70, 76] : [200, 200, 208]);
    p.set(7, 7, [40, 40, 44]);
  },
  bedroll_top(p, r) {
    speckle(p, r, [176, 64, 58], 0.05);
    for (let y = 0; y < 5; y++) for (let x = 1; x < 15; x++) p.set(x, y, shade([236, 232, 220], 0.95 + r() * 0.05));
    for (let x = 0; x < TEX_SIZE; x++) { p.set(x, 5, [140, 46, 42]); if (x % 4 === 1) p.set(x, 10, [140, 46, 42]); }
  },
  bedroll_side(p, r) {
    planks([160, 120, 74])(p, r);
    for (let y = 0; y < 8; y++) for (let x = 0; x < TEX_SIZE; x++) p.set(x, y, shade([176, 64, 58], 0.9 + r() * 0.1));
    for (let x = 0; x < TEX_SIZE; x++) p.set(x, 7, [130, 44, 40]);
  },
  torch(p) {
    plantBase(p);
    // Stick columns at 0-1, 7-8 and 14-15 so standing and wall torches all find them.
    for (const c of [0, 7, 14]) {
      for (let y = 6; y < TEX_SIZE; y++) {
        p.set(c, y, [118, 84, 46]);
        p.set(c + 1, y, [92, 64, 34]);
      }
      p.set(c, 6, [255, 240, 150]); p.set(c + 1, 6, [255, 210, 90]);
      p.set(c, 7, [255, 200, 70]); p.set(c + 1, 7, [240, 150, 40]);
      p.set(c, 8, [230, 120, 40]); p.set(c + 1, 8, [200, 90, 30]);
    }
  },
  door_lower(p, r) {
    planks([176, 150, 108])(p, r);
    for (let t = 0; t < TEX_SIZE; t++) { p.set(t, 15, [120, 92, 60]); p.set(0, t, [120, 92, 60]); p.set(15, t, [120, 92, 60]); }
    for (let x = 3; x <= 12; x++) { p.set(x, 3, [130, 100, 66]); p.set(x, 11, [130, 100, 66]); }
    p.set(12, 1, [60, 50, 40]); p.set(13, 1, [60, 50, 40]);
  },
  door_upper(p, r) {
    planks([176, 150, 108])(p, r);
    for (let t = 0; t < TEX_SIZE; t++) { p.set(t, 0, [120, 92, 60]); p.set(0, t, [120, 92, 60]); p.set(15, t, [120, 92, 60]); }
    for (let y = 3; y <= 11; y++) for (let x = 3; x <= 12; x++) {
      const bar = x === 7 || x === 8 || y === 7;
      p.set(x, y, bar ? [120, 92, 60] : [160, 200, 222], bar ? 255 : 0);
    }
  },
  ashwood_sapling(p, r) {
    plantBase(p);
    stem(p, 7, 8, [110, 90, 60]);
    for (let n = 0; n < 22; n++) {
      const x = 4 + Math.floor(r() * 8);
      const y = 2 + Math.floor(r() * 8);
      p.set(x, y, shade([74, 138, 52], 0.8 + r() * 0.4));
    }
  },
  frostpine_sapling(p, r) {
    plantBase(p);
    stem(p, 7, 9, [90, 62, 42]);
    for (let y = 2; y < 11; y++) {
      const w = Math.floor((y - 1) / 2);
      for (let x = 7 - w; x <= 8 + w; x++) if (r() < 0.8) p.set(x, y, shade([44, 98, 76], 0.85 + r() * 0.3));
    }
  },
  cut_stone(p, r) {
    speckle(p, r, [132, 134, 138], 0.04);
    for (let t = 0; t < TEX_SIZE; t++) {
      p.set(t, 7, [92, 92, 96]);
      p.set(t, 15, [92, 92, 96]);
      p.set(t, 8, [156, 158, 162]);
      p.set(t, 0, [156, 158, 162]);
    }
    for (let y = 0; y < 7; y++) p.set(7, y, [92, 92, 96]);
    for (let y = 8; y < 15; y++) p.set(15, y, [92, 92, 96]);
  },
};

function textureSeed(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = hash3i(h, name.charCodeAt(i), i, 0x7e);
  return h;
}

export function paintTexture(name: string): Pixmap {
  const p = new Pixmap();
  const painter = PAINTERS[name];
  const r = mulberry32(textureSeed(name));
  if (painter) painter(p, r);
  else {
    // Missing texture: magenta checker so it is obvious.
    for (let y = 0; y < TEX_SIZE; y++) for (let x = 0; x < TEX_SIZE; x++) p.set(x, y, ((x >> 2) + (y >> 2)) % 2 ? [255, 0, 255] : [0, 0, 0]);
  }
  return p;
}

export function hasPainter(name: string): boolean {
  return name in PAINTERS;
}
