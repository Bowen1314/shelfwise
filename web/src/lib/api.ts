import type { ApiError, HealthResponse, RunRequest } from "@shared/types";
import { httpFailure, NETWORK_FAILURE, type RunFailure } from "./failure";

/** A non-SSE failure from POST /api/runs (400, 404, 409, 429, 503, ...). */
export class RunRequestError extends Error {
  readonly failure: RunFailure;

  constructor(failure: RunFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

type Fetch = typeof fetch;

/** `?mock=1` swaps in a scripted event player. The branch is a build-time constant, so production drops it. */
async function resolveFetch(): Promise<Fetch> {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
    const { mockFetch } = await import("../dev/mock");
    return mockFetch;
  }
  return fetch;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const doFetch = await resolveFetch();
  const response = await doFetch("/api/health", { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`health check failed (${response.status})`);
  return (await response.json()) as HealthResponse;
}

async function readApiError(response: Response): Promise<RunFailure> {
  let code = "http_error";
  let message = "";
  let retryAfterSec: number | undefined;
  try {
    const body = (await response.json()) as Partial<ApiError>;
    code = body.error?.code ?? code;
    message = body.error?.message ?? "";
    retryAfterSec = body.error?.retryAfterSec;
  } catch {
    // The body was not JSON (for example an HTML error page from a proxy); the status alone is enough.
  }
  if (retryAfterSec === undefined) {
    const header = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(header) && header > 0) retryAfterSec = header;
  }
  return httpFailure(response.status, code, message, retryAfterSec);
}

/**
 * Starts a run and returns the SSE body. Throws RunRequestError for HTTP-level failures and a plain
 * RunRequestError(NETWORK_FAILURE) when the server cannot be reached; aborts propagate as AbortError.
 */
export async function openRun(request: RunRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const doFetch = await resolveFetch();
  let response: Response;
  try {
    response = await doFetch("/api/runs", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RunRequestError(NETWORK_FAILURE);
  }
  if (!response.ok) throw new RunRequestError(await readApiError(response));
  const isEventStream = response.headers.get("Content-Type")?.includes("text/event-stream") ?? false;
  if (!response.body || !isEventStream) throw new RunRequestError(httpFailure(502, "bad_response", ""));
  return response.body;
}
