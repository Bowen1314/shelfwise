import { useCallback, useRef, useState } from "react";
import { clearRecentRuns, loadRecentRuns, removeRecentRun, saveRecentRun, type RecentRun } from "../lib/recentRuns";

export interface RecentRunsApi {
  runs: RecentRun[];
  save: (run: RecentRun) => void;
  remove: (sessionId: string) => void;
  clear: () => void;
}

/**
 * The recent-runs list, kept in this browser's localStorage. When storage is blocked the list still works for the
 * life of the page: each change is applied to what is on screen.
 */
export function useRecentRuns(): RecentRunsApi {
  const [runs, setRuns] = useState<RecentRun[]>(() => loadRecentRuns());
  const latest = useRef(runs);

  const commit = useCallback((next: RecentRun[]) => {
    latest.current = next;
    setRuns(next);
  }, []);

  const save = useCallback((run: RecentRun) => commit(saveRecentRun(run, undefined, latest.current)), [commit]);
  const remove = useCallback((sessionId: string) => commit(removeRecentRun(sessionId, undefined, latest.current)), [commit]);
  const clear = useCallback(() => commit(clearRecentRuns()), [commit]);

  return { runs, save, remove, clear };
}
