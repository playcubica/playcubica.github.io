import { B } from '../../shared/blocks/registry';
import { I, toolParts, TIERS } from '../../shared/items/registry';
import { mulberry32 } from '../../shared/rng';
import { Pixmap, TEX_SIZE } from './procedural';

// Original 16×16 sprites for items that are not drawn as blocks: materials, food,
// tools and their heads. Painted procedurally like the block textures.

type RGB = [number, number, number];

const TIER_COLOR: Record<(typeof TIERS)[number], RGB> = {
  wood: [168, 124, 70],
  stone: [128, 128, 134],
  iron: [214, 216, 222],
  gold: [246, 206, 64],
  diamond: [90, 226, 218],
};
const HANDLE: RGB = [112, 78, 42];

const shade = (c: RGB, f: number): RGB => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];

function blank(): Pixmap {
  const p = new Pixmap();
  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) p.data[i * 4 + 3] = 0;
  return p;
}

/** Diagonal handle from bottom-left towards the centre. */
function handle(p: Pixmap, to: number): void {
  for (let x = 1; x <= to; x++) {
    const y = 15 - x;
    p.set(x, y, HANDLE);
    p.set(x + 1, y, shade(HANDLE, 0.75));
  }
}

function toolSprite(tier: number, kind: number, head: boolean): Pixmap {
  const p = blank();
  const m = TIER_COLOR[TIERS[tier]];
  const hi = shade(m, 1.18);
  const lo = shade(m, 0.7);
  const paint = (x: number, y: number, edge: boolean) => p.set(x, y, edge ? lo : (x + y) % 5 === 0 ? hi : m);
  switch (kind) {
    case 0: // pickaxe: curved bar
      if (!head) handle(p, 8);
      for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
        const r = Math.hypot(x - 15, y - 15);
        if (r >= 9.6 && r <= 11.4 && x >= 3 && y >= 3) paint(x, y, r > 10.9);
      }
      break;
    case 1: // axe: wedge beside the top of the handle
      if (!head) handle(p, 11);
      for (let y = 1; y <= 8; y++) for (let x = 4; x <= 11; x++) {
        if (x + y >= 9 && x + y <= 14 && x - y >= 0 && x - y <= 8) paint(x, y, x + y === 9 || x - y === 8);
      }
      break;
    case 2: // shovel: rounded spade
      if (!head) handle(p, 9);
      for (let y = 1; y <= 8; y++) for (let x = 8; x <= 15; x++) {
        const d = Math.abs(x - 11.5) + Math.abs(y - 4.5);
        if (d <= 4) paint(x, y, d > 3.2);
      }
      break;
    default: // sword: long blade, guard, grip
      for (let k = 0; k < 10; k++) {
        const x = 5 + k;
        const y = 10 - k;
        paint(x, y, false);
        paint(x, y + 1, true);
        if (k < 9) p.set(x + 1, y, hi);
      }
      if (!head) {
        for (let k = -2; k <= 2; k++) p.set(4 + k, 11 + k, [90, 70, 50]);
        for (let k = 0; k < 4; k++) p.set(1 + k, 14 - k, HANDLE);
      }
  }
  return p;
}

function lump(base: RGB, spots: RGB | null, seed: number): Pixmap {
  const p = blank();
  const r = mulberry32(seed);
  for (let y = 3; y < 14; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot((x - 7.5) / 5.5, (y - 8.5) / 4.8);
    if (d > 1 + (r() - 0.5) * 0.25) continue;
    p.set(x, y, shade(base, 0.8 + (1 - d) * 0.35 + (r() - 0.5) * 0.12));
  }
  if (spots) for (let n = 0; n < 6; n++) p.set(4 + Math.floor(r() * 8), 5 + Math.floor(r() * 6), spots);
  return p;
}

function ingot(c: RGB): Pixmap {
  const p = blank();
  for (let y = 6; y <= 11; y++) {
    const inset = 11 - y;
    for (let x = 2 + Math.floor(inset / 2); x <= 13 - Math.floor(inset / 2); x++) {
      p.set(x, y, y === 6 ? shade(c, 1.2) : y === 11 ? shade(c, 0.65) : shade(c, 0.95 + ((x + y) % 3) * 0.04));
    }
  }
  return p;
}

function fruit(body: RGB, leaf: boolean): Pixmap {
  const p = blank();
  for (let y = 4; y < 15; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot(x - 7.5, y - 9.5);
    if (d <= 5.2) p.set(x, y, shade(body, d < 2 && x < 7 && y < 9 ? 1.3 : 1.05 - d * 0.06));
  }
  p.set(8, 3, [96, 66, 36]);
  p.set(8, 4, [96, 66, 36]);
  if (leaf) {
    p.set(9, 2, [80, 150, 60]);
    p.set(10, 2, [80, 150, 60]);
    p.set(10, 3, [60, 120, 48]);
  }
  return p;
}

function meat(c: RGB, fat: RGB): Pixmap {
  const p = blank();
  for (let y = 4; y < 13; y++) for (let x = 2; x < 14; x++) {
    const d = Math.hypot((x - 7.5) / 5.5, (y - 8.5) / 4);
    if (d > 1) continue;
    p.set(x, y, d > 0.8 ? fat : shade(c, 0.9 + (1 - d) * 0.25));
  }
  // Bone end.
  p.set(12, 5, [240, 236, 220]);
  p.set(13, 4, [240, 236, 220]);
  p.set(14, 4, [240, 236, 220]);
  p.set(13, 3, [240, 236, 220]);
  return p;
}

const PAINTERS: Record<number, () => Pixmap> = {
  [I.STICK]: () => {
    const p = blank();
    for (let x = 3; x <= 12; x++) {
      p.set(x, 15 - x, HANDLE);
      p.set(x + 1, 15 - x, shade(HANDLE, 0.75));
    }
    return p;
  },
  [I.COAL]: () => lump([46, 44, 46], [90, 88, 92], 11),
  [I.RAW_IRON]: () => lump([196, 160, 128], [150, 104, 80], 12),
  [I.RAW_GOLD]: () => lump([236, 196, 70], [200, 140, 40], 13),
  [I.IRON_INGOT]: () => ingot([214, 216, 222]),
  [I.GOLD_INGOT]: () => ingot([246, 206, 64]),
  [I.DIAMOND]: () => {
    const p = blank();
    for (let y = 3; y <= 13; y++) for (let x = 2; x <= 13; x++) {
      const top = y <= 6;
      const half = top ? 2 + (y - 3) : 13 - y;
      if (Math.abs(x - 7.5) > half + 1.5) continue;
      p.set(x, y, top ? (x < 8 ? [190, 255, 250] : [120, 236, 228]) : x < 8 ? [80, 210, 204] : [50, 170, 166]);
    }
    return p;
  },
  [I.ASHFRUIT]: () => fruit([142, 92, 168], true),
  [I.BAKED_ASHFRUIT]: () => fruit([186, 104, 52], false),
  [I.FROSTBERRIES]: () => {
    const p = blank();
    for (const [cx, cy] of [[5, 10], [10, 10], [7.5, 6]]) {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= 2.6) p.set(x, y, d < 1 ? [220, 240, 255] : [120, 170, 230]);
      }
    }
    p.set(8, 2, [60, 110, 70]);
    p.set(8, 3, [60, 110, 70]);
    return p;
  },
  [I.RAW_MEAT]: () => meat([200, 70, 70], [240, 200, 190]),
  [I.COOKED_MEAT]: () => meat([150, 82, 44], [222, 170, 110]),
  [I.FLEECE]: () => {
    const p = blank();
    const r = mulberry32(21);
    for (let n = 0; n < 9; n++) {
      const cx = 4 + r() * 8;
      const cy = 5 + r() * 7;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < 2.6) p.set(x, y, shade([236, 230, 214], 0.85 + (2.6 - d) * 0.06));
      }
    }
    return p;
  },
  [I.HIDE]: () => {
    const p = blank();
    for (let y = 3; y < 14; y++) for (let x = 2; x < 14; x++) {
      const edge = (x === 2 || x === 13) && (y < 5 || y > 11);
      if (edge) continue;
      p.set(x, y, shade([150, 96, 58], 0.9 + ((x * 7 + y * 3) % 5) * 0.03));
    }
    for (let x = 4; x < 12; x += 3) p.set(x, 8, [110, 68, 40]);
    return p;
  },
  [I.SILK]: () => {
    const p = blank();
    for (let t = 0; t < 40; t++) {
      const a = t / 40 * Math.PI * 3;
      const x = Math.round(8 + Math.cos(a) * (2 + t / 10));
      const y = Math.round(8 + Math.sin(a) * (2 + t / 10));
      p.set(x, y, [232, 236, 240]);
    }
    return p;
  },
  [I.GLOOM_ASH]: () => lump([70, 58, 86], [150, 120, 190], 31),
  [I.SPORE_POWDER]: () => {
    const p = lump([110, 200, 170], [200, 255, 235], 41);
    return p;
  },
  [B.ASHWOOD_DOOR]: () => {
    const p = blank();
    for (let y = 1; y < 15; y++) for (let x = 4; x < 12; x++) {
      const frame = x === 4 || x === 11 || y === 1 || y === 14 || y === 7;
      const window = y >= 2 && y <= 6 && x >= 5 && x <= 10;
      p.set(x, y, frame ? [120, 92, 60] : window ? [170, 210, 230] : [176, 150, 108]);
    }
    p.set(10, 9, [60, 50, 40]);
    return p;
  },
};

/** A sprite for a non-block (or flat block) item, or null if the item has none. */
export function paintItem(id: number): Pixmap | null {
  const painter = PAINTERS[id];
  if (painter) return painter();
  const tool = toolParts(id);
  if (tool) return toolSprite(tool.tier, tool.kind, tool.head);
  return null;
}
