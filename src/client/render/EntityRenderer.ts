import * as THREE from 'three';
import type { EntityInfo } from '../../shared/protocol/messages';
import type { ClientWorld } from '../ClientWorld';
import { itemIconCanvas } from '../ui/icons';

interface ItemSprite {
  sprite: THREE.Sprite;
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  phase: number;
}

/** Draws entities the host reports (stage 3: dropped items, as bobbing sprites). */
export class EntityRenderer {
  private readonly items = new Map<number, ItemSprite>();
  private readonly textures = new Map<number, THREE.Texture>();
  private time = 0;

  constructor(private readonly scene: THREE.Scene, private readonly world: ClientWorld) {}

  get count(): number {
    return this.items.size;
  }

  private texture(itemId: number): THREE.Texture {
    let t = this.textures.get(itemId);
    if (!t) {
      t = new THREE.CanvasTexture(itemIconCanvas(itemId));
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      this.textures.set(itemId, t);
    }
    return t;
  }

  spawn(e: EntityInfo): void {
    this.remove(e.id);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(e.item.id), transparent: true, alphaTest: 0.3, fog: false }));
    sprite.scale.setScalar(e.item.count > 1 ? 0.42 : 0.36);
    this.scene.add(sprite);
    this.items.set(e.id, { sprite, x: e.x, y: e.y, z: e.z, tx: e.x, ty: e.y, tz: e.z, phase: Math.random() * 6 });
  }

  move(data: number[]): void {
    for (let i = 0; i < data.length; i += 4) {
      const e = this.items.get(data[i]);
      if (!e) continue;
      e.tx = data[i + 1];
      e.ty = data[i + 2];
      e.tz = data[i + 3];
    }
  }

  remove(id: number): void {
    const e = this.items.get(id);
    if (!e) return;
    this.scene.remove(e.sprite);
    e.sprite.material.dispose();
    this.items.delete(id);
  }

  /** Drops entities inside a chunk the client no longer holds. */
  removeInChunk(cx: number, cz: number): void {
    for (const [id, e] of this.items) if (Math.floor(e.x) >> 4 === cx && Math.floor(e.z) >> 4 === cz) this.remove(id);
  }

  update(dt: number, daylight: number): void {
    this.time += dt;
    const k = Math.min(1, dt * 12);
    for (const e of this.items.values()) {
      e.x += (e.tx - e.x) * k;
      e.y += (e.ty - e.y) * k;
      e.z += (e.tz - e.z) * k;
      e.sprite.position.set(e.x, e.y + 0.22 + Math.sin(this.time * 2.5 + e.phase) * 0.06, e.z);
      const l = this.world.getLight(Math.floor(e.x), Math.floor(e.y + 0.2), Math.floor(e.z));
      const b = Math.max(0.08, Math.pow(0.8, 15 - (l >> 4)) * daylight, Math.pow(0.8, 15 - (l & 15)));
      e.sprite.material.color.setRGB(b, b, b);
    }
  }

  dispose(): void {
    for (const id of [...this.items.keys()]) this.remove(id);
    for (const t of this.textures.values()) t.dispose();
  }
}
