#!/usr/bin/env node
/**
 * Print quiz calibration + session summaries from logs/quiz-metrics.db
 * Usage: node scripts/quiz-metrics-report.mjs
 *
 * Env: QUIZ_METRICS_DISABLED is ignored here — report reads existing DB only.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_FILE = join(root, "logs", "quiz-metrics.db");

if (!existsSync(DB_FILE)) {
  console.log("No database yet:", DB_FILE, "(run a quiz flow with QUIZ_METRICS_DISABLED unset first.)");
  process.exit(0);
}

let BetterSql;
try {
  BetterSql = require("better-sqlite3");
} catch {
  console.error("better-sqlite3 not available — run from project root after npm install.");
  process.exit(1);
}

const db = new BetterSql(DB_FILE);

/** Same semantics as `formatHeadlineAggregateLine` in quiz-metrics.ts — null headline checks are usually points vs question count. */
function formatHeadlineAgg(v, r, which) {
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

function tableHasColumn(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === col);
}

console.log("=== Quiz metrics DB ===", DB_FILE, "\n");

const hasReconciliationJson = tableHasColumn("quiz_sessions", "reconciliation_json");
const sessions = hasReconciliationJson
  ? db
      .prepare(
        `SELECT id, quiz_code, threshold_profile, summary_correct, summary_total, summary_pct, ts_start, ts_end, reconciliation_json
         FROM quiz_sessions ORDER BY ts_start DESC LIMIT 100`
      )
      .all()
  : db
      .prepare(
        `SELECT id, quiz_code, threshold_profile, summary_correct, summary_total, summary_pct, ts_start, ts_end
         FROM quiz_sessions ORDER BY ts_start DESC LIMIT 100`
      )
      .all();

console.log("--- Recent sessions (up to 100) ---");
for (const s of sessions) {
  const score =
    s.summary_total > 0
      ? `${s.summary_correct}/${s.summary_total} (${s.summary_pct ?? "?"}%)`
      : s.summary_pct != null
        ? `${s.summary_pct}% (x/y not parsed)`
        : "—";
  let reconLine = "";
  if (hasReconciliationJson && s.reconciliation_json) {
    try {
      const r = JSON.parse(s.reconciliation_json);
      reconLine = `  recon: effective ${r.effectiveCorrect}/${r.submitRows}  backfill ${r.backfillCount}  disagree ${r.disagreeKeptCount}  headline≟checklist ${formatHeadlineAgg(r.aggregateMatchesListSum, r, "checklist")}  headline≟effective ${formatHeadlineAgg(r.aggregateMatchesEffectiveSum, r, "effective")}`;
    } catch {
      reconLine = "";
    }
  }
  console.log(
    `  ${s.id}  quiz=${s.quiz_code ?? "?"}  profile=${s.threshold_profile ?? "—"}  score=${score}${reconLine ? "\n" + reconLine : ""}`
  );
}

const cal = db
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
  .all();

console.log("\n--- Calibration (confidence bucket → accuracy) ---");
for (const r of cal) {
  const rate = r.n > 0 ? ((r.correct / r.n) * 100).toFixed(1) : "0";
  console.log(`  ${r.bucket}  n=${r.n}  correct=${r.correct}  rate=${rate}%`);
}

const calProfile = db
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
  .all();

console.log("\n--- Calibration by QUIZ_METRICS_PROFILE (A/B) ---");
for (const r of calProfile) {
  const rate = r.n > 0 ? ((r.correct / r.n) * 100).toFixed(1) : "0";
  console.log(
    `  profile=${r.profile ?? "null"}  ${r.bucket}  n=${r.n}  correct=${r.correct}  rate=${rate}%`
  );
}

if (tableHasColumn("quiz_question_events", "question_category")) {
  const byCat = db
    .prepare(
      `SELECT
         COALESCE(question_category, '(null)') AS category,
         COUNT(*) AS n,
         SUM(CASE WHEN outcome IN ('correct', 'incorrect') THEN 1 ELSE 0 END) AS with_outcome,
         SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct
       FROM quiz_question_events
       GROUP BY question_category
       ORDER BY n DESC`
    )
    .all();
  console.log("\n--- By question_category (coarse routing bucket) ---");
  for (const r of byCat) {
    const denom = r.with_outcome > 0 ? r.with_outcome : r.n;
    const rate = denom > 0 ? ((r.correct / denom) * 100).toFixed(1) : "0";
    console.log(`  ${r.category}  n=${r.n}  with_outcome=${r.with_outcome}  correct=${r.correct}  rate=${rate}%`);
  }
}

if (tableHasColumn("quiz_question_events", "solver_route")) {
  const byRoute = db
    .prepare(
      `SELECT
         COALESCE(solver_route, '(null)') AS route,
         COUNT(*) AS n,
         SUM(CASE WHEN outcome IN ('correct', 'incorrect') THEN 1 ELSE 0 END) AS with_outcome,
         SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct
       FROM quiz_question_events
       GROUP BY solver_route
       ORDER BY n DESC`
    )
    .all();
  console.log("\n--- By solver_route (local / cloud / vision) ---");
  for (const r of byRoute) {
    const denom = r.with_outcome > 0 ? r.with_outcome : r.n;
    const rate = denom > 0 ? ((r.correct / denom) * 100).toFixed(1) : "0";
    console.log(`  ${r.route}  n=${r.n}  with_outcome=${r.with_outcome}  correct=${r.correct}  rate=${rate}%`);
  }
}

const pending = db
  .prepare(
    `SELECT COUNT(*) AS c FROM quiz_question_events WHERE outcome IS NULL OR outcome = ''`
  )
  .get();
console.log("\n--- Events without feedback outcome (pending / unknown) ---", pending?.c ?? 0);

db.close();
