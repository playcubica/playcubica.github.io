import type { Transport } from './Transport';

// In-page transport for single player and for the host's own client.
// Delivery is asynchronous (like a real network) but loss-free and ordered.

class LocalEnd<Out, In> implements Transport<Out, In> {
  onMessage: ((msg: In) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  peer!: LocalEnd<In, Out>;
  closed = false;
  private outbox: Out[] = [];
  private scheduled = false;

  send(msg: Out): void {
    if (this.closed) return;
    this.outbox.push(msg);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const batch = this.outbox;
    this.outbox = [];
    for (const m of batch) this.peer.onMessage?.(m);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.peer.closed = true;
    this.onClose?.(reason);
    this.peer.onClose?.(reason);
  }
}

export function createLocalPair<A, B>(): [Transport<A, B>, Transport<B, A>] {
  const a = new LocalEnd<A, B>();
  const b = new LocalEnd<B, A>();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
