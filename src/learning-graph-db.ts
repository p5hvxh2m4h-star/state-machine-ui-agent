/**
 * SQLite dual-write for learning events (cross-run queries). JSONL remains the SSE stream source.
 * Set DISABLE_LEARNING_GRAPH_SQLITE=1 to skip DB writes.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_FILE = join(root, "logs", "learning-graph.db");

type SqliteDb = InstanceType<typeof import("better-sqlite3")>;

let db: SqliteDb | null = null;

function getDb(): SqliteDb | null {
  if (process.env.DISABLE_LEARNING_GRAPH_SQLITE === "1") return null;
  if (db) return db;
  try {
    const BetterSqlite = require("better-sqlite3") as typeof import("better-sqlite3");
    mkdirSync(dirname(DB_FILE), { recursive: true });
    const instance = new BetterSqlite(DB_FILE);
    instance.exec(`
      CREATE TABLE IF NOT EXISTS learning_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        weight REAL,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_learning_ts ON learning_events(ts);
      CREATE INDEX IF NOT EXISTS idx_learning_subject ON learning_events(subject);
      CREATE INDEX IF NOT EXISTS idx_learning_type ON learning_events(type);
    `);
    db = instance;
    return db;
  } catch (e) {
    console.warn("[learning-graph-db] SQLite unavailable:", (e as Error).message);
    return null;
  }
}

export function insertLearningGraphEventRow(event: {
  ts: number;
  type: string;
  subject: string;
  weight?: number;
  meta?: Record<string, unknown>;
}): void {
  const instance = getDb();
  if (!instance) return;
  try {
    const stmt = instance.prepare(
      `INSERT INTO learning_events (ts, type, subject, weight, meta_json)
       VALUES (@ts, @type, @subject, @weight, @meta_json)`
    );
    stmt.run({
      ts: event.ts,
      type: event.type,
      subject: event.subject,
      weight: event.weight ?? null,
      meta_json: event.meta ? JSON.stringify(event.meta) : null,
    });
  } catch (e) {
    console.warn("[learning-graph-db] insert failed:", (e as Error).message);
  }
}

export function queryRecentLearningEvents(limit = 200): Array<{
  ts: number;
  type: string;
  subject: string;
}> {
  const instance = getDb();
  if (!instance) return [];
  try {
    const rows = instance
      .prepare(`SELECT ts, type, subject FROM learning_events ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Array<{ ts: number; type: string; subject: string }>;
    return rows;
  } catch {
    return [];
  }
}
