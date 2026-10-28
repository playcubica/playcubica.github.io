import { describe, expect, it, vi } from 'vitest';

// A fake PeerJS signalling server: ids in `taken` are refused once each (like a page that is
// still closing), every other id opens.
const registered: string[] = [];
const taken = new Map<string, number>();

vi.mock('peerjs', () => {
  class FakePeer {
    destroyed = false;
    private handlers = new Map<string, Array<(arg?: unknown) => void>>();
    constructor(readonly id: string) {
      setTimeout(() => {
        const left = taken.get(id) ?? 0;
        if (left > 0) {
          taken.set(id, left - 1);
          this.emit('error', { type: 'unavailable-id' });
        } else {
          registered.push(id);
          this.emit('open');
        }
      }, 0);
    }
    private emit(ev: string, arg?: unknown): void {
      for (const h of this.handlers.get(ev) ?? []) h(arg);
      if (ev !== 'open' && ev !== 'error') return;
      this.handlers.delete(`once:${ev}`);
    }
    on(ev: string, h: (arg?: unknown) => void): void {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), h]);
    }
    once(ev: string, h: (arg?: unknown) => void): void {
      this.on(ev, h);
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return { Peer: FakePeer };
});

const { HostNetwork, normalizeInviteCode } = await import('../src/net/peerNetwork');

describe('fixed invite codes', () => {
  it('opens a world under its saved code, waiting while the old page still holds it', async () => {
    taken.set('cubica-v1-ABCD2345', 2);
    const net = new HostNetwork(() => {}, 1);
    const code = await net.open('ABCD-2345');
    expect(code).toBe('ABCD-2345');
    expect(registered.at(-1)).toBe('cubica-v1-ABCD2345');
    net.close();
  });

  it('gives up with a readable message if the code stays taken', async () => {
    taken.set('cubica-v1-WXYZ6789', 99);
    const net = new HostNetwork(() => {}, 1);
    await expect(net.open('WXYZ-6789')).rejects.toThrow(/קוד חדש/);
  });

  it('makes up a code when the world has none', async () => {
    const net = new HostNetwork(() => {}, 1);
    const code = await net.open();
    expect(normalizeInviteCode(code)).toBe(code);
    net.close();
  });
});
