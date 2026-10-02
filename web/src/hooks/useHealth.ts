import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "@shared/types";
import { fetchHealth } from "../lib/api";

export type HealthState =
  | { status: "loading" }
  | { status: "ready"; health: HealthResponse }
  | { status: "unreachable" };

export function useHealth(): { state: HealthState; recheck: () => void } {
  const [state, setState] = useState<HealthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchHealth(controller.signal).then(
      (health) => setState({ status: "ready", health }),
      () => {
        if (!controller.signal.aborted) setState({ status: "unreachable" });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, recheck };
}
