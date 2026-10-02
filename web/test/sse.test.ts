import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser, toAgentEvent } from "../src/lib/sse";

function drain(parser: SseParser, chunks: string[]) {
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe("SseParser", () => {
  it("parses a single message", () => {
    const messages = drain(new SseParser(), ['event: note\ndata: {"type":"note","text":"hi"}\n\n']);
    assert.deepEqual(messages, [{ event: "note", data: '{"type":"note","text":"hi"}' }]);
  });

  it("handles a message split across chunks at any position", () => {
    const text = 'event: note\ndata: {"type":"note","text":"hello"}\n\nevent: started\ndata: {"type":"started"}\n\n';
    for (let cut = 1; cut < text.length; cut++) {
      const messages = drain(new SseParser(), [text.slice(0, cut), text.slice(cut)]);
      assert.equal(messages.length, 2, `cut at ${cut}`);
      assert.equal(messages[0]?.event, "note");
      assert.equal(messages[1]?.event, "started");
    }
  });

  it("handles one character per chunk", () => {
    const text = "event: a\r\ndata: one\r\n\r\nevent: b\r\ndata: two\r\n\r\n";
    const messages = drain(new SseParser(), [...text]);
    assert.deepEqual(messages, [
      { event: "a", data: "one" },
      { event: "b", data: "two" },
    ]);
  });

  it("accepts CRLF, CR and LF line endings", () => {
    assert.equal(drain(new SseParser(), ["event: a\r\ndata: x\r\n\r\n"]).length, 1);
    assert.equal(drain(new SseParser(), ["event: a\rdata: x\r\revent: b\rdata: y\r\rdata: z"]).length, 2);
    assert.equal(drain(new SseParser(), ["event: a\ndata: x\n\n"]).length, 1);
  });

  it("releases a final event that ends in a bare CR once the stream is finished", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("event: a\rdata: x\r\r"), []);
    assert.deepEqual(parser.finish(), [{ event: "a", data: "x" }]);
  });

  it("holds back a trailing CR until it knows whether LF follows", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("data: x\r\n\r"), []);
    assert.deepEqual(parser.push("\n"), [{ event: "message", data: "x" }]);
  });

  it("joins multi-line data with newlines", () => {
    const [message] = drain(new SseParser(), ["data: line one\ndata: line two\n\n"]);
    assert.equal(message?.data, "line one\nline two");
  });

  it("ignores comment lines and heartbeats", () => {
    const messages = drain(new SseParser(), [": heartbeat\n\n", ": another\r\n", "event: x\ndata: 1\n\n"]);
    assert.deepEqual(messages, [{ event: "x", data: "1" }]);
  });

  it("strips only one leading space after the colon", () => {
    const [message] = drain(new SseParser(), ["data:  two spaces\n\n"]);
    assert.equal(message?.data, " two spaces");
  });

  it("does not dispatch events without data and discards a message cut off at end of stream", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push("event: ping\n\n"), []);
    assert.deepEqual(parser.push('event: note\ndata: {"half":'), []);
  });
});

describe("toAgentEvent", () => {
  it("takes the type from the JSON body", () => {
    const event = toAgentEvent({ event: "message", data: '{"type":"note","text":"hi"}' });
    assert.deepEqual(event, { type: "note", text: "hi" });
  });

  it("falls back to the SSE event name", () => {
    const event = toAgentEvent({ event: "started", data: "{}" });
    assert.deepEqual(event, { type: "started" });
  });

  it("drops unknown types and bad JSON instead of throwing", () => {
    assert.equal(toAgentEvent({ event: "future_thing", data: "{}" }), null);
    assert.equal(toAgentEvent({ event: "note", data: "not json" }), null);
    assert.equal(toAgentEvent({ event: "note", data: "[1,2]" }), null);
  });
});
