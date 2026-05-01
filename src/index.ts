/**
 * State-machine UI agent — entry point.
 * Run with a concrete driver (Playwright/Puppeteer/OpenClaw) that implements IUIDriver.
 */

import { DEFAULT_CONFIG } from "./types.js";
import { runOneStep } from "./step-runner.js";
import { extractQuiz, solveQuizTextRouted } from "./quiz-solver.js";
import { buildLearningContextForPrompt } from "./quiz-learning-memory.js";
import { initAesDrbg, setPrngSeed, setUseAesDrbg } from "./prng.js";
import type { IUIDriver } from "./driver.js";
import type { Observation, AgentConfig } from "./types.js";

export * from "./types.js";
export * from "./state-machine.js";
export * from "./driver.js";
export * from "./timing.js";
export * from "./logger.js";
export * from "./step-runner.js";
export * from "./quiz-solver.js";
export * from "./config.js";
export * from "./prng.js";
export * from "./screen-reader-claude.js";
export * from "./quiz-playlist.js";
export { PlaywrightDriver } from "./playwright-driver.js";
export { getApexObservation, detectApexScreen } from "./parsers/apex-learning.js";
export { getEdmentumObservation, detectEdmentumScreen } from "./parsers/edmentum.js";
export {
  parseQuizScoreFromBody,
  setQuizMetricsContext,
  recordQuizAnswerSubmit,
  consumeQuizFeedbackObservation,
  recordQuizScoreSnapshot,
  finalizeQuizSessionForPlan,
  resetQuizMetricsSession,
  getCalibrationBuckets,
  getCalibrationBucketsByProfile,
  getQuizSessionSummaries,
  parseQuizSummaryQuestionOutcomesFromBody,
  applyQuizSummaryBackfill,
  auditLastSessionOutcomeCompleteness,
  countNullOutcomesForSession,
} from "./quiz-metrics.js";
export type { QuizMetricsReconciliation, PriorSessionOutcomeAudit } from "./quiz-metrics.js";
export {
  buildLearningContextForPrompt,
  rememberQuizSubmitForLearning,
  commitQuizLearningFromFeedback,
  clearQuizLearningPending,
  extractCorrectAnswerHint,
} from "./quiz-learning-memory.js";
export type { QuizLearningRecord } from "./quiz-learning-memory.js";
export { ensureOllamaReadyForQuizLearning, tagsListIncludesEmbeddingModel } from "./quiz-learning-ollama.js";

/** Initialize randomness layer from config (NIST AES-CTR DRBG). Call once before running steps. All timing, jitter, misclick, hesitation, scroll use this for behavioral-biometric resistance. */
export function initRandomLayer(config: Partial<AgentConfig> & { seed?: number }): void {
  const c = { ...DEFAULT_CONFIG, ...config };
  if (c.useAesDrbg) {
    setUseAesDrbg(true);
    if (config.seed != null) setPrngSeed(config.seed);
    else initAesDrbg();
  } else {
    setUseAesDrbg(false);
    if (config.seed != null) setPrngSeed(config.seed);
  }
}

/** Run a single agent step (for integration with your driver). */
export async function step(
  currentState: string,
  driver: IUIDriver,
  options: {
    config?: Partial<typeof DEFAULT_CONFIG>;
    isTaskCompleted?: (obs: Observation) => boolean;
    doesNextLessonExist?: (code: number[]) => boolean;
    targetSubject?: string;
    targetQuizzes?: string[];
    targetQuizIndex?: number;
    quizExitIncomplete?: boolean;
    /** Plan `skipCodes`: never open these lesson triples — exit to map if detected. */
    forbiddenLessonCodes?: string[];
    /** Current plan quiz code for `logs/quiz-metrics.*` session tagging. */
    quizMetricsQuizCode?: string;
    /** Plan `isTest` tile — enables strict test solver policy for this step. */
    strictTestActivity?: boolean;
    /** Prior-session outcome gap from `auditLastSessionOutcomeCompleteness` (recovery). */
    priorRunMetricsGap?: import("./quiz-metrics.js").PriorSessionOutcomeAudit | null;
  } = {}
) {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  return runOneStep(currentState, {
    config,
    driver,
    isTaskCompleted: options.isTaskCompleted ?? (() => false),
    doesNextLessonExist: options.doesNextLessonExist ?? (() => true),
    targetSubject: options.targetSubject,
    targetQuizzes: options.targetQuizzes,
    targetQuizIndex: options.targetQuizIndex ?? 0,
    quizExitIncomplete: options.quizExitIncomplete,
    forbiddenLessonCodes: options.forbiddenLessonCodes,
    quizMetricsQuizCode: options.quizMetricsQuizCode,
    strictTestActivity: options.strictTestActivity,
    priorRunMetricsGap: options.priorRunMetricsGap,
  });
}

/** If on quiz screen, solve and return action + confidence. */
export async function handleQuizScreen(
  obs: Observation,
  options: {
    config?: Partial<typeof DEFAULT_CONFIG>;
    targetSubject?: string;
    quizMetricsQuizCode?: string;
  } = {}
): Promise<
  | { action: "SUBMIT"; choiceIndex: number; confidence: number; flagForReview: boolean }
  | { action: "SKIP" | "FLAG"; reason: string }
> {
  const quiz = extractQuiz(obs);
  if (!quiz) return { action: "SKIP", reason: "Not a quiz screen" };

  const learning =
    options.config?.quizLearningEnabled === false
      ? ""
      : await buildLearningContextForPrompt(quiz.question, quiz.choices, {
          subject: options.targetSubject,
          quizCode: options.quizMetricsQuizCode,
          maxChars: options.config?.quizLearningMaxPromptChars,
        });
  const result = await solveQuizTextRouted({
    question: quiz.question,
    passage: quiz.passage,
    choices: quiz.choices,
    multiSelect: quiz.multiSelect,
    learningBlock: learning,
    targetSubject: options.targetSubject,
  });
  if (result.confidence < 0.5 || result.flagForReview) {
    return {
      action: "FLAG",
      reason: result.reasoning ?? "Low confidence",
    };
  }
  if (result.choiceIndices && result.choiceIndices.length > 0) {
    return {
      action: "SUBMIT",
      choiceIndex: result.choiceIndices[0]!,
      confidence: result.confidence,
      flagForReview: result.flagForReview,
    };
  }
  return {
    action: "SUBMIT",
    choiceIndex: result.choiceIndex,
    confidence: result.confidence,
    flagForReview: result.flagForReview,
  };
}
