import { useCallback, useState } from "react";
import { TAB_IDS, type TabId } from "../components/Results";
import { readStored, writeStored } from "../lib/storage";

const KEY = "shelfwise.tab";

/** The selected report tab, remembered for the browser session. */
export function usePersistedTab(): [TabId, (tab: TabId) => void] {
  const [tab, setTab] = useState<TabId>(() => TAB_IDS.find((id) => id === readStored(KEY)) ?? "bridge");
  const update = useCallback((next: TabId) => {
    setTab(next);
    writeStored(KEY, next);
  }, []);
  return [tab, update];
}
