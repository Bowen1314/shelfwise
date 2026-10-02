import type { EntityRef, ToolStatus, TrendDirection } from "@shared/types";
import { entityTypeLabel, STATUS_META, TREND_LABELS } from "../lib/format";
import { Icon, Spinner, type IconName } from "./Icon";

const STATUS_ICONS: Record<ToolStatus, IconName> = {
  ok: "check",
  empty: "dash",
  needs_input: "help",
  partial: "half",
  degraded: "alert",
  error: "x-circle",
};

/**
 * Status is carried by icon, word and colour together. `status` null means the call has no result yet: it is
 * running while the run is live, and never finished once the run has ended.
 */
export function StatusChip({ status, live }: { status: ToolStatus | null; live: boolean }) {
  if (status === null) {
    return live ? (
      <span className="chip chip--running">
        <Spinner />
        Running
      </span>
    ) : (
      <span className="chip chip--neutral">
        <Icon name="dash" />
        Not finished
      </span>
    );
  }
  const meta = STATUS_META[status];
  return (
    <span className={`chip chip--${meta.tone}`}>
      <Icon name={STATUS_ICONS[status]} />
      {meta.label}
    </span>
  );
}

const TREND_ICONS: Record<TrendDirection, IconName> = {
  rising: "arrow-up-right",
  fading: "arrow-down-right",
  steady: "arrow-right",
  unknown: "help",
};

export function TrendChip({ direction }: { direction: TrendDirection }) {
  return (
    <span className={`chip chip--trend-${direction}`}>
      <Icon name={TREND_ICONS[direction]} />
      {TREND_LABELS[direction]}
    </span>
  );
}

export function ReducedChip() {
  return (
    <span className="chip chip--reduced" title="Some of the Qloo calls behind this were partial or degraded.">
      <Icon name="alert" />
      Reduced confidence
    </span>
  );
}

export function SampleChip() {
  return (
    <span className="chip chip--sample">
      <Icon name="flask" />
      Sample
    </span>
  );
}

export function SignalChip({ entity }: { entity: Pick<EntityRef, "name" | "type"> }) {
  const type = entityTypeLabel(entity.type);
  return (
    <span className="chip chip--signal">
      {entity.name}
      {type && <span className="chip__type">{type}</span>}
    </span>
  );
}
