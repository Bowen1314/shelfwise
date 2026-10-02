import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrailApi } from "../components/TrailContext";
import { usePrefersReducedMotion } from "./useMediaQuery";

const HIGHLIGHT_MS = 2600;

export interface TrailController {
  api: TrailApi;
  sheetOpen: boolean;
  /** The sheet's own handle: open it, or close it and leave focus where it is. */
  toggleSheet: () => void;
  /** Closing from the keyboard or the backdrop: focus goes back to the citation that opened it, else to `fallback`. */
  closeSheet: (fallback: HTMLElement | null) => void;
  expanded: ReadonlySet<string>;
  toggle: (callId: string) => void;
  highlighted: string | null;
}

/**
 * State for the evidence trail: which calls are expanded, which one is highlighted, and whether the
 * mobile bottom sheet is open. `openCall` is what a click on a citation does.
 */
export function useTrailController(knownCallIds: ReadonlySet<string>): TrailController {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [target, setTarget] = useState<{ callId: string; seq: number } | null>(null);
  const timer = useRef<number>(0);
  const opener = useRef<HTMLElement | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  const toggle = useCallback((callId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }, []);

  const toggleSheet = useCallback(() => {
    opener.current = null;
    setSheetOpen((open) => !open);
  }, []);

  const closeSheet = useCallback((fallback: HTMLElement | null) => {
    setSheetOpen(false);
    const back = opener.current?.isConnected ? opener.current : fallback;
    opener.current = null;
    back?.focus();
  }, []);

  const openCall = useCallback((callId: string) => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setSheetOpen(true);
    setExpanded((current) => new Set(current).add(callId));
    setHighlighted(callId);
    setTarget((current) => ({ callId, seq: (current?.seq ?? 0) + 1 }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
  }, []);

  // Runs after the sheet has opened and the row has expanded, so the row exists and can take focus. An expanded
  // row can be taller than the list, so align its top edge rather than centring it.
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(`call-${target.callId}`);
      if (!row) return;
      row.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
      row.querySelector<HTMLElement>(".call__head")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, reduceMotion]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const api = useMemo<TrailApi>(
    () => ({ openCall, hasCall: (callId) => knownCallIds.has(callId) }),
    [openCall, knownCallIds],
  );

  return { api, sheetOpen, toggleSheet, closeSheet, expanded, toggle, highlighted };
}
