/**
 * Step runner: per-step deadline, readiness wait, retries, logging, screenshot on failure.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AppState, Observation, Action, ActionResult, StepLog } from "./types.js";
import {
  consumeQuizFeedbackObservation,
  recordQuizAnswerSubmit,
  recordQuizScoreSnapshot,
  setQuizMetricsContext,
  applyQuizSummaryBackfill,
  type PriorSessionOutcomeAudit,
} from "./quiz-metrics.js";
import { decide, getNextState } from "./state-machine.js";
import { waitUntilReady, remainingMs, delayWithJitter } from "./timing.js";
import { quizAnswerDelayMs } from "./prng.js";
import { logStep } from "./logger.js";
import type { IUIDriver } from "./driver.js";
import {
  extractQuiz,
  inferQuizMultiSelect,
  solveQuizTextRouted,
  solveQuizWithVision,
  isAnthropicAccessError,
  isIncompleteQuizVisionResponse,
  type QuizSolverResult,
  type QuizTextSolverRoute,
} from "./quiz-solver.js";
import { mergeAgentConfigForSubject, getSubjectPreset, normalizeSubjectKey } from "./subject-profiles.js";
import { inferQuizQuestionCategory } from "./quiz-question-category.js";
import { mapShortSubjectToLearningGraphFull, recordLearningGraphEvent } from "./learning-graph-bridge.js";
import {
  buildLearningContextForPrompt,
  rememberQuizSubmitForLearning,
  commitQuizLearningFromFeedback,
} from "./quiz-learning-memory.js";

/** Failure PNGs land here so the repo root stays readable (same filenames, same driver behavior). */
const FAIL_SCREENSHOT_DIR = join(process.cwd(), "artifacts", "screenshot-fails");

/** Dedupe pattern events while the same feedback screen is observed across steps. */
let lastQuizFeedbackSignature: string | null = null;

/** After INCOMPLETE_VIEWPORT on a screen, do not call vision again until observation changes (saves API credits). */
let quizVisionIncompleteScreenKey: string | null = null;

function quizScreenDedupeKey(obs: Observation, quiz: { question: string; choices: string[] }): string {
  return `${obs.url ?? ""}|${quiz.choices.join("¦")}|${quiz.question.slice(0, 120)}`;
}

/** Same selected answer(s) for single- or multi-select solver results. */
function solverChoicesAgree(
  multiSelect: boolean,
  a: { choiceIndex?: number; choiceIndices?: number[] },
  b: { choiceIndex?: number; choiceIndices?: number[] }
): boolean {
  if (multiSelect) {
    const sa = [...(a.choiceIndices ?? [])].sort((x, y) => x - y);
    const sb = [...(b.choiceIndices ?? [])].sort((x, y) => x - y);
    if (sa.length === 0 || sb.length === 0) return false;
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  }
  const ia = a.choiceIndex;
  const ib = b.choiceIndex;
  return ia != null && ib != null && ia === ib && ia >= 0;
}

/** True if question or choices look mangled (math/Unicode from DOM) so vision may be more accurate. */
function textLooksMangled(question: string, choices: string[]): boolean {
  const combined = (question + " " + choices.join(" ")).normalize("NFKC");
  if (combined.length < 20) return true;
  if (/[≥≤√]\s+[≥≤√]|\s{3,}[A-D][.)]/.test(combined)) return true;
  if (/[\u200B-\u200D\u2060\uFEFF]/.test(combined)) return true;
  const mathLike = /[√²\u2212\u00D7\u00F7\u{1D465}]/u;
  const looksLikeBrokenMath = (s: string) =>
    (mathLike.test(s) && /\d\s+\d|\s{2,}[x\u00D7]/.test(s)) || /^[x\u00D7]\s*\d\s*\d/.test(s);
  if (looksLikeBrokenMath(question)) return true;
  if (choices.some(looksLikeBrokenMath)) return true;
  return false;
}

export interface StepRunnerOptions {
  config: AgentConfig;
  driver: IUIDriver;
  /** Callback: task completed for current lesson? */
  isTaskCompleted: (obs: Observation) => boolean;
  /** Callback: does next lesson exist in UI? */
  doesNextLessonExist: (code: number[]) => boolean;
  /** Target subject (e.g. Algebra, Biology) for course selection */
  targetSubject?: string;
  /** Target quiz codes (e.g. ["2.2.3", "2.2.4"]) */
  targetQuizzes?: string[];
  /** Index of current target quiz */
  targetQuizIndex?: number;
  /** Left quiz without confirmed completion — decide() will prefer scoped RESUME. */
  quizExitIncomplete?: boolean;
  /** Run-plan skipCodes — if parser sees this lesson, exit to map (never complete the activity). */
  forbiddenLessonCodes?: string[];
  /** Current plan quiz code (e.g. "2.2.3") for metrics session tagging. */
  quizMetricsQuizCode?: string;
  /** Plan item `isTest: true` — separate min-confidence target; same relaxed floor after retries as quizzes. */
  strictTestActivity?: boolean;
  /** Prior DB audit: incomplete outcomes — drive RESUME/summary and optional summary backfill for that session id. */
  priorRunMetricsGap?: PriorSessionOutcomeAudit | null;
}

function recordQuizSubmitMetrics(
  action: Action,
  multiSelect: boolean,
  visionUsed: boolean,
  minConf: number,
  solver: { confidence: number; choiceIndex?: number; choiceIndices?: number[]; reasoning?: string },
  learningSnap?: {
    subject?: string;
    quizCode?: string;
    question: string;
    choices: string[];
  },
  submitTag?: { activityKind: "quiz" | "test"; textVisionAgreed?: boolean | null },
  routeMeta?: { solverRoute?: QuizTextSolverRoute | "vision"; questionCategory?: string | null }
): void {
  if (action.type !== "SUBMIT_ANSWER") return;
  recordQuizAnswerSubmit({
    confidence: solver.confidence,
    choiceIndex: solver.choiceIndex,
    choiceIndices: solver.choiceIndices,
    multiSelect,
    reasoning: solver.reasoning,
    visionUsed,
    minConfidenceThreshold: minConf,
    incompleteViewport: false,
    activityKind: submitTag?.activityKind,
    textVisionAgreed: submitTag?.textVisionAgreed ?? null,
    solverRoute: routeMeta?.solverRoute ?? null,
    questionCategory: routeMeta?.questionCategory ?? null,
  });
  if (learningSnap) {
    rememberQuizSubmitForLearning({
      question: learningSnap.question,
      choices: learningSnap.choices,
      choiceIndex: action.choiceIndex,
      choiceIndices: action.choiceIndices,
      multiSelect,
      reasoning: solver.reasoning,
      subject: learningSnap.subject,
      quizCode: learningSnap.quizCode,
    });
  }
}

export async function runOneStep(
  currentState: string,
  options: StepRunnerOptions
): Promise<{
  nextState: string;
  ok: boolean;
  deadlineExceeded: boolean;
  action: Action;
  observation: Observation;
}> {
  const {
    config,
    driver,
    isTaskCompleted,
    doesNextLessonExist,
    targetSubject,
    targetQuizzes,
    targetQuizIndex = 0,
    quizExitIncomplete,
    forbiddenLessonCodes,
    quizMetricsQuizCode,
    strictTestActivity = false,
    priorRunMetricsGap = null,
  } = options;
  const strictTest = strictTestActivity === true;
  const quizCfg = mergeAgentConfigForSubject(config, targetSubject);
  const effectiveMinConfidence = strictTest
    ? (config.strictTestMinConfidenceToSubmit ?? 0.95)
    : (quizCfg.minConfidenceToSubmit ?? 0.85);
  const stepDeadlineAt = Date.now() + config.stepDeadlineMs;

  const remaining = remainingMs(stepDeadlineAt);
  const readinessCap = config.readinessDeadlineMs ?? 15_000;
  const readinessDeadlineMs = Math.min(remaining, readinessCap);
  const readyCheck =
    typeof (driver as { isPageReady?: () => Promise<boolean> }).isPageReady === "function"
      ? () => (driver as { isPageReady: () => Promise<boolean> }).isPageReady()
      : async () => (await driver.getObservation()).ready;
  const { ready } = await waitUntilReady(readyCheck, readinessDeadlineMs, config.readinessPollIntervalMs);

  if (!ready) {
    logStep({
      timestamp: new Date().toISOString(),
      state: currentState as any,
      observation: { ready: false },
      action: { type: "NOOP" },
      result: { ok: false, error: "Readiness timeout", recoverable: true },
      reason: "DEADLINE_EXCEEDED",
      deadlineExceeded: remainingMs(stepDeadlineAt) <= 0,
    });
    return {
      nextState: "SAFE_EXIT",
      ok: false,
      deadlineExceeded: remainingMs(stepDeadlineAt) <= 0,
      action: { type: "NOOP" },
      observation: { state: "MAIN_MENU" as AppState, buttons: [], ready: false },
    };
  }

  const obs = await driver.getObservation();
  setQuizMetricsContext({
    subject: targetSubject,
    quizCode: quizMetricsQuizCode,
    minConfidenceToSubmit: effectiveMinConfidence,
    activityKind: strictTest ? "test" : "quiz",
    thresholdProfile: config.metricsThresholdProfile,
  });
  consumeQuizFeedbackObservation(obs);
  await commitQuizLearningFromFeedback(obs);
  if (obs.quizScoreSnapshot) recordQuizScoreSnapshot(obs.quizScoreSnapshot);
  applyQuizSummaryBackfill(obs, {
    reconcilePriorSessionId:
      priorRunMetricsGap && priorRunMetricsGap.rowsMissingOutcome > 0 ? priorRunMetricsGap.sessionId : undefined,
  });
  if (!obs.feedbackVisible) lastQuizFeedbackSignature = null;
  if (obs.feedbackVisible || obs.quizSummaryReached) quizVisionIncompleteScreenKey = null;

  const taskCompleted = isTaskCompleted(obs);
  const code = obs.lessonCode ?? [];
  const nextCode = code.length > 0 ? [code[0], code[1] ?? 0, (code[2] ?? 0) + 1] : [];
  const nextLessonExists = doesNextLessonExist(nextCode);

  const deadlineExceeded = remainingMs(stepDeadlineAt) <= 0;
  const u = obs.url ?? "";
  const onApexHost = u.includes("apexvs.com") || u.includes("course.apexlearning.com");
  let stateForDecision = currentState as AppState;
  // Parser beats stale FSM: e.g. still MODULE_LIST after navigation while URL is My Dashboard (course list has no 3.2.5 to click).
  if (obs.state === "APEX_LMS_DASHBOARD") {
    stateForDecision = "APEX_LMS_DASHBOARD";
  } else if (obs.state === "APEX_COURSE") {
    stateForDecision = "APEX_COURSE";
  } else if (obs.state === "QUIZ_SCREEN") {
    stateForDecision = "QUIZ_SCREEN";
  } else if ((currentState as string) === "QUIZ_SCREEN") {
    // FSM says QUIZ but parser disagrees (e.g. lesson strip) — trust parser so we navigate / solve correctly.
    stateForDecision = obs.state as AppState;
  } else if (
    (currentState as string) === "LESSON_SCREEN" &&
    obs.state === "MODULE_LIST" &&
    onApexHost &&
    u.includes("/activity/")
  ) {
    // FSM says lesson after NAVIGATE_LESSON; parser often still MODULE_LIST on the same activity URL — avoid EXIT_TO_MODULE_LIST loop.
    stateForDecision = "MODULE_LIST";
  } else if (
    onApexHost &&
    (currentState === "EDMENTUM_READY_TO_LAUNCH" || currentState === "EDMENTUM_COURSE_GRID") &&
    obs.state &&
    obs.state !== "EDMENTUM_DASHBOARD" &&
    obs.state !== "EDMENTUM_COURSE_GRID" &&
    obs.state !== "EDMENTUM_READY_TO_LAUNCH"
  ) {
    stateForDecision = obs.state;
  }
  const onEdmentum =
    stateForDecision === "EDMENTUM_COURSE_GRID" ||
    stateForDecision === "EDMENTUM_DASHBOARD" ||
    stateForDecision === "EDMENTUM_READY_TO_LAUNCH";
  const onApex =
    stateForDecision === "APEX_LMS_DASHBOARD" ||
    stateForDecision === "APEX_COURSE" ||
    stateForDecision === "QUIZ_SCREEN";

  if (
    obs.feedbackVisible &&
    stateForDecision === "QUIZ_SCREEN" &&
    obs.state === "QUIZ_SCREEN"
  ) {
    const lgSubject = mapShortSubjectToLearningGraphFull(targetSubject);
    if (lgSubject) {
      const sig = `${obs.questionText ?? ""}|${obs.headerText ?? ""}|${obs.url ?? ""}|${obs.feedbackOutcome ?? ""}`;
      if (sig !== lastQuizFeedbackSignature) {
        lastQuizFeedbackSignature = sig;
        if (obs.feedbackOutcome === "incorrect") {
          recordLearningGraphEvent({
            type: "feedback_incorrect",
            subject: lgSubject,
            meta: { outcome: "incorrect" },
          });
        } else if (obs.feedbackOutcome === "correct") {
          recordLearningGraphEvent({
            type: "feedback_correct",
            subject: lgSubject,
            meta: { outcome: "correct" },
          });
        } else {
          recordLearningGraphEvent({ type: "pattern", subject: lgSubject });
        }
      }
    }
  }

  let { action, reason } = decide(
    stateForDecision,
    obs,
    taskCompleted,
    nextLessonExists,
    onEdmentum || onApex ? false : deadlineExceeded,
    {
      targetSubject,
      targetQuizzes,
      targetQuizIndex,
      quizExitIncomplete,
      forbiddenLessonCodes,
      priorRunMetricsGap,
    }
  );

  // When on quiz question (no START button), use Claude to solve and submit answer.
  // Skip solving if screen shows feedback (Incorrect/Correct) — click Next/Continue instead.
  // Require parser to agree we're on QUIZ_SCREEN (avoid loop when FSM is stale on lesson strip / REVIEW).
  // Do not skip when obs.buttons includes CONTINUE — the parser often adds it from incidental "continue" in body text;
  // decide() now returns NOOP when Submit is present so we still run the solver.
  if (
    stateForDecision === "QUIZ_SCREEN" &&
    obs.state === "QUIZ_SCREEN" &&
    action.type === "NOOP" &&
    !obs.feedbackVisible &&
    !obs.quizSummaryReached &&
    !obs.buttons.includes("START")
  ) {
    const learnQ = async (q: string, ch: string[]) =>
      config.quizLearningEnabled === false
        ? ""
        : buildLearningContextForPrompt(q, ch, {
            subject: targetSubject,
            quizCode: quizMetricsQuizCode,
            maxChars: config.quizLearningMaxPromptChars,
          });
    const learnSnap = (q: string, ch: string[]) =>
      config.quizLearningEnabled === false
        ? undefined
        : { subject: targetSubject, quizCode: quizMetricsQuizCode, question: q, choices: ch };

    const submitKind = strictTest ? ("test" as const) : ("quiz" as const);
    const tag = (textVisionAgreed?: boolean | null) =>
      ({ activityKind: submitKind, textVisionAgreed } as const);
    const visionSubjectExtra = getSubjectPreset(normalizeSubjectKey(targetSubject)).visionNudge;

    const quiz = extractQuiz(obs);
    if (!quiz) {
      console.log("[Quiz] No quiz extracted — questionText:", obs.questionText ? "present" : "missing", "choices:", (obs.choices?.length ?? 0));
      // When DOM gives 0 choices: optionally use vision (screenshot → Claude) to pick the answer from the screen.
      if (obs.questionText && (obs.choices?.length ?? 0) === 0) {
        const minConf = effectiveMinConfidence;
        const visionHint = inferQuizMultiSelect(obs.questionText ?? "");
        let choiceIndex = 0;
        let metricsSolver: { confidence: number; choiceIndex?: number; choiceIndices?: number[]; reasoning?: string } = {
          confidence: 0,
          choiceIndex: 0,
          reasoning: "blind_first_choice",
        };
        let visionUsedFlag = false;
        const learning0 = await learnQ(obs.questionText ?? "", []);
        const qCat0 = inferQuizQuestionCategory({
          subject: targetSubject,
          passage: obs.quizPassageText,
          question: obs.questionText ?? "",
          multiSelect: visionHint,
        });
        if (config.useVisionQuiz !== false && typeof driver.screenshot === "function") {
          const visionResult = await solveQuizWithVision(driver, visionHint, learning0, visionSubjectExtra);
          if (isIncompleteQuizVisionResponse(visionResult.reasoning)) {
            console.log("[Quiz] 0 choices — vision reported incomplete viewport; not submitting (no credits for blind guess).");
          } else if (visionResult.choiceIndices && visionResult.choiceIndices.length > 0) {
            action = { type: "SUBMIT_ANSWER", choiceIndices: visionResult.choiceIndices };
            console.log("[Quiz] 0 choices — vision multi:", JSON.stringify(visionResult.choiceIndices));
            metricsSolver = visionResult;
            visionUsedFlag = true;
          } else {
            choiceIndex = visionResult.choiceIndex;
            action = { type: "SUBMIT_ANSWER", choiceIndex };
            console.log("[Quiz] 0 choices parsed — used vision (screenshot); choiceIndex=" + choiceIndex + " (=" + "ABCD"[choiceIndex] + ")");
            metricsSolver = visionResult;
            visionUsedFlag = true;
          }
        } else {
          console.log("[Quiz] 0 choices parsed — will click first answer (A) by position; driver will find A/B/C/D in DOM");
          action = { type: "SUBMIT_ANSWER", choiceIndex };
        }
        if (action.type === "SUBMIT_ANSWER") {
          const flagged = "flagForReview" in metricsSolver && (metricsSolver as { flagForReview?: boolean }).flagForReview;
          if (
            strictTest &&
            (!visionUsedFlag || metricsSolver.confidence < minConf || flagged === true)
          ) {
            console.warn(
              "[Quiz] TEST strictness: 0 parsed choices — require vision + confidence ≥ " + minConf + " — not submitting."
            );
            action = { type: "NOOP" };
          } else {
            recordQuizSubmitMetrics(action, visionHint, visionUsedFlag, minConf, metricsSolver, learnSnap(obs.questionText ?? "", []), tag(), {
              solverRoute: "vision",
              questionCategory: qCat0,
            });
            const delay0 = quizAnswerDelayMs();
            await new Promise((r) => setTimeout(r, config.maxQuizThinkingMs != null ? Math.min(delay0, config.maxQuizThinkingMs) : delay0));
          }
        }
      }
    } else if (quiz.choices.length === 0) {
      console.log("[Quiz] Quiz has no choices — using vision or first option");
      if (obs.questionText) {
        const minConf = effectiveMinConfidence;
        const visionHint = inferQuizMultiSelect(obs.questionText ?? "");
        let choiceIndex = 0;
        let metricsSolver: { confidence: number; choiceIndex?: number; choiceIndices?: number[]; reasoning?: string } = {
          confidence: 0,
          choiceIndex: 0,
          reasoning: "blind_first_choice",
        };
        let visionUsedFlag = false;
        const learning0b = await learnQ(obs.questionText ?? "", obs.choices ?? []);
        const qCat0b = inferQuizQuestionCategory({
          subject: targetSubject,
          passage: obs.quizPassageText,
          question: obs.questionText ?? "",
          multiSelect: visionHint,
        });
        if (config.useVisionQuiz !== false && typeof driver.screenshot === "function") {
          const visionResult = await solveQuizWithVision(driver, visionHint, learning0b, visionSubjectExtra);
          if (isIncompleteQuizVisionResponse(visionResult.reasoning)) {
            console.log("[Quiz] Vision reported incomplete viewport; not submitting (no credits for blind guess).");
          } else if (visionResult.choiceIndices && visionResult.choiceIndices.length > 0) {
            action = { type: "SUBMIT_ANSWER", choiceIndices: visionResult.choiceIndices };
            console.log("[Quiz] Used vision multi:", JSON.stringify(visionResult.choiceIndices));
            metricsSolver = visionResult;
            visionUsedFlag = true;
          } else {
            choiceIndex = visionResult.choiceIndex;
            action = { type: "SUBMIT_ANSWER", choiceIndex };
            console.log("[Quiz] Used vision; choiceIndex=" + choiceIndex + " (=" + "ABCD"[choiceIndex] + ")");
            metricsSolver = visionResult;
            visionUsedFlag = true;
          }
        } else {
          console.log("[Quiz] Will click first answer (A) by position; driver will find A/B/C/D in DOM");
          action = { type: "SUBMIT_ANSWER", choiceIndex };
        }
        if (action.type === "SUBMIT_ANSWER") {
          const flagged = "flagForReview" in metricsSolver && (metricsSolver as { flagForReview?: boolean }).flagForReview;
          if (
            strictTest &&
            (!visionUsedFlag || metricsSolver.confidence < minConf || flagged === true)
          ) {
            console.warn(
              "[Quiz] TEST strictness: empty choice list — require vision + confidence ≥ " + minConf + " — not submitting."
            );
            action = { type: "NOOP" };
          } else {
            recordQuizSubmitMetrics(
              action,
              visionHint,
              visionUsedFlag,
              minConf,
              metricsSolver,
              learnSnap(obs.questionText ?? "", obs.choices ?? []),
              tag(),
              { solverRoute: "vision", questionCategory: qCat0b }
            );
            const delay0 = quizAnswerDelayMs();
            await new Promise((r) => setTimeout(r, config.maxQuizThinkingMs != null ? Math.min(delay0, config.maxQuizThinkingMs) : delay0));
          }
        }
      }
    } else {
      const learningBlock = await learnQ(quiz.question, quiz.choices);
      const learningSnapMain = learnSnap(quiz.question, quiz.choices);
      const questionCategory = inferQuizQuestionCategory({
        subject: targetSubject,
        passage: quiz.passage,
        question: quiz.question,
        multiSelect: quiz.multiSelect,
      });
      const runTextSolver = () =>
        solveQuizTextRouted({
          question: quiz.question,
          passage: quiz.passage,
          choices: quiz.choices,
          multiSelect: quiz.multiSelect,
          learningBlock,
          targetSubject,
        });
      const minConf = effectiveMinConfidence;
      const maxRetries = Math.max(1, quizCfg.maxQuizSolverRetries ?? 4);
      const capMs = config.maxQuizThinkingMs;
      const visionAvailable = typeof driver.screenshot === "function";
      const useVisionAlways = config.useVisionAlwaysForQuiz && visionAvailable;
      const useVisionBecauseMangled =
        !useVisionAlways &&
        config.preferVisionWhenTextMangled &&
        visionAvailable &&
        textLooksMangled(quiz.question, quiz.choices);
      if (useVisionAlways) {
        console.log("[Quiz] Using vision (screenshot) for answer for maximum precision.");
      } else if (useVisionBecauseMangled) {
        console.log("[Quiz] Parsed text looks mangled — using vision (screenshot) for answer instead of text.");
      }
      if (quiz.multiSelect) {
        console.log("[Quiz] Multi-select mode (select all that apply / checkboxes).");
      }
      console.log("[Quiz] Solving with", quiz.choices.length, "choices (minConfidence=" + minConf + ", maxRetries=" + maxRetries + ")");
      if (process.env.DEBUG_QUIZ_TEXT === "1") {
        console.log("[Quiz] Sent to Claude — question:", JSON.stringify(quiz.question.slice(0, 300)));
        quiz.choices.forEach((c, i) => console.log("[Quiz] Sent to Claude — choice " + i + ":", JSON.stringify(c.slice(0, 120))));
      }
      let result: QuizSolverResult & { solverRoute?: QuizTextSolverRoute };
      let attempt = 1;
      let visionUsedForAnswer = false;
      if (useVisionAlways || useVisionBecauseMangled) {
        const dedupeKey = quizScreenDedupeKey(obs, quiz);
        const skipDuplicateVision = quizVisionIncompleteScreenKey === dedupeKey;
        if (skipDuplicateVision) {
          console.warn(
            "[Quiz] Skipping vision — same screen as prior INCOMPLETE_VIEWPORT (no API call). Waiting for parser feedback (NEXT QUESTION + checked choice) or scroll."
          );
        }
        let visionResult: Awaited<ReturnType<typeof solveQuizWithVision>> = skipDuplicateVision
          ? {
              choiceIndex: 0,
              confidence: 0,
              reasoning: "INCOMPLETE_VIEWPORT: duplicate screen — vision skipped to save credits",
              flagForReview: true,
            }
          : await solveQuizWithVision(driver, quiz.multiSelect, learningBlock, visionSubjectExtra);
        if (!skipDuplicateVision) {
          visionUsedForAnswer = true;
        }
        if (!skipDuplicateVision) {
          if (isIncompleteQuizVisionResponse(visionResult.reasoning)) {
            quizVisionIncompleteScreenKey = dedupeKey;
          } else {
            quizVisionIncompleteScreenKey = null;
          }
        }
        let best = { ...visionResult, flagForReview: visionResult.confidence < 0.5 };
        if (isIncompleteQuizVisionResponse(visionResult.reasoning)) {
          console.warn(
            "[Quiz] Vision: still incomplete after multi-shot + full-page fallbacks inside solveQuizWithVision. Not submitting; fix layout or re-run after scrolling."
          );
          result = { ...visionResult, solverRoute: undefined };
          attempt = maxRetries;
        } else if (isAnthropicAccessError(visionResult.reasoning) && quiz.choices.length > 0) {
          console.warn(
            "[Quiz] Vision API unavailable (credits/billing/access). Retrying with text-only solver on parsed question — not re-calling vision."
          );
          visionUsedForAnswer = false;
          result = await runTextSolver();
          attempt = maxRetries;
        } else if (isAnthropicAccessError(visionResult.reasoning)) {
          console.warn(
            "[Quiz] Vision API error and no parsed choices for text fallback — add Anthropic credits or fix ANTHROPIC_API_KEY."
          );
          result = { ...best, solverRoute: undefined };
          attempt = maxRetries;
        } else {
          while (
            visionResult.confidence < minConf &&
            attempt < maxRetries &&
            !isAnthropicAccessError(visionResult.reasoning) &&
            !isIncompleteQuizVisionResponse(visionResult.reasoning)
          ) {
            console.log("[Quiz] Vision attempt " + attempt + ": confidence=" + visionResult.confidence + " < " + minConf + ", retrying...");
            attempt++;
            visionResult = await solveQuizWithVision(driver, quiz.multiSelect, learningBlock, visionSubjectExtra);
            if (visionResult.confidence > best.confidence) best = { ...visionResult, flagForReview: visionResult.confidence < 0.5 };
            if (isAnthropicAccessError(visionResult.reasoning)) break;
            if (isIncompleteQuizVisionResponse(visionResult.reasoning)) break;
          }
          if (isAnthropicAccessError(visionResult.reasoning) && quiz.choices.length > 0) {
            console.warn("[Quiz] Vision failed with API access error — falling back to text-only solver.");
            visionUsedForAnswer = false;
            result = await runTextSolver();
            attempt = maxRetries;
          } else if (isIncompleteQuizVisionResponse(visionResult.reasoning)) {
            // Latest attempt says viewport incomplete — do not fall back to `best` from an earlier retry.
            console.warn(
              "[Quiz] Vision retry ended with incomplete viewport — not using any prior guess; not submitting."
            );
            result = { ...visionResult, flagForReview: true, solverRoute: undefined };
            attempt = maxRetries;
            quizVisionIncompleteScreenKey = dedupeKey;
          } else if (visionResult.confidence >= minConf) {
            result = { ...visionResult, flagForReview: visionResult.confidence < 0.5, solverRoute: undefined };
          } else {
            result = { ...best, solverRoute: undefined };
            attempt = maxRetries;
          }
        }
      } else {
        result = await runTextSolver();
        let best = result;
        while (result.confidence < minConf && attempt < maxRetries && !isAnthropicAccessError(result.reasoning)) {
          console.log("[Quiz] Solver attempt " + attempt + ": confidence=" + result.confidence + " < " + minConf + ", retrying...");
          attempt++;
          result = await runTextSolver();
          if (result.confidence > best.confidence) best = result;
        }
        if (result.confidence < minConf) result = best;
      }
      if (
        (useVisionAlways || useVisionBecauseMangled) &&
        quiz.choices.length > 1 &&
        result &&
        !isIncompleteQuizVisionResponse(result.reasoning) &&
        !isAnthropicAccessError(result.reasoning) &&
        result.confidence < minConf
      ) {
        const txt = await runTextSolver();
        const preferText =
          txt.confidence > result.confidence &&
          (txt.confidence >= minConf || txt.confidence >= result.confidence + 0.12);
        if (preferText) {
          console.log(
            "[Quiz] Preferring text solver after vision (route=" +
              txt.solverRoute +
              ", conf=" +
              txt.confidence +
              " vs vision " +
              result.confidence +
              ")"
          );
          result = txt;
          visionUsedForAnswer = false;
        }
      }
      console.log(
        "[Quiz] Solver:",
        result.choiceIndices?.length
          ? "choiceIndices=" + JSON.stringify(result.choiceIndices)
          : "choiceIndex=" + result.choiceIndex,
        "confidence=" + result.confidence,
        "flagForReview=" + result.flagForReview
      );
      const relaxedFloor = quizCfg.relaxedMinConfidenceAfterRetries ?? 0.85;
      const allowRelaxedAfterRetries =
        attempt >= maxRetries && !result.flagForReview && result.confidence >= relaxedFloor;
      let baseWillSubmit =
        !isIncompleteQuizVisionResponse(result.reasoning) &&
        ((quiz.choices.length === 1 && stateForDecision === "QUIZ_SCREEN") ||
          (result.confidence >= minConf && !result.flagForReview) ||
          allowRelaxedAfterRetries);

      let crosscheckAgreed: boolean | null = null;
      if (
        baseWillSubmit &&
        strictTest &&
        config.strictTestRequireTextVisionAgreement === true &&
        quiz.choices.length > 1
      ) {
        if (visionUsedForAnswer) {
          const textCross = await runTextSolver();
          if (!isAnthropicAccessError(textCross.reasoning)) {
            crosscheckAgreed = solverChoicesAgree(quiz.multiSelect, result, textCross);
            if (!crosscheckAgreed) {
              console.warn("[Quiz] TEST strictness: vision vs text cross-check disagrees — not submitting.");
            }
          }
        } else if (visionAvailable && config.useVisionQuiz !== false) {
          const visionCross = await solveQuizWithVision(driver, quiz.multiSelect, learningBlock, visionSubjectExtra);
          if (!isIncompleteQuizVisionResponse(visionCross.reasoning) && !isAnthropicAccessError(visionCross.reasoning)) {
            crosscheckAgreed = solverChoicesAgree(quiz.multiSelect, result, visionCross);
            if (!crosscheckAgreed) {
              console.warn("[Quiz] TEST strictness: text vs vision cross-check disagrees — not submitting.");
            }
          }
        }
      }

      const willSubmit = baseWillSubmit && crosscheckAgreed !== false;
      if (willSubmit) {
        if (result.choiceIndices && result.choiceIndices.length > 0) {
          action = { type: "SUBMIT_ANSWER", choiceIndices: result.choiceIndices };
          console.log("[Quiz] Will click multi-select indices:", JSON.stringify(result.choiceIndices));
        } else {
          const chosenText = quiz.choices[result.choiceIndex]?.trim();
          const choiceIndex = quiz.choices.length === 1 ? 0 : result.choiceIndex;
          action = {
            type: "SUBMIT_ANSWER",
            choiceIndex,
            ...(chosenText ? { choiceText: chosenText } : {}),
          };
          if (quiz.choices.length === 1) {
            console.log("[Quiz] Only 1 choice parsed — will click first answer (A) by position; driver will find A/B/C/D in DOM");
          }
          const choiceLetter = "ABCD"[choiceIndex] ?? String(choiceIndex);
          console.log("[Quiz] Will click choice", choiceIndex, "(" + choiceLetter + ")", chosenText ? `"${chosenText.slice(0, 40)}..."` : "");
        }
        const tvTag =
          strictTest && quiz.choices.length > 1 && config.strictTestRequireTextVisionAgreement === true
            ? crosscheckAgreed === true
              ? true
              : null
            : null;
        recordQuizSubmitMetrics(action, quiz.multiSelect, visionUsedForAnswer, minConf, result, learningSnapMain, tag(tvTag), {
          solverRoute: result.solverRoute ?? (visionUsedForAnswer ? "vision" : "cloud"),
          questionCategory,
        });
        const rawThinking = quizAnswerDelayMs();
        const thinkingMs = capMs != null ? Math.min(rawThinking, capMs) : rawThinking;
        await new Promise((r) => setTimeout(r, thinkingMs));
      } else {
        const hint = isAnthropicAccessError(result.reasoning)
          ? " (Anthropic API: add credits at console.anthropic.com or use a valid API key — vision and text both need the same key.)"
          : isIncompleteQuizVisionResponse(result.reasoning)
            ? " (Incomplete viewport: not guessing — scroll or capture more of the question before re-running.)"
            : "";
        const testHint =
          baseWillSubmit && !willSubmit && crosscheckAgreed === false
            ? " (TEST strictness: vision and text solvers disagreed.)"
            : "";
        console.log(
          "[Quiz] Not submitting — confidence " + result.confidence + " vs threshold " + minConf + ". Reasoning:",
          result.reasoning?.slice(0, 80) + hint + testHint
        );
      }
    }
  }

  await delayWithJitter(config.baseDelayMs, config.jitterMs);

  let result: ActionResult;
  let retries = config.maxRetries;

  while (retries > 0) {
    result = await driver.execute(action);
    if (result.ok) break;
    if (!result.recoverable) break;
    await delayWithJitter(config.baseDelayMs, config.jitterMs);
    retries--;
  }

  const finalResult = result!;
  if (finalResult.ok && action.type === "SUBMIT_ANSWER") {
    const lgSubject = mapShortSubjectToLearningGraphFull(targetSubject);
    if (lgSubject) {
      recordLearningGraphEvent({ type: "connection", subject: lgSubject });
      recordLearningGraphEvent({ type: "question_complete", subject: lgSubject });
    }
  }
  // On recoverable failure (e.g. element not found), stay in state so we retry next step instead of exiting.
  const nextState = finalResult.ok
    ? getNextState(stateForDecision, action)
    : finalResult.recoverable
      ? currentState
      : "SAFE_EXIT";

  if (!finalResult.ok && options.driver.screenshot) {
    mkdirSync(FAIL_SCREENSHOT_DIR, { recursive: true });
    const shotPath = join(FAIL_SCREENSHOT_DIR, `screenshot-fail-${Date.now()}.png`);
    await options.driver.screenshot(shotPath).catch(() => {});
  }

  logStep({
    timestamp: new Date().toISOString(),
    state: stateForDecision,
    observation: {
      state: obs.state,
      headerText: obs.headerText,
      buttons: obs.buttons,
      courseCards: obs.courseCards,
      popupVisible: obs.popupVisible,
      url: obs.url,
    },
    action,
    result: finalResult,
    reason,
    deadlineExceeded: remainingMs(stepDeadlineAt) <= 0,
  });

  return {
    nextState,
    ok: finalResult.ok,
    deadlineExceeded: remainingMs(stepDeadlineAt) <= 0,
    action,
    observation: obs,
  };
}
