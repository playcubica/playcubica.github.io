import { describe, expect, it } from 'vitest';
import type { DataConnection } from 'peerjs';
import { PeerTransport } from '../src/net/PeerTransport';
import { FRAGMENT_SIZE } from '../src/shared/protocol/codec';

/** Two fake PeerJS data connections wired back to back (ArrayBuffers, like 'raw' serialization). */
function fakePair(): [DataConnection, DataConnection, () => void] {
  type Handler = (arg?: unknown) => void;
  const make = () => {
    const handlers: Record<string, Handler[]> = {};
    const conn = {
      peer: 'remote',
      dataChannel: { bufferedAmount: 0 },
      peerConnection: undefined,
      other: null as unknown as { emit(ev: string, arg?: unknown): void },
      on(ev: string, fn: Handler) {
        (handlers[ev] ??= []).push(fn);
      },
      emit(ev: string, arg?: unknown) {
        for (const fn of handlers[ev] ?? []) fn(arg);
      },
      send(data: ArrayBuffer) {
        const copy = data.slice(0);
        queueMicrotask(() => conn.other.emit('data', copy));
      },
      close() {
        conn.emit('close');
        conn.other.emit('close');
      },
    };
    return conn;
  };
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a as unknown as DataConnection, b as unknown as DataConnection, () => a.close()];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PeerTransport', () => {
  it('delivers JSON and big binary messages across fragments, in order', async () => {
    const [ca, cb] = fakePair();
    const a = new PeerTransport<{ t: string }, unknown>(ca);
    const b = new PeerTransport<{ t: string }, unknown>(cb);
    const got: unknown[] = [];
    b.onMessage = (m) => got.push(m);
    const big = new Uint8Array(FRAGMENT_SIZE * 2 + 5).map((_, i) => i & 255);
    a.send({ t: 'chat', text: 'א' } as never);
    a.send({ t: 'chunk', cx: 3, cz: -4, data: big } as never);
    a.send({ t: 'time', time: 9 } as never);
    await flush();
    expect(got.length).toBe(3);
    expect(got[0]).toEqual({ t: 'chat', text: 'א' });
    const chunk = got[1] as { cx: number; cz: number; data: Uint8Array };
    expect([chunk.cx, chunk.cz]).toEqual([3, -4]);
    expect(chunk.data).toEqual(big);
    expect(got[2]).toEqual({ t: 'time', time: 9 });
  });

  it('ignores garbage and reports closing once', async () => {
    const [ca, cb, closeAll] = fakePair();
    const b = new PeerTransport<{ t: string }, unknown>(cb);
    const got: unknown[] = [];
    let closes = 0;
    b.onMessage = (m) => got.push(m);
    b.onClose = () => closes++;
    (ca as unknown as { send(d: ArrayBuffer): void }).send(new Uint8Array([0, 0, 99, 1, 2]).buffer);
    await flush();
    expect(got).toEqual([]);
    closeAll();
    closeAll();
    expect(closes).toBe(1);
  });
});
