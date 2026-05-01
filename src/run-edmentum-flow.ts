/**

 * Run the agent starting from Edmentum dashboard (course grid).

 *

 * Single subject + quiz codes (typical):

 *   npx tsx src/run-edmentum-flow.ts [URL] [--subject SUBJECT] [--quizzes Q1,Q2,...]

 *   npx tsx src/run-edmentum-flow.ts --subject Algebra --quizzes 2.2.3,2.2.4

 *

 * Multi-subject sequence for one session (JSON you create per run — not committed):

 *   npx tsx src/run-edmentum-flow.ts --plan C:\\path\\session-plan.json

 *

 * Subjects: Algebra, Biology, English, History (maps to course titles in quiz-playlist).

 *

 * Optional: CHROME_USER_DATA; Edmentum login from EDMENTUM_EMAIL / EDMENTUM_PASSWORD or config.local.json (edmentumEmail, edmentumPassword)

 */



import { PlaywrightDriver } from "./playwright-driver.js";

import { step, initRandomLayer } from "./index.js";

import { DEFAULT_CONFIG } from "./types.js";

import { subjectToCourseTitle } from "./quiz-playlist.js";

import { loadRunPlan, type RunPlanSegment } from "./run-plan.js";
import { getEdmentumEmail, getEdmentumPassword } from "./config.js";
import { observationLooksLikePostQuizCompletion } from "./quiz-plan-progress.js";

import { launchLearningGraphUiIfEnabled } from "./launch-learning-graph-ui.js";
import { mapShortSubjectToLearningGraphFull, recordLearningGraphEvent } from "./learning-graph-bridge.js";
import {
  auditLastSessionOutcomeCompleteness,
  countNullOutcomesForSession,
  finalizeQuizSessionForPlan,
  resetQuizMetricsSession,
  type PriorSessionOutcomeAudit,
} from "./quiz-metrics.js";
import { ensureOllamaReadyForQuizLearning } from "./quiz-learning-ollama.js";



function parseArgs(): {
  url: string;
  subject?: string;
  quizzes: string[];
  planPath?: string;
  skipCodesFromCli: string[];
} {

  const args = process.argv.slice(2);

  let url = "https://edm.geniussis.com/FEDashboard.aspx";

  let subject: string | undefined;

  let quizzes: string[] = [];

  let planPath: string | undefined;

  let skipCodesFromCli: string[] = [];



  for (let i = 0; i < args.length; i++) {

    if (args[i] === "--subject" || args[i] === "-s") {

      subject = args[++i];

    } else if (args[i] === "--quizzes" || args[i] === "-q") {

      const val = args[++i] ?? "";

      quizzes = val.split(/[,\s]+/).filter(Boolean);

    } else if (args[i] === "--skip-codes" || args[i] === "--forbidden") {

      const val = args[++i] ?? "";

      skipCodesFromCli = val.split(/[,\s]+/).filter(Boolean);

    } else if (args[i] === "--plan" || args[i] === "-p") {

      planPath = args[++i];

    } else if (args[i]?.startsWith("--")) {

      i++;

    } else if (i === 0 && /^https?:\/\//i.test(args[i] ?? "")) {

      url = args[i];

    } else if (!subject && ["Algebra", "Biology", "English", "History"].some((s) => (args[i] ?? "").toLowerCase().startsWith(s.toLowerCase()))) {

      const s = (args[i] ?? "").toLowerCase();

      if (s.startsWith("algebra")) subject = "Algebra";

      else if (s.startsWith("biology")) subject = "Biology";

      else if (s.startsWith("english")) subject = "English";

      else if (s.startsWith("history")) subject = "History";

    } else if (/^\d+\.\d+\.\d+$/.test(args[i] ?? "")) {

      quizzes.push(args[i]!);

    }

  }

  return { url, subject, quizzes, planPath, skipCodesFromCli };

}



const parsed = parseArgs();



function printUsageAndExit(): never {

  console.error(`

Usage (one subject per run):

  npx tsx src/run-edmentum-flow.ts --subject English --quizzes 2.2.3,2.2.4



Usage (multi-subject — supply a JSON file for this session only):

  npx tsx src/run-edmentum-flow.ts --plan ".\\my-session-plan.json"



Plan file shape:

  { "segments": [ { "subject": "Biology", "skipCodes": ["2.4.4"], "items": [ { "code": "3.1.4" } ] }, ... ] }

  Optional per segment: "skip": true — omit that course. "skipCodes": [ "x.y.z" ] — never open these lessons.

  CLI without a plan: --skip-codes 3.4.3,2.4.4 — same as plan skipCodes (merged with segment skipCodes when using --plan).

`);

  process.exit(1);

}



let url = parsed.url;

let subject = parsed.subject;

let quizzes = parsed.quizzes;

let segments: RunPlanSegment[] | null = null;

let segmentIndex = 0;



if (parsed.planPath) {

  const plan = loadRunPlan(parsed.planPath);

  if (!plan) process.exit(1);

  segments = plan.segments;

  const first = segments[0];

  if (!first) {

    console.error("Run plan has no segments.");

    process.exit(1);

  }

  subject = first.subject;

  quizzes = first.items.map((it) => it.code);

  console.log("Using --plan:", parsed.planPath, "—", segments.length, "segment(s). First:", subject, quizzes.join(", "));

} else if (!subject || quizzes.length === 0) {

  printUsageAndExit();

}

function mergeSkipCodes(a: string[], b: string[]): string[] {

  return [...new Set([...a.map((s) => s.trim()).filter(Boolean), ...b.map((s) => s.trim()).filter(Boolean)])];

}

/** Current plan tile: tests use stricter solver retries; quizzes use normal budget. Index advance switches mode automatically. */
function maxQuizSolverRetriesForPlanItem(
  segments: RunPlanSegment[] | null,
  segmentIndex: number,
  targetQuizIndex: number,
  quizzesLength: number,
  quizRetries: number,
  testRetries: number
): number {
  if (!segments || targetQuizIndex < 0 || targetQuizIndex >= quizzesLength) return quizRetries;
  const item = segments[segmentIndex]?.items[targetQuizIndex];
  return item?.isTest === true ? testRetries : quizRetries;
}

/** True when current plan item is a test (`isTest`) — uses strictTestMinConfidence + metrics activityKind. */
function planItemIsStrictTest(
  segments: RunPlanSegment[] | null,
  segmentIndex: number,
  targetQuizIndex: number,
  quizzesLength: number
): boolean {
  if (!segments || targetQuizIndex < 0 || targetQuizIndex >= quizzesLength) return false;
  return segments[segmentIndex]?.items[targetQuizIndex]?.isTest === true;
}



const parsedSkip = parsed.skipCodesFromCli;

let forbiddenLessonCodes: string[] = [...parsedSkip];

if (segments?.[segmentIndex]) {

  forbiddenLessonCodes = mergeSkipCodes(parsedSkip, segments[segmentIndex]!.skipCodes ?? []);

}



async function main() {

  initRandomLayer({ ...DEFAULT_CONFIG, useAesDrbg: true });

  await ensureOllamaReadyForQuizLearning();

  let priorRunMetricsGap: PriorSessionOutcomeAudit | null = auditLastSessionOutcomeCompleteness();
  if (priorRunMetricsGap && priorRunMetricsGap.rowsMissingOutcome > 0) {
    console.warn(
      `[QuizMetrics] Prior session ${priorRunMetricsGap.sessionId} (quiz ${priorRunMetricsGap.quizCode ?? "?"}) has ` +
        `${priorRunMetricsGap.rowsMissingOutcome} submit row(s) still missing per-question outcome. ` +
        `FSM will prefer RESUME / View Summary until summary backfill can reconcile (e.g. open itemized results).`
    );
  } else {
    priorRunMetricsGap = null;
  }

  await launchLearningGraphUiIfEnabled().catch((e) => console.warn("[LearningGraph UI]", e));



  const driver = new PlaywrightDriver({

    startUrl: url,

    useClaudeScreenReader: true,

    headless: false,

    siteContext: "edmentum",

    misclickRate: DEFAULT_CONFIG.misclickRate ?? 0,

    userDataDir: process.env.CHROME_USER_DATA,

  });

  await driver.init();



  const email = getEdmentumEmail();

  const password = getEdmentumPassword();

  if (!email || !password) {

    console.warn(
      "Edmentum email/password empty (set EDMENTUM_EMAIL / EDMENTUM_PASSWORD or edmentumEmail / edmentumPassword in config.local.json) — login may need to be completed manually."
    );

  }



  await new Promise((r) => setTimeout(r, 5000));

  let didLogin = email && password ? await driver.performEdmentumLogin(email, password) : false;

  if (!didLogin) {

    await new Promise((r) => setTimeout(r, 3000));

    didLogin = email && password ? await driver.performEdmentumLogin(email, password) : false;

  }

  if (didLogin) {

    console.log("Login form filled and submitted. Waiting for redirect...");

    await new Promise((r) => setTimeout(r, 8000));

    await new Promise((r) => setTimeout(r, 2000));

    const closed = await driver.dismissEdmentumAnnouncement();

    if (closed) console.log("Announcements popup closed.");

  } else {

    const loginWaitSeconds = 15;

    console.log(`No login form detected. If you see the login screen, log in manually. Agent will start in ${loginWaitSeconds} seconds...`);

    await new Promise((r) => setTimeout(r, loginWaitSeconds * 1000));

  }



  if (subject) console.log("Target subject:", subject, subjectToCourseTitle(subject));

  if (quizzes.length > 0) console.log("Target quizzes:", quizzes.join(", "));

  if (forbiddenLessonCodes.length > 0) {

    console.log("Never open (skipCodes):", forbiddenLessonCodes.join(", "));

  }

  if (segments) {

    segments.forEach((seg, i) => {

      const kinds = seg.items.map((it) => `${it.code}${it.isTest ? " (TEST)" : ""}`).join(", ");

      console.log(`  Plan segment ${i + 1}: ${seg.subject} — ${kinds}`);

    });

  }



  console.log("Starting agent — scroll to top so course tiles are in view...");

  await driver.execute({ type: "SCROLL_TOP" }).catch(() => {});



  let state = "EDMENTUM_COURSE_GRID";

  const planTotalItems = segments ? segments.reduce((n, s) => n + s.items.length, 0) : quizzes.length;

  const maxSteps = Math.max(40, Math.max(planTotalItems, quizzes.length) * 30);

  let steps = 0;

  let targetQuizIndex = 0;

  /** True after we parse "View Summary" / results on the quiz flow (same attempt). */
  let quizCompletionArmed = false;

  /** True when we left the quiz UI without confirming completion — drive decide() to RESUME with lesson code. */
  let quizExitIncomplete = false;

  /** Latest parsed quiz summary score (x/y, %) for the current quiz attempt — passed to metrics on plan advance. */
  let lastQuizScoreSnapshot: { correct: number; total: number; pct: number } | undefined;

  while (state !== "SAFE_EXIT" && steps < maxSteps) {

    console.log(`[Step ${steps + 1}] state=${state} ...`);

    let out;

    try {

      const quizRetries = 6;

      const testRetries = DEFAULT_CONFIG.strictTestMaxQuizSolverRetries ?? 6;

      const maxQuizSolverRetries = maxQuizSolverRetriesForPlanItem(
        segments,
        segmentIndex,
        targetQuizIndex,
        quizzes.length,
        quizRetries,
        testRetries
      );

      const strictTestActivity = planItemIsStrictTest(segments, segmentIndex, targetQuizIndex, quizzes.length);

      out = await step(state, driver, {

        config: {

          ...DEFAULT_CONFIG,

          stepDeadlineMs: 60_000,

          readinessDeadlineMs: 25_000,

          baseDelayMs: 80,

          jitterMs: 30,

          minConfidenceToSubmit: 0.95,

          maxQuizSolverRetries,

          maxQuizThinkingMs: 3500,

          preferVisionWhenTextMangled: true,

          useVisionAlwaysForQuiz: true,

        },

        isTaskCompleted: () => false,

        doesNextLessonExist: () => false,

        targetSubject: subject,

        targetQuizzes: quizzes,

        targetQuizIndex,

        quizExitIncomplete,

        forbiddenLessonCodes,

        quizMetricsQuizCode: quizzes[Math.min(targetQuizIndex, quizzes.length - 1)],

        strictTestActivity,

        priorRunMetricsGap,

      });

    } catch (err) {

      const msg = err instanceof Error ? err.message : String(err);

      if (/closed|Target page|context or browser has been closed/i.test(msg)) {

        console.log("Browser or tab was closed. Exiting.");

        break;

      }

      throw err;

    }

    console.log(`[Step ${steps + 1}] action=${out.action?.type ?? "?"} nextState=${out.nextState} ok=${out.ok}`);

    if (priorRunMetricsGap && priorRunMetricsGap.rowsMissingOutcome > 0) {
      const missing = countNullOutcomesForSession(priorRunMetricsGap.sessionId);
      if (missing === 0) {
        console.log(
          `[QuizMetrics] Prior session ${priorRunMetricsGap.sessionId} reconciled — all per-question outcomes recorded.`
        );
        priorRunMetricsGap = null;
      }
    }

    const prevStateForPlan = state;

    const stepObs = out.observation;

    if (stepObs?.quizSummaryReached) {
      quizCompletionArmed = true;
    }

    if (stepObs?.quizScoreSnapshot) {
      lastQuizScoreSnapshot = stepObs.quizScoreSnapshot;
    }

    // Do not auto-advance the plan from strip text alone — Wrap-Up rows mix completed tiles (3.4.1) with
    // in-progress tests (3.4.2) and %-gauges, which caused false "already completed" skips. Advance only via
    // quizSummaryReached / post-quiz observation below.
    //
    // Do not require stepObs.state === "QUIZ_SCREEN": after submit, Apex often classifies the page as LESSON_STRIP
    // (activity map + many lesson codes) while run-loop state is still QUIZ_SCREEN, so the plan never advanced.
    // Skip marking "incomplete" when feedback is visible — that is usually Next to the next question, not exit.

    /**
     * FSM `state` can lag the parser: Apex quiz/summary is often `obs.state === "QUIZ_SCREEN"` while `state` is still
     * `LESSON_SCREEN` (e.g. after Next → lesson transition). Plan advance used to require `prevStateForPlan === "QUIZ_SCREEN"`,
     * so we never incremented `targetQuizIndex`, never hit SAFE_EXIT, and wandered REVIEW ↔ Activities after the last quiz.
     */
    const leavingQuizUiForPlan =
      prevStateForPlan === "QUIZ_SCREEN" ||
      (prevStateForPlan === "LESSON_SCREEN" && stepObs?.state === "QUIZ_SCREEN");

    if (
      leavingQuizUiForPlan &&
      out.nextState !== "QUIZ_SCREEN" &&
      out.nextState !== "SAFE_EXIT" &&
      targetQuizIndex < quizzes.length
    ) {
      const code = quizzes[targetQuizIndex]!;
      let advance = quizCompletionArmed;
      if (typeof driver.getObservation === "function") {
        const postExit = await driver.getObservation();
        advance = advance || observationLooksLikePostQuizCompletion(postExit, code);
      }
      if (advance) {
        finalizeQuizSessionForPlan({
          quizCode: code,
          subject,
          scoreSnapshot: lastQuizScoreSnapshot ?? stepObs?.quizScoreSnapshot ?? null,
        });
        lastQuizScoreSnapshot = undefined;
        targetQuizIndex++;
        quizExitIncomplete = false;
        const lg = mapShortSubjectToLearningGraphFull(subject);
        if (lg) recordLearningGraphEvent({ type: "quiz_complete", subject: lg });
        console.log(
          `[Plan] Quiz ${code} marked complete (${quizCompletionArmed ? "summary/armed" : "post-exit UI"}) — plan progress ${targetQuizIndex}/${quizzes.length} in segment.`
        );
      } else if (!stepObs?.feedbackVisible) {
        quizExitIncomplete = true;
        console.warn(
          `[Plan] Left quiz without summary or map confirmation for ${code} — will prefer RESUME until quiz UI returns.`
        );
      }
      quizCompletionArmed = false;
    }

    if (out.nextState === "QUIZ_SCREEN" && stepObs?.state === "QUIZ_SCREEN") {
      quizExitIncomplete = false;
    }

    if (

      segments &&

      targetQuizIndex >= quizzes.length &&

      segmentIndex < segments.length - 1

    ) {

      segmentIndex++;

      const nextSeg = segments[segmentIndex]!;

      subject = nextSeg.subject;

      quizzes = nextSeg.items.map((it) => it.code);

      forbiddenLessonCodes = mergeSkipCodes(parsedSkip, nextSeg.skipCodes ?? []);

      targetQuizIndex = 0;

      quizCompletionArmed = false;

      quizExitIncomplete = false;

      lastQuizScoreSnapshot = undefined;

      resetQuizMetricsSession();

      state = "EDMENTUM_COURSE_GRID";

      console.log(

        `--- Run plan: segment ${segmentIndex + 1}/${segments.length} — ${subject} (${quizzes.join(", ")}) — reloading dashboard ---`

      );

      await driver.navigateTo(url).catch((e) => console.warn("navigateTo:", (e as Error).message));

      await driver.execute({ type: "SCROLL_TOP" }).catch(() => {});

      steps++;

      continue;

    }

    // Single segment (or last segment): no more quiz codes — stop instead of wandering course UI / REVIEW loops.
    if (
      quizzes.length > 0 &&
      targetQuizIndex >= quizzes.length &&
      (!segments || segmentIndex >= segments.length - 1)
    ) {
      console.log("[Plan] All planned items in this run are complete — stopping agent.");
      state = "SAFE_EXIT";
      steps++;
      break;
    }

    state = out.nextState;

    steps++;

  }



  await driver.close().catch(() => {});

  console.log("Done. State:", state);

}



main().catch((e) => {

  console.error(e);

  process.exit(1);

});


