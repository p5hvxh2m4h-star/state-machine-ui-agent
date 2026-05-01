/**
 * Append-only log for the learning-graph visualization. Subject-scoped events stream to
 * visual/learning-neural-net.html via scripts/learning-graph-sse.mjs (npm run graph:viz).
 *
 * For structured memory later, add SQLite/Postgres and keep this as an event bus or dual-write.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LearningGraphSubject,
  LEARNING_GRAPH_SUBJECTS,
  mapShortSubjectToLearningGraphFull,
} from "./learning-subjects.js";
import { insertLearningGraphEventRow } from "./learning-graph-db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_FILE = join(root, "logs", "learning-graph.jsonl");

export type { LearningGraphSubject };
export { LEARNING_GRAPH_SUBJECTS, mapShortSubjectToLearningGraphFull };
export { queryRecentLearningEvents } from "./learning-graph-db.js";

/** @deprecated Use mapShortSubjectToLearningGraphFull */
export const mapTargetSubjectToLearningGraphSubject = mapShortSubjectToLearningGraphFull;

export type LearningGraphEventType =
  | "connection"
  | "node"
  | "pattern"
  | "question_complete"
  | "quiz_complete"
  | "feedback_correct"
  | "feedback_incorrect";

export interface LearningGraphEvent {
  type: LearningGraphEventType;
  subject: LearningGraphSubject;
  weight?: number;
  meta?: Record<string, unknown>;
  ts: number;
}

export function recordLearningGraphEvent(event: Omit<LearningGraphEvent, "ts">): void {
  const line: LearningGraphEvent = { ...event, ts: Date.now() };
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, `${JSON.stringify(line)}\n`, "utf8");
  insertLearningGraphEventRow(line);
}
