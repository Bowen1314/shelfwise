import { TtlCache, cacheKey } from "./cache.js";
import type { JsonObject, QlooEnvelope, QlooToolClient, ToolDef } from "./types.js";
import { syntheticError } from "./types.js";

export interface QlooCallResult {
  envelope: QlooEnvelope;
  /** Served from the response cache: no Qloo call was made and no quota was used. */
  cached: boolean;
  durationMs: number;
}

export interface QlooServiceOptions {
  client: QlooToolClient;
  cache: TtlCache<QlooEnvelope>;
  /** Max real (uncached) Qloo calls per UTC day, across all users. */
  dailyCallBudget: number;
  timeoutMs: number;
  concurrency: number;
  now?: () => number;
}

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A waiter is handed the slot directly (`active` is not decremented), so a call arriving in the gap before
    // the waiter resumes cannot see a free slot and exceed the limit.
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active += 1;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/**
 * Everything between the agent and Qloo that protects the Qloo quota: response cache keyed by normalised
 * inputs, a global daily budget of real calls, bounded concurrency, and a per-call timeout.
 */
export class QlooService {
  private readonly semaphore: Semaphore;
  private toolList: ToolDef[] | undefined;
  private budgetDay = "";
  private budgetUsed = 0;
  private readonly now: () => number;

  constructor(private readonly opts: QlooServiceOptions) {
    this.semaphore = new Semaphore(Math.max(1, opts.concurrency));
    this.now = opts.now ?? Date.now;
  }

  get client(): QlooToolClient {
    return this.opts.client;
  }

  async tools(): Promise<ToolDef[]> {
    if (!this.toolList) {
      const all = await this.opts.client.listTools();
      this.toolList = all.filter((t) => t.name !== "qloo_capabilities");
    }
    return this.toolList;
  }

  private takeBudget(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.budgetDay) {
      this.budgetDay = day;
      this.budgetUsed = 0;
    }
    if (this.budgetUsed >= this.opts.dailyCallBudget) return false;
    this.budgetUsed += 1;
    return true;
  }

  budgetRemaining(): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return day === this.budgetDay ? Math.max(0, this.opts.dailyCallBudget - this.budgetUsed) : this.opts.dailyCallBudget;
  }

  async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<QlooCallResult> {
    const tools = await this.tools();
    const tool = tools.find((t) => t.name === name);
    const key = cacheKey(tool, name, args);
    const hit = this.opts.cache.get(key);
    if (hit) return { envelope: hit, cached: true, durationMs: 0 };

    if (!this.takeBudget()) {
      return {
        envelope: syntheticError(
          name.replace(/^qloo_/, ""),
          "DEMO_BUDGET_EXHAUSTED",
          "This demo has used its daily allowance of Qloo calls.",
          false,
          "Try again after 00:00 UTC, or run Shelfwise yourself with your own Qloo key.",
        ),
        cached: false,
        durationMs: 0,
      };
    }

    const started = this.now();
    const envelope = await this.semaphore.run(() =>
      this.opts.client.call(name, args, { ...(signal ? { signal } : {}), timeoutMs: this.opts.timeoutMs }),
    );
    const durationMs = this.now() - started;
    if (envelope.status === "ok" || envelope.status === "empty") this.opts.cache.set(key, envelope);
    return { envelope, cached: false, durationMs };
  }
}
