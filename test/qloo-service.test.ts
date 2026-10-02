import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TtlCache } from "../src/qloo/cache.js";
import { McpQlooClient } from "../src/qloo/mcp-client.js";
import { QlooService } from "../src/qloo/service.js";
import type { CallOptions, JsonObject, QlooEnvelope, QlooToolClient, ToolDef } from "../src/qloo/types.js";
import { type FakeMcp, type FakeMcpOptions, startFakeMcp } from "./helpers/fakes.js";

async function withFake<T>(opts: FakeMcpOptions, fn: (f: FakeMcp) => Promise<T>): Promise<T> {
  const fake = startFakeMcp(opts);
  try {
    return await fn(fake);
  } finally {
    await fake.dispose();
  }
}

const rec = (signals: string[], extra: JsonObject = {}): JsonObject => ({ target_type: "book", signals, ...extra });
const errorOf = (e: QlooEnvelope): { code: string; retryable: boolean } => {
  assert.ok(e.error, `expected an error envelope, got status ${e.status}`);
  return e.error;
};

// ------------------------------------------------------------------------------------------------

describe("QlooService response cache", () => {
  it("serves inputs that differ only in case, order and whitespace from one real call", async () => {
    await withFake({}, async (f) => {
      const first = await f.service.call("qloo_recommend", { target_type: "book", signals: ["Severance", "The Bear"], signal_location: "Newark, NJ" });
      const second = await f.service.call("qloo_recommend", { signal_location: "newark,   NJ ", signals: ["  the   BEAR ", "severance"], target_type: "BOOK", limit: 10 });
      assert.equal(first.envelope.status, "ok");
      assert.equal(first.cached, false);
      assert.equal(second.cached, true);
      assert.equal(second.durationMs, 0);
      assert.deepEqual(second.envelope, first.envelope);
      const calls = f.realCalls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.tool, "qloo_recommend");
    });
  });

  it("does not share entries between genuinely different inputs", async () => {
    await withFake({}, async (f) => {
      await f.service.call("qloo_recommend", rec(["Severance"]));
      const other = await f.service.call("qloo_recommend", rec(["The Bear"]));
      const limited = await f.service.call("qloo_recommend", rec(["Severance"], { limit: 2 }));
      assert.equal(other.cached, false);
      assert.equal(limited.cached, false);
      assert.equal(f.realCalls().length, 3);
    });
  });

  it("does not cache an error envelope: the retry reaches the server and can succeed", async () => {
    await withFake({}, async (f) => {
      const first = await f.service.call("qloo_recommend", rec(["Flaky"]));
      assert.equal(first.envelope.status, "error");
      assert.equal(errorOf(first.envelope).code, "QLOO_UPSTREAM_TIMEOUT");
      assert.equal(errorOf(first.envelope).retryable, true);
      assert.equal(first.cached, false);

      const second = await f.service.call("qloo_recommend", rec(["Flaky"]));
      assert.equal(second.envelope.status, "ok");
      assert.equal(second.cached, false);
      assert.equal(f.realCalls().length, 2);

      const third = await f.service.call("qloo_recommend", rec(["flaky"]));
      assert.equal(third.envelope.status, "ok");
      assert.equal(third.cached, true, "the success is cached");
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("does not cache a non-retryable error either", async () => {
    await withFake({}, async (f) => {
      const a = await f.service.call("qloo_recommend", rec(["Brokenly"]));
      const b = await f.service.call("qloo_recommend", rec(["Brokenly"]));
      for (const r of [a, b]) {
        assert.equal(r.envelope.status, "error");
        assert.equal(errorOf(r.envelope).retryable, false);
        assert.equal(r.cached, false);
      }
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("does not cache needs_input: the user's answer changes the call anyway", async () => {
    await withFake({}, async (f) => {
      const a = await f.service.call("qloo_recommend", rec(["Ambiguo"]));
      const b = await f.service.call("qloo_recommend", rec(["Ambiguo"]));
      assert.equal(a.envelope.status, "needs_input");
      assert.equal(b.envelope.status, "needs_input");
      assert.equal(a.cached, false);
      assert.equal(b.cached, false);
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("does not cache partial or degraded results (only ok and empty are cached)", async () => {
    await withFake({}, async (f) => {
      const p1 = await f.service.call("qloo_recommend", rec(["Partialo"]));
      const p2 = await f.service.call("qloo_recommend", rec(["Partialo"]));
      const d1 = await f.service.call("qloo_recommend", rec(["Degradedo"]));
      const d2 = await f.service.call("qloo_recommend", rec(["Degradedo"]));
      assert.equal(p1.envelope.status, "partial");
      assert.equal(d1.envelope.status, "degraded");
      for (const r of [p1, p2, d1, d2]) assert.equal(r.cached, false);
      assert.equal(f.realCalls().length, 4);
    });
  });

  it("DOES cache an empty result", async () => {
    await withFake({}, async (f) => {
      const a = await f.service.call("qloo_recommend", rec(["Nothingness"]));
      const b = await f.service.call("qloo_recommend", rec(["nothingness"]));
      assert.equal(a.envelope.status, "empty");
      assert.equal(a.cached, false);
      assert.equal(b.envelope.status, "empty");
      assert.equal(b.cached, true);
      assert.equal(f.realCalls().length, 1);
    });
  });
});

// ------------------------------------------------------------------------------------------------

describe("QlooService daily call budget", () => {
  it("refuses the call after the budget is spent, without reaching the server", async () => {
    await withFake({ dailyCallBudget: 2 }, async (f) => {
      assert.equal(f.service.budgetRemaining(), 2);
      const a = await f.service.call("qloo_recommend", rec(["Severance"]));
      const b = await f.service.call("qloo_recommend", rec(["The Bear"]));
      const c = await f.service.call("qloo_recommend", rec(["Phoebe Bridgers"]));
      assert.equal(a.envelope.status, "ok");
      assert.equal(b.envelope.status, "ok");
      assert.equal(c.envelope.status, "error");
      const err = errorOf(c.envelope);
      assert.equal(err.code, "DEMO_BUDGET_EXHAUSTED");
      assert.equal(err.retryable, false);
      assert.equal(c.cached, false);
      assert.equal(c.durationMs, 0);
      assert.equal(c.envelope.operation, "recommend");
      assert.equal(f.realCalls().length, 2);
      assert.equal(f.service.budgetRemaining(), 0);

      // it stays refused, and is not cached
      const again = await f.service.call("qloo_recommend", rec(["Phoebe Bridgers"]));
      assert.equal(errorOf(again.envelope).code, "DEMO_BUDGET_EXHAUSTED");
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("does not charge the budget for cache hits, and still serves cache hits once the budget is gone", async () => {
    await withFake({ dailyCallBudget: 2 }, async (f) => {
      await f.service.call("qloo_recommend", rec(["Severance"]));
      for (let i = 0; i < 4; i++) {
        const hit = await f.service.call("qloo_recommend", rec(["  SEVERANCE "]));
        assert.equal(hit.cached, true);
      }
      assert.equal(f.service.budgetRemaining(), 1);
      await f.service.call("qloo_recommend", rec(["The Bear"]));
      assert.equal(f.service.budgetRemaining(), 0);
      const hit = await f.service.call("qloo_recommend", rec(["severance"]));
      assert.equal(hit.envelope.status, "ok");
      assert.equal(hit.cached, true);
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("does not charge the budget for calls the agent never makes (tools() is free)", async () => {
    await withFake({ dailyCallBudget: 1 }, async (f) => {
      await f.service.tools();
      assert.equal(f.service.budgetRemaining(), 1);
    });
  });

  it("resets when the injected clock crosses a UTC day boundary", async () => {
    let nowMs = Date.UTC(2026, 9, 2, 23, 59, 30);
    await withFake({ dailyCallBudget: 1, now: () => nowMs }, async (f) => {
      const a = await f.service.call("qloo_recommend", rec(["Severance"]));
      assert.equal(a.envelope.status, "ok");
      assert.equal(f.service.budgetRemaining(), 0);

      const refused = await f.service.call("qloo_recommend", rec(["The Bear"]));
      assert.equal(errorOf(refused.envelope).code, "DEMO_BUDGET_EXHAUSTED");

      nowMs = Date.UTC(2026, 9, 2, 23, 59, 59, 999); // still the same UTC day
      assert.equal(f.service.budgetRemaining(), 0);
      assert.equal(errorOf((await f.service.call("qloo_recommend", rec(["The Bear"]))).envelope).code, "DEMO_BUDGET_EXHAUSTED");

      nowMs = Date.UTC(2026, 9, 3, 0, 0, 0, 0); // midnight UTC
      assert.equal(f.service.budgetRemaining(), 1);
      const fresh = await f.service.call("qloo_recommend", rec(["The Bear"]));
      assert.equal(fresh.envelope.status, "ok");
      assert.equal(fresh.cached, false);
      assert.equal(f.service.budgetRemaining(), 0);
      assert.equal(f.realCalls().length, 2);

      assert.equal(errorOf((await f.service.call("qloo_recommend", rec(["Phoebe Bridgers"]))).envelope).code, "DEMO_BUDGET_EXHAUSTED");
    });
  });
});

// ------------------------------------------------------------------------------------------------

describe("QlooService timeout and cancellation", () => {
  it("turns a slow server into a retryable QLOO_TIMEOUT envelope without waiting for it", async () => {
    const fake = startFakeMcp({ timeoutMs: 300 });
    try {
      const started = Date.now();
      const slow = await fake.service.call("qloo_recommend", rec(["Slowpoke"]));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2_500, `returned after ${elapsed}ms; the fake answers after 3000ms`);
      assert.equal(slow.envelope.status, "error");
      const err = errorOf(slow.envelope);
      assert.equal(err.code, "QLOO_TIMEOUT");
      assert.equal(err.retryable, true);
      assert.equal(slow.cached, false);
      assert.equal(fake.realCalls().length, 1);

      // the connection is not wedged by the abandoned call, and the timeout was not cached
      const ok = await fake.service.call("qloo_describe", { entity: "Severance" });
      assert.equal(ok.envelope.status, "ok");
      assert.equal(fake.client.isUp(), true);
      assert.equal(fake.client.restarts(), 0);
    } finally {
      const t = Date.now();
      await fake.dispose();
      assert.ok(Date.now() - t < 2_500, "dispose() must not wait for the slow in-flight request");
    }
  });

  it("does not cache a timeout", async () => {
    await withFake({ timeoutMs: 250 }, async (f) => {
      const a = await f.service.call("qloo_recommend", rec(["Slowpoke"]));
      const b = await f.service.call("qloo_recommend", rec(["Slowpoke"]));
      assert.equal(errorOf(a.envelope).code, "QLOO_TIMEOUT");
      assert.equal(errorOf(b.envelope).code, "QLOO_TIMEOUT");
      assert.equal(b.cached, false);
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("returns ABORTED (not retryable) when the caller's signal fires mid-call", async () => {
    await withFake({}, async (f) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 100);
      try {
        const started = Date.now();
        const r = await f.service.call("qloo_recommend", rec(["Slowpoke"]), ac.signal);
        assert.ok(Date.now() - started < 2_500);
        assert.equal(r.envelope.status, "error");
        assert.equal(errorOf(r.envelope).code, "ABORTED");
        assert.equal(errorOf(r.envelope).retryable, false);
      } finally {
        clearTimeout(timer);
      }
    });
  });
});

// ------------------------------------------------------------------------------------------------

describe("McpQlooClient", () => {
  it("publishes the tools but the service hides qloo_capabilities from the agent", async () => {
    await withFake({}, async (f) => {
      const all = (await f.client.listTools()).map((t) => t.name);
      assert.ok(all.includes("qloo_capabilities"));
      const exposed = await f.service.tools();
      const names = exposed.map((t) => t.name);
      assert.ok(!names.includes("qloo_capabilities"));
      assert.equal(names.length, all.length - 1);
      for (const expected of ["qloo_recommend", "qloo_rank", "qloo_describe", "qloo_where_popular", "qloo_compare_audiences", "qloo_trends", "qloo_find_tags", "qloo_entity_tags", "qloo_audience_demographics"]) {
        assert.ok(names.includes(expected), expected);
      }
      assert.equal(await f.service.tools(), exposed, "the filtered list is computed once");
    });
  });

  it("is lazy: not up before first use, up after", async () => {
    await withFake({}, async (f) => {
      assert.equal(f.client.isUp(), false);
      assert.equal(f.client.restarts(), 0);
      assert.deepEqual(f.realCalls(), []);
      await f.service.tools();
      assert.equal(f.client.isUp(), true);
      assert.equal(f.client.restarts(), 0);
    });
  });

  it("keeps one long-lived child across many calls (no restarts)", async () => {
    await withFake({}, async (f) => {
      for (const s of ["Severance", "The Bear", "Phoebe Bridgers", "Flaky", "Partialo", "Nothingness"]) {
        await f.service.call("qloo_recommend", rec([s]));
        assert.equal(f.client.isUp(), true);
        assert.equal(f.client.restarts(), 0);
      }
      assert.equal(f.realCalls().length, 6);
      await f.client.close();
      assert.equal(f.client.isUp(), false);
    });
  });

  it("reports readiness from the child's capabilities (key present or not)", async () => {
    await withFake({}, async (f) => {
      const r = await f.client.readiness();
      assert.equal(r.ready, false);
      assert.match(r.detail ?? "", /QLOO_API_KEY/);
    });
    await withFake({ env: { QLOO_API_KEY: "test-qloo" } }, async (f) => {
      assert.deepEqual(await f.client.readiness(), { ready: true });
    });
  });

  it("recovers from a crash: that call fails as QLOO_MCP_DISCONNECTED (retryable), the next call gets a fresh child", async () => {
    await withFake({}, async (f) => {
      await f.service.tools();
      assert.equal(f.client.restarts(), 0);

      const crashed = await f.service.call("qloo_recommend", rec(["Crashy"]));
      assert.equal(crashed.envelope.status, "error");
      const err = errorOf(crashed.envelope);
      assert.equal(err.code, "QLOO_MCP_DISCONNECTED");
      assert.equal(err.retryable, true);
      assert.equal(crashed.cached, false);

      const again = await f.service.call("qloo_recommend", rec(["Crashy"]));
      assert.equal(again.envelope.status, "ok");
      assert.equal(again.cached, false);
      assert.equal(f.client.isUp(), true);
      assert.equal(f.client.restarts(), 1);

      // and it stays up afterwards
      const next = await f.service.call("qloo_recommend", rec(["Severance"]));
      assert.equal(next.envelope.status, "ok");
      assert.equal(f.client.restarts(), 1);
      assert.equal(f.realCalls().length, 3);
    });
  });

  it("never forwards credential-looking variables to the child (any tool's), but does forward the Qloo key and ordinary settings", async () => {
    const env = { QLOO_API_KEY: "test-qloo", LLM_API_KEY: "x", NEBIUS_API_KEY: "y", OPENAI_API_KEY: "z", ANOTHER_TOOL_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", HARMLESS_SETTING: "1" };
    await withFake({ env }, async (f) => {
      const probe = await f.service.call("qloo_describe", { entity: "Envprobe" });
      assert.equal(probe.envelope.status, "ok");
      const summary = probe.envelope.summary ?? "";
      assert.match(summary, /QLOO_API_KEY:present/);
      assert.match(summary, /LLM_API_KEY:absent/);
      assert.match(summary, /NEBIUS_API_KEY:absent/);
      assert.match(summary, /OPENAI_API_KEY:absent/);
      assert.match(summary, /ANOTHER_TOOL_TOKEN:absent/);
      assert.match(summary, /AWS_SECRET_ACCESS_KEY:absent/);
      assert.match(summary, /HARMLESS_SETTING:present/);
    });
  });

  it("without a Qloo key the child sees none (nothing leaks in from elsewhere)", async () => {
    await withFake({ env: { LLM_API_KEY: "x" } }, async (f) => {
      const probe = await f.service.call("qloo_describe", { entity: "Envprobe" });
      assert.equal(probe.envelope.summary, "QLOO_API_KEY:absent LLM_API_KEY:absent NEBIUS_API_KEY:absent OPENAI_API_KEY:absent ANOTHER_TOOL_TOKEN:absent AWS_SECRET_ACCESS_KEY:absent HARMLESS_SETTING:absent");
    });
  });

  it("returns QLOO_MCP_START_FAILED (not retryable) when the executable cannot be started", async () => {
    const client = new McpQlooClient({ command: "/nonexistent/x", args: [] }, {});
    try {
      assert.equal(client.isUp(), false);
      const r = await client.call("qloo_recommend", rec(["Severance"]));
      assert.equal(r.status, "error");
      const err = errorOf(r);
      assert.equal(err.code, "QLOO_MCP_START_FAILED");
      assert.equal(err.retryable, false);
      assert.equal(r.operation, "recommend");
      assert.equal(client.isUp(), false);
      assert.equal(client.restarts(), 0);

      // it keeps answering with the same envelope rather than throwing or hanging
      const again = await client.call("qloo_rank", { options: ["x"], option_type: "book" });
      assert.equal(errorOf(again).code, "QLOO_MCP_START_FAILED");

      const ready = await client.readiness();
      assert.equal(ready.ready, false);
      assert.match(ready.detail ?? "", /Could not start/);
      await assert.rejects(client.listTools());
    } finally {
      await client.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------

/** Delegates to a real client and records how many calls are in flight at once. */
class SpyClient implements QlooToolClient {
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly inner: QlooToolClient) {}
  listTools(): Promise<ToolDef[]> {
    return this.inner.listTools();
  }
  readiness(): Promise<{ ready: boolean; detail?: string }> {
    return this.inner.readiness();
  }
  isUp(): boolean | null {
    return this.inner.isUp();
  }
  restarts(): number {
    return this.inner.restarts();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  async call(name: string, args: JsonObject, opts?: CallOptions): Promise<QlooEnvelope> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.inner.call(name, args, opts);
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe("QlooService concurrency", () => {
  it("with concurrency 1, two simultaneous calls are both served, one after the other", async () => {
    await withFake({ concurrency: 1 }, async (f) => {
      const [a, b] = await Promise.all([f.service.call("qloo_recommend", rec(["Severance"])), f.service.call("qloo_recommend", rec(["The Bear"]))]);
      assert.equal(a.envelope.status, "ok");
      assert.equal(b.envelope.status, "ok");
      assert.equal(f.realCalls().length, 2);
    });
  });

  it("never has more than `concurrency` calls in flight, and does use the allowed parallelism", async () => {
    for (const concurrency of [1, 2]) {
      const fake = startFakeMcp({ concurrency });
      try {
        const spy = new SpyClient(fake.client);
        const service = new QlooService({ client: spy, cache: new TtlCache<QlooEnvelope>(60_000, 100), dailyCallBudget: 1000, timeoutMs: 10_000, concurrency });
        const names = ["Severance", "The Bear", "Phoebe Bridgers", "Flaky", "Partialo", "Nothingness"];
        const results = await Promise.all(names.map((n) => service.call("qloo_recommend", rec([n]))));
        assert.equal(results.length, names.length);
        assert.ok(results.every((r) => r.envelope.status === "ok" || r.envelope.status === "error" || r.envelope.status === "empty" || r.envelope.status === "partial"));
        assert.equal(fake.realCalls().length, names.length);
        assert.equal(spy.maxInFlight, concurrency, `concurrency ${concurrency}`);
      } finally {
        await fake.dispose();
      }
    }
  });

  it(
    "keeps the semaphore at its limit when a new call arrives at the moment a slot is handed to a waiter",
    async () => {
      // A fake client whose calls complete only when the test says so, so the interleaving is exact.
      const done = new Map<string, () => void>();
      let inFlight = 0;
      let max = 0;
      const ok = (name: string): QlooEnvelope => ({ status: "ok", operation: name, results: [] });
      const client: QlooToolClient = {
        listTools: async () => [],
        readiness: async () => ({ ready: true }),
        isUp: () => true,
        restarts: () => 0,
        close: async () => undefined,
        call: (name: string, args: JsonObject) =>
          new Promise<QlooEnvelope>((resolve) => {
            inFlight += 1;
            max = Math.max(max, inFlight);
            done.set(String(args["id"]), () => {
              inFlight -= 1;
              resolve(ok(name));
            });
          }),
      };
      const service = new QlooService({ client, cache: new TtlCache<QlooEnvelope>(60_000, 100), dailyCallBudget: 1000, timeoutMs: 10_000, concurrency: 1 });
      await service.tools();
      const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

      const a = service.call("x", { id: "a" });
      const b = service.call("x", { id: "b" }); // waits for a's slot
      await tick();
      assert.deepEqual([...done.keys()], ["a"]);

      done.get("a")?.(); // a finishes: its slot is handed to b...
      const c = service.call("x", { id: "c" }); // ...while c arrives in the same tick
      await tick();
      const peakAfterHandOff = max;

      // finish whatever is running until all three calls have completed
      let settled = 0;
      for (const p of [a, b, c]) void p.then(() => (settled += 1));
      for (let i = 0; i < 50 && settled < 3; i++) {
        for (const [id, finish] of [...done]) {
          done.delete(id);
          finish();
        }
        await tick();
      }
      await Promise.all([a, b, c]);
      assert.equal(Math.max(peakAfterHandOff, max), 1, `up to ${max} calls ran at once with concurrency 1`);
    },
  );
});
