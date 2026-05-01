/**
 * Optional Ollama embeddings for quiz-learning retrieval (semantic similarity).
 *
 * Env:
 * - QUIZ_LEARNING_EMBEDDINGS=0 — disable (Jaccard only)
 * - QUIZ_LEARNING_EMBEDDING_MODEL — default nomic-embed-text
 * - OLLAMA_HOST — default http://127.0.0.1:11434
 * - QUIZ_LEARNING_OLLAMA_AUTOSTART=0 — do not spawn `ollama serve` when localhost is unreachable
 */

import { spawn } from "child_process";

const DEFAULT_HOST = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const MAX_PROMPT_CHARS = 12_000;

export function ollamaEmbeddingsConfigured(): boolean {
  if (process.env.QUIZ_LEARNING_DISABLED === "1") return false;
  if (process.env.QUIZ_LEARNING_EMBEDDINGS === "0") return false;
  const m = (process.env.QUIZ_LEARNING_EMBEDDING_MODEL ?? DEFAULT_MODEL).trim();
  return m.length > 0;
}

export function getOllamaEmbeddingModel(): string {
  return (process.env.QUIZ_LEARNING_EMBEDDING_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

export function getOllamaHost(): string {
  const h = process.env.OLLAMA_HOST?.trim();
  if (!h) return DEFAULT_HOST;
  return h.replace(/\/+$/, "");
}

/** True when host is loopback — safe to try spawning a local `ollama serve`. */
function isLocalOllamaHost(host: string): boolean {
  try {
    const u = new URL(host.includes("://") ? host : `http://${host}`);
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

let ollamaServeSpawnAttempted = false;

/**
 * If Ollama isn’t running, start `ollama serve` once (Windows/macOS/Linux when `ollama` is on PATH).
 * Skipped when QUIZ_LEARNING_OLLAMA_AUTOSTART=0 or OLLAMA_HOST is not loopback.
 */
function trySpawnOllamaServeInBackground(host: string): void {
  if (ollamaServeSpawnAttempted) return;
  if (process.env.QUIZ_LEARNING_OLLAMA_AUTOSTART === "0") return;
  if (!isLocalOllamaHost(host)) return;
  ollamaServeSpawnAttempted = true;
  try {
    const child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log("[quiz-learning] Ollama not reachable on localhost — started `ollama serve` in the background.");
  } catch {
    console.warn("[quiz-learning] Could not spawn `ollama serve`; start the Ollama app or add `ollama` to PATH.");
  }
}

/** L2-normalized cosine similarity (vectors assumed finite). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length !== a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * Single text → embedding via Ollama. Returns null if disabled, HTTP error, or bad payload.
 */
export async function embedTextOllama(text: string): Promise<number[] | null> {
  if (!ollamaEmbeddingsConfigured()) return null;
  const model = getOllamaEmbeddingModel();
  const host = getOllamaHost();
  const prompt = text.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
  if (prompt.length < 3) return null;

  try {
    const res = await fetch(`${host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding) || json.embedding.length === 0) return null;
    return json.embedding;
  } catch {
    return null;
  }
}

const OLLAMA_WAIT_DEFAULT_MS = 120_000;
const OLLAMA_POLL_MS = 1500;
const OLLAMA_FETCH_MS = 12_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = OLLAMA_FETCH_MS): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const { signal: _ignored, ...rest } = init;
    return await fetch(url, { ...rest, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/** True if /api/tags lists an embedding model matching QUIZ_LEARNING_EMBEDDING_MODEL (e.g. nomic-embed-text / nomic-embed-text:latest). */
export function tagsListIncludesEmbeddingModel(
  tagsJson: { models?: Array<{ name?: string; model?: string }> },
  model: string
): boolean {
  const want = model.trim().toLowerCase().split(/[/:]/)[0] ?? "";
  if (!want) return false;
  for (const m of tagsJson.models ?? []) {
    const n = (m.name ?? m.model ?? "").trim().toLowerCase();
    if (!n) continue;
    const base = n.split(":")[0] ?? n;
    if (base === want || n.startsWith(want + ":")) return true;
  }
  return false;
}

/**
 * Block until Ollama responds and the configured embedding model is installed.
 * No-op if QUIZ_LEARNING_DISABLED=1 or QUIZ_LEARNING_EMBEDDINGS=0.
 *
 * Env: QUIZ_LEARNING_OLLAMA_WAIT_MS — max wait (default 120000).
 * Env: QUIZ_LEARNING_OLLAMA_AUTOSTART=0 — never spawn `ollama serve` for localhost.
 */
export async function ensureOllamaReadyForQuizLearning(): Promise<void> {
  if (!ollamaEmbeddingsConfigured()) return;

  const host = getOllamaHost();
  const model = getOllamaEmbeddingModel();
  const maxWait = parseInt(process.env.QUIZ_LEARNING_OLLAMA_WAIT_MS ?? "", 10);
  const deadline = Date.now() + (Number.isFinite(maxWait) && maxWait > 0 ? maxWait : OLLAMA_WAIT_DEFAULT_MS);

  console.log(`[quiz-learning] Waiting for Ollama at ${host} (embedding model: ${model})…`);

  let lastErr = "";
  let triedAutostart = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${host}/api/tags`, { method: "GET" });
      if (!res.ok) throw new Error(`GET /api/tags → ${res.status}`);
      const j = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      if (!tagsListIncludesEmbeddingModel(j, model)) {
        console.error(
          `[quiz-learning] Ollama is running but model "${model}" is not installed. Run: ollama pull ${model}`
        );
        process.exit(1);
      }
      // Prove embeddings API works (tags alone is not enough on some installs).
      const probe = await fetchWithTimeout(`${host}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "ok" }),
      });
      if (!probe.ok) throw new Error(`POST /api/embeddings → ${probe.status}`);
      const ej = (await probe.json()) as { embedding?: unknown };
      if (!Array.isArray(ej.embedding) || ej.embedding.length === 0) {
        throw new Error("embeddings response missing vector");
      }
      console.log(`[quiz-learning] Ollama ready — ${model} (${(ej.embedding as number[]).length} dims).`);
      return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (!triedAutostart) {
        triedAutostart = true;
        trySpawnOllamaServeInBackground(host);
      }
      await new Promise((r) => setTimeout(r, OLLAMA_POLL_MS));
    }
  }

  const sec = (Number.isFinite(maxWait) && maxWait > 0 ? maxWait : OLLAMA_WAIT_DEFAULT_MS) / 1000;
  console.error(
    `[quiz-learning] Ollama not ready after ${sec}s (${lastErr || "no response"}). Start the Ollama app on this PC or run: ollama serve`
  );
  console.error(`[quiz-learning] Or disable embeddings: set QUIZ_LEARNING_EMBEDDINGS=0`);
  process.exit(1);
}
