import { EventEmitter } from "node:events";

// ── Event types ─────────────────────────────────────────────────────────────

export type NeedleEventStep =
  | "run.started"
  | "resource.resolved"
  | "surface.discovered"
  | "evidence.collected"
  | "evidence.reranked"
  | "deepread.completed"
  | "imports.followed"
  | "gaps.identified"
  | "iteration.pass2.completed"
  | "synthesis.completed"
  | "verify.completed"
  | "web.collected"
  | "run.completed"
  | "run.failed";

export interface NeedleEvent {
  runId: string;
  ts: string;
  step: NeedleEventStep;
  data: Record<string, unknown>;
}

// ── Global event bus ────────────────────────────────────────────────────────

export const needleEvents = new EventEmitter();
needleEvents.setMaxListeners(100);

// ── Run logger helper ───────────────────────────────────────────────────────

export interface RunLogger {
  emit(step: NeedleEventStep, data?: Record<string, unknown>): void;
  markStepStart(name: string): void;
  markStepEnd(name: string): void;
}

export function createRunLogger(runId: string): RunLogger {
  const timers = new Map<string, number>();

  return {
    emit(step: NeedleEventStep, data: Record<string, unknown> = {}) {
      const event: NeedleEvent = {
        runId,
        ts: new Date().toISOString(),
        step,
        data,
      };
      needleEvents.emit("event", event);
    },

    markStepStart(name: string) {
      timers.set(name, Date.now());
    },

    markStepEnd(name: string) {
      const start = timers.get(name);
      const elapsed = start ? Date.now() - start : 0;
      timers.delete(name);
      return elapsed;
    },
  };
}

/** Generate a short random run ID */
export function generateRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
