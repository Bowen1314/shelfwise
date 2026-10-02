/** Minimal OpenAI-compatible chat-completions client (Nebius Token Factory serves this API shape). */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  /** True for the rule-based demo planner used with sample data when no LLM key is configured. */
  readonly scripted: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

/** Reasoning models may emit <think>...</think> inline; it is not part of the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

export class OpenAiCompatLlm implements LlmClient {
  readonly provider = "openai-compatible";
  readonly scripted = false;
  private readonly endpoint: string;

  constructor(private readonly opts: OpenAiCompatOptions) {
    const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
    this.endpoint = new URL("chat/completions", base).toString();
  }

  get model(): string {
    return this.opts.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: req.messages,
      temperature: 0.2,
      max_tokens: this.opts.maxTokens,
      stream: false,
      ...(this.opts.extraBody ?? {}),
    };
    if (req.tools.length) {
      body["tools"] = req.tools;
      if (req.toolChoice) body["tool_choice"] = req.toolChoice;
    }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const doFetch = this.opts.fetchImpl ?? fetch;

    let res: Response;
    try {
      res = await doFetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (req.signal?.aborted) throw new LlmError("The request was cancelled.", false);
      if (timeout.aborted) throw new LlmError(`The language model did not answer within ${Math.round(this.opts.timeoutMs / 1000)}s.`, true);
      throw new LlmError(`Could not reach the language model endpoint (${error instanceof Error ? error.message : "network error"}).`, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        detail = (typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? detail).toString().slice(0, 300);
      } catch {
        /* keep raw text */
      }
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      const ra = Number(res.headers.get("retry-after"));
      throw new LlmError(`Language model returned HTTP ${res.status}: ${detail}`, retryable, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new LlmError("The language model returned a response that was not JSON.", true);
    }
    const message = (json as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] }).choices?.[0]?.message;
    if (!message) throw new LlmError("The language model returned no message.", true);

    const toolCalls: ToolCall[] = [];
    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
    rawCalls.forEach((c, i) => {
      const call = c as { id?: string; function?: { name?: string; arguments?: unknown } };
      const name = call.function?.name;
      if (!name) return;
      const args = call.function?.arguments;
      toolCalls.push({
        id: call.id && call.id.length > 0 ? call.id : `call_${Date.now().toString(36)}_${i}`,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
      });
    });
    return { content: stripThinking(contentToString(message.content)), toolCalls };
  }
}
