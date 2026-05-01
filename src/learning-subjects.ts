/**
 * Authoritative list: edit `learning-subjects.json` only (then `npm run build` copies to `visual/subjects.json`).
 */

import data from "./learning-subjects.json" with { type: "json" };

export interface SubjectRow {
  short: string;
  full: string;
  hex: string;
}

export const LEARNING_SUBJECT_REGISTRY: readonly SubjectRow[] = data.subjects;

/** Full course name as stored in events / DB (e.g. "Algebra II Sem 2"). */
export type LearningGraphSubject = string;

export const LEARNING_GRAPH_SUBJECTS: readonly string[] = LEARNING_SUBJECT_REGISTRY.map((r) => r.full);

export function mapShortSubjectToLearningGraphFull(short: string | undefined): string | null {
  if (!short) return null;
  const row = LEARNING_SUBJECT_REGISTRY.find((r) => r.short === short);
  return row ? row.full : null;
}
