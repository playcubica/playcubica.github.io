import { CHUNK_AREA, CHUNK_HEIGHT } from '../constants';
import type { BlockEntity } from './blockEntities';
import { Chunk } from './Chunk';

// Binary chunk format, used both for IndexedDB saves and for network transfer.
//   u8 version | zigzag-varint cx | zigzag-varint cz | u8 topY
//   RLE(blocks[0 .. topY*256)) as varint (runLength, value) pairs
//   RLE(light [0 .. topY*256))
//   heightmap[256] | biomes[256]
//   (v2) varint count, then per block entity: varint index, varint length, UTF-8 JSON
// Layers at y >= topY are implicit: air with full sky light.

export const CHUNK_CODEC_VERSION = 2;

class ByteWriter {
  buf = new Uint8Array(4096);
  len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  varint(v: number): void {
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }

  zigzag(v: number): void {
    this.varint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error('chunk data truncated');
    return this.buf[this.pos++];
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if (b < 0x80) return result >>> 0;
      shift += 7;
      if (shift > 28) throw new Error('bad varint');
    }
  }

  zigzag(): number {
    const v = this.varint();
    return (v >>> 1) ^ -(v & 1);
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('chunk data truncated');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function writeRle(w: ByteWriter, data: ArrayLike<number>, count: number): void {
  let i = 0;
  while (i < count) {
    const v = data[i];
    let run = 1;
    while (i + run < count && data[i + run] === v) run++;
    w.varint(run);
    w.varint(v);
    i += run;
  }
}

function readRle(r: ByteReader, out: Uint16Array | Uint8Array, count: number): void {
  let i = 0;
  while (i < count) {
    const run = r.varint();
    const v = r.varint();
    if (i + run > count) throw new Error('RLE overflow');
    out.fill(v, i, i + run);
    i += run;
  }
}

export function encodeChunk(c: Chunk): Uint8Array {
  // Block light can rise up to 15 blocks above the highest block.
  const topY = Math.min(CHUNK_HEIGHT, c.maxY + 16);
  const count = Math.max(0, topY) * CHUNK_AREA;
  const w = new ByteWriter();
  w.u8(CHUNK_CODEC_VERSION);
  w.zigzag(c.cx);
  w.zigzag(c.cz);
  w.varint(Math.max(0, topY));
  writeRle(w, c.blocks, count);
  writeRle(w, c.light, count);
  w.bytes(c.heightmap);
  w.bytes(c.biomes);
  w.varint(c.blockEntities.size);
  const enc = new TextEncoder();
  for (const [index, be] of c.blockEntities) {
    const json = enc.encode(JSON.stringify(be));
    w.varint(index);
    w.varint(json.length);
    w.bytes(json);
  }
  return w.result();
}

export function decodeChunk(data: Uint8Array): Chunk {
  const r = new ByteReader(data);
  const version = r.u8();
  if (version !== 1 && version !== 2) throw new Error(`unsupported chunk version ${version}`);
  const cx = r.zigzag();
  const cz = r.zigzag();
  const topY = r.varint();
  if (topY > CHUNK_HEIGHT) throw new Error('bad chunk height');
  const c = new Chunk(cx, cz);
  const count = topY * CHUNK_AREA;
  readRle(r, c.blocks, count);
  readRle(r, c.light, count);
  c.light.fill(0xf0, count);
  c.heightmap.set(r.bytes(CHUNK_AREA));
  c.biomes.set(r.bytes(CHUNK_AREA));
  if (version >= 2) {
    const count = r.varint();
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      const index = r.varint();
      const json = dec.decode(r.bytes(r.varint()));
      if (index < 65536) c.blockEntities.set(index, JSON.parse(json) as BlockEntity);
    }
  }
  c.recomputeHeights();
  return c;
}
