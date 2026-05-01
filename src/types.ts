/**
 * State-machine UI agent — type definitions.
 * States, observations, actions, and transition rules.
 */

/** Parsed row from Apex results checklist (Question N … M points). */
export type QuizSummaryQuestionRow = {
  questionNumber: number;
  outcome: "correct" | "incorrect";
  points: number;
};

/** Lesson/section code as tuple, e.g. "2.2.3" → [2, 2, 3] */
export type LessonCode = number[];

/** Top-level FSM states (full flow: apex menu → Edmentum grid → LAUNCH → Apex course → quiz) */
export type AppState =
  | "EDMENTUM_DASHBOARD"   // FEDashboard, Virtual Learning module
  | "EDMENTUM_COURSE_GRID" // Grid of course cards (scroll, click subject, LAUNCH)
  | "EDMENTUM_READY_TO_LAUNCH" // Course card selected, LAUNCH visible
  | "APEX_COURSE"          // course.apexlearning.com — Resume, unit cards, options under course name
  | "APEX_LMS_DASHBOARD"   // alhs.apexvs.com My Dashboard — course names as links
  | "MAIN_MENU"
  | "MODULE_LIST"
  | "LESSON_SCREEN"
  | "QUIZ_SCREEN"
  | "SAFE_EXIT"; // fallback when deadline exceeded or error

/** What the agent observes on screen (parsed from UI) */
export interface Observation {
  state: AppState;
  /** Parsed lesson code if on lesson/quiz, e.g. [2, 2, 3] */
  lessonCode?: LessonCode;
  /** Visible header/label text, e.g. "2.2.3" */
  headerText?: string;
  /** Buttons currently visible and clickable */
  buttons: string[];
  /** Quiz: question text (if on QUIZ_SCREEN) */
  questionText?: string;
  /** Quiz: reading passage / long context when split from the stem (Apex reading comp). */
  quizPassageText?: string;
  /** Quiz: choices (if on QUIZ_SCREEN) */
  choices?: string[];
  /** True when the item is "select all that apply" / multiple checkboxes (not single-choice radio). */
  quizMultiSelect?: boolean;
  /** UI ready: element exists, clickable, no spinner */
  ready: boolean;
  /** Network idle (if available from driver) */
  networkIdle?: boolean;
  /** Edmentum: course card titles (e.g. "ALVS PT Biology Sem 2") */
  courseCards?: string[];
  /** Current URL or host (for flow detection) */
  url?: string;
  /** Edmentum: post-login modal/dialog is visible; agent should dismiss it first */
  popupVisible?: boolean;
  /** Label of the button/link to close the popup (e.g. "Close", "X") */
  popupCloseLabel?: string;
  /** Quiz: screen shows post-submission feedback (Incorrect/Correct, "The correct answer is"). Do not solve — click Next/Continue instead. */
  feedbackVisible?: boolean;
  /** When feedback is visible: whether the learner's attempt was correct or incorrect (Apex body text). */
  feedbackOutcome?: "correct" | "incorrect";
  /** When quiz feedback is visible: excerpt of page text to extract hints ("The correct answer is …"). */
  quizFeedbackTextSample?: string;
  /**
   * Quiz: final summary / results step is available (e.g. "View Summary" CTA, or results copy without live MCQ).
   * Used by unattended runs to advance the plan only after the assessment is actually finished.
   */
  quizSummaryReached?: boolean;
  /** When the parser sees a final score on the quiz summary/results screen (x/y, %). */
  quizScoreSnapshot?: { correct: number; total: number; pct: number };
  /**
   * Itemized results on the completed assessment screen (Question N … points / icons).
   * Used for metrics backfill when per-question feedback was missed, and for reconciliation.
   */
  quizSummaryPerQuestion?: QuizSummaryQuestionRow[];
  /** Apex activity: e.g. "1 of 19" paged study — used to distinguish footer PREVIOUS (page) vs map Back. */
  pageProgress?: { current: number; total: number };
  /** Apex lesson strip: sample of combined frame text for "3.2.5 … Completed" heuristics. */
  stripTextSample?: string;
  /**
   * Apex: the horizontal unit nav has **INTRODUCTION** selected (unit overview). Full-page text still
   * contains many `x.y.z` codes — do not treat parsed `lessonCode` as the current activity until a lesson tab is opened.
   */
  apexUnitIntroActive?: boolean;
}

/** One quiz to do: subject + lesson code (e.g. "2.2.3") */
export interface QuizTarget {
  subject: string;
  code: string;
  isTest?: boolean; // e.g. Biology TEST 2.3.2
}

/** Playlist of quizzes from the user's list (handwritten list). */
export interface QuizPlaylist {
  targets: QuizTarget[];
}

/** Actions the agent can perform */
export type Action =
  /** `lessonCode` (e.g. [3,2,5]) scopes RESUME to the activity tile that shows that code — avoids clicking the wrong RESUME. */
  | { type: "CLICK"; target: string; lessonCode?: number[] }
  | { type: "NAVIGATE_LESSON"; code: LessonCode }
  | { type: "EXIT_TO_MODULE_LIST" }
  | { type: "EXIT_TO_PARENT" }
  /** Single-choice: set choiceIndex. Multi-select: set choiceIndices (0-based); omit choiceIndex. */
  | { type: "SUBMIT_ANSWER"; choiceIndex?: number; choiceIndices?: number[]; choiceText?: string }
  /** Go to URL (e.g. return to Edmentum dashboard between run segments). */
  | { type: "NAVIGATE"; url: string }
  | { type: "REFRESH" }
  | { type: "SCROLL_DOWN" }
  | { type: "SCROLL_TOP" }
  | { type: "CLICK_SUBJECT"; subject: string }  // course card on Edmentum grid (e.g. "ALVS PT Biology Sem 2")
  | { type: "LAUNCH" }                          // LAUNCH button on selected course card
  | { type: "DISMISS_POPUP" }                   // close post-login modal (Edmentum)
  | { type: "NOOP" };

/** Result of executing an action */
export type ActionResult =
  | { ok: true; nextState: AppState }
  | { ok: false; error: string; recoverable: boolean };

/** Decision policy: when to continue vs exit */
export type DecisionReason =
  | "TASK_COMPLETED_GO_NEXT"
  | "ERROR_BLOCKED_RETRY"
  | "TIME_BUDGET_EXCEEDED"
  | "END_OF_MODULE"
  | "NEXT_LESSON_DOES_NOT_EXIST"
  | "ELEMENT_NOT_FOUND"
  | "DEADLINE_EXCEEDED";

export interface StepLog {
  timestamp: string;
  state: AppState;
  observation: Partial<Observation>;
  action: Action;
  result: ActionResult;
  reason?: DecisionReason;
  deadlineExceeded?: boolean;
}

/** Config for timing, limits, and anti-detection (AES-CTR DRBG, misclick, step budget) */
export interface AgentConfig {
  stepDeadlineMs: number;
  maxRetries: number;
  baseDelayMs: number;
  jitterMs: number;
  readinessPollIntervalMs: number;
  /** Max ms to wait for `isPageReady` / body before each step (Edmentum→Apex handoff can be slow). Default 15000. */
  readinessDeadlineMs?: number;
  /** Use NIST SP 800-90A AES-256-CTR DRBG for all randomness (timing, jitter, misclick, hesitation, scroll). State-of-the-art; defeats behavioral biometrics. */
  useAesDrbg?: boolean;
  /** Tiny misclick rate 0..0.02 (e.g. 0.008 = 0.8%). Intentional wrong click then correct; always corrects. */
  misclickRate?: number;
  /** When DOM gives 0 quiz choices, solve by sending screenshot to Claude (vision). Default true. */
  useVisionQuiz?: boolean;
  /** Only submit quiz answer when solver confidence >= this (e.g. 0.85). */
  minConfidenceToSubmit?: number;
  /**
   * For plan items with `isTest: true`: minimum confidence before submit (default aligns with Edmentum quiz 0.95).
   */
  strictTestMinConfidenceToSubmit?: number;
  /**
   * After max solver retries on a question (quiz or test), allow submit only if confidence >= this floor.
   * Default 0.85 — never submit below this on the “best after retries” path.
   */
  relaxedMinConfidenceAfterRetries?: number;
  /**
   * Extra vision ↔ text call before submit on tests; fewer tokens when false. Default false.
   */
  strictTestRequireTextVisionAgreement?: boolean;
  /** Retry solver up to this many times to reach minConfidenceToSubmit before submitting best. */
  maxQuizSolverRetries?: number;
  /**
   * Plan items with `isTest: true` use this retry budget instead of `maxQuizSolverRetries`.
   * Default matches quiz retries (6); raise in config only if you want more solver attempts on tests.
   */
  strictTestMaxQuizSolverRetries?: number;
  /** Cap quiz "thinking" delay (ms) for faster runs; e.g. 3500 = ~50% quicker. */
  maxQuizThinkingMs?: number;
  /** When parsed question/choices look mangled (math/Unicode), use vision (screenshot) for answer instead of text. Improves accuracy. */
  preferVisionWhenTextMangled?: boolean;
  /** Always use vision (screenshot) for quiz answer instead of parsed text. Maximizes precision. */
  useVisionAlwaysForQuiz?: boolean;
  /** Stored in quiz metrics DB/JSONL for A/B threshold runs (overrides env if set). */
  metricsThresholdProfile?: string;
  /** Inject similar past outcomes from logs/quiz-learning.jsonl into quiz prompts. Default true; disable with QUIZ_LEARNING_DISABLED=1. */
  quizLearningEnabled?: boolean;
  /** Max characters of learning context appended to solver prompts. */
  quizLearningMaxPromptChars?: number;
}

/** Step budget ~12–14.5–15 s per answer+submit; 12_500 = 12.5s default. */
export const DEFAULT_CONFIG: AgentConfig = {
  stepDeadlineMs: 12_500,
  maxRetries: 3,
  baseDelayMs: 300,
  jitterMs: 150,
  readinessPollIntervalMs: 200,
  readinessDeadlineMs: 15_000,
  useAesDrbg: true,
  misclickRate: 0.008,
  useVisionQuiz: true,
  /** Default strict; Edmentum runner may override to 0.95 + visionAlways. */
  minConfidenceToSubmit: 0.88,
  strictTestMinConfidenceToSubmit: 0.95,
  relaxedMinConfidenceAfterRetries: 0.85,
  strictTestRequireTextVisionAgreement: false,
  maxQuizSolverRetries: 6,
  strictTestMaxQuizSolverRetries: 6,
  useVisionAlwaysForQuiz: true,
  preferVisionWhenTextMangled: true,
  /** Wider default block for quiz-learning.jsonl hints in prompts. */
  quizLearningMaxPromptChars: 2400,
};
