/**
 * Quiz playlist from the user's handwritten list (last screenshot).
 * Agent uses this to know which quizzes to do: subject + code (e.g. English 2.2.3).
 */

import type { QuizPlaylist, QuizTarget } from "./types.js";

/** Current run targets (session plan mirrors this in session-plan.json). */
export const DEFAULT_QUIZ_PLAYLIST: QuizPlaylist = {
  targets: [
    { subject: "History", code: "4.1.2" },
    { subject: "History", code: "4.1.5" },
    { subject: "History", code: "4.2.2" },
    { subject: "History", code: "4.2.5" },
  ],
};

/** Map subject to full Edmentum card title (ALVS PT ...). */
export function subjectToCourseTitle(subject: string): string {
  const map: Record<string, string> = {
    English: "ALVS PT English 10 Sem 2",
    Algebra: "ALVS PT Algebra II Sem 2",
    Biology: "ALVS PT Biology Sem 2",
    History: "ALVS PT U.S. History Sem 2",
  };
  return map[subject] ?? subject;
}

/** Map subject to Apex course name (as shown on Apex dashboard). */
export function subjectToApexCourseName(subject: string): string {
  const map: Record<string, string> = {
    English: "English 10 Sem 2",
    Algebra: "Algebra II Sem 2",
    Biology: "Biology Sem 2",
    History: "U.S. History Sem 2",
  };
  return map[subject] ?? subject;
}

/** Next target from playlist for current subject (by code order). */
export function getNextQuizInPlaylist(
  playlist: QuizPlaylist,
  subject: string,
  currentCode: string
): QuizTarget | null {
  const codes = playlist.targets
    .filter((t) => t.subject === subject)
    .map((t) => t.code)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const idx = codes.indexOf(currentCode);
  return idx >= 0 && idx < codes.length - 1
    ? playlist.targets.find((t) => t.subject === subject && t.code === codes[idx + 1]) ?? null
    : null;
}
