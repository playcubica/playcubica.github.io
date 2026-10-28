import { DAY_LENGTH_TICKS } from './constants';

// Time of day. 0 = sunrise, 6000 = noon, 12000 = sunset, 18000 = midnight.

/** Position in the day cycle, 0..1. */
export function dayFraction(time: number): number {
  return (((time % DAY_LENGTH_TICKS) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS) / DAY_LENGTH_TICKS;
}

/** Height of the sun: 1 at noon, -1 at midnight. */
export function sunHeight(time: number): number {
  return Math.sin(dayFraction(time) * Math.PI * 2);
}

/** How much sky light reaches the ground: 0 at night, 1 by day (smooth at dawn/dusk). */
export function daylight(time: number): number {
  const t = Math.min(1, Math.max(0, (sunHeight(time) + 0.18) / 0.4));
  return t * t * (3 - 2 * t);
}
