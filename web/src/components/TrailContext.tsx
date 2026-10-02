import { createContext, useContext } from "react";

export interface TrailApi {
  /** Opens the evidence trail, expands that call, scrolls to it and highlights it. */
  openCall: (callId: string) => void;
  /** Whether the trail knows this call (cites to unknown calls are shown but inert). */
  hasCall: (callId: string) => boolean;
}

const inert: TrailApi = { openCall: () => undefined, hasCall: () => false };

export const TrailContext = createContext<TrailApi>(inert);

export function useTrail(): TrailApi {
  return useContext(TrailContext);
}
