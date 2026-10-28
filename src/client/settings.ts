// Player settings, remembered in this browser (localStorage).

export interface Settings {
  /** Chunks. */
  viewDistance: number;
  /** Degrees. */
  fov: number;
  /** Mouse sensitivity multiplier. */
  sensitivity: number;
  /** 0..1 */
  sound: number;
  /** 0..1 */
  music: number;
  /** The F3 info panel (fps, coordinates…). */
  showDebug: boolean;
}

const KEY = 'cubica.settings';
export const DEFAULT_SETTINGS: Settings = { viewDistance: 8, fov: 70, sensitivity: 1, sound: 0.8, music: 0.5, showDebug: false };

const clamp = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

export function loadSettings(): Settings {
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    // storage blocked or corrupt: defaults
  }
  const d = DEFAULT_SETTINGS;
  return {
    viewDistance: Math.round(clamp(raw.viewDistance, 2, 12, d.viewDistance)),
    fov: Math.round(clamp(raw.fov, 50, 110, d.fov)),
    sensitivity: clamp(raw.sensitivity, 0.2, 3, d.sensitivity),
    sound: clamp(raw.sound, 0, 1, d.sound),
    music: clamp(raw.music, 0, 1, d.music),
    showDebug: typeof raw.showDebug === 'boolean' ? raw.showDebug : d.showDebug,
  };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage blocked: settings last for this visit only
  }
}
