// A fixed set of workers that each run one job at a time.
// Worker side contract: receives { id, req }, replies { id, res } or { id, error }.

interface Job<Req, Res> {
  req: Req;
  transfer: Transferable[];
  resolve: (res: Res) => void;
  reject: (err: Error) => void;
}

export class WorkerPool<Req, Res> {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Job<Req, Res>[] = [];
  private readonly running = new Map<number, Job<Req, Res>>();
  private nextId = 1;

  constructor(factory: () => Worker, readonly size: number) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<{ id: number; res?: Res; error?: string }>) => {
        const job = this.running.get(e.data.id);
        this.running.delete(e.data.id);
        this.idle.push(w);
        if (job) {
          if (e.data.error !== undefined) job.reject(new Error(e.data.error));
          else job.resolve(e.data.res as Res);
        }
        this.pump();
      };
      w.onerror = (e) => console.error('worker error', e.message);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(req: Req, transfer: Transferable[] = []): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      this.queue.push({ req, transfer, resolve, reject });
      this.pump();
    });
  }

  /** Jobs running or waiting. */
  get load(): number {
    return this.running.size + this.queue.length;
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      const id = this.nextId++;
      this.running.set(id, job);
      w.postMessage({ id, req: job.req }, job.transfer);
    }
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    for (const job of this.running.values()) job.reject(new Error('pool terminated'));
    for (const job of this.queue) job.reject(new Error('pool terminated'));
    this.running.clear();
    this.queue.length = 0;
  }
}

/** Installs the worker-side half of the pool contract. */
export function serveWorker<Req, Res>(handler: (req: Req) => { res: Res; transfer?: Transferable[] }): void {
  const ctx = self as unknown as Worker;
  ctx.onmessage = (e: MessageEvent<{ id: number; req: Req }>) => {
    try {
      const { res, transfer } = handler(e.data.req);
      ctx.postMessage({ id: e.data.id, res }, transfer ?? []);
    } catch (err) {
      ctx.postMessage({ id: e.data.id, error: String(err) });
    }
  };
}

export function defaultWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, Math.floor((cores - 1) / 2)));
}
