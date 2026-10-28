// `.cubica` world export format:
//   8 bytes  magic "CUBICAW1"
//   u32 LE   header length, then the header as UTF-8 JSON (world metadata)
//   repeated: u32 LE length + one chunk in chunkCodec format

const MAGIC = 'CUBICAW1';

export function packWorldFile(header: unknown, chunks: Uint8Array[]): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  let size = MAGIC.length + 4 + head.length;
  for (const c of chunks) size += 4 + c.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < MAGIC.length; i++) out[o++] = MAGIC.charCodeAt(i);
  view.setUint32(o, head.length, true);
  o += 4;
  out.set(head, o);
  o += head.length;
  for (const c of chunks) {
    view.setUint32(o, c.length, true);
    o += 4;
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function unpackWorldFile(data: Uint8Array): { header: unknown; chunks: Uint8Array[] } {
  const fail = (why: string): never => {
    throw new Error(`קובץ עולם לא תקין (${why})`);
  };
  if (data.length < MAGIC.length + 4) fail('קצר מדי');
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC.charCodeAt(i)) fail('לא קובץ Cubica');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = MAGIC.length;
  const headLen = view.getUint32(o, true);
  o += 4;
  if (o + headLen > data.length) fail('כותרת חתוכה');
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(o, o + headLen)));
  } catch {
    fail('כותרת פגומה');
  }
  o += headLen;
  const chunks: Uint8Array[] = [];
  while (o < data.length) {
    if (o + 4 > data.length) fail('נתונים חתוכים');
    const len = view.getUint32(o, true);
    o += 4;
    if (o + len > data.length) fail('נתונים חתוכים');
    chunks.push(data.slice(o, o + len));
    o += len;
  }
  return { header, chunks };
}
