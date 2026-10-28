/** Small, fast seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash of a seed and an integer position. */
export function hash3i(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic float in [0, 1) for a seed and an integer position. */
export function hash01(seed: number, x: number, y: number, z: number): number {
  return hash3i(seed, x, y, z) / 4294967296;
}

/** Numeric strings are used as-is; anything else is hashed (FNV-1a). */
export function seedFromString(s: string): number {
  const trimmed = s.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed) | 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

export function randomSeed(): number {
  return (Math.random() * 0x7fffffff) | 0;
}
