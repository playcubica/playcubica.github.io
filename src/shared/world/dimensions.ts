// The Ember Deep (עמקי הגחלים) lives in the same coordinate space as the surface world,
// one million blocks east. Everything (chunks, saves, creatures, items, networking) works
// unchanged; generation, sky and spawning check isDeep(x). Rifts map x ± DEEP_ORIGIN 1:1.

export const DEEP_ORIGIN = 1_000_000;
/** The Deep is sealed between corerock at y=0 and y=DEEP_CEILING. */
export const DEEP_CEILING = 127;

export function isDeep(x: number): boolean {
  return x >= DEEP_ORIGIN / 2;
}
