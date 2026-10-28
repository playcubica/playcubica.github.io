import type { DataConnection } from 'peerjs';
import { decodeMessage, encodeMessage, fragment, Reassembler } from '../shared/protocol/codec';
import type { Transport } from './Transport';

/** A Transport over a PeerJS data connection ('raw' serialization, reliable + ordered). */
export class PeerTransport<Out extends { t: string }, In> implements Transport<Out, In> {
  onMessage: ((msg: In) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  /** performance.now() of the last message received. */
  lastReceived = performance.now();
  private readonly reassembler = new Reassembler();
  private nextId = 1;
  private closed = false;

  constructor(private readonly conn: DataConnection) {
    conn.on('data', (data) => this.receive(data));
    conn.on('close', () => this.finish('החיבור נסגר'));
    conn.on('error', (err) => this.finish(`שגיאת חיבור: ${err.message}`));
    const pc = conn.peerConnection;
    pc?.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') this.finish('החיבור הישיר בין המחשבים נכשל');
    });
  }

  /** The peer's id on the signalling server. */
  get peer(): string {
    return this.conn.peer;
  }

  /** Bytes waiting to be sent; the host slows chunk streaming when this grows. */
  get backlog(): number {
    const queued = (this.conn as unknown as { bufferSize?: number }).bufferSize ?? 0;
    return (this.conn.dataChannel?.bufferedAmount ?? 0) + queued * 16 * 1024;
  }

  send(msg: Out): void {
    if (this.closed) return;
    for (const part of fragment(encodeMessage(msg), this.nextId++)) {
      void this.conn.send(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
    }
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    this.lastReceived = performance.now();
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!bytes) throw new Error('unexpected data type');
      const payload = this.reassembler.push(bytes);
      if (payload) this.onMessage?.(decodeMessage(payload) as In);
    } catch (err) {
      console.warn('dropping bad message from', this.conn.peer, err);
    }
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }

  close(reason = 'נסגר'): void {
    if (this.closed) return;
    this.finish(reason);
    // Let queued messages (e.g. a kick reason) go out before closing.
    setTimeout(() => this.conn.close(), 250);
  }
}
