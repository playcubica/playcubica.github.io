import { faceLayer, FACING_DIR, RENDER, TEX_SIDE, withState } from '../../shared/blocks/registry';
import { itemDef } from '../../shared/items/registry';
import { atlasTile } from '../textures/atlas';
import { paintItem } from '../textures/itemTextures';
import { TEX_SIZE } from '../textures/procedural';

// Inventory icons: blocks are drawn as small isometric cubes from the atlas;
// plants, torches, doors and non-block items as flat sprites. Cached per item.

const SIZE = 48;
const canvases = new Map<number, HTMLCanvasElement>();
const urls = new Map<number, string>();
let atlas: HTMLCanvasElement | null = null;

export function setIconAtlas(canvas: HTMLCanvasElement): void {
  atlas = canvas;
  canvases.clear();
  urls.clear();
}

/** One texture layer as its own 16×16 canvas (for 3D falling blocks). */
export function tileCanvas(layer: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  if (atlas) {
    const [sx, sy] = atlasTile(layer);
    c.getContext('2d')!.drawImage(atlas, sx, sy, TEX_SIZE, TEX_SIZE, 0, 0, TEX_SIZE, TEX_SIZE);
  }
  return c;
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

function drawFlat(g: CanvasRenderingContext2D, src: CanvasImageSource, sx: number, sy: number): void {
  g.drawImage(src, sx, sy, TEX_SIZE, TEX_SIZE, 4, 4, SIZE - 8, SIZE - 8);
}

/** The icon as a canvas (also used for item sprites in the world). */
export function itemIconCanvas(id: number): HTMLCanvasElement {
  const hit = canvases.get(id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const def = itemDef(id);
  const sprite = paintItem(id);
  if (sprite) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = TEX_SIZE;
    tile.getContext('2d')!.putImageData(new ImageData(sprite.data, TEX_SIZE, TEX_SIZE), 0, 0);
    drawFlat(g, tile, 0, 0);
  } else if (atlas && def?.block !== undefined) {
    const block = def.block;
    if (def.flat || RENDER[block] === 2) {
      const [sx, sy] = atlasTile(TEX_SIDE[block]);
      drawFlat(g, atlas, sx, sy);
    } else {
      // Show the block's front (if it has one) on the left face.
      const raw = withState(block, 0);
      const left = faceLayer(raw, FACING_DIR[0]);
      const layer = (draw: (lg: CanvasRenderingContext2D) => void) => {
        const l = document.createElement('canvas');
        l.width = l.height = SIZE;
        const lg = l.getContext('2d')!;
        lg.imageSmoothingEnabled = false;
        draw(lg);
        g.drawImage(l, 0, 0);
      };
      layer((lg) => face(lg, faceLayer(raw, 2), [4, 14], [20, -10], [20, 10], 0));
      layer((lg) => face(lg, left, [4, 14], [20, 10], [0, 22], 0.22));
      layer((lg) => face(lg, faceLayer(raw, 0), [24, 24], [20, -10], [0, 22], 0.4));
    }
  }
  canvases.set(id, c);
  return c;
}

export function itemIcon(id: number): string {
  let url = urls.get(id);
  if (!url) {
    url = itemIconCanvas(id).toDataURL();
    urls.set(id, url);
  }
  return url;
}
