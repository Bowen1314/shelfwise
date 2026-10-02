import type { JsonObject, ToolDef } from "./types.js";

/** Tool arguments whose array order carries no meaning, so [A, B] and [B, A] share one cache entry. */
const SET_LIKE = new Set([
  "signals",
  "signal_tags",
  "include_tags",
  "exclude_tags",
  "options",
  "entities",
  "group_a",
  "group_b",
]);

function normalizeString(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Stable cache key: tool name + arguments with strings trimmed/lowercased, set-like arrays sorted,
 * defaulted values removed (so `limit: 10` equals omitting it), and keys sorted.
 */
export function cacheKey(tool: ToolDef | undefined, name: string, args: JsonObject): string {
  const props = (tool?.inputSchema["properties"] ?? {}) as Record<string, { default?: unknown }>;
  const norm: JsonObject = {};
  for (const key of Object.keys(args).sort()) {
    let value = args[key];
    if (value === undefined || value === null) continue;
    if (props[key] && "default" in props[key] && JSON.stringify(props[key].default) === JSON.stringify(value)) continue;
    if (typeof value === "string") value = normalizeString(value);
    else if (Array.isArray(value)) {
      const items = value.map((v) => (typeof v === "string" ? normalizeString(v) : v));
      value = SET_LIKE.has(key) ? [...items].sort() : items;
    }
    norm[key] = value;
  }
  return `${name}:${JSON.stringify(norm)}`;
}

interface Entry<T> {
  value: T;
  expires: number;
}

/** Small LRU + TTL cache (Map preserves insertion order). */
export class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
