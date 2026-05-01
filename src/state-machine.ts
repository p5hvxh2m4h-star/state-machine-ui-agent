/**
 * FSM: states, transition rules, and decision policy.
 * Deterministic transitions based on (state, observation) → action → next state.
 */

import type { Action, AppState, Observation, DecisionReason } from "./types.js";
import { subjectToCourseTitle, subjectToApexCourseName } from "./quiz-playlist.js";
import type { PriorSessionOutcomeAudit } from "./quiz-metrics.js";

/** Context passed to decide() for targeting subject and quizzes. */
export interface DecideContext {
  targetSubject?: string;
  targetQuizzes?: string[];
  targetQuizIndex?: number;
  /**
   * We left the quiz without confirming completion — prefer RESUME scoped to the current target code
   * until the quiz UI is visible again.
   */
  quizExitIncomplete?: boolean;
  /**
   * Prior run (any terminal session): SQLite still has submit rows without `outcome` for the last session —
   * prefer RESUME / View Summary until `applyQuizSummaryBackfill` can reconcile.
   */
  priorRunMetricsGap?: PriorSessionOutcomeAudit | null;
  /** Run-plan `skipCodes` — never interact with these lesson triples except to leave (Activities / Back). */
  forbiddenLessonCodes?: string[];
}

/** When the parser finds no course cards, try clicking one of these (driver uses getByText). */
const FALLBACK_EDMENTUM_COURSE_NAMES = [
  "ALVS PT Biology Sem 2",
  "ALVS PT English 10 Sem 2",
  "ALVS PT Algebra II Sem 2",
  "ALVS PT U.S. History Sem 2",
];

/** Parse "2.2.3" → [2, 2, 3] */
export function parseLessonCode(label: string): number[] | null {
  const parts = label.trim().split(".").map((s) => parseInt(s, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

/** Format [2, 2, 3] → "2.2.3" */
export function formatLessonCode(code: number[]): string {
  return code.join(".");
}

/** Next lesson: (2,2,3) → (2,2,4). Parent: (2,2,3) → (2,2) or (2). */
export function getNextLessonCode(code: number[]): number[] {
  const next = [...code];
  const last = next.length - 1;
  next[last] = (next[last] ?? 0) + 1;
  return next;
}

export function getParentCode(code: number[]): number[] | null {
  if (code.length <= 1) return null;
  return code.slice(0, -1);
}

/** Lexicographic compare for lesson code tuples (pad with 0). */
export function compareLex(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : av > bv ? 1 : 0;
  }
  return 0;
}

/**
 * True when we're on a specific activity in the lesson line (4.1.x), not the unit intro that only
 * parses as [4,1] or spuriously matches the target triple from the header before we've opened the lesson.
 */
function isInTargetLessonBand(obs: Observation, band: [number, number]): boolean {
  if (obs.apexUnitIntroActive) return false;
  const cur = obs.lessonCode;
  return !!cur && cur.length >= 3 && cur[0] === band[0] && cur[1] === band[1];
}

/**
 * Find "Lesson 4.1" / "LESSON 4.1" (nav tab or carousel arrow label) for the lesson band that contains
 * a triple like 4.1.2 — used when lessonCode is missing on unit intro.
 */
function findLessonBandTabButton(buttons: string[], band: [number, number]): string | null {
  const a = band[0];
  const b = band[1];
  const exact = [
    new RegExp(`^\\s*Lesson\\s+${a}\\.${b}\\s*$`, "i"),
    new RegExp(`^\\s*LESSON\\s+${a}\\.${b}\\s*$`, "i"),
  ];
  for (const btn of buttons) {
    const t = btn.trim();
    if (exact.some((re) => re.test(t))) return btn;
  }
  const loose = new RegExp(`(?:Lesson|LESSON)\\s+${a}\\.${b}\\b`, "i");
  return buttons.find((x) => loose.test(x)) ?? null;
}

/**
 * Strip navigators like "Lesson 2.2" (forward along unit lessons). Prefer the smallest forward
 * step that is still on or before the target triple (e.g. 3.4.2).
 *
 * Unit introduction often has **no** parsed lessonCode — we still must click "Lesson 4.1" (forward)
 * once so the wrap-up / activity strip appears for 4.1.2.
 */
export function pickForwardLessonNavLabel(obs: Observation, targetCode: number[]): string | null {
  if (targetCode.length >= 2) {
    const band: [number, number] = [targetCode[0]!, targetCode[1]!];
    const tab = findLessonBandTabButton(obs.buttons, band);
    if (tab && !isInTargetLessonBand(obs, band)) {
      return tab;
    }
  }

  const current = obs.lessonCode;
  if (!current?.length) return null;
  if (compareLex(targetCode, current) <= 0) return null;
  const forwardLabels = obs.buttons.filter((b) => /Lesson\s+\d+\.\d+/i.test(b));
  if (forwardLabels.length === 0) return null;
  let best: string | null = null;
  let bestParsed: number[] | null = null;
  for (const label of forwardLabels) {
    const m = label.match(/Lesson\s+(\d+)\.(\d+)/i);
    if (!m) continue;
    const p = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (compareLex(p, current) <= 0) continue;
    // Never skip past target (e.g. do not click Lesson 3.3 when target is 3.2.5).
    if (compareLex(p, targetCode) > 0) continue;
    if (!bestParsed || compareLex(p, bestParsed) < 0) {
      best = label;
      bestParsed = p;
    }
  }
  return best;
}

/** True if the lesson strip lists this exact code (clickable), e.g. buttons contain "3.4.2". */
function stripListsLessonCode(obs: Observation, target: number[]): boolean {
  const needle = formatLessonCode(target);
  if (obs.buttons.includes(needle)) return true;
  const wordBoundary = new RegExp(`\\b${needle.replace(/\./g, "\\.")}\\b`);
  for (const b of obs.buttons) {
    if (wordBoundary.test(b)) return true;
    const m = b.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (m) {
      const p = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
      if (compareLex(p, target) === 0) return true;
    }
  }
  return false;
}

/** Plan target triple appears as a strip/tile **button** label (not only from body-derived `lessonCode`). */
function targetTripleVisibleInStripButtons(obs: Observation, tq: number[]): boolean {
  if (tq.length < 3) return false;
  const needle = formatLessonCode(tq);
  if (obs.buttons.includes(needle)) return true;
  const wb = new RegExp(`\\b${needle.replace(/\./g, "\\.")}\\b`);
  for (const b of obs.buttons) {
    if (wb.test(b)) return true;
  }
  return false;
}

/**
 * Horizontal activity map (several circles / codes visible). On this screen, phantom RESUME/START from body text
 * plus a spurious `lessonCode === target` would open the wrong tile — require target code in strip before footer CTAs.
 */
function apexActivityMapLike(obs: Observation): boolean {
  const tripleButtons = obs.buttons.filter((b) => /^\d+\.\d+\.\d+$/.test(b.trim()));
  if (tripleButtons.length >= 2) return true;
  const lessonTabs = obs.buttons.filter(
    (b) => /^LESSON\s+\d+\.\d+$/i.test(b.trim()) || /^Lesson\s+\d+\.\d+$/i.test(b.trim())
  );
  return lessonTabs.length >= 1 && tripleButtons.length >= 1;
}

/**
 * Multi-tile `/activity/` map: scoped RESUME often jumps to the first in-progress row (e.g. **3.1.1**) instead of
 * the plan tile (**3.1.4**) until that tile appears in parsed strip labels — prefer NAVIGATE_LESSON / tile CLICK.
 */
function shouldDeferResumeOnActivityMap(obs: Observation, lc: number[] | null | undefined): boolean {
  if (!lc || lc.length < 3) return false;
  if (!obs.url?.includes("/activity/")) return false;
  return apexActivityMapLike(obs) && !targetTripleVisibleInStripButtons(obs, lc);
}

/** First number in lesson code = Apex unit (3.2.5 → unit 3). */
function primaryUnitNumber(code: number[]): number | null {
  return code.length > 0 ? code[0]! : null;
}

/** Parse current Unit N from header/body text when on Apex activity map / lesson strip. */
function currentUnitNumberFromText(obs: Observation): number | null {
  const s = `${obs.stripTextSample ?? ""}\n${obs.headerText ?? ""}`.slice(0, 20_000);
  const m = s.match(/\bUnit\s+(\d+)\b/i);
  if (!m) return null;
  const u = parseInt(m[1]!, 10);
  return Number.isFinite(u) && u > 0 ? u : null;
}

/** Match "Unit 3" or "Unit 3: Title…" on course outline. */
function findUnitOutlineButton(buttons: string[], unitNum: number): string | undefined {
  const re = new RegExp(`^Unit\\s+${unitNum}(\\s*:|\\s*$)`, "i");
  return buttons.find((b) => re.test(b.trim()));
}

function hasActiveQuizTarget(ctx: DecideContext): boolean {
  const { targetQuizzes = [], targetQuizIndex = 0 } = ctx;
  return targetQuizzes.length > 0 && targetQuizIndex < targetQuizzes.length;
}

function escapeCodeForForbiddenRegex(code: string): string {
  return code.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parser lesson/header shows a plan-forbidden triple (e.g. strip misclick opened 2.4.4). */
function observationMatchesForbiddenLesson(obs: Observation, ctx: DecideContext): boolean {
  const { forbiddenLessonCodes = [] } = ctx;
  if (forbiddenLessonCodes.length === 0) return false;
  for (const raw of forbiddenLessonCodes) {
    const c = raw.trim();
    if (!/^\d+\.\d+\.\d+$/.test(c)) continue;
    if (obs.lessonCode?.length && formatLessonCode(obs.lessonCode) === c) return true;
    // Multi-tile activity maps list many sibling codes (e.g. 3.2.9 next to target 3.2.3). skipCodes means
    // "do not open that activity", not "leave whenever that label appears on the strip" — blob match would
    // false-trigger decideExitForbiddenLesson and EXIT_TO_MODULE_LIST loops (see debug H2 on 3.2.x maps).
    if (apexActivityMapLike(obs)) continue;
    const blob = [obs.headerText ?? "", obs.buttons.join("\n"), obs.questionText ?? ""].join("\n");
    if (new RegExp(`\\b${escapeCodeForForbiddenRegex(c)}\\b`).test(blob)) return true;
  }
  return false;
}

/** Leave a forbidden activity without submitting — map first, then NAVIGATE_LESSON will target the real plan code. */
function decideExitForbiddenLesson(obs: Observation): { action: Action; reason: DecisionReason } | null {
  if (!obs.url?.includes("/activity/")) return null;
  if (obs.buttons.includes("Activities")) {
    return { action: { type: "CLICK", target: "Activities" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  if (obs.buttons.includes("Back")) {
    return { action: { type: "CLICK", target: "Back" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  if (obs.buttons.includes("PREVIOUS")) {
    return { action: { type: "CLICK", target: "PREVIOUS" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  const previousLabel = obs.buttons.find((b) => /^previous$/i.test(b.trim()));
  if (previousLabel) {
    return { action: { type: "CLICK", target: previousLabel }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  return { action: { type: "EXIT_TO_MODULE_LIST" }, reason: "TASK_COMPLETED_GO_NEXT" };
}

function lessonCodeForActiveTarget(ctx: DecideContext): number[] | null {
  const { targetQuizzes = [], targetQuizIndex = 0 } = ctx;
  if (!hasActiveQuizTarget(ctx)) return null;
  return parseLessonCode(targetQuizzes[targetQuizIndex]!) ?? null;
}

/** Same Apex "lesson line" (e.g. 3.2.*) — safe to use CONTINUE to move within 3.2.x toward 3.2.5. */
function sameLessonBand(tq: number[], cur: number[] | undefined): boolean {
  if (!cur?.length || tq.length < 2 || cur.length < 2) return false;
  return tq[0] === cur[0] && tq[1] === cur[1];
}

/**
 * `.../activity/<id>/page/<n>` — paged lesson/overview/study reader. CONTINUE advances through pages; it does
 * **not** open the plan quiz on the horizontal activity map. Parser `lessonCode` / strip text can still mention
 * the target triple on this screen — must not run the "target activity RESUME/CONTINUE/START" branch here.
 */
function isApexActivityPagedReader(obs: Observation): boolean {
  const u = obs.url ?? "";
  return /\/activity\/[^/]+\/page\//i.test(u);
}

/**
 * True on `/activity/.../page/N` when we are already inside the **plan target** quiz flow (vocab review, item
 * instructions) — must allow CONTINUE. Distinct from unit lesson overviews that mention the code in body text
 * but should open the circle-map tile instead.
 */
function insideTargetQuizPagedIntro(obs: Observation, ctx: DecideContext): boolean {
  if (!isApexActivityPagedReader(obs) || !hasActiveQuizTarget(ctx)) return false;
  const lc = lessonCodeForActiveTarget(ctx);
  if (!lc || lc.length < 3) return false;
  // Plan target must be a real strip label — not only a wrong `lessonCode` from first body triple.
  if (!targetTripleVisibleInStripButtons(obs, lc)) return false;
  if (obs.buttons.includes("Submit") || obs.buttons.includes("SUBMIT")) return false;
  if (obs.questionText || (obs.choices && obs.choices.length > 0)) return false;
  // Vocab / quiz intro uses CONTINUE (multi-page) or START only (e.g. "1 of 1" → begin quiz).
  if (!obs.buttons.includes("CONTINUE") && !obs.buttons.includes("START")) return false;
  const needle = formatLessonCode(lc);
  const s = `${obs.headerText ?? ""}\n${obs.stripTextSample ?? ""}`.slice(0, 14_000);
  if (/\bvocabulary\s+review\b/i.test(s)) return true;
  if (/\bquestion\s+\d+\s+of\s+\d+\b/i.test(s)) return true;
  if (new RegExp(`\\b${needle.replace(/\./g, "\\.")}\\b\\s*:\\s*[^\\n]*\\bquiz\\b`, "i").test(s)) return true;
  if (new RegExp(`\\b${needle.replace(/\./g, "\\.")}\\s+quiz\\s*:\\s*`, "i").test(s)) return true;
  return false;
}

/** Paged Apex reader with a plan quiz target but no real assessment UI yet — do not burn CONTINUE to flip slides. */
function apexPagedReaderChasingQuizTarget(obs: Observation, ctx: DecideContext): boolean {
  if (!isApexActivityPagedReader(obs) || !hasActiveQuizTarget(ctx)) return false;
  if (insideTargetQuizPagedIntro(obs, ctx)) return false;
  if (
    obs.state === "QUIZ_SCREEN" ||
    obs.buttons.includes("Submit") ||
    obs.buttons.includes("SUBMIT") ||
    obs.questionText ||
    (obs.choices && obs.choices.length > 0) ||
    obs.buttons.includes("START") ||
    obs.buttons.includes("View Summary")
  ) {
    return false;
  }
  return true;
}

function decideApexActivityStrip(
  obs: Observation,
  ctx: DecideContext
): { action: Action; reason: DecisionReason } | null {
  if (!obs.url?.includes("/activity/")) return null;
  if (observationMatchesForbiddenLesson(obs, ctx)) {
    return decideExitForbiddenLesson(obs);
  }
  const { targetQuizzes = [], targetQuizIndex = 0 } = ctx;
  const tq = hasActiveQuizTarget(ctx) ? parseLessonCode(targetQuizzes[targetQuizIndex]!) : null;

  const pagedReaderChasingQuiz = apexPagedReaderChasingQuizTarget(obs, ctx);

  // Overshot (e.g. on 3.3.1 study when target is 3.2.5) — Back, or PREVIOUS on Apex read/study footers.
  if (tq && obs.lessonCode && compareLex(obs.lessonCode, tq) > 0) {
    if (obs.buttons.includes("Back")) {
      return { action: { type: "CLICK", target: "Back" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.buttons.includes("PREVIOUS")) {
      return { action: { type: "CLICK", target: "PREVIOUS" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
  }

  // Header already matches target lesson — open the activity; do not re-click the same strip code.
  // Order: RESUME → CONTINUE → START → Next. Test/wrap-up intros need CONTINUE before START ("click next page to begin").
  // Skip when `.../activity/.../page/N` is a paged overview/study reader: CONTINUE advances slides, not the quiz tile.
  // On a multi-tile map, body text can set `lessonCode` to the target while the focused tile is still 3.1.1 — never
  // click START/CONTINUE until the target triple is visible in the strip (else we launch the wrong activity).
  if (tq && obs.lessonCode && compareLex(obs.lessonCode, tq) === 0 && !pagedReaderChasingQuiz) {
    const mapLike = apexActivityMapLike(obs);
    const targetShown = targetTripleVisibleInStripButtons(obs, tq);
    if (!mapLike || targetShown) {
      if (obs.buttons.includes("RESUME")) {
        return { action: { type: "CLICK", target: "RESUME", lessonCode: tq }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("CONTINUE")) {
        return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("START")) {
        return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("Next")) {
        return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
    }
  }

  if (tq) {
    const forward = pickForwardLessonNavLabel(obs, tq);
    if (forward) {
      return { action: { type: "CLICK", target: forward }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
  }
  // Target activity visible: in-progress quizzes show RESUME on the tile — prefer that over getByText(3.2.5), which often misses split DOM.
  // Do NOT return null when lessonCode === target before this block: that skipped RESUME/NAVIGATE on the Wrap-Up map (e.g. 3.4.2 Test In Progress).
  if (hasActiveQuizTarget(ctx)) {
    const code = parseLessonCode(targetQuizzes[targetQuizIndex]!);
    if (code && stripListsLessonCode(obs, code)) {
      if (insideTargetQuizPagedIntro(obs, ctx)) {
        if (obs.buttons.includes("CONTINUE")) {
          return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
        }
        if (obs.buttons.includes("START")) {
          return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
        }
      }
      if (obs.buttons.includes("RESUME") && !shouldDeferResumeOnActivityMap(obs, code)) {
        return { action: { type: "CLICK", target: "RESUME", lessonCode: code }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      // Strip lists target code but parser `lessonCode` often mismatches focused tile — do not loop CLICK tile forever.
      // CST/TST intros show CONTINUE and/or START without matching `insideTargetQuizPagedReader` / paged reader heuristics.
      if (
        !obs.buttons.includes("Submit") &&
        !obs.buttons.includes("SUBMIT") &&
        !obs.questionText &&
        !(obs.choices && obs.choices.length > 0)
      ) {
        if (obs.buttons.includes("CONTINUE")) {
          return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
        }
        if (obs.buttons.includes("START")) {
          return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
        }
      }
      const needle = formatLessonCode(code);
      return { action: { type: "CLICK", target: needle }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
  }

  // With a plan target, never authorize CONTINUE from missing parser position — that clicks whatever row is
  // focused (e.g. 2.4.4 Test when target is 2.4.3). Same band (2.4.*) must be strictly before target, not past it.
  let allowContinue = false;
  if (!tq) {
    allowContinue = true;
  } else if (!obs.lessonCode) {
    allowContinue = !hasActiveQuizTarget(ctx);
  } else if (compareLex(obs.lessonCode, tq) === 0) {
    allowContinue =
      !pagedReaderChasingQuiz &&
      (!apexActivityMapLike(obs) || targetTripleVisibleInStripButtons(obs, tq));
  } else if (sameLessonBand(tq, obs.lessonCode)) {
    allowContinue = compareLex(obs.lessonCode, tq) < 0;
  }
  if (obs.buttons.includes("CONTINUE") && allowContinue) {
    return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }

  // Unit boundary: the top lesson strip does not jump units. When the plan target is in a future unit
  // (e.g. target 4.1.4 while map shows Unit 3 Wrap-Up), click the "Unit 4 Intro" forward arrow label.
  if (tq && tq.length > 0) {
    const targetUnit = tq[0]!;
    const curUnit = currentUnitNumberFromText(obs) ?? (obs.lessonCode?.[0] ?? null);
    const unitIntroLabel = `Unit ${targetUnit} Intro`;
    if ((curUnit == null || curUnit < targetUnit) && obs.buttons.includes(unitIntroLabel)) {
      return { action: { type: "CLICK", target: unitIntroLabel }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
  }

  // Wrong unit (e.g. target 3.2.5 but strip is Unit 2) — Back / PREVIOUS toward outline.
  if (
    tq &&
    obs.lessonCode &&
    tq.length > 0 &&
    obs.lessonCode.length > 0 &&
    tq[0] !== obs.lessonCode[0] &&
    (obs.buttons.includes("Back") || obs.buttons.includes("PREVIOUS"))
  ) {
    return {
      action: { type: "CLICK", target: obs.buttons.includes("Back") ? "Back" : "PREVIOUS" },
      reason: "TASK_COMPLETED_GO_NEXT",
    };
  }
  // Target is ahead of current lesson but not visible on strip — Next only advances within the same Lesson 3.x line
  // (e.g. 3.3.6 → 3.3.7). It does not jump from 3.3.* to 3.4.*; fall through so MODULE_LIST uses NAVIGATE_LESSON.
  if (
    tq &&
    obs.lessonCode &&
    compareLex(tq, obs.lessonCode) > 0 &&
    sameLessonBand(tq, obs.lessonCode) &&
    obs.buttons.includes("Next")
  ) {
    return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  if (!hasActiveQuizTarget(ctx) && obs.lessonCode && obs.buttons.includes("Next")) {
    return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  // Paged study/read (no Submit): wrong activity open — jump to target tile on the map (driver scrolls strip).
  const readalongLike =
    !!obs.pageProgress &&
    obs.pageProgress.total > 1 &&
    !obs.buttons.includes("Submit") &&
    !obs.buttons.includes("SUBMIT");
  if (readalongLike && tq && obs.lessonCode && compareLex(obs.lessonCode, tq) !== 0) {
    return { action: { type: "NAVIGATE_LESSON", code: tq }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  // Single-page lesson intro ("Lesson 3.4 Overview", 1 of 1) — strip may list Lesson 3.4 / 3.4 without the target triple; CONTINUE opens Wrap-Up where 3.4.2 appears.
  // Skip when URL is .../page/N reader chasing a quiz: that path matches Lesson 4.2 overview "1 of 1" but CONTINUE never opens 4.2.2.
  if (
    hasActiveQuizTarget(ctx) &&
    tq &&
    obs.buttons.includes("CONTINUE") &&
    obs.pageProgress &&
    obs.pageProgress.current === 1 &&
    obs.pageProgress.total === 1 &&
    !obs.buttons.includes("Submit") &&
    !obs.buttons.includes("SUBMIT") &&
    !obs.feedbackVisible &&
    (!obs.lessonCode || compareLex(obs.lessonCode, tq) <= 0) &&
    !apexPagedReaderChasingQuizTarget(obs, ctx)
  ) {
    return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }
  return null;
}

/**
 * Decision policy (explicit rules, no deception).
 * Returns recommended action and reason.
 */
export function decide(
  state: AppState,
  obs: Observation,
  taskCompleted: boolean,
  nextLessonExists: boolean,
  deadlineExceeded: boolean,
  ctx: DecideContext = {}
): { action: Action; reason: DecisionReason } {
  const { targetSubject, targetQuizzes = [], targetQuizIndex = 0, quizExitIncomplete, priorRunMetricsGap } = ctx;
  const priorGapUnresolved = priorRunMetricsGap && priorRunMetricsGap.rowsMissingOutcome > 0;
  if (deadlineExceeded) {
    return {
      action: { type: "EXIT_TO_MODULE_LIST" },
      reason: "DEADLINE_EXCEEDED",
    };
  }

  if ((quizExitIncomplete || priorGapUnresolved) && hasActiveQuizTarget(ctx)) {
    const lc = lessonCodeForActiveTarget(ctx);
    // DB "prior run" recovery: only RESUME on an `/activity/` map — not course home `.../public` where
    // "Resume" reopens the wrong context and loops forever (stale FSM + global Resume).
    const skipPriorGapResume =
      priorGapUnresolved && !quizExitIncomplete && !obs.url?.includes("/activity/");
    if (
      !skipPriorGapResume &&
      lc &&
      (obs.buttons.includes("RESUME") || obs.buttons.includes("Resume")) &&
      !shouldDeferResumeOnActivityMap(obs, lc)
    ) {
      return {
        action: {
          type: "CLICK",
          target: obs.buttons.includes("RESUME") ? "RESUME" : "Resume",
          lessonCode: lc,
        },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
  }

  if (observationMatchesForbiddenLesson(obs, ctx)) {
    const leave = decideExitForbiddenLesson(obs);
    if (leave) return leave;
  }

  // Parser reflects real UI; stale FSM can say QUIZ_SCREEN after REVIEW/Back while page is lesson strip.
  if (state === "QUIZ_SCREEN" && obs.state && obs.state !== "QUIZ_SCREEN") {
    return decide(obs.state as AppState, obs, taskCompleted, nextLessonExists, deadlineExceeded, ctx);
  }

  if (state === "QUIZ_SCREEN") {
    // Feedback first — advance after incorrect/correct.
    // On the last question Apex shows VIEW SUMMARY (not Next); parser may still list "Next" from chrome — prefer View Summary first.
    if (obs.feedbackVisible) {
      if (obs.buttons.includes("View Summary")) {
        return { action: { type: "CLICK", target: "View Summary" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("Next")) {
        return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("CONTINUE")) {
        return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
    }
    // Summary / results / itemized question list — before live MCQ (Submit still appears in chrome and would otherwise force NOOP → solver).
    // Prefer CONTINUE / Next over Activities: Activities returns to the strip where a plan with no remaining
    // targets can hit REVIEW and reopen this quiz, causing an end-of-run loop.
    if (obs.quizSummaryReached) {
      if (obs.buttons.includes("CONTINUE")) {
        return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      // Last question often replaces Next with VIEW SUMMARY; parser still lists phantom "Next" from chrome — must click View Summary first.
      if (obs.buttons.includes("View Summary")) {
        return { action: { type: "CLICK", target: "View Summary" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("Next")) {
        return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("Activities")) {
        return { action: { type: "CLICK", target: "Activities" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
    }
    const hasSubmit = obs.buttons.includes("Submit") || obs.buttons.includes("SUBMIT");
    // Live MCQ: SUBMIT must win over START — parser often adds a phantom "START" from body text ("start your test").
    if (hasSubmit && !obs.feedbackVisible) {
      return { action: { type: "NOOP" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.buttons.includes("START")) {
      return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.buttons.includes("View Summary")) {
      return { action: { type: "CLICK", target: "View Summary" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.buttons.includes("CONTINUE")) {
      return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    return { action: { type: "NOOP" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }

  if (state === "LESSON_SCREEN") {
    if (obs.quizSummaryReached) {
      if (obs.buttons.includes("CONTINUE")) {
        return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("View Summary")) {
        return { action: { type: "CLICK", target: "View Summary" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("Next")) {
        return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      if (obs.buttons.includes("Activities")) {
        return { action: { type: "CLICK", target: "Activities" }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
    }
    const strip = decideApexActivityStrip(obs, ctx);
    if (strip) return strip;
    if (taskCompleted && nextLessonExists) {
      return {
        action: { type: "CLICK", target: "Next" },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
    if (taskCompleted && !nextLessonExists) {
      return {
        action: { type: "EXIT_TO_PARENT" },
        reason: "NEXT_LESSON_DOES_NOT_EXIST",
      };
    }
    if (obs.buttons.includes("Back")) {
      return { action: { type: "CLICK", target: "Back" }, reason: "ERROR_BLOCKED_RETRY" };
    }
  }

  if (state === "MODULE_LIST") {
    const strip = decideApexActivityStrip(obs, ctx);
    if (strip) return strip;
    const onApexCoursePicker = obs.url?.includes("apexvs.com") && /DashBoard|dashboard/i.test(obs.url ?? "");
    // Lesson codes are not on My Dashboard — NAVIGATE_LESSON always fails there.
    if (!obs.url?.includes("/activity/") && !onApexCoursePicker) {
      if (targetQuizzes.length > 0 && targetQuizIndex < targetQuizzes.length) {
        const code = parseLessonCode(targetQuizzes[targetQuizIndex]!);
        if (code) {
          return { action: { type: "NAVIGATE_LESSON", code }, reason: "TASK_COMPLETED_GO_NEXT" };
        }
      }
      if (obs.lessonCode && obs.buttons.includes("Next")) {
        const tgt = hasActiveQuizTarget(ctx) ? parseLessonCode(targetQuizzes[targetQuizIndex]!) : null;
        if (
          !tgt ||
          (compareLex(tgt, obs.lessonCode) > 0 && sameLessonBand(tgt, obs.lessonCode))
        ) {
          return { action: { type: "CLICK", target: "Next" }, reason: "TASK_COMPLETED_GO_NEXT" };
        }
      }
    }
    if (obs.buttons.includes("START") && !hasActiveQuizTarget(ctx)) {
      return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    // REVIEW opens completed assignments — skip when we have a specific quiz target (avoid redoing checkmarked items).
    // On multi-tile activity maps, REVIEW without a plan target often reopens the last quiz UI and loops after the run plan is done.
    // Strip buttons may omit full `3.x.x` labels (only "3.1", LESSON tabs) so `apexActivityMapLike` is false — still never
    // REVIEW on `/activity/` when the plan is exhausted (prefer SAFE_EXIT from the run loop).
    if (
      obs.buttons.includes("REVIEW") &&
      !hasActiveQuizTarget(ctx) &&
      !apexActivityMapLike(obs) &&
      !obs.url?.includes("/activity/")
    ) {
      return { action: { type: "CLICK", target: "REVIEW" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.buttons.includes("RESUME")) {
      const lc = lessonCodeForActiveTarget(ctx);
      if (!shouldDeferResumeOnActivityMap(obs, lc)) {
        return {
          action: lc ? { type: "CLICK", target: "RESUME", lessonCode: lc } : { type: "CLICK", target: "RESUME" },
          reason: "TASK_COMPLETED_GO_NEXT",
        };
      }
    }
    if (obs.buttons.includes("Resume")) {
      const lc = lessonCodeForActiveTarget(ctx);
      if (!shouldDeferResumeOnActivityMap(obs, lc)) {
        return {
          action: lc ? { type: "CLICK", target: "Resume", lessonCode: lc } : { type: "CLICK", target: "Resume" },
          reason: "TASK_COMPLETED_GO_NEXT",
        };
      }
    }
    // Do not force START on every activity URL — overview cards often only show REVIEW; target activity must be opened first (e.g. click 3.4.2).
  }

  // Edmentum: dismiss blocking modals (e.g. Announcements) before clicking course cards — they intercept pointer events
  // even when ALVS tiles are visible underneath. Previously we skipped dismiss when hasAlvsCourse, which caused
  // infinite CLICK_SUBJECT retries against a covered link.
  if ((state === "EDMENTUM_DASHBOARD" || state === "EDMENTUM_COURSE_GRID") && obs.popupVisible) {
    return {
      action: { type: "DISMISS_POPUP" },
      reason: "TASK_COMPLETED_GO_NEXT",
    };
  }

  // Edmentum: dashboard (1st screen) → click Virtual Learning to reach course grid
  if (state === "EDMENTUM_DASHBOARD") {
    if (obs.buttons.includes("Virtual Learning")) {
      return {
        action: { type: "CLICK", target: "Virtual Learning" },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
  }

  // Flow: (1) Edmentum dashboard → click course name → (2) LAUNCH → (3) Apex My Dashboard → click course name → (4) course page → click Resume
  // Edmentum: course grid (1st screenshot) — click ALVS course name, then LAUNCH
  if (state === "EDMENTUM_COURSE_GRID") {
    const cards = obs.courseCards ?? [];
    const preferredCourse = targetSubject ? subjectToCourseTitle(targetSubject) : null;
    const alvsCourse = preferredCourse && cards.some((c) => c.includes(preferredCourse))
      ? cards.find((c) => c.includes(preferredCourse))
      : cards.find((c) => c.includes("ALVS PT"));
    if (alvsCourse) {
      return {
        action: { type: "CLICK_SUBJECT", subject: alvsCourse },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
    if (cards.length > 0) {
      return { action: { type: "SCROLL_DOWN" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    // Parser timed out or found no cards — prefer the run's subject, not a hard-coded first fallback.
    const fallbackTitle =
      (targetSubject ? subjectToCourseTitle(targetSubject) : null) ?? FALLBACK_EDMENTUM_COURSE_NAMES[0];
    return {
      action: { type: "CLICK_SUBJECT", subject: fallbackTitle },
      reason: "TASK_COMPLETED_GO_NEXT",
    };
  }

  // Edmentum: card selected → either LAUNCH button or (on ALVS list screen) click a course name to open it
  if (state === "EDMENTUM_READY_TO_LAUNCH") {
    const alvsCourseNames = ["Algebra II Sem 2", "Biology Sem 2", "English 10 Sem 2", "U.S. History Sem 2"];
    const preferred = targetSubject ? subjectToApexCourseName(targetSubject) : null;
    const course = (preferred && (obs.buttons.find((b) => b.includes(preferred)) ?? obs.courseCards?.find((c) => c.includes(preferred))))
      ?? obs.buttons.find((b) => alvsCourseNames.some((n) => b.includes(n) || n.includes(b)))
      ?? obs.courseCards?.find((c) => alvsCourseNames.some((n) => c.includes(n) || n.includes(c)));
    if (course) {
      return {
        action: { type: "CLICK", target: course },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
    return { action: { type: "LAUNCH" }, reason: "TASK_COMPLETED_GO_NEXT" };
  }

  // Apex LMS: My Dashboard (course list) → click course name; or we're already on course page (units) → click target unit
  if (state === "APEX_LMS_DASHBOARD") {
    const onCoursePage = obs.buttons.some((b) => /^Unit \d+$/i.test(b) || b.startsWith("Unit ") || b === "Resume");
    if (onCoursePage) {
      const tgtU = hasActiveQuizTarget(ctx) ? parseLessonCode(targetQuizzes[targetQuizIndex]!) : null;
      const uNum = tgtU ? primaryUnitNumber(tgtU) : null;
      const unitForTarget = uNum != null ? findUnitOutlineButton(obs.buttons, uNum) : undefined;
      if (unitForTarget) {
        return { action: { type: "CLICK", target: unitForTarget }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      const unit2 = obs.buttons.find((b) => b === "Unit 2" || /^Unit 2\s*:/i.test(b));
      if (unit2) {
        return { action: { type: "CLICK", target: unit2 }, reason: "TASK_COMPLETED_GO_NEXT" };
      }
      const anyUnit = obs.buttons.find((b) => /^Unit \d+/i.test(b));
      if (anyUnit) return { action: { type: "CLICK", target: anyUnit }, reason: "TASK_COMPLETED_GO_NEXT" };
      if (obs.buttons.includes("Resume")) {
        const lc = lessonCodeForActiveTarget(ctx);
        return {
          action: lc ? { type: "CLICK", target: "Resume", lessonCode: lc } : { type: "CLICK", target: "Resume" },
          reason: "TASK_COMPLETED_GO_NEXT",
        };
      }
    }
    const preferred = targetSubject ? subjectToApexCourseName(targetSubject) : null;
    const course = (preferred && obs.buttons.find((b) => b.includes(preferred)))
      ?? obs.buttons.find(
        (b) =>
          b.includes("Biology Sem 2") ||
          b.includes("Algebra II Sem 2") ||
          b.includes("English 10 Sem 2") ||
          b.includes("U.S. History Sem 2")
      );
    if (course) {
      return {
        action: { type: "CLICK", target: course },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
    // Parser sometimes returns no course buttons while the dashboard is visible — still open the plan's course.
    if (preferred && hasActiveQuizTarget(ctx)) {
      return {
        action: { type: "CLICK", target: preferred },
        reason: "TASK_COMPLETED_GO_NEXT",
      };
    }
  }

  const hasResume = (obs: Observation) =>
    obs.buttons.includes("Resume") || obs.buttons.includes("RESUME");

  /** Completed unit intro / overview often shows REVIEW instead of RESUME. */
  const hasReview = (obs: Observation) => obs.buttons.includes("REVIEW");

  // Apex: course page (units + Resume) or lesson/activity strip (START/RESUME) → prefer START, then REVIEW, then RESUME, then Unit 2
  if (state === "APEX_COURSE") {
    if (obs.url?.includes("/activity/") && obs.buttons.includes("CONTINUE")) {
      return { action: { type: "CLICK", target: "CONTINUE" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.buttons.includes("START") && !hasActiveQuizTarget(ctx)) {
      return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.url?.includes("/activity/") && hasReview(obs) && !hasActiveQuizTarget(ctx)) {
      return { action: { type: "CLICK", target: "REVIEW" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (obs.url?.includes("/activity/") && hasResume(obs)) {
      const lc = lessonCodeForActiveTarget(ctx);
      if (!shouldDeferResumeOnActivityMap(obs, lc)) {
        return {
          action: lc ? { type: "CLICK", target: "RESUME", lessonCode: lc } : { type: "CLICK", target: "RESUME" },
          reason: "TASK_COMPLETED_GO_NEXT",
        };
      }
    }
    if (obs.url?.includes("/activity/") && !hasActiveQuizTarget(ctx)) {
      return { action: { type: "CLICK", target: "START" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    const tgtForUnit = hasActiveQuizTarget(ctx) ? parseLessonCode(targetQuizzes[targetQuizIndex]!) : null;
    const unitNum = tgtForUnit ? primaryUnitNumber(tgtForUnit) : null;
    const unitForTarget = unitNum != null ? findUnitOutlineButton(obs.buttons, unitNum) : undefined;
    if (unitForTarget) {
      return { action: { type: "CLICK", target: unitForTarget }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    const unit2 = obs.buttons.find((b) => b === "Unit 2" || /^Unit 2\s*:/i.test(b));
    if (unit2) {
      return { action: { type: "CLICK", target: unit2 }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (hasReview(obs) && !hasActiveQuizTarget(ctx)) {
      return { action: { type: "CLICK", target: "REVIEW" }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
    if (hasResume(obs)) {
      const lc = lessonCodeForActiveTarget(ctx);
      if (!shouldDeferResumeOnActivityMap(obs, lc)) {
        return {
          action: lc ? { type: "CLICK", target: "RESUME", lessonCode: lc } : { type: "CLICK", target: "RESUME" },
          reason: "TASK_COMPLETED_GO_NEXT",
        };
      }
    }
  }

  // Last resort on Apex activity map: jump to the plan's lesson code (strip scroll is in the driver).
  // Include LESSON_SCREEN: after NAVIGATE_LESSON the FSM often stays LESSON_SCREEN while the parser still reports MODULE_LIST;
  // decideApexActivityStrip may return nothing — do not fall through to EXIT_TO_MODULE_LIST.
  if (
    (state === "MODULE_LIST" || state === "LESSON_SCREEN") &&
    obs.url?.includes("/activity/") &&
    hasActiveQuizTarget(ctx)
  ) {
    const code = parseLessonCode(targetQuizzes[targetQuizIndex]!);
    if (code) {
      return { action: { type: "NAVIGATE_LESSON", code }, reason: "TASK_COMPLETED_GO_NEXT" };
    }
  }

  // Default safe exit
  return {
    action: { type: "EXIT_TO_MODULE_LIST" },
    reason: "TIME_BUDGET_EXCEEDED",
  };
}

/** Resolve next state after action (for logging/audit). */
export function getNextState(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "CLICK":
      if (action.target === "Next") return "LESSON_SCREEN";
      if (action.target === "PREVIOUS") return "LESSON_SCREEN";
      if (action.target === "Back") return "MODULE_LIST";
      if (action.target === "Submit") return "MODULE_LIST";
      if (action.target === "Resume" || action.target === "RESUME") return "QUIZ_SCREEN";
      // REVIEW on completed overviews stays on lesson/module navigation, not an assessment question.
      if (action.target === "REVIEW") return "MODULE_LIST";
      // CONTINUE advances lesson/video pages; real quiz intro still uses START / View Summary.
      if (action.target === "CONTINUE") return "LESSON_SCREEN";
      if (action.target === "Activities") return "MODULE_LIST";
      if (/^Lesson\s+\d+\.\d+$/i.test(action.target.trim())) return "LESSON_SCREEN";
      if (/^\d+\.\d+\.\d+$/.test(action.target.trim())) return "LESSON_SCREEN";
      if (action.target === "START" || action.target === "View Summary") return "QUIZ_SCREEN";
      if (state === "APEX_LMS_DASHBOARD") return "APEX_COURSE";
      if (state === "APEX_COURSE" && /^Unit \d+/i.test(action.target)) return "MODULE_LIST";
      if (state === "EDMENTUM_READY_TO_LAUNCH" && /Sem\s*2|Algebra|Biology|English|History/i.test(action.target)) return "APEX_LMS_DASHBOARD";
      return state;
    case "NAVIGATE_LESSON":
      return "LESSON_SCREEN";
    case "EXIT_TO_MODULE_LIST":
    case "EXIT_TO_PARENT":
      return "MODULE_LIST";
    case "REFRESH":
      return "MAIN_MENU";
    case "SCROLL_DOWN":
    case "SCROLL_TOP":
      return state;
    case "CLICK_SUBJECT":
      return state === "EDMENTUM_COURSE_GRID" ? "EDMENTUM_READY_TO_LAUNCH" : "EDMENTUM_COURSE_GRID";
    case "LAUNCH":
      return "APEX_LMS_DASHBOARD";
    case "DISMISS_POPUP":
      return state;
    case "SUBMIT_ANSWER":
      return "QUIZ_SCREEN";
    case "NAVIGATE":
      return state;
    default:
      return state;
  }
}
