import { RENDER, TEX_SIDE, TEX_TOP } from '../../shared/blocks/registry';
import { itemDef } from '../../shared/items/registry';
import { atlasTile } from '../textures/atlas';
import { TEX_SIZE } from '../textures/procedural';

// Inventory icons: blocks are drawn as small isometric cubes from the atlas,
// plants as flat sprites. Rendered once per item and cached as data URLs.

const SIZE = 48;
const cache = new Map<number, string>();
let atlas: HTMLCanvasElement | null = null;

export function setIconAtlas(canvas: HTMLCanvasElement): void {
  atlas = canvas;
  cache.clear();
}

/** Draws one atlas tile onto the parallelogram origin + u*s + v*t (s, t in 0..1). */
function face(g: CanvasRenderingContext2D, layer: number, o: [number, number], u: [number, number], v: [number, number], dark: number): void {
  const [sx, sy] = atlasTile(layer);
  g.save();
  g.setTransform(u[0] / TEX_SIZE, u[1] / TEX_SIZE, v[0] / TEX_SIZE, v[1] / TEX_SIZE, o[0], o[1]);
  g.drawImage(atlas!, sx, sy, TEX_SIZE, TEX_SIZE, 0, 0, TEX_SIZE, TEX_SIZE);
  if (dark > 0) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = `rgba(0,0,0,${dark})`;
    g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  }
  g.restore();
}

export function itemIcon(id: number): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const block = itemDef(id)?.block;
  if (atlas && block !== undefined) {
    if (RENDER[block] === 2) {
      const [sx, sy] = atlasTile(TEX_SIDE[block]);
      g.drawImage(atlas, sx, sy, TEX_SIZE, TEX_SIZE, 4, 4, SIZE - 8, SIZE - 8);
    } else {
      // Each face is drawn on its own layer so 'source-atop' darkening only hits that face.
      const layer = (draw: (lg: CanvasRenderingContext2D) => void) => {
        const l = document.createElement('canvas');
        l.width = l.height = SIZE;
        const lg = l.getContext('2d')!;
        lg.imageSmoothingEnabled = false;
        draw(lg);
        g.drawImage(l, 0, 0);
      };
      layer((lg) => face(lg, TEX_TOP[block], [4, 14], [20, -10], [20, 10], 0));
      layer((lg) => face(lg, TEX_SIDE[block], [4, 14], [20, 10], [0, 22], 0.22));
      layer((lg) => face(lg, TEX_SIDE[block], [24, 24], [20, -10], [0, 22], 0.4));
    }
  }
  const url = c.toDataURL();
  cache.set(id, url);
  return url;
}
