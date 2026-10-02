import type { IncomingMessage } from "node:http";

/** Sliding-window limiter keyed by an arbitrary string (here: client IP + bucket). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and reports whether it is allowed. */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? t;
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true };
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
  }
}

/**
 * Client IP for rate limiting. Forwarding headers are forgeable, so they are used ONLY when TRUST_PROXY is set
 * (the app sits behind a proxy/tunnel you control): CF-Connecting-IP first, otherwise the Nth-from-right
 * X-Forwarded-For entry (N = trusted hops).
 */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  if (trustProxy > 0) {
    const cf = req.headers["cf-connecting-ip"];
    const cfv = Array.isArray(cf) ? cf[0] : cf;
    if (cfv && cfv.trim()) return cfv.trim();
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    if (raw) {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const ip = parts[Math.max(0, parts.length - trustProxy)];
      if (ip) return ip;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}
