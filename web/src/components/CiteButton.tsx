import type { Cite } from "@shared/types";
import { shortTool } from "../lib/progress";
import { useTrail } from "./TrailContext";

interface CiteButtonProps {
  callId: string;
  /** Extra words for the accessible name and tooltip, such as "affinity 0.83, result 2 of 8". */
  detail?: string;
  tool?: string;
}

/** A pointer from a claim to the tool call behind it. Opens the evidence trail at that call. */
export function CiteButton({ callId, detail, tool }: CiteButtonProps) {
  const trail = useTrail();
  const known = trail.hasCall(callId);
  const toolName = tool ? shortTool(tool) : null;
  const name = ["Evidence", callId, toolName, detail].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      className="cite"
      title={detail ? `${callId}: ${detail}` : callId}
      aria-label={known ? `Show ${name} in the evidence trail` : name}
      disabled={!known}
      onClick={() => trail.openCall(callId)}
    >
      {callId}
    </button>
  );
}

/** "Evidence: c3 · c5": one button per distinct call, tooltips carry the cited values. */
export function EvidenceChips({ cites }: { cites: Cite[] }) {
  const distinct = new Map<string, Cite>();
  for (const cite of cites) {
    const seen = distinct.get(cite.callId);
    distinct.set(cite.callId, seen ? { ...seen, label: [seen.label, cite.label].filter(Boolean).join("; ") } : cite);
  }
  if (distinct.size === 0) return null;
  return (
    <span className="evidence-chips">
      <span className="evidence-chips__label">Evidence:</span>
      {[...distinct.values()].map((cite) => (
        <CiteButton key={cite.callId} callId={cite.callId} tool={cite.tool} detail={cite.label} />
      ))}
    </span>
  );
}
