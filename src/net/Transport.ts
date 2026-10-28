/** A bidirectional, ordered, reliable message channel. */
export interface Transport<Out, In> {
  send(msg: Out): void;
  onMessage: ((msg: In) => void) | null;
  onClose: ((reason: string) => void) | null;
  close(reason?: string): void;
  /** Bytes queued for sending (network transports only). */
  readonly backlog?: number;
}
