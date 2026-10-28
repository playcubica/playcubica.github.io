import { LIGHT_EMIT, LIGHT_FILTER, OPAQUE } from '../blocks/registry';
import { CHUNK_AREA } from '../constants';
import { Chunk, idx } from './Chunk';

// Flood-fill lighting with two channels: sky (high nibble) and block (low nibble).
//  - Each step loses 1 level plus the target block's filter.
//  - Full-strength sky light (15) travels straight down without loss through clear blocks.
// Chunks are first lit in isolation (worldgen worker); mergeChunkBorders() then lets
// light flow across chunk boundaries once neighbours are present.

export interface ChunkSource {
  getChunk(cx: number, cz: number): Chunk | undefined;
}

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];
const DOWN = 3;

const SKY = 0;
const BLK = 1;
type Channel = typeof SKY | typeof BLK;

/** Growable FIFO of (x, y, z[, level]) integer tuples. */
class Queue {
  data = new Int32Array(4096);
  head = 0;
  tail = 0;

  constructor(readonly stride: number) {}

  push(x: number, y: number, z: number, level = 0): void {
    if (this.tail + this.stride > this.data.length) {
      if (this.head > 0) {
        this.data.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      }
      if (this.tail + this.stride > this.data.length) {
        const next = new Int32Array(this.data.length * 2);
        next.set(this.data.subarray(0, this.tail));
        this.data = next;
      }
    }
    const d = this.data;
    d[this.tail] = x;
    d[this.tail + 1] = y;
    d[this.tail + 2] = z;
    if (this.stride === 4) d[this.tail + 3] = level;
    this.tail += this.stride;
  }

  get empty(): boolean {
    return this.head >= this.tail;
  }

  reset(): void {
    this.head = 0;
    this.tail = 0;
  }
}

function getLevel(c: Chunk, i: number, ch: Channel): number {
  return ch === SKY ? c.light[i] >> 4 : c.light[i] & 15;
}

function setLevel(c: Chunk, i: number, ch: Channel, v: number): void {
  c.light[i] = ch === SKY ? (c.light[i] & 0x0f) | (v << 4) : (c.light[i] & 0xf0) | v;
}

/** Caches the last looked-up chunk; most neighbour lookups stay in the same chunk. */
class Lookup {
  private cx = NaN;
  private cz = NaN;
  private c: Chunk | undefined;
  constructor(private readonly src: ChunkSource) {}
  get(cx: number, cz: number): Chunk | undefined {
    if (cx !== this.cx || cz !== this.cz) {
      this.cx = cx;
      this.cz = cz;
      this.c = this.src.getChunk(cx, cz);
    }
    return this.c;
  }
}

/** Spreads light outward from every queued cell (world coordinates). */
function propagate(src: ChunkSource, q: Queue, ch: Channel, touched?: Set<Chunk>): void {
  const look = new Lookup(src);
  while (q.head < q.tail) {
    const x = q.data[q.head];
    const y = q.data[q.head + 1];
    const z = q.data[q.head + 2];
    q.head += q.stride;
    const c = look.get(x >> 4, z >> 4);
    if (!c) continue;
    const level = getLevel(c, idx(x & 15, y, z & 15), ch);
    if (level <= 1) continue;
    for (let dir = 0; dir < 6; dir++) {
      const ny = y + DY[dir];
      if (ny < 0 || ny > 255) continue;
      const nx = x + DX[dir];
      const nz = z + DZ[dir];
      const nc = (nx >> 4) === c.cx && (nz >> 4) === c.cz ? c : look.get(nx >> 4, nz >> 4);
      if (!nc) continue;
      const ni = idx(nx & 15, ny, nz & 15);
      const id = nc.blocks[ni] & 0xfff;
      if (OPAQUE[id]) continue;
      const filter = LIGHT_FILTER[id];
      const next = ch === SKY && dir === DOWN && level === 15 && filter === 0 ? 15 : level - 1 - filter;
      if (next > getLevel(nc, ni, ch)) {
        setLevel(nc, ni, ch, next);
        q.push(nx, ny, nz);
        touched?.add(nc);
      }
    }
  }
  q.reset();
}

/** Lights a freshly generated chunk as if it had no neighbours. */
export function computeChunkLight(chunk: Chunk): void {
  const { blocks, light } = chunk;
  light.fill(0);
  const src: ChunkSource = { getChunk: (cx, cz) => (cx === chunk.cx && cz === chunk.cz ? chunk : undefined) };
  const bx = chunk.cx * 16;
  const bz = chunk.cz * 16;

  // Sky light: straight down each column until something opaque.
  for (let col = 0; col < CHUNK_AREA; col++) {
    let level = 15;
    for (let y = 255; y >= 0 && level > 0; y--) {
      const i = col | (y << 8);
      const id = blocks[i] & 0xfff;
      if (OPAQUE[id]) break;
      level = Math.max(0, level - LIGHT_FILTER[id]);
      light[i] = level << 4;
    }
  }

  // Seed horizontal spreading wherever a lit cell borders a darker clear cell.
  const sky = new Queue(3);
  const top = Math.min(255, chunk.maxY + 1);
  for (let y = 0; y <= top; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = idx(x, y, z);
        const s = light[i] >> 4;
        if (s <= 1) continue;
        const want = s - 1;
        if (
          (x < 15 && (light[i + 1] >> 4) < want && !OPAQUE[blocks[i + 1] & 0xfff]) ||
          (x > 0 && (light[i - 1] >> 4) < want && !OPAQUE[blocks[i - 1] & 0xfff]) ||
          (z < 15 && (light[i + 16] >> 4) < want && !OPAQUE[blocks[i + 16] & 0xfff]) ||
          (z > 0 && (light[i - 16] >> 4) < want && !OPAQUE[blocks[i - 16] & 0xfff]) ||
          (y > 0 && (light[i - 256] >> 4) < want && !OPAQUE[blocks[i - 256] & 0xfff])
        ) {
          sky.push(bx + x, y, bz + z);
        }
      }
    }
  }
  propagate(src, sky, SKY);

  // Block light from emitters.
  const blk = new Queue(3);
  const count = (chunk.maxY + 1) * CHUNK_AREA;
  for (let i = 0; i < count; i++) {
    const e = LIGHT_EMIT[blocks[i] & 0xfff];
    if (e) {
      light[i] = (light[i] & 0xf0) | e;
      blk.push(bx + (i & 15), i >> 8, bz + ((i >> 4) & 15));
    }
  }
  propagate(src, blk, BLK);
}

/**
 * Lets light flow between a newly added chunk and its four loaded neighbours.
 * Returns every chunk whose light changed.
 */
export function mergeChunkBorders(src: ChunkSource, chunk: Chunk): Set<Chunk> {
  const touched = new Set<Chunk>();
  const sky = new Queue(3);
  const blk = new Queue(3);
  const sides: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of sides) {
    const n = src.getChunk(chunk.cx + dx, chunk.cz + dz);
    if (!n) continue;
    const top = Math.min(255, Math.max(chunk.maxY, n.maxY) + 16);
    for (let y = 0; y <= top; y++) {
      for (let t = 0; t < 16; t++) {
        // (lx, lz): cell on our edge; (nx, nz): facing cell in the neighbour.
        const lx = dx === 1 ? 15 : dx === -1 ? 0 : t;
        const lz = dz === 1 ? 15 : dz === -1 ? 0 : t;
        const nx = dx === 1 ? 0 : dx === -1 ? 15 : t;
        const nz = dz === 1 ? 0 : dz === -1 ? 15 : t;
        const a = chunk.light[idx(lx, y, lz)];
        const b = n.light[idx(nx, y, nz)];
        const ax = chunk.cx * 16 + lx;
        const az = chunk.cz * 16 + lz;
        const bx = n.cx * 16 + nx;
        const bz = n.cz * 16 + nz;
        if (a >> 4 > 1) sky.push(ax, y, az);
        if ((a & 15) > 1) blk.push(ax, y, az);
        if (b >> 4 > 1) sky.push(bx, y, bz);
        if ((b & 15) > 1) blk.push(bx, y, bz);
      }
    }
  }
  propagate(src, sky, SKY, touched);
  propagate(src, blk, BLK, touched);
  return touched;
}

/**
 * Repairs light after the block at (x, y, z) changed (placed or removed).
 * Returns every chunk whose light changed.
 */
export function updateLightAt(src: ChunkSource, x: number, y: number, z: number): Set<Chunk> {
  const touched = new Set<Chunk>();
  const look = new Lookup(src);
  const home = look.get(x >> 4, z >> 4);
  if (!home) return touched;
  touched.add(home);
  const hi = idx(x & 15, y, z & 15);
  const id = home.blocks[hi] & 0xfff;

  for (const ch of [SKY, BLK] as Channel[]) {
    const remove = new Queue(4);
    const add = new Queue(3);
    const old = getLevel(home, hi, ch);
    setLevel(home, hi, ch, 0);
    if (old > 0) remove.push(x, y, z, old);

    // Un-light everything that depended on the old value.
    while (!remove.empty) {
      const rx = remove.data[remove.head];
      const ry = remove.data[remove.head + 1];
      const rz = remove.data[remove.head + 2];
      const level = remove.data[remove.head + 3];
      remove.head += 4;
      for (let dir = 0; dir < 6; dir++) {
        const ny = ry + DY[dir];
        if (ny < 0 || ny > 255) continue;
        const nx = rx + DX[dir];
        const nz = rz + DZ[dir];
        const nc = look.get(nx >> 4, nz >> 4);
        if (!nc) continue;
        const ni = idx(nx & 15, ny, nz & 15);
        const nl = getLevel(nc, ni, ch);
        if (nl === 0) continue;
        if (nl < level || (ch === SKY && dir === DOWN && level === 15 && nl === 15)) {
          setLevel(nc, ni, ch, 0);
          remove.push(nx, ny, nz, nl);
          touched.add(nc);
        } else {
          add.push(nx, ny, nz);
        }
      }
    }

    if (ch === BLK && LIGHT_EMIT[id]) {
      setLevel(home, hi, ch, LIGHT_EMIT[id]);
      add.push(x, y, z);
    }
    // Neighbours re-flood into the changed cell (if it is now clear).
    for (let dir = 0; dir < 6; dir++) {
      const ny = y + DY[dir];
      if (ny < 0 || ny > 255) continue;
      if (look.get((x + DX[dir]) >> 4, (z + DZ[dir]) >> 4)) add.push(x + DX[dir], ny, z + DZ[dir]);
    }
    if (ch === SKY && y === 255 && !OPAQUE[id]) {
      setLevel(home, hi, ch, Math.max(0, 15 - LIGHT_FILTER[id]));
      add.push(x, y, z);
    }
    propagate(src, add, ch, touched);
  }
  return touched;
}
