/**
 * Cross-run quiz learning: store outcomes + platform feedback, retrieve similar past items
 * (token Jaccard + optional Ollama embeddings) and inject into solver prompts.
 *
 * Env: QUIZ_LEARNING_DISABLED=1 — no storage or prompt injection.
 * Env: QUIZ_LEARNING_EMBEDDINGS=0 — Jaccard only (no Ollama).
 * Default embedding model: nomic-embed-text @ OLLAMA_HOST (http://127.0.0.1:11434).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Observation } from "./types.js";
import { cosineSimilarity, embedTextOllama, ollamaEmbeddingsConfigured } from "./quiz-learning-ollama.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSONL_FILE = join(root, "logs", "quiz-learning.jsonl");

/** Max lines to scan from end of JSONL on each retrieval (keep reads bounded). */
const TAIL_LINES = 2000;
/** Max characters injected into Claude prompts. */
const DEFAULT_MAX_PROMPT_CHARS = 2400;
/** Min token overlap (Jaccard * 100) to surface an item as "similar". */
const MIN_SIMILARITY = 12;
/** Min cosine similarity (0–1) when both query and stored row have embeddings. */
const MIN_EMBEDDING_COSINE = 0.36;

export type QuizLearningRecord = {
  ts: number;
  subject?: string;
  quizCode?: string;
  outcome: "correct" | "incorrect";
  questionBrief: string;
  choicesBrief: string;
  chosenSummary: string;
  /** Extracted from Apex feedback ("The correct answer is …") when available. */
  platformHint?: string;
  /** Ollama embedding of questionBrief + choicesBrief (when captured at commit time). */
  emb?: number[];
  /** True when prior-run memory was retrieved and injected into the solver prompt for this question. */
  memoryHit?: boolean;
  /** Number of incorrect-outcome matches that were injected (0 when memoryHit is false/absent). */
  priorIncorrectMatches?: number;
  /** Number of correct-outcome matches that were injected (0 when memoryHit is false/absent). */
  priorCorrectMatches?: number;
};

type PendingSubmit = {
  question: string;
  choices: string[];
  choiceIndex?: number;
  choiceIndices?: number[];
  multiSelect: boolean;
  reasoning?: string;
  subject?: string;
  quizCode?: string;
  /** Retrieval metadata captured at solve time — stamped into the JSONL record on commit. */
  retrievalMeta?: LearningRetrievalMeta;
};

let pending: PendingSubmit | null = null;

function disabled(): boolean {
  return process.env.QUIZ_LEARNING_DISABLED === "1";
}

function normSubject(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase().slice(0, 80);
}

/** Plan may say "English"; stored row may say "English ALVS PT English 10 Sem 2". */
function subjectMatches(stored: string | undefined, current: string | undefined): boolean {
  const a = normSubject(stored);
  const b = normSubject(current);
  if (!b) return true;
  if (!a) return true;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aw = a.split(/\s+/).filter((w) => w.length > 2);
  const bw = b.split(/\s+/).filter((w) => w.length > 2);
  if (aw.length === 0 || bw.length === 0) return false;
  return aw.some((w) => bw.includes(w)) || bw.some((w) => aw.includes(w));
}

function normCode(s: string | undefined): string {
  return (s ?? "").trim();
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "boy",
  "did",
  "she",
  "use",
  "her",
  "which",
  "that",
  "this",
  "with",
  "from",
  "have",
  "your",
  "what",
  "when",
  "will",
  "each",
  "than",
  "then",
  "them",
  "these",
  "those",
]);

function tokenize(text: string): Set<string> {
  const raw = text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\s+./-]/g, " ");
  const set = new Set<string>();
  for (const w of raw.split(/\s+/)) {
    const t = w.replace(/^\.+|\.+$/g, "").trim();
    if (t.length < 3 || STOP.has(t)) continue;
    set.add(t);
  }
  return set;
}

function jaccard100(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const u = a.size + b.size - inter;
  return u === 0 ? 0 : Math.round((100 * inter) / u);
}

function brief(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

export function extractCorrectAnswerHint(feedbackText: string): string | undefined {
  const t = feedbackText.replace(/\s+/g, " ");
  const patterns: RegExp[] = [
    /the\s+correct\s+answer\s+is\s*[:\s]?\s*([^\n]+?)(?=\n|$|NEXT|Previous|SUBMIT)/i,
    /correct\s+answer\s*[:\s]\s*([^\n]+?)(?=\n|$|NEXT|Previous)/i,
    /answer\s*[:\s]\s*([A-D])\s*[.)]\s*([^\n]{3,120})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const slice =
        m.length >= 3 && /^[A-D]$/i.test((m[1] ?? "").trim())
          ? `${m[1]}. ${(m[2] ?? "").trim()}`
          : (m[1] ?? "").trim();
      if (slice.length >= 2) return brief(slice, 420);
    }
  }
  return undefined;
}

/** Call immediately after each successful solver submit (paired with next feedback step). */
export function rememberQuizSubmitForLearning(meta: Omit<PendingSubmit, "retrievalMeta"> & { retrievalMeta?: LearningRetrievalMeta }): void {
  if (disabled()) return;
  pending = { ...meta };
}

/**
 * After `consumeQuizFeedbackObservation`, pair platform outcome with the last remembered submit
 * and append one JSONL record.
 */
export async function commitQuizLearningFromFeedback(obs: Observation): Promise<void> {
  if (disabled() || !pending) return;
  if (!obs.feedbackVisible || !obs.feedbackOutcome) return;

  const outcome = obs.feedbackOutcome;
  const feedbackBlob = obs.quizFeedbackTextSample ?? "";
  const platformHint =
    outcome === "incorrect" ? extractCorrectAnswerHint(feedbackBlob) : undefined;

  const chosenParts: string[] = [];
  if (pending.choiceIndices && pending.choiceIndices.length > 0) {
    for (const i of pending.choiceIndices) {
      const c = pending.choices[i];
      if (c) chosenParts.push(`${i}:${brief(c, 120)}`);
    }
  } else if (pending.choiceIndex != null) {
    const c = pending.choices[pending.choiceIndex];
    chosenParts.push(
      c ? `${pending.choiceIndex}:${brief(c, 120)}` : String(pending.choiceIndex)
    );
  }

  const questionBrief = brief(pending.question, 900);
  const choicesBrief = brief(pending.choices.join(" | "), 600);

  const rm = pending.retrievalMeta;
  const memoryHit = rm ? (rm.incorrectMatches + rm.correctMatches) > 0 : false;

  const rec: QuizLearningRecord = {
    ts: Date.now(),
    subject: pending.subject,
    quizCode: pending.quizCode,
    outcome,
    questionBrief,
    choicesBrief,
    chosenSummary: chosenParts.join("; ") || "?",
    ...(platformHint ? { platformHint } : {}),
    ...(memoryHit
      ? {
          memoryHit: true,
          priorIncorrectMatches: rm!.incorrectMatches,
          priorCorrectMatches: rm!.correctMatches,
        }
      : {}),
  };

  if (ollamaEmbeddingsConfigured()) {
    const vec = await embedTextOllama(`${questionBrief}\n${choicesBrief}`);
    if (vec) rec.emb = vec;
    else if (process.env.QUIZ_LEARNING_DEBUG === "1") {
      console.warn("[quiz-learning] Ollama embedding unavailable — stored row without emb (Jaccard retrieval only for this row).");
    }
  }

  try {
    mkdirSync(dirname(JSONL_FILE), { recursive: true });
    appendFileSync(JSONL_FILE, JSON.stringify(rec) + "\n", "utf-8");
  } catch (e) {
    console.warn("[quiz-learning] append failed:", (e as Error).message);
  }

  pending = null;
}

function readTailRecords(): QuizLearningRecord[] {
  if (!existsSync(JSONL_FILE)) return [];
  let lines: string[];
  try {
    const raw = readFileSync(JSONL_FILE, "utf-8");
    lines = raw.trim().split(/\n/).filter(Boolean);
  } catch {
    return [];
  }
  const tail = lines.slice(-TAIL_LINES);
  const out: QuizLearningRecord[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as QuizLearningRecord);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export type BuildLearningPromptOptions = {
  subject?: string;
  quizCode?: string;
  maxChars?: number;
  /** Extra incorrect items to prefer beyond top similar. */
  topIncorrect?: number;
};

/** Metadata returned alongside the prompt block so callers can log/stamp it. */
export type LearningRetrievalMeta = {
  /** Total past records scanned (after subject filter). */
  totalScanned: number;
  /** Number of incorrect-outcome records injected into the prompt. */
  incorrectMatches: number;
  /** Number of correct-outcome records injected into the prompt. */
  correctMatches: number;
};

export type BuildLearningPromptResult = {
  block: string;
  meta: LearningRetrievalMeta;
};

const EMPTY_META: LearningRetrievalMeta = { totalScanned: 0, incorrectMatches: 0, correctMatches: 0 };

/**
 * Build a short block for Claude (text + vision): similar past mistakes and confirmed patterns.
 * Uses Ollama embeddings when available (query + stored `emb`), else token Jaccard.
 * Returns both the prompt block and retrieval metadata (match counts) for logging/stamping.
 */
export async function buildLearningContextForPrompt(
  question: string,
  choices: string[],
  options: BuildLearningPromptOptions = {}
): Promise<BuildLearningPromptResult> {
  if (disabled()) return { block: "", meta: EMPTY_META };
  const maxChars = options.maxChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const topIncorrectN = options.topIncorrect ?? 4;
  const code = normCode(options.quizCode);

  const blob = `${question}\n${choices.join("\n")}`;
  const tokCurrent = tokenize(blob);
  if (tokCurrent.size < 2) return { block: "", meta: EMPTY_META };

  const records = readTailRecords();
  if (records.length === 0) return { block: "", meta: EMPTY_META };

  const queryVec = ollamaEmbeddingsConfigured() ? await embedTextOllama(blob) : null;
  if (ollamaEmbeddingsConfigured() && !queryVec && process.env.QUIZ_LEARNING_DEBUG === "1") {
    console.warn("[quiz-learning] Ollama embedding failed for current question — using Jaccard only for retrieval.");
  }

  type Scored = { rec: QuizLearningRecord; score: number };
  const scored: Scored[] = [];
  let scanned = 0;
  for (const rec of records) {
    if (!subjectMatches(rec.subject, options.subject)) continue;
    scanned++;
    const tokPast = tokenize(`${rec.questionBrief}\n${rec.choicesBrief}`);
    const jac = jaccard100(tokCurrent, tokPast);
    let score: number;
    if (
      queryVec &&
      rec.emb &&
      rec.emb.length === queryVec.length
    ) {
      const cos = cosineSimilarity(queryVec, rec.emb);
      if (cos < MIN_EMBEDDING_COSINE) continue;
      score = Math.round(cos * 100) + Math.min(10, Math.floor(jac / 5));
    } else {
      score = jac;
      if (score < MIN_SIMILARITY) continue;
    }
    if (code && normCode(rec.quizCode) === code) score += 18;
    if (rec.outcome === "incorrect") score += 6;
    scored.push({ rec, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const pickedIncorrect: QuizLearningRecord[] = [];
  const pickedCorrect: QuizLearningRecord[] = [];
  for (const { rec } of scored) {
    if (rec.outcome === "incorrect" && pickedIncorrect.length < topIncorrectN) {
      pickedIncorrect.push(rec);
    } else if (rec.outcome === "correct" && pickedCorrect.length < 3) {
      pickedCorrect.push(rec);
    }
    if (pickedIncorrect.length >= topIncorrectN && pickedCorrect.length >= 3) break;
  }

  const meta: LearningRetrievalMeta = {
    totalScanned: scanned,
    incorrectMatches: pickedIncorrect.length,
    correctMatches: pickedCorrect.length,
  };

  if (pickedIncorrect.length === 0 && pickedCorrect.length === 0) return { block: "", meta };

  const lines: string[] = [
    "Learnings from earlier runs on this machine (same subject when noted; quiz questions are often reworded — match concepts, not wording):",
  ];
  for (const rec of pickedIncorrect) {
    const tag = [rec.subject, rec.quizCode].filter(Boolean).join(" · ");
    const hint = rec.platformHint ? ` Platform feedback: ${rec.platformHint}` : "";
    lines.push(
      `- [${tag || "quiz"}] Similar topic — you chose: ${rec.chosenSummary}.${hint} Question context was: ${brief(rec.questionBrief, 320)}`
    );
  }
  for (const rec of pickedCorrect) {
    const tag = [rec.subject, rec.quizCode].filter(Boolean).join(" · ");
    lines.push(
      `- [${tag || "quiz"}] Confirmed-correct pattern: ${brief(rec.questionBrief, 280)}`
    );
  }
  lines.push(
    "Use these only when the underlying idea clearly applies; letter positions (A/B/C/D) on this screen may differ from past screens."
  );

  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(0, maxChars - 1) + "…";
  return { block, meta };
}

/** Clear pending (e.g. safe exit mid-quiz) — optional hook */
export function clearQuizLearningPending(): void {
  pending = null;
}
