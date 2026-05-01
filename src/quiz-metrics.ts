/**
 * Data-driven quiz calibration: per-question (confidence, choice, outcome), session summaries,
 * SQLite + JSONL storage, and report helpers for threshold / calibration analysis.
 *
 * Env: QUIZ_METRICS_PROFILE=default|A|B — stored with each session for A/B threshold comparison.
 * Disable: QUIZ_METRICS_DISABLED=1
 * Terminal: per-question outcome lines when feedback is applied (||| CORRECT ||| -QUESTION n/m).
 * Recovery: `auditLastSessionOutcomeCompleteness` + `applyQuizSummaryBackfill(..., { reconcilePriorSessionId })`.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Observation, QuizSummaryQuestionRow } from "./types.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_FILE = join(root, "logs", "quiz-metrics.db");
const JSONL_FILE = join(root, "logs", "quiz-metrics.jsonl");

type SqliteDb = InstanceType<typeof import("better-sqlite3")>;

function tableHasColumn(inst: SqliteDb, table: string, col: string): boolean {
  const rows = inst.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === col);
}

/** Add columns on existing DBs (idempotent). */
function migrateQuizMetricsSchema(inst: SqliteDb): void {
  try {
    if (!tableHasColumn(inst, "quiz_sessions", "reconciliation_json")) {
      inst.exec(`ALTER TABLE quiz_sessions ADD COLUMN reconciliation_json TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "outcome_feedback")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN outcome_feedback TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "outcome_summary")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN outcome_summary TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "outcome_source")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN outcome_source TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_sessions", "activity_kind")) {
      inst.exec(`ALTER TABLE quiz_sessions ADD COLUMN activity_kind TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "activity_kind")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN activity_kind TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "text_vision_agreed")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN text_vision_agreed INTEGER`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "solver_route")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN solver_route TEXT`);
    }
    if (!tableHasColumn(inst, "quiz_question_events", "question_category")) {
      inst.exec(`ALTER TABLE quiz_question_events ADD COLUMN question_category TEXT`);
    }
    inst.exec(
      `UPDATE quiz_question_events SET outcome_feedback = outcome WHERE outcome IS NOT NULL AND outcome != '' AND outcome_feedback IS NULL`
    );
  } catch (e) {
    console.warn("[quiz-metrics] migrate:", (e as Error).message);
  }
}

let db: SqliteDb | null = null;
let pendingQuestionEventId: number | null = null;
let activeSessionId: string | null = null;
/** 1-based count of feedback screens seen this metrics session (fallback when UI has no "n of m"). */
let sessionFeedbackOrdinal = 0;

function disabled(): boolean {
  return process.env.QUIZ_METRICS_DISABLED === "1";
}

function getDb(): SqliteDb | null {
  if (disabled()) return null;
  if (db) return db;
  try {
    const BetterSql = require("better-sqlite3") as typeof import("better-sqlite3");
    mkdirSync(dirname(DB_FILE), { recursive: true });
    const instance = new BetterSql(DB_FILE);
    instance.exec(`
      CREATE TABLE IF NOT EXISTS quiz_sessions (
        id TEXT PRIMARY KEY,
        ts_start INTEGER NOT NULL,
        ts_end INTEGER,
        subject TEXT,
        quiz_code TEXT,
        threshold_profile TEXT,
        min_confidence_threshold REAL,
        summary_correct INTEGER,
        summary_total INTEGER,
        summary_pct REAL,
        reconciliation_json TEXT
      );
      CREATE TABLE IF NOT EXISTS quiz_question_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        confidence REAL,
        choice_index INTEGER,
        choice_indices_json TEXT,
        multi_select INTEGER,
        outcome TEXT,
        vision_used INTEGER,
        min_confidence_threshold REAL,
        reasoning_snippet TEXT,
        incomplete_viewport INTEGER,
        outcome_feedback TEXT,
        outcome_summary TEXT,
        outcome_source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_qm_session ON quiz_question_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_qm_confidence ON quiz_question_events(confidence);
      CREATE INDEX IF NOT EXISTS idx_qm_outcome ON quiz_question_events(outcome);
    `);
    migrateQuizMetricsSchema(instance);
    db = instance;
    return db;
  } catch (e) {
    console.warn("[quiz-metrics] SQLite unavailable:", (e as Error).message);
    return null;
  }
}

function appendJsonl(obj: Record<string, unknown>): void {
  if (disabled()) return;
  try {
    mkdirSync(dirname(JSONL_FILE), { recursive: true });
    appendFileSync(JSONL_FILE, JSON.stringify({ ts: Date.now(), ...obj }) + "\n", "utf-8");
  } catch (e) {
    console.warn("[quiz-metrics] JSONL append failed:", (e as Error).message);
  }
}

/** Extract x/y and % from Apex quiz summary / results body text. */
export function parseQuizScoreFromBody(body: string): { correct: number; total: number; pct: number } | null {
  const t = body.replace(/\s+/g, " ");
  const patterns: RegExp[] = [
    /(\d+)\s*\/\s*(\d+)\s*(?:correct|right|pts?|points?)/i,
    /(\d+)\s+out\s+of\s+(\d+)/i,
    /earned\s*(\d+)\s*out\s*of\s*(\d+)/i,
    /you\s+(?:earned|scored)\s+(\d+)\s*\/\s*(\d+)/i,
    /score[:\s]+(\d+)\s*\/\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const correct = parseInt(m[1]!, 10);
      const total = parseInt(m[2]!, 10);
      if (total > 0 && correct >= 0 && correct <= total) {
        const pct = Math.round((correct / total) * 1000) / 10;
        return { correct, total, pct };
      }
    }
  }
  const pctM = t.match(/(\d{1,2}(?:\.\d)?)\s*%\s*(?:correct|score|)/i);
  if (pctM) {
    const pct = parseFloat(pctM[1]!);
    if (!Number.isNaN(pct)) return { correct: 0, total: 0, pct };
  }
  return null;
}

/**
 * Parse per-question outcomes from the Apex results / itemized summary body (points, checkmarks).
 * Does not use screenshots; used for backfill when feedback screens were missed and for reconciliation.
 */
export function parseQuizSummaryQuestionOutcomesFromBody(body: string): QuizSummaryQuestionRow[] {
  const text = body.replace(/\r/g, "\n");
  const re = /\bQuestion\s+(\d+)\b/gi;
  const hits: { num: number; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1]!, 10);
    if (num > 0 && num < 2000) hits.push({ num, start: m.index });
  }
  if (hits.length === 0) return [];
  const byNum = new Map<number, QuizSummaryQuestionRow>();
  for (let i = 0; i < hits.length; i++) {
    const { num, start } = hits[i]!;
    const end = i + 1 < hits.length ? hits[i + 1]!.start : text.length;
    const segment = text.slice(start, Math.min(end, start + 1500));
    const pm = segment.match(/(\d+)\s*points?/i);
    let points = pm ? parseInt(pm[1]!, 10) : -1;
    let outcome: "correct" | "incorrect";
    if (points >= 0) {
      outcome = points > 0 ? "correct" : "incorrect";
    } else if (/[✓✔]/u.test(segment) && !/[✗✘×]/u.test(segment)) {
      outcome = "correct";
      points = 1;
    } else if (/[✗✘×]/u.test(segment)) {
      outcome = "incorrect";
      points = 0;
    } else {
      continue;
    }
    byNum.set(num, { questionNumber: num, outcome, points });
  }
  return [...byNum.values()].sort((a, b) => a.questionNumber - b.questionNumber);
}

export interface QuizMetricsReconciliation {
  submitRows: number;
  summaryListParsed: number;
  effectiveCorrect: number;
  feedbackCorrect: number;
  summaryListCorrect: number;
  aggregateCorrect: number | null;
  aggregateTotal: number | null;
  mismatchCount: number;
  backfillCount: number;
  disagreeKeptCount: number;
  /** Headline x/y equals sum of parsed checklist when checklist length matches headline total (else null = not compared). */
  aggregateMatchesListSum: boolean | null;
  /** Headline x/y equals effective correct count when submit row count matches headline total (else null = not compared). */
  aggregateMatchesEffectiveSum: boolean | null;
}

/** Console-only: `null` here is usually points (e.g. 18/20) vs per-question rows (10) — not an error. */
function formatHeadlineAggregateLine(
  v: boolean | null,
  r: QuizMetricsReconciliation,
  which: "checklist" | "effective"
): string {
  if (v === true) return "match";
  if (v === false) return "mismatch";
  if (r.aggregateCorrect == null || r.aggregateTotal == null) {
    return "n/a (no headline score)";
  }
  if (which === "checklist" && r.summaryListParsed !== r.aggregateTotal) {
    return `n/a (headline ${r.aggregateCorrect}/${r.aggregateTotal} points vs ${r.summaryListParsed} checklist questions)`;
  }
  if (which === "effective" && r.submitRows !== r.aggregateTotal) {
    return `n/a (headline ${r.aggregateCorrect}/${r.aggregateTotal} points vs ${r.submitRows} answered rows)`;
  }
  return "n/a";
}

export interface QuizMetricsContext {
  subject?: string;
  quizCode?: string;
  minConfidenceToSubmit?: number;
  /** `test` when current plan item has `isTest: true` (stricter solver policy). */
  activityKind?: "quiz" | "test";
  /** A/B or experiment label (env QUIZ_METRICS_PROFILE). */
  thresholdProfile?: string;
}

let metricsContext: QuizMetricsContext = {};

export function setQuizMetricsContext(ctx: Partial<QuizMetricsContext>): void {
  metricsContext = { ...metricsContext, ...ctx };
  if (!metricsContext.thresholdProfile && process.env.QUIZ_METRICS_PROFILE) {
    metricsContext.thresholdProfile = process.env.QUIZ_METRICS_PROFILE.trim();
  }
}

function ensureSession(): string {
  if (activeSessionId) return activeSessionId;
  sessionFeedbackOrdinal = 0;
  const id = `qm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  activeSessionId = id;
  const inst = getDb();
  if (inst) {
    try {
      inst
        .prepare(
          `INSERT INTO quiz_sessions (id, ts_start, subject, quiz_code, threshold_profile, min_confidence_threshold, activity_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          Date.now(),
          metricsContext.subject ?? null,
          metricsContext.quizCode ?? null,
          metricsContext.thresholdProfile ?? null,
          metricsContext.minConfidenceToSubmit ?? null,
          metricsContext.activityKind ?? null
        );
    } catch (e) {
      console.warn("[quiz-metrics] session insert:", (e as Error).message);
    }
  }
  appendJsonl({ type: "session_start", sessionId: id, ...metricsContext });
  return id;
}

/** Call when a quiz answer is actually submitted (after solver, before driver.execute). */
export function recordQuizAnswerSubmit(meta: {
  confidence: number;
  choiceIndex?: number;
  choiceIndices?: number[];
  multiSelect: boolean;
  reasoning?: string;
  visionUsed: boolean;
  minConfidenceThreshold: number;
  incompleteViewport?: boolean;
  activityKind?: "quiz" | "test";
  /** Set when strict test cross-check ran: 1 = agreed, 0 = would have blocked (not stored on non-submit). */
  textVisionAgreed?: boolean | null;
  /** Text solver path: local (Ollama) vs cloud (Claude), or vision when the submitted answer came from screenshot flow. */
  solverRoute?: "local" | "cloud" | "vision" | null;
  /** Coarse category for calibration reports (see quiz-question-category). */
  questionCategory?: string | null;
}): void {
  if (disabled()) return;
  const sessionId = ensureSession();
  const choiceIndicesJson =
    meta.choiceIndices && meta.choiceIndices.length > 0 ? JSON.stringify(meta.choiceIndices) : null;
  const reasoningSnippet = meta.reasoning?.slice(0, 500) ?? null;
  const activityKind = meta.activityKind ?? metricsContext.activityKind ?? null;
  const textVisionSql =
    meta.textVisionAgreed === true ? 1 : meta.textVisionAgreed === false ? 0 : null;
  const solverRouteSql = meta.solverRoute ?? null;
  const questionCategorySql = meta.questionCategory ?? null;
  const inst = getDb();
  let rowId: number | null = null;
  if (inst) {
    try {
      const info = inst
        .prepare(
          `INSERT INTO quiz_question_events (session_id, ts, confidence, choice_index, choice_indices_json, multi_select, outcome, vision_used, min_confidence_threshold, reasoning_snippet, incomplete_viewport, activity_kind, text_vision_agreed, solver_route, question_category)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          Date.now(),
          meta.confidence,
          meta.choiceIndex ?? null,
          choiceIndicesJson,
          meta.multiSelect ? 1 : 0,
          null,
          meta.visionUsed ? 1 : 0,
          meta.minConfidenceThreshold,
          reasoningSnippet,
          meta.incompleteViewport ? 1 : 0,
          activityKind,
          textVisionSql,
          solverRouteSql,
          questionCategorySql
        );
      rowId = Number(info.lastInsertRowid);
    } catch (e) {
      console.warn("[quiz-metrics] insert question event:", (e as Error).message);
    }
  }
  pendingQuestionEventId = rowId;
  appendJsonl({
    type: "question_submit",
    sessionId,
    eventId: rowId,
    ...meta,
    choiceIndices: meta.choiceIndices,
  });
}

/** Call on the next observation after submit when Apex shows Correct / Incorrect. */
export function consumeQuizFeedbackObservation(obs: Observation): void {
  if (disabled() || pendingQuestionEventId == null) return;
  if (!obs.feedbackVisible || !obs.feedbackOutcome) return;
  const outcome = obs.feedbackOutcome;
  const inst = getDb();
  if (inst) {
    try {
      inst
        .prepare(
          `UPDATE quiz_question_events SET outcome = ?, outcome_feedback = ?, outcome_source = ? WHERE id = ?`
        )
        .run(outcome, outcome, "feedback", pendingQuestionEventId);
    } catch (e) {
      console.warn("[quiz-metrics] update outcome:", (e as Error).message);
    }
  }
  appendJsonl({
    type: "question_feedback",
    eventId: pendingQuestionEventId,
    outcome,
  });

  sessionFeedbackOrdinal += 1;
  const qCur = obs.pageProgress?.current ?? sessionFeedbackOrdinal;
  const qTot = obs.pageProgress?.total != null ? obs.pageProgress.total : "?";
  const tag = outcome === "correct" ? "CORRECT" : "INCORRECT";
  console.log(`||| ${tag} ||| -QUESTION ${qCur}/${qTot}`);

  pendingQuestionEventId = null;
}

/** When parser sees score on summary screen. */
export function recordQuizScoreSnapshot(snapshot: { correct: number; total: number; pct: number }): void {
  if (disabled()) return;
  const sessionId = ensureSession();
  const inst = getDb();
  if (inst) {
    try {
      inst
        .prepare(
          `UPDATE quiz_sessions SET summary_correct = ?, summary_total = ?, summary_pct = ? WHERE id = ?`
        )
        .run(snapshot.correct, snapshot.total, snapshot.pct, sessionId);
    } catch (e) {
      console.warn("[quiz-metrics] update session summary:", (e as Error).message);
    }
  }
  appendJsonl({ type: "quiz_score_snapshot", sessionId, ...snapshot });
}

/**
 * Merge itemized summary outcomes with per-submit rows: backfill NULL outcomes, record disagreements
 * (canonical effective outcome = feedback when present), and persist reconciliation stats on the session.
 */
export function applyQuizSummaryBackfill(
  obs: Observation,
  options?: { reconcilePriorSessionId?: string }
): void {
  if (disabled()) return;
  if (!obs.quizSummaryReached || !obs.quizSummaryPerQuestion?.length) return;
  const priorId = options?.reconcilePriorSessionId?.trim();
  let sessionId: string | null = null;
  if (priorId) {
    // Never merge a prior session's summary into a different active metrics session.
    if (activeSessionId != null && activeSessionId !== priorId) return;
    sessionId = priorId;
  } else {
    sessionId = activeSessionId;
  }
  if (!sessionId) return;
  const inst = getDb();
  if (!inst) return;

  const list = [...obs.quizSummaryPerQuestion].sort((a, b) => a.questionNumber - b.questionNumber);
  const rows = inst
    .prepare(
      `SELECT id, outcome, outcome_feedback, outcome_summary, outcome_source FROM quiz_question_events WHERE session_id = ? ORDER BY id ASC`
    )
    .all(sessionId) as Array<{
      id: number;
      outcome: string | null;
      outcome_feedback: string | null;
      outcome_summary: string | null;
      outcome_source: string | null;
    }>;
  if (rows.length === 0) return;

  let backfillCount = 0;
  let disagreeKeptCount = 0;

  const setSummaryOnly = inst.prepare(`UPDATE quiz_question_events SET outcome_summary = ? WHERE id = ?`);
  const backfill = inst.prepare(
    `UPDATE quiz_question_events SET outcome = ?, outcome_summary = ?, outcome_source = ? WHERE id = ?`
  );
  const setAgree = inst.prepare(`UPDATE quiz_question_events SET outcome_source = ? WHERE id = ?`);
  const setDisagree = inst.prepare(
    `UPDATE quiz_question_events SET outcome = ?, outcome_source = ? WHERE id = ?`
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const fromList = list.find((x) => x.questionNumber === i + 1) ?? list[i];
    if (!fromList) continue;
    const s = fromList.outcome;
    const feedback = (row.outcome_feedback as string | null) ?? row.outcome;

    setSummaryOnly.run(s, row.id);

    if (!feedback || feedback === "") {
      backfill.run(s, s, "summary_backfill", row.id);
      backfillCount++;
    } else if (feedback === s) {
      setAgree.run("agree", row.id);
    } else {
      disagreeKeptCount++;
      setDisagree.run(feedback, "disagree_feedback_kept", row.id);
    }
  }

  if (pendingQuestionEventId != null) {
    const still = inst.prepare(`SELECT outcome FROM quiz_question_events WHERE id = ?`).get(pendingQuestionEventId) as
      | { outcome: string | null }
      | undefined;
    if (still?.outcome) pendingQuestionEventId = null;
  }

  const after = inst
    .prepare(
      `SELECT outcome, outcome_feedback FROM quiz_question_events WHERE session_id = ? ORDER BY id ASC`
    )
    .all(sessionId) as Array<{ outcome: string | null; outcome_feedback: string | null }>;

  let effectiveCorrect = 0;
  let feedbackCorrect = 0;
  for (const r of after) {
    if (r.outcome === "correct") effectiveCorrect++;
    const fb = r.outcome_feedback;
    if (fb === "correct") feedbackCorrect++;
  }

  const summaryListCorrect = list.filter((x) => x.outcome === "correct").length;
  const agg = obs.quizScoreSnapshot;
  const aggregateCorrect = agg && agg.total > 0 ? agg.correct : null;
  const aggregateTotal = agg && agg.total > 0 ? agg.total : null;

  let aggregateMatchesListSum: boolean | null = null;
  if (aggregateCorrect != null && aggregateTotal != null && list.length === aggregateTotal) {
    aggregateMatchesListSum = aggregateCorrect === summaryListCorrect;
  }

  let aggregateMatchesEffectiveSum: boolean | null = null;
  if (aggregateCorrect != null && aggregateTotal != null && after.length === aggregateTotal) {
    aggregateMatchesEffectiveSum = aggregateCorrect === effectiveCorrect;
  }

  const recon: QuizMetricsReconciliation = {
    submitRows: rows.length,
    summaryListParsed: list.length,
    effectiveCorrect,
    feedbackCorrect,
    summaryListCorrect,
    aggregateCorrect,
    aggregateTotal,
    mismatchCount: disagreeKeptCount,
    backfillCount,
    disagreeKeptCount,
    aggregateMatchesListSum,
    aggregateMatchesEffectiveSum,
  };

  try {
    inst.prepare(`UPDATE quiz_sessions SET reconciliation_json = ? WHERE id = ?`).run(JSON.stringify(recon), sessionId);
  } catch (e) {
    console.warn("[quiz-metrics] reconciliation_json:", (e as Error).message);
  }
  appendJsonl({ type: "quiz_summary_reconciliation", sessionId, ...recon });
}

/** When plan advances after completing a target quiz — log and close session. */
export function finalizeQuizSessionForPlan(meta: {
  quizCode: string;
  subject?: string;
  scoreSnapshot?: { correct: number; total: number; pct: number } | null;
}): void {
  if (disabled()) return;
  const sessionId = activeSessionId;
  if (!sessionId) {
    appendJsonl({ type: "quiz_plan_advance", ...meta, note: "no_active_session" });
    return;
  }
  const inst = getDb();
  if (meta.scoreSnapshot && inst) {
    try {
      inst
        .prepare(
          `UPDATE quiz_sessions SET summary_correct = ?, summary_total = ?, summary_pct = ?, ts_end = ?, quiz_code = ? WHERE id = ?`
        )
        .run(
          meta.scoreSnapshot.correct,
          meta.scoreSnapshot.total,
          meta.scoreSnapshot.pct,
          Date.now(),
          meta.quizCode,
          sessionId
        );
    } catch (e) {
      console.warn("[quiz-metrics] finalize session:", (e as Error).message);
    }
  } else if (inst) {
    try {
      inst.prepare(`UPDATE quiz_sessions SET ts_end = ?, quiz_code = COALESCE(?, quiz_code) WHERE id = ?`).run(Date.now(), meta.quizCode, sessionId);
    } catch {
      /* */
    }
  }
  const snap = meta.scoreSnapshot;
  if (snap && (snap.total > 0 || snap.pct > 0)) {
    const xy =
      snap.total > 0 ? `${snap.correct}/${snap.total}` : snap.pct > 0 ? "x/y unknown" : "?/?";
    console.log(
      `[QuizMetrics] Quiz ${meta.quizCode} complete — score ${xy} (${snap.pct}%)` +
        (metricsContext.thresholdProfile ? ` [profile=${metricsContext.thresholdProfile}]` : "")
    );
  } else {
    console.log(
      `[QuizMetrics] Quiz ${meta.quizCode} marked complete (see logs/quiz-metrics.jsonl for per-question data)` +
        (metricsContext.thresholdProfile ? ` [profile=${metricsContext.thresholdProfile}]` : "")
    );
  }
  if (inst) {
    try {
      const rj = inst.prepare(`SELECT reconciliation_json FROM quiz_sessions WHERE id = ?`).get(sessionId) as
        | { reconciliation_json: string | null }
        | undefined;
      if (rj?.reconciliation_json) {
        const r = JSON.parse(rj.reconciliation_json) as QuizMetricsReconciliation;
        console.log(
          `[QuizMetrics] Reconciliation: effective ${r.effectiveCorrect}/${r.submitRows} correct; feedback-only ${r.feedbackCorrect}; checklist ${r.summaryListCorrect}; backfill ${r.backfillCount}; feedback-vs-summary disagreements ${r.disagreeKeptCount}; headline vs checklist ${formatHeadlineAggregateLine(r.aggregateMatchesListSum, r, "checklist")}; headline vs effective ${formatHeadlineAggregateLine(r.aggregateMatchesEffectiveSum, r, "effective")}`
        );
      }
    } catch {
      /* */
    }
  }
  appendJsonl({
    type: "session_end",
    sessionId,
    ...meta,
    activityKind: metricsContext.activityKind,
  });
  activeSessionId = null;
  pendingQuestionEventId = null;
  sessionFeedbackOrdinal = 0;
}

/** Start fresh session when targeting a new quiz code (e.g. plan segment). */
export function resetQuizMetricsSession(): void {
  activeSessionId = null;
  pendingQuestionEventId = null;
  sessionFeedbackOrdinal = 0;
}

/** Calibration: bucket confidence vs accuracy (requires paired outcomes). */
export function getCalibrationBuckets(): Array<{
  bucket: string;
  n: number;
  correct: number;
  rate: number;
}> {
  const inst = getDb();
  if (!inst) return [];
  try {
    const rows = inst
      .prepare(
        `SELECT
           CASE
             WHEN confidence < 0.7 THEN '0.0-0.7'
             WHEN confidence < 0.8 THEN '0.7-0.8'
             WHEN confidence < 0.9 THEN '0.8-0.9'
             WHEN confidence < 0.95 THEN '0.9-0.95'
             ELSE '0.95-1.0'
           END AS bucket,
           COUNT(*) AS n,
           SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct
         FROM quiz_question_events
         WHERE outcome IN ('correct', 'incorrect')
         GROUP BY bucket`
      )
      .all() as Array<{ bucket: string; n: number; correct: number }>;
    return rows.map((r) => ({
      bucket: r.bucket,
      n: r.n,
      correct: r.correct,
      rate: r.n > 0 ? Math.round((r.correct / r.n) * 1000) / 1000 : 0,
    }));
  } catch {
    return [];
  }
}

/** Per-session rows for A/B comparison (threshold profile, scores). */
export function getQuizSessionSummaries(): Array<{
  id: string;
  quiz_code: string | null;
  threshold_profile: string | null;
  summary_correct: number | null;
  summary_total: number | null;
  summary_pct: number | null;
  ts_start: number;
  ts_end: number | null;
  reconciliation_json: string | null;
}> {
  const inst = getDb();
  if (!inst) return [];
  try {
    return inst
      .prepare(
        `SELECT id, quiz_code, threshold_profile, summary_correct, summary_total, summary_pct, ts_start, ts_end, reconciliation_json
         FROM quiz_sessions ORDER BY ts_start DESC LIMIT 500`
      )
      .all() as Array<{
      id: string;
      quiz_code: string | null;
      threshold_profile: string | null;
      summary_correct: number | null;
      summary_total: number | null;
      summary_pct: number | null;
      ts_start: number;
      ts_end: number | null;
      reconciliation_json: string | null;
    }>;
  } catch {
    return [];
  }
}

/** Calibration buckets split by `threshold_profile` (A/B runs). */
export function getCalibrationBucketsByProfile(): Array<{
  profile: string | null;
  bucket: string;
  n: number;
  correct: number;
  rate: number;
}> {
  const inst = getDb();
  if (!inst) return [];
  try {
    const rows = inst
      .prepare(
        `SELECT
           qs.threshold_profile AS profile,
           CASE
             WHEN qe.confidence < 0.7 THEN '0.0-0.7'
             WHEN qe.confidence < 0.8 THEN '0.7-0.8'
             WHEN qe.confidence < 0.9 THEN '0.8-0.9'
             WHEN qe.confidence < 0.95 THEN '0.9-0.95'
             ELSE '0.95-1.0'
           END AS bucket,
           COUNT(*) AS n,
           SUM(CASE WHEN qe.outcome = 'correct' THEN 1 ELSE 0 END) AS correct
         FROM quiz_question_events qe
         JOIN quiz_sessions qs ON qs.id = qe.session_id
         WHERE qe.outcome IN ('correct', 'incorrect')
         GROUP BY qs.threshold_profile, bucket`
      )
      .all() as Array<{ profile: string | null; bucket: string; n: number; correct: number }>;
    return rows.map((r) => ({
      profile: r.profile,
      bucket: r.bucket,
      n: r.n,
      correct: r.correct,
      rate: r.n > 0 ? Math.round((r.correct / r.n) * 1000) / 1000 : 0,
    }));
  } catch {
    return [];
  }
}

/** Read-only open for launch-time audit when `QUIZ_METRICS_DISABLED=1` or DB not yet opened for write. */
function openReadonlyMetricsDb(): SqliteDb | null {
  if (!existsSync(DB_FILE)) return null;
  try {
    const BetterSql = require("better-sqlite3") as typeof import("better-sqlite3");
    return new BetterSql(DB_FILE, { readonly: true });
  } catch {
    return null;
  }
}

/** Result of scanning the most recent `quiz_sessions` row for incomplete per-question outcomes. */
export type PriorSessionOutcomeAudit = {
  sessionId: string;
  quizCode: string | null;
  tsStart: number;
  tsEnd: number | null;
  submitRows: number;
  rowsWithOutcome: number;
  rowsMissingOutcome: number;
};

/**
 * Deterministic health check: last session in `quiz_metrics.db`, counts submit rows vs rows with `outcome` set.
 * Works even when `QUIZ_METRICS_DISABLED=1` (readonly). Returns null if DB missing or empty.
 */
export function auditLastSessionOutcomeCompleteness(): PriorSessionOutcomeAudit | null {
  const inst = openReadonlyMetricsDb();
  if (!inst) return null;
  try {
    const row = inst
      .prepare(
        `SELECT id, quiz_code, ts_start, ts_end FROM quiz_sessions ORDER BY ts_start DESC LIMIT 1`
      )
      .get() as
      | { id: string; quiz_code: string | null; ts_start: number; ts_end: number | null }
      | undefined;
    if (!row) return null;
    const submitRows = (
      inst.prepare(`SELECT COUNT(*) AS c FROM quiz_question_events WHERE session_id = ?`).get(row.id) as { c: number }
    ).c;
    const rowsWithOutcome = (
      inst
        .prepare(
          `SELECT COUNT(*) AS c FROM quiz_question_events WHERE session_id = ? AND outcome IS NOT NULL AND outcome != ''`
        )
        .get(row.id) as { c: number }
    ).c;
    const rowsMissingOutcome = Math.max(0, submitRows - rowsWithOutcome);
    return {
      sessionId: row.id,
      quizCode: row.quiz_code,
      tsStart: row.ts_start,
      tsEnd: row.ts_end,
      submitRows,
      rowsWithOutcome,
      rowsMissingOutcome,
    };
  } catch {
    return null;
  } finally {
    try {
      inst.close();
    } catch {
      /* */
    }
  }
}

/** Count rows still missing `outcome` for a session (after backfill attempts). Returns -1 if DB unavailable. */
export function countNullOutcomesForSession(sessionId: string): number {
  const tryCount = (db: SqliteDb): number => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM quiz_question_events WHERE session_id = ? AND (outcome IS NULL OR outcome = '')`
      )
      .get(sessionId) as { c: number };
    return row.c;
  };
  const w = getDb();
  if (w) {
    try {
      return tryCount(w);
    } catch {
      return -1;
    }
  }
  const r = openReadonlyMetricsDb();
  if (!r) return -1;
  try {
    return tryCount(r);
  } catch {
    return -1;
  } finally {
    try {
      r.close();
    } catch {
      /* */
    }
  }
}
