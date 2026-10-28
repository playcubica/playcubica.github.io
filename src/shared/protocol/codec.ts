// Wire encoding for protocol messages sent over the network (the in-page
// LocalTransport passes objects directly).
//   byte 0 = 0: UTF-8 JSON message
//   byte 0 = 1: chunk message: zigzag-varint cx, cz, then the chunkCodec bytes

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeVar(out: number[], v: number): void {
  let z = ((v << 1) ^ (v >> 31)) >>> 0;
  while (z >= 0x80) {
    out.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  out.push(z);
}

function readVar(b: Uint8Array, pos: { i: number }): number {
  let r = 0;
  let shift = 0;
  for (;;) {
    if (pos.i >= b.length || shift > 28) throw new Error('bad varint');
    const x = b[pos.i++];
    r |= (x & 0x7f) << shift;
    if (x < 0x80) break;
    shift += 7;
  }
  return (r >>> 1) ^ -(r & 1);
}

export function encodeMessage(msg: { t: string }): Uint8Array {
  const m = msg as { t: string; cx?: number; cz?: number; data?: Uint8Array };
  if (m.t === 'chunk' && m.data instanceof Uint8Array) {
    const head: number[] = [1];
    writeVar(head, m.cx!);
    writeVar(head, m.cz!);
    const out = new Uint8Array(head.length + m.data.length);
    out.set(head);
    out.set(m.data, head.length);
    return out;
  }
  const json = enc.encode(JSON.stringify(msg));
  const out = new Uint8Array(json.length + 1);
  out[0] = 0;
  out.set(json, 1);
  return out;
}

/** Decodes a message; throws on malformed input. The result still needs field validation. */
export function decodeMessage(bytes: Uint8Array): { t: string } {
  if (bytes.length === 0) throw new Error('empty message');
  if (bytes[0] === 1) {
    const pos = { i: 1 };
    const cx = readVar(bytes, pos);
    const cz = readVar(bytes, pos);
    return { t: 'chunk', cx, cz, data: bytes.slice(pos.i) } as { t: string };
  }
  if (bytes[0] !== 0) throw new Error('unknown message kind');
  const msg = JSON.parse(dec.decode(bytes.subarray(1)));
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('not a message');
  return msg;
}

// --- Fragmentation (data channels limit message size) ------------------------
//   byte 0 = 0: whole frame follows
//   byte 0 = 1: fragment: u32 id, u16 index, u16 count, payload

export const FRAGMENT_SIZE = 16 * 1024;
/** Largest reassembled message accepted (protects the host from memory abuse). */
export const MAX_MESSAGE_SIZE = 2 * 1024 * 1024;

export function fragment(payload: Uint8Array, id: number): Uint8Array[] {
  if (payload.length + 1 <= FRAGMENT_SIZE) {
    const out = new Uint8Array(payload.length + 1);
    out[0] = 0;
    out.set(payload, 1);
    return [out];
  }
  const count = Math.ceil(payload.length / FRAGMENT_SIZE);
  const parts: Uint8Array[] = [];
  for (let k = 0; k < count; k++) {
    const slice = payload.subarray(k * FRAGMENT_SIZE, (k + 1) * FRAGMENT_SIZE);
    const out = new Uint8Array(slice.length + 9);
    const v = new DataView(out.buffer);
    out[0] = 1;
    v.setUint32(1, id);
    v.setUint16(5, k);
    v.setUint16(7, count);
    out.set(slice, 9);
    parts.push(out);
  }
  return parts;
}

/** Reassembles fragments (in order, as the channel is ordered). */
export class Reassembler {
  private id = -1;
  private parts: Uint8Array[] = [];
  private size = 0;

  /** Returns a complete payload, or null while waiting for more fragments. */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length === 0) throw new Error('empty frame');
    if (frame[0] === 0) return frame.subarray(1);
    if (frame[0] !== 1 || frame.length < 9) throw new Error('bad frame');
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = v.getUint32(1);
    const index = v.getUint16(5);
    const count = v.getUint16(7);
    if (index === 0) {
      this.id = id;
      this.parts = [];
      this.size = 0;
    }
    if (id !== this.id || index !== this.parts.length || count * FRAGMENT_SIZE > MAX_MESSAGE_SIZE + FRAGMENT_SIZE) {
      throw new Error('fragment out of order');
    }
    const body = frame.slice(9);
    this.parts.push(body);
    this.size += body.length;
    if (this.size > MAX_MESSAGE_SIZE) throw new Error('message too large');
    if (this.parts.length < count) return null;
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.id = -1;
    return out;
  }
}
