import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { type AgentLimits, runAgent } from "../agent/loop.js";
import { type Session, SessionStore, newSession } from "../agent/session.js";
import type { QlooService } from "../qloo/service.js";
import { SAMPLE_INPUTS } from "../qloo/fixtures/data.js";
import type { AgentEvent, ApiError, FormInput, HealthResponse, Healthz } from "../shared/types.js";
import { LIMITS_LINE } from "../shared/types.js";
import { type Config, readinessProblems } from "./config.js";
import { type PlannerLlm, describeLlm } from "./planner.js";
import { RunQueue } from "./queue.js";
import { RateLimiter, clientIp } from "./ratelimit.js";
import { parseRunRequest } from "./request.js";

export interface AppOptions {
  config: Config;
  qloo: QlooService;
  llm: PlannerLlm;
  /** True when Qloo data is placeholder fixtures (sample-data mode). */
  sample: boolean;
  /** Directory holding the built frontend (index.html + assets). Missing directory is fine (API-only). */
  webRoot?: string;
  /** Test hooks. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  heartbeatMs?: number;
}

export interface App {
  server: Server;
  sessions: SessionStore;
  queue: RunQueue;
  close(): Promise<void>;
}

const MAX_BODY = 32 * 1024;
const HOUR = 3_600_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, retryAfterSec?: number): void {
  const body: ApiError = { error: { code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) } };
  sendJson(res, status, body, retryAfterSec !== undefined ? { "Retry-After": String(retryAfterSec) } : {});
}

function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }> {
  return new Promise((resolveBody) => {
    const type = req.headers["content-type"] ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      resolveBody({ ok: false, status: 415, code: "unsupported_media_type", message: "Send the request as application/json." });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: Parameters<typeof resolveBody>[0]): void => {
      if (done) return;
      done = true;
      resolveBody(r);
    };
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        finish({ ok: false, status: 413, code: "too_large", message: "That request is too large." });
        // Stop reading, but do not destroy the socket: the 413 still has to be written. The caller answers with
        // `Connection: close`, so the rest of the oversized upload is discarded when the response ends.
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
      } catch {
        finish({ ok: false, status: 400, code: "bad_json", message: "The request body is not valid JSON." });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400, code: "bad_request", message: "The request could not be read." }));
  });
}

export function createApp(opts: AppOptions): App {
  const { config, qloo, llm, sample } = opts;
  const now = opts.now ?? Date.now;
  const mode = sample ? "fixtures" : "live";
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const webRoot = opts.webRoot ? resolve(opts.webRoot) : undefined;

  const sessions = new SessionStore(2 * HOUR, 200, now);
  const queue = new RunQueue(config.limits.maxConcurrentRuns, config.limits.maxQueue);
  const runLimiter = new RateLimiter(config.limits.runsPerHour, HOUR, now);
  const messageLimiter = new RateLimiter(config.limits.messagesPerHour, HOUR, now);
  const activeRuns = new Set<AbortController>();

  const limits: AgentLimits = {
    maxSteps: config.agent.maxSteps,
    maxToolCalls: config.agent.maxToolCalls,
    maxRetries: config.agent.maxRetries,
    retryBaseMs: config.agent.retryBaseMs,
    maxSessionToolCalls: config.agent.maxSessionToolCalls,
    maxReportRepairs: config.agent.maxReportRepairs,
  };

  const health = (): HealthResponse => {
    const problems = readinessProblems(config);
    return {
      ok: true,
      mode,
      ready: problems.length === 0,
      problems,
      llm: describeLlm(llm, config),
      qloo: { sample, mcpUp: qloo.client.isUp() },
      limitsLine: LIMITS_LINE,
      limits: {
        maxSteps: config.agent.maxSteps,
        maxToolCalls: config.agent.maxToolCalls,
        runsPerHour: config.limits.runsPerHour,
        messagesPerHour: config.limits.messagesPerHour,
        maxConcurrentRuns: config.limits.maxConcurrentRuns,
      },
      sampleInputs: sample ? (SAMPLE_INPUTS as unknown as FormInput[]) : [],
    };
  };

  /**
   * The `qloo mcp` child starts lazily and restarts on demand, so "down" alone is not unhealthy: if it is down, try to
   * bring it up (no Qloo network call; this only starts the process) and report what happened. A child that cannot be
   * started is the failure an orchestrator should see.
   */
  const healthz = async (): Promise<Healthz> => {
    let up = qloo.client.isUp();
    if (up === false) {
      await Promise.race([qloo.client.readiness(), new Promise((r) => setTimeout(r, 5000).unref())]).catch(() => undefined);
      up = qloo.client.isUp();
    }
    return {
      ok: up !== false,
      mode: sample ? "sample-data" : "live",
      mcp: up === null ? null : { up, restarts: qloo.client.restarts() },
    };
  };

  async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const problems = readinessProblems(config);
    if (problems.length > 0) {
      sendError(res, 503, "not_configured", problems.join(" "));
      req.resume();
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      if (body.status === 413) res.setHeader("Connection", "close");
      return sendError(res, body.status, body.code, body.message);
    }
    const parsed = parseRunRequest(body.value);
    if (!parsed.ok) return sendError(res, 400, "invalid_request", parsed.message);
    const request = parsed.value;

    const ip = clientIp(req, config.trustProxy);
    const limiter = request.input.kind === "form" ? runLimiter : messageLimiter;

    // ---- session
    let session: Session | undefined;
    if (request.input.kind === "form") {
      session = undefined;
    } else {
      session = sessions.get(request.sessionId!);
      if (!session) return sendError(res, 404, "session_not_found", "That session has expired. Start again from the form.");
      if (session.busy) return sendError(res, 409, "session_busy", "That session is still working on your last request.");
      if (request.input.kind === "message" && session.followUps >= config.limits.maxSessionFollowUps) {
        return sendError(res, 429, "session_limit", `A session is limited to ${config.limits.maxSessionFollowUps} follow-ups. Start a new one from the form.`);
      }
      if (request.input.kind === "resolution") {
        if (session.pending.size === 0) return sendError(res, 409, "nothing_pending", "There is no open question in this session.");
        for (const choice of request.input.choices) {
          const issue = session.pending.get(choice.issueId);
          if (!issue) return sendError(res, 400, "invalid_request", "That question is no longer open.");
          if (choice.pick && !issue.candidates.some((c) => c.id === choice.pick?.id)) {
            return sendError(res, 400, "invalid_request", "That choice was not one of the options offered.");
          }
        }
      }
    }

    // A queue that is full is a plain 503, before any rate-limit hit is spent.
    if (queue.isFull()) return sendError(res, 503, "busy", "Shelfwise is busy right now. Please try again in a minute.", 30);

    const taken = limiter.take(ip);
    if (!taken.ok) {
      return sendError(
        res,
        429,
        "rate_limited",
        request.input.kind === "form" ? "This demo allows a limited number of new runs per hour per visitor. Please try again later." : "You have reached the hourly message limit. Please try again later.",
        taken.retryAfterSec,
      );
    }

    if (request.input.kind === "form") {
      session = newSession(request.input.form, mode, now());
      sessions.add(session);
    }
    const live = session!;
    live.busy = true;
    live.lastUsed = now();

    // ---- SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const runId = randomBytes(6).toString("hex");
    const ac = new AbortController();
    activeRuns.add(ac);
    let closed = false;
    res.on("close", () => {
      closed = true;
      if (!res.writableEnded) ac.abort();
    });
    const send = (e: AgentEvent): void => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": keep-alive\n\n");
    }, heartbeatMs);

    send({ type: "session", sessionId: live.id, runId, mode });

    let release: (() => void) | undefined;
    try {
      let lastPosition = 0;
      const slot = await queue.acquire(
        ac.signal,
        (position, ahead) => {
          if (position !== lastPosition) {
            lastPosition = position;
            send({ type: "queued", position, ahead });
          }
        },
        config.limits.queueWaitTimeoutSec * 1000,
      );
      if (!slot.ok) {
        if (slot.reason === "timeout") {
          send({ type: "error", code: "queue_timeout", message: "Waited too long for a free slot. Please try again.", retryable: true });
          send({ type: "done", reason: "error", steps: 0, toolCalls: 0 });
        } else if (slot.reason === "full") {
          send({ type: "error", code: "busy", message: "Shelfwise is busy right now. Please try again in a minute.", retryable: true });
          send({ type: "done", reason: "error", steps: 0, toolCalls: 0 });
        }
        return;
      }
      release = slot.release;
      send({ type: "started" });
      await runAgent(
        {
          llm,
          qloo,
          limits,
          sample,
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
          now: () => new Date(now()),
        },
        live,
        request.input.kind === "form" ? { kind: "form" } : request.input.kind === "message" ? { kind: "message", text: request.input.text } : { kind: "resolution", choices: request.input.choices },
        send,
        ac.signal,
      );
    } catch (error) {
      // runAgent reports its own failures; this is the last-resort net so a stream never just stops.
      console.error("[shelfwise] run failed:", error instanceof Error ? error.message : String(error));
      send({ type: "error", code: "internal", message: "Something went wrong on the server. Please try again.", retryable: true });
      send({ type: "done", reason: "error", steps: 0, toolCalls: 0 });
    } finally {
      clearInterval(heartbeat);
      release?.();
      live.busy = false;
      live.lastUsed = now();
      activeRuns.delete(ac);
      if (!res.writableEnded) res.end();
    }
  }

  async function serveStatic(pathname: string, res: ServerResponse, method: string): Promise<boolean> {
    if (!webRoot) return false;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.includes("\0")) return false;
    const target = normalize(join(webRoot, rel));
    if (target !== webRoot && !target.startsWith(webRoot + sep)) return false;

    const tryFile = async (file: string): Promise<boolean> => {
      let info;
      try {
        info = await stat(file);
      } catch {
        return false;
      }
      if (!info.isFile()) return false;
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      // Vite emits content-hashed files under assets/; judge by the path inside the web root, not the absolute path.
      const hashed = file.slice(webRoot.length + 1).startsWith(`assets${sep}`);
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(info.size),
        "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      });
      if (method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return true;
    };

    if (await tryFile(rel.endsWith("/") ? join(target, "index.html") : target)) return true;
    // SPA fallback for navigations only, not for missing assets.
    if (extname(rel) === "") return tryFile(join(webRoot, "index.html"));
    return false;
  }

  const server = createServer((req, res) => {
    securityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    const route = async (): Promise<void> => {
      if (url.pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
        const h = await healthz();
        return sendJson(res, h.ok ? 200 : 503, h);
      }
      if (url.pathname === "/api/health" && method === "GET") return sendJson(res, 200, health());
      if (url.pathname === "/api/runs") {
        if (method !== "POST") return sendError(res, 405, "method_not_allowed", "Use POST.");
        return handleRun(req, res);
      }
      if (url.pathname.startsWith("/api/")) return sendError(res, 404, "not_found", "No such endpoint.");
      if (method !== "GET" && method !== "HEAD") return sendError(res, 405, "method_not_allowed", "Method not allowed.");
      if (await serveStatic(url.pathname, res, method)) return;
      if (extname(url.pathname) === "" && !webRoot) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return void res.end("Shelfwise API is running. The web app has not been built (run `npm run build:web`).");
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    };

    route().catch((error: unknown) => {
      console.error("[shelfwise] request failed:", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) sendError(res, 500, "internal", "Something went wrong on the server.");
      else if (!res.writableEnded) res.end();
    });
  });
  // SSE responses are long-lived; do not let the default request timeout cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  return {
    server,
    sessions,
    queue,
    async close() {
      for (const ac of activeRuns) ac.abort();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}
