/**
 * Plan progress for unattended multi-quiz runs: when to advance targetQuizIndex vs resume an incomplete attempt.
 */

import type { Observation } from "./types.js";

/** Escape a lesson code like "3.2.5" for use inside RegExp constructors. */
function escapeLessonCodeForRegex(code: string): string {
  return code.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * After leaving the quiz UI, detect whether the assessment for `targetQuizCode` appears finished on the course map / results.
 * Used when `quizSummaryReached` was never set during the attempt (e.g. fast path back to the activity list).
 */
export function observationLooksLikePostQuizCompletion(obs: Observation, targetQuizCode: string): boolean {
  if (obs.quizSummaryReached) return true;
  const code = targetQuizCode.trim();
  if (!/^\d+\.\d+\.\d+$/.test(code)) return false;

  const escaped = escapeLessonCodeForRegex(code);
  const codeWord = `\\b${escaped}\\b`;
  const blob = [
    obs.headerText ?? "",
    (obs.buttons ?? []).join("\n"),
    obs.questionText ?? "",
    obs.url ?? "",
  ]
    .join("\n")
    .slice(0, 120_000);

  // Same tile can show In Progress + points; do not treat as submitted.
  if (
    new RegExp(`${codeWord}[\\s\\S]{0,420}\\b(In\\s+Progress|Not\\s+Started|RESUME|Resume)\\b`, "i").test(blob)
  ) {
    return false;
  }

  // Row or tile: "3.2.5 ... Completed" / "Mastered" / score line near code (whole code token — not a substring of e.g. 13.4.2)
  const nearCode = new RegExp(`${codeWord}[\\s\\S]{0,200}\\b(completed|mastered|passed|submitted)\\b`, "i");
  if (nearCode.test(blob)) return true;

  // Do not use "% / score / points" near code — in-progress tests show gauges (e.g. 80%) and false-complete.

  // Summary / results phrasing (lesson strip or dashboard)
  if (
    /\b(assessment|quiz|test)\s+(complete|submitted|recorded)\b/i.test(blob) &&
    new RegExp(codeWord).test(blob)
  ) {
    return true;
  }

  return false;
}

/**
 * Apex horizontal strip / map: a row for `code` shows Completed, checkmark wording, or score — item already done.
 * Wrap-Up rows mix "3.4.1 … Completed" with "3.4.2 … In Progress"; require whole-code `\b` match and reject In Progress / RESUME near that code.
 */
export function stripTextShowsCodeDone(stripSample: string, code: string): boolean {
  const c = code.trim();
  if (!/^\d+\.\d+\.\d+$/.test(c)) return false;
  const esc = escapeLessonCodeForRegex(c);
  const codeWord = `\\b${esc}\\b`;
  const blob = stripSample.slice(0, 120_000);

  if (
    new RegExp(`${codeWord}[\\s\\S]{0,420}\\b(In\\s+Progress|Not\\s+Started|RESUME|Resume)\\b`, "i").test(blob)
  ) {
    return false;
  }

  if (
    new RegExp(`${codeWord}[\\s\\S]{0,160}\\b(Completed|Mastered|passed|submitted)\\b`, "i").test(blob)
  ) {
    return true;
  }
  // No "% / score" shortcut here — same false-positive as observationLooksLikePostQuizCompletion.
  if (new RegExp(`[✓✔☑]\\s*${codeWord}|${codeWord}\\s*[✓✔☑]`, "i").test(blob)) {
    return true;
  }
  return false;
}
