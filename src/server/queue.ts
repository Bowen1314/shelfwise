export type AcquireResult = { ok: true; release: () => void } | { ok: false; reason: "full" | "timeout" | "aborted" };

interface Waiter {
  grant: () => void;
  onPosition: (position: number, ahead: number) => void;
}

/**
 * Caps concurrent agent runs (the host has little RAM) and queues the rest in order. Waiting runs are told their
 * position so the UI can show a visible "waiting" state; a waiter that disconnects or times out leaves the queue.
 */
export class RunQueue {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiting: number,
  ) {}

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** True when a new run would have to be rejected rather than queued. */
  isFull(): boolean {
    return this.active >= this.maxActive && this.waiters.length >= this.maxWaiting;
  }

  acquire(signal: AbortSignal, onPosition: (position: number, ahead: number) => void, timeoutMs: number): Promise<AcquireResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve({ ok: true, release: this.makeRelease() });
    }
    if (this.waiters.length >= this.maxWaiting) return Promise.resolve({ ok: false, reason: "full" });

    return new Promise<AcquireResult>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          this.active += 1;
          resolve({ ok: true, release: this.makeRelease() });
        },
        onPosition,
      };
      const leave = (reason: "timeout" | "aborted"): void => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return;
        this.waiters.splice(i, 1);
        cleanup();
        this.notify();
        resolve({ ok: false, reason });
      };
      const onAbort = (): void => leave("aborted");
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      timer = setTimeout(() => leave("timeout"), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.notify();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next.grant();
      this.notify();
    };
  }

  private notify(): void {
    this.waiters.forEach((w, i) => w.onPosition(i + 1, i));
  }
}
