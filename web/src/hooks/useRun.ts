import { useCallback, useReducer, useRef } from "react";
import type { FormInput, ResolutionChoice, RunRequest } from "@shared/types";
import { openRun, RunRequestError } from "../lib/api";
import { DROPPED_FAILURE } from "../lib/failure";
import { initialRunState, runReducer, type RunState } from "../lib/reduce";
import { readAgentEvents } from "../lib/sse";

export interface RunApi {
  state: RunState;
  start: (form: FormInput) => void;
  sendMessage: (text: string) => void;
  answer: (choices: ResolutionChoice[]) => void;
  /** Resubmits the last request unchanged. */
  retry: () => void;
  stop: () => void;
  reset: () => void;
}

/** Owns one agent session: streams events into the reducer and can abort the stream. */
export function useRun(): RunApi {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const controllerRef = useRef<AbortController | null>(null);

  const send = useCallback(async (request: RunRequest, retry = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    dispatch({ type: "submit", request, retry });

    let sawDone = false;
    try {
      const body = await openRun(request, controller.signal);
      await readAgentEvents(body, (event) => {
        if (event.type === "done") sawDone = true;
        dispatch({ type: "event", event });
      });
      if (!sawDone && !controller.signal.aborted) dispatch({ type: "failed", failure: DROPPED_FAILURE });
    } catch (error) {
      if (controller.signal.aborted) dispatch({ type: "stopped" });
      else if (error instanceof RunRequestError) dispatch({ type: "failed", failure: error.failure });
      else dispatch({ type: "failed", failure: DROPPED_FAILURE });
    }
  }, []);

  const start = useCallback((form: FormInput) => void send({ input: { kind: "form", form } }), [send]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!state.sessionId) return;
      void send({ sessionId: state.sessionId, input: { kind: "message", text } });
    },
    [send, state.sessionId],
  );

  const answer = useCallback(
    (choices: ResolutionChoice[]) => {
      if (!state.sessionId) return;
      void send({ sessionId: state.sessionId, input: { kind: "resolution", choices } });
    },
    [send, state.sessionId],
  );

  const retry = useCallback(() => {
    if (state.lastRequest) void send(state.lastRequest, true);
  }, [send, state.lastRequest]);

  const stop = useCallback(() => controllerRef.current?.abort(), []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    dispatch({ type: "reset" });
  }, []);

  return { state, start, sendMessage, answer, retry, stop, reset };
}
