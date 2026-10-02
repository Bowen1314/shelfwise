import { randomBytes } from "node:crypto";
import type { Candidate, FormInput, Report } from "../shared/types.js";
import { EvidenceStore } from "./evidence.js";
import type { ChatMessage } from "./llm.js";

export interface PendingIssue {
  issueId: string;
  callId: string;
  tool: string;
  input: string;
  field: string;
  inputKind: "entity" | "tag";
  kind: "ambiguous" | "not_found";
  candidates: Candidate[];
}

export interface Session {
  id: string;
  createdAt: number;
  lastUsed: number;
  mode: "live" | "fixtures";
  form: FormInput;
  messages: ChatMessage[];
  store: EvidenceStore;
  pending: Map<string, PendingIssue>;
  lastReport: Report | undefined;
  reportVersion: number;
  /** Qloo calls that returned usable evidence since the last accepted report. */
  unreportedCalls: number;
  toolCallsTotal: number;
  followUps: number;
  busy: boolean;
}

export function newSession(form: FormInput, mode: "live" | "fixtures", now = Date.now()): Session {
  return {
    id: randomBytes(16).toString("hex"),
    createdAt: now,
    lastUsed: now,
    mode,
    form,
    messages: [],
    store: new EvidenceStore(),
    pending: new Map(),
    lastReport: undefined,
    reportVersion: 0,
    unreportedCalls: 0,
    toolCallsTotal: 0,
    followUps: 0,
    busy: false,
  };
}

/** In-memory sessions with a TTL and a hard cap (oldest idle evicted first). */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  add(session: Session): void {
    this.sweep();
    while (this.sessions.size >= this.max) {
      const idle = [...this.sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) break;
      this.sessions.delete(idle.id);
    }
    this.sessions.set(session.id, session);
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (!s.busy && this.now() - s.lastUsed > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (!s.busy && t - s.lastUsed > this.ttlMs) this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
