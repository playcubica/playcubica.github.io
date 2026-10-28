import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { decodeMessage, encodeMessage, fragment, FRAGMENT_SIZE, Reassembler } from '../src/shared/protocol/codec';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { MoveFlag } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { normalizeInviteCode, newInviteCode } from '../src/net/peerNetwork';
import { GameServer, sanitizeName } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta } from '../src/server/storage/WorldStorage';

describe('wire codec', () => {
  it('round-trips JSON and binary chunk messages', () => {
    const chat = { t: 'chat', text: 'שלום עולם' };
    expect(decodeMessage(encodeMessage(chat))).toEqual(chat);
    const data = new Uint8Array([1, 2, 3, 250]);
    const back = decodeMessage(encodeMessage({ t: 'chunk', cx: -5, cz: 123456, data } as never)) as unknown as { cx: number; cz: number; data: Uint8Array };
    expect(back.cx).toBe(-5);
    expect(back.cz).toBe(123456);
    expect([...back.data]).toEqual([1, 2, 3, 250]);
    expect(() => decodeMessage(new Uint8Array([0, 123]))).toThrow();
    expect(() => decodeMessage(new Uint8Array([7]))).toThrow();
  });

  it('fragments big messages and reassembles them in order', () => {
    const big = new Uint8Array(FRAGMENT_SIZE * 3 + 17).map((_, i) => i % 251);
    const parts = fragment(big, 42);
    expect(parts.length).toBe(4);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    for (const p of parts) out = r.push(p) ?? out;
    expect(out).toEqual(big);
    const small = fragment(new Uint8Array([9, 9]), 1);
    expect(small.length).toBe(1);
    expect([...new Reassembler().push(small[0])!]).toEqual([9, 9]);
    expect(() => new Reassembler().push(parts[1])).toThrow(); // fragment without its start
  });
});

describe('invite codes and names', () => {
  it('normalizes codes typed or pasted as links', () => {
    const code = newInviteCode();
    expect(normalizeInviteCode(code)).toBe(code);
    expect(normalizeInviteCode(code.toLowerCase().replace('-', ''))).toBe(code);
    expect(normalizeInviteCode(`https://x.github.io/cubica/?join=${code}`)).toBe(code);
    expect(normalizeInviteCode('ABC')).toBeNull();
    expect(normalizeInviteCode('ABCD-OOOO')).toBeNull(); // O is not in the alphabet
  });

  it('accepts Hebrew and English names and rejects markup', () => {
    expect(sanitizeName('  דני  ')).toBe('דני');
    expect(sanitizeName('Noa_12')).toBe('Noa_12');
    expect(sanitizeName('<script>')).toBeNull();
    expect(sanitizeName('')).toBeNull();
    expect(sanitizeName('a'.repeat(17))).toBeNull();
  });
});

// --- Several clients on one host ------------------------------------------------

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = B.STONE;
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function world() {
  const server = new GameServer({ viewDistance: 2, meta: newWorldMeta('mp', 1, GameMode.SURVIVAL) }, flatGen);
  const priv = server as unknown as { tick(): void; players: Map<number, { name: string; pos: number[] }>; teleport(p: unknown, pos: number[]): void };
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      priv.tick();
      await flush();
    }
  };
  const join = async (name: string, host = false) => {
    const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
    const got: ServerMsg[] = [];
    let closed = '';
    c.onMessage = (m) => got.push(m);
    c.onClose = (r) => (closed = r);
    server.addConnection(s, { host });
    c.send({ t: 'hello', v: PROTOCOL_VERSION, name });
    await flush();
    const session = [...priv.players.values()].find((p) => p.name === name);
    if (session) priv.teleport(session, [0.5, 10, 0.5]);
    return {
      got,
      send: async (m: ClientMsg) => {
        c.send(m);
        await flush();
      },
      close: () => c.close(),
      get closed() {
        return closed;
      },
      session,
    };
  };
  return { server, tick, join };
}

describe('multiplayer host', () => {
  it('announces players to each other and shares positions', async () => {
    const { tick, join } = await world();
    const a = await join('נועה', true);
    const b = await join('Dan');
    const welcomeB = b.got.find((m) => m.t === 'welcome');
    expect(welcomeB && welcomeB.t === 'welcome' && welcomeB.players.map((p) => p.name).sort()).toEqual(['Dan', 'נועה']);
    expect(a.got.some((m) => m.t === 'playerJoin' && m.player.name === 'Dan')).toBe(true);
    await b.send({ t: 'move', seq: 1, x: 1.5, y: 10, z: 0.5, yaw: 1, pitch: 0, flags: MoveFlag.ON_GROUND | MoveFlag.SNEAK });
    await tick(2);
    const snap = [...a.got].reverse().find((m) => m.t === 'snapshot');
    expect(snap && snap.t === 'snapshot' && snap.entities.length).toBe(1);
    expect(snap && snap.t === 'snapshot' && snap.entities[0].x).toBe(1.5);
    expect(snap && snap.t === 'snapshot' && snap.entities[0].anim & 1).toBe(1);
    b.close();
    await flush();
    expect(a.got.some((m) => m.t === 'playerLeave')).toBe(true);
  });

  it('shares block changes with everyone holding the chunk', async () => {
    const { server, tick, join } = await world();
    const a = await join('A', true);
    const b = await join('B');
    await tick(5);
    a.session!.pos.splice(0, 3, 0.5, 10, 0.5);
    (server as unknown as { players: Map<number, { inventory: { slots: unknown[] } }> }).players.forEach((p) => (p.inventory.slots[0] = { id: B.DIRT, count: 5 }));
    await a.send({ t: 'place', x: 2, y: 10, z: 0, raw: B.DIRT, slot: 0 });
    expect(b.got.some((m) => m.t === 'blockChange' && m.x === 2 && m.id === B.DIRT)).toBe(true);
  });

  it('broadcasts chat, limits its rate and lets only the host kick', async () => {
    const { join } = await world();
    const a = await join('Host', true);
    const b = await join('Guest');
    await b.send({ t: 'chat', text: 'היי <b>כולם</b>' });
    expect(a.got.some((m) => m.t === 'chat' && m.from === 'Guest' && m.text === 'היי <b>כולם</b>')).toBe(true);
    for (let i = 0; i < 6; i++) await b.send({ t: 'chat', text: `spam ${i}` });
    expect(a.got.filter((m) => m.t === 'chat' && m.from === 'Guest').length).toBe(5);
    await b.send({ t: 'chat', text: '/kick Host' });
    expect(a.closed).toBe('');
    await a.send({ t: 'chat', text: '/kick guest' });
    expect(b.got.some((m) => m.t === 'kick')).toBe(true);
    expect(b.closed).not.toBe('');
  });

  it('rejects duplicate and invalid names', async () => {
    const { join } = await world();
    await join('Sam', true);
    const dup = await join('sam');
    expect(dup.got.some((m) => m.t === 'kick')).toBe(true);
    const bad = await join('<img>');
    expect(bad.got.some((m) => m.t === 'kick')).toBe(true);
  });

  it('pulls a speed-hacking client back', async () => {
    const { join } = await world();
    const a = await join('Runner', true);
    await a.send({ t: 'move', seq: 1, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.ON_GROUND });
    await a.send({ t: 'move', seq: 2, x: 60.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.ON_GROUND });
    expect(a.session!.pos[0]).toBe(0.5);
    expect(a.got.some((m) => m.t === 'teleport' && m.x === 0.5)).toBe(true);
  });

  it('measures ping and publishes a player list', async () => {
    const { tick, join } = await world();
    const a = await join('P1', true);
    await tick(40);
    const ping = a.got.find((m) => m.t === 'ping');
    expect(ping).toBeDefined();
    await a.send({ t: 'pong', id: ping!.t === 'ping' ? ping!.id : 0 });
    await tick(60);
    const list = [...a.got].reverse().find((m) => m.t === 'playerList');
    expect(list && list.t === 'playerList' && list.players[0].name).toBe('P1');
    expect(list && list.t === 'playerList' && list.players[0].ping).toBeGreaterThanOrEqual(0);
  });
});
