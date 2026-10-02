import type { AgentEvent } from "@shared/types";

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental parser for the Server-Sent Events wire format (fetch + ReadableStream cannot use EventSource,
 * which has no POST). Handles messages split across chunks, CRLF / CR / LF line endings, multi-line `data:`
 * fields and `:` comment lines (heartbeats). An event that is cut off at end-of-stream is discarded, as the
 * SSE specification requires.
 */
export class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    return this.scan(false);
  }

  /** Call when the stream has ended: a trailing "\r" is then a complete line ending, not half of "\r\n". */
  finish(): SseMessage[] {
    return this.scan(true);
  }

  private scan(atEnd: boolean): SseMessage[] {
    const messages: SseMessage[] = [];
    let lineStart = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      // A "\r" at the very end may be the first half of "\r\n"; wait for the next chunk to find out.
      if (ch === "\r" && i === this.buffer.length - 1 && !atEnd) break;
      const line = this.buffer.slice(lineStart, i);
      if (ch === "\r" && this.buffer[i + 1] === "\n") i++;
      lineStart = i + 1;
      const message = this.consumeLine(line);
      if (message) messages.push(message);
    }
    this.buffer = this.buffer.slice(lineStart);
    return messages;
  }

  private consumeLine(line: string): SseMessage | null {
    if (line === "") {
      if (this.dataLines.length === 0) {
        this.eventName = "";
        return null;
      }
      const message = { event: this.eventName || "message", data: this.dataLines.join("\n") };
      this.eventName = "";
      this.dataLines = [];
      return message;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    return null;
  }
}

const EVENT_TYPES: ReadonlySet<string> = new Set<AgentEvent["type"]>([
  "session",
  "queued",
  "started",
  "plan",
  "note",
  "tool_call",
  "tool_result",
  "retry",
  "needs_input",
  "report",
  "message",
  "error",
  "done",
]);

/**
 * Turns one SSE message into an AgentEvent. The server's contract is trusted for the shape of each event;
 * only unknown event types and unparseable JSON are dropped, so a newer server cannot break an older client.
 */
export function toAgentEvent(message: SseMessage): AgentEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const declared = (parsed as { type?: unknown }).type;
  const type = typeof declared === "string" ? declared : message.event;
  if (!EVENT_TYPES.has(type)) return null;
  return { ...parsed, type } as AgentEvent;
}

/** Reads a response body to the end, calling `onEvent` for every complete AgentEvent. */
export async function readAgentEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const deliver = (messages: SseMessage[]) => {
    for (const message of messages) {
      const event = toAgentEvent(message);
      if (event) onEvent(event);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        deliver(parser.finish());
        return;
      }
      deliver(parser.push(decoder.decode(value, { stream: true })));
    }
  } finally {
    reader.releaseLock();
  }
}
