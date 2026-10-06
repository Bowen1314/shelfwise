import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startThemeFade, THEME_FADE_CLASS, THEME_FADE_MS, type FadeTimers } from "../src/lib/themeFade";

function fakeClassList() {
  const tokens = new Set<string>();
  return { tokens, add: (token: string) => void tokens.add(token), remove: (token: string) => void tokens.delete(token) };
}

function fakeTimers() {
  let next = 1;
  const queue = new Map<number, { callback: () => void; ms: number }>();
  const timers: FadeTimers = {
    setTimeout: (callback, ms) => {
      const id = next++;
      queue.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (handle) => void queue.delete(handle as number),
  };
  const runAll = () => {
    for (const [id, { callback }] of [...queue]) {
      queue.delete(id);
      callback();
    }
  };
  return { timers, queue, runAll };
}

describe("startThemeFade", () => {
  it("sets the class for one fade, then removes it", () => {
    const list = fakeClassList();
    const { timers, queue, runAll } = fakeTimers();
    startThemeFade(list, timers);
    assert.ok(list.tokens.has(THEME_FADE_CLASS));
    assert.equal([...queue.values()][0]?.ms, THEME_FADE_MS);
    runAll();
    assert.ok(!list.tokens.has(THEME_FADE_CLASS));
  });

  it("outlasts the .32s colour transitions", () => {
    assert.ok(THEME_FADE_MS >= 320);
  });

  it("cancel removes the class at once and drops the pending timer", () => {
    const list = fakeClassList();
    const { timers, queue } = fakeTimers();
    const cancel = startThemeFade(list, timers);
    cancel();
    assert.ok(!list.tokens.has(THEME_FADE_CLASS));
    assert.equal(queue.size, 0);
  });

  it("a second toggle restarts the fade instead of being cut short by the first timer", () => {
    const list = fakeClassList();
    const { timers, queue, runAll } = fakeTimers();
    const first = startThemeFade(list, timers);
    first();
    startThemeFade(list, timers);
    assert.ok(list.tokens.has(THEME_FADE_CLASS));
    assert.equal(queue.size, 1);
    runAll();
    assert.ok(!list.tokens.has(THEME_FADE_CLASS));
  });
});
