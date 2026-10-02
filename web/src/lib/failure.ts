/** Everything that can go wrong with a run, in the words the interface shows. */
export interface RunFailure {
  kind: "agent" | "http" | "network" | "dropped";
  code: string;
  message: string;
  /** Whether "Try again" can reasonably succeed. */
  retryable: boolean;
}

export function minutesPhrase(seconds: number): string {
  if (seconds <= 60) return "a minute";
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

export function httpFailure(status: number, code: string, serverMessage: string, retryAfterSec?: number): RunFailure {
  const base = { kind: "http" as const, code };
  switch (status) {
    case 429:
      return {
        ...base,
        retryable: true,
        message:
          retryAfterSec !== undefined
            ? `You’ve reached the demo’s limit for now — try again in ${minutesPhrase(retryAfterSec)}. Your entries are kept.`
            : "You’ve reached the demo’s limit for now — try again in a little while. Your entries are kept.",
      };
    case 503:
      return {
        ...base,
        retryable: true,
        message: "Shelfwise is busy or not ready right now. Your entries are kept — try again in a moment.",
      };
    case 409:
      return {
        ...base,
        retryable: true,
        message: "This session is still working on something. Wait for it to finish, then try again.",
      };
    case 404:
      return {
        ...base,
        retryable: false,
        message: "That session has expired, so it can’t take follow-ups any more. Start a new search — your entries are kept.",
      };
    case 400:
      return {
        ...base,
        retryable: false,
        message: serverMessage ? `Shelfwise couldn’t use that request: ${serverMessage}` : "Shelfwise couldn’t use that request. Check your entries and try again.",
      };
    default:
      return {
        ...base,
        retryable: true,
        message: `The server returned an unexpected error (${status}). Please try again.`,
      };
  }
}

export const NETWORK_FAILURE: RunFailure = {
  kind: "network",
  code: "network",
  retryable: true,
  message: "Couldn’t reach the Shelfwise server. Check your connection, then try again.",
};

export const DROPPED_FAILURE: RunFailure = {
  kind: "dropped",
  code: "stream_dropped",
  retryable: true,
  message: "The connection was lost before the agent finished. Try again to rerun it.",
};
