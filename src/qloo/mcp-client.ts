import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallOptions, JsonObject, QlooEnvelope, QlooToolClient, ToolDef } from "./types.js";
import { syntheticError } from "./types.js";

export interface McpCommand {
  command: string;
  args: string[];
}

/**
 * Credential-looking variables never reach the Qloo child process, except Qloo's own. The child needs QLOO_API_KEY and
 * nothing else secret: model keys (Shelfwise's own or another tool's), cloud credentials and tokens in the same shell
 * have no business there.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
function forwardable(name: string): boolean {
  return name.startsWith("QLOO_") || !SECRET_NAME.test(name);
}

/**
 * Locate `qloo mcp`. Uses the harness installed as a project dependency and runs it with the SAME Node
 * that runs this server (so the engines requirement is checked once, and no PATH lookup is involved).
 * `QLOO_BIN` overrides with an explicit executable.
 */
export function resolveQlooCommand(env: NodeJS.ProcessEnv = process.env): McpCommand {
  if (env["QLOO_BIN"]) return { command: env["QLOO_BIN"], args: ["mcp"] };
  // The package only exports an ESM entry, so resolve it the ESM way (.../dist/index.js).
  const entry = fileURLToPath(import.meta.resolve("@qloo/qloo-harness"));
  return { command: process.execPath, args: [path.join(path.dirname(entry), "bin.js"), "mcp"] };
}

function childEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && forwardable(k)) out[k] = v;
  }
  return { ...out, ...extra };
}

/** Shapes the MCP result into a Qloo envelope. */
function toEnvelope(operation: string, result: unknown): QlooEnvelope {
  const r = result as { structuredContent?: unknown; content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
  const structured = r?.structuredContent;
  if (structured && typeof structured === "object" && typeof (structured as JsonObject)["status"] === "string") {
    return structured as QlooEnvelope;
  }
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as JsonObject)["status"] === "string") return parsed as QlooEnvelope;
    } catch {
      /* fall through */
    }
  }
  return syntheticError(
    operation,
    "QLOO_BAD_RESPONSE",
    "The Qloo MCP server returned a result Shelfwise could not read.",
    false,
    "Check the server logs; this is not something retrying will fix.",
  );
}

/**
 * One long-lived `qloo mcp` child process shared by all requests. It is started lazily, and restarted
 * on the next call if it dies. Never one process per request.
 */
export class McpQlooClient implements QlooToolClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private toolsCache: ToolDef[] | undefined;
  private restartCount = 0;
  private everConnected = false;
  private stderrTail = "";

  constructor(
    private readonly command: McpCommand,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  isUp(): boolean {
    return this.client !== undefined;
  }

  restarts(): number {
    return this.restartCount;
  }

  /** Last few KB of the child's stderr, for operator diagnostics. Never contains the key (the harness redacts it). */
  diagnostics(): string {
    return this.stderrTail;
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.command.command,
        args: this.command.args,
        env: childEnv(this.env, this.extraEnv),
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
      });
      const client = new Client({ name: "shelfwise", version: "0.1.0" });
      transport.onclose = () => {
        if (this.client === client) this.client = undefined;
      };
      await client.connect(transport);
      if (this.everConnected) this.restartCount += 1;
      this.everConnected = true;
      this.client = client;
      return client;
    })();
    const done = this.connecting;
    done.then(
      () => {
        if (this.connecting === done) this.connecting = undefined;
      },
      () => {
        if (this.connecting === done) this.connecting = undefined;
      },
    );
    return done;
  }

  async listTools(): Promise<ToolDef[]> {
    if (this.toolsCache) return this.toolsCache;
    const client = await this.connect();
    const { tools } = await client.listTools();
    this.toolsCache = tools.map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description ?? "",
      inputSchema: t.inputSchema as JsonObject,
    }));
    return this.toolsCache;
  }

  async readiness(): Promise<{ ready: boolean; detail?: string }> {
    try {
      const client = await this.connect();
      const res = await client.callTool({ name: "qloo_capabilities", arguments: {} });
      const adapter = (res.structuredContent as { adapter?: { ready?: boolean } } | undefined)?.adapter;
      return adapter?.ready ? { ready: true } : { ready: false, detail: "qloo mcp is running but has no usable Qloo credential (set QLOO_API_KEY)." };
    } catch (error) {
      return { ready: false, detail: `Could not start qloo mcp: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async call(name: string, args: JsonObject, opts: CallOptions = {}): Promise<QlooEnvelope> {
    const operation = name.replace(/^qloo_/, "");
    let client: Client;
    try {
      client = await this.connect();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return syntheticError(
        operation,
        "QLOO_MCP_START_FAILED",
        `Could not start the local Qloo MCP server (${detail}).`,
        false,
        "Check that @qloo/qloo-harness is installed and Node >= 22.19 is running the server.",
      );
    }
    try {
      const res = await client.callTool(
        { name, arguments: args },
        undefined,
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.timeoutMs ? { timeout: opts.timeoutMs, maxTotalTimeout: opts.timeoutMs } : {}),
        },
      );
      return toEnvelope(operation, res);
    } catch (error) {
      if (opts.signal?.aborted) {
        return syntheticError(operation, "ABORTED", "The request was cancelled.", false, "Run it again.");
      }
      const code = (error as { code?: number }).code;
      if (code === -32001) {
        return syntheticError(
          operation,
          "QLOO_TIMEOUT",
          "Qloo did not answer in time.",
          true,
          "Retry; if it keeps happening Qloo may be slow or rate limiting.",
        );
      }
      if (code === -32000 || this.client === undefined) {
        this.client = undefined;
        return syntheticError(
          operation,
          "QLOO_MCP_DISCONNECTED",
          "The local Qloo MCP server stopped; it will be restarted.",
          true,
          "Retry the call.",
        );
      }
      return syntheticError(
        operation,
        "QLOO_MCP_ERROR",
        `The Qloo MCP call failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
        "Check the arguments against the tool schema.",
      );
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.toolsCache = undefined;
    await client?.close().catch(() => undefined);
  }
}
