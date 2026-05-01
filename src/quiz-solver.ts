/**
 * Quiz flow: extract question + choices, classify, solve with Claude, return answer with confidence.
 * Low confidence → ask for help / skip / flag for review.
 *
 * Two modes:
 * - Text: question + choices[] → Claude → choiceIndex (when DOM extraction gives choices).
 * - Vision: screenshot → Claude (image + prompt) → choiceIndex (when DOM gives 0 choices or useVisionQuiz).
 */

import { readFileSync } from "node:fs";
import type { Observation } from "./types.js";
import type { IUIDriver } from "./driver.js";
import { getOllamaHost } from "./quiz-learning-ollama.js";
import {
  getQuizLocalAcceptConfidence,
  getOllamaQuizModelFromEnv,
  getSubjectPreset,
  isQuizLocalFirstEnabled,
  normalizeSubjectKey,
  type SubjectKey,
} from "./subject-profiles.js";

/** `screenshot()` / `screenshotForQuizVision()` may return a PNG path (string) or raw bytes. */
function bufferFromDriverScreenshot(out: string | Buffer): Buffer {
  if (Buffer.isBuffer(out)) return out;
  return readFileSync(out);
}

export interface QuizSolverResult {
  /** Single-select: index of the one correct option (0-based). */
  choiceIndex: number;
  /** Multi-select ("select all that apply"): all correct indices; when set, use these instead of choiceIndex. */
  choiceIndices?: number[];
  confidence: number; // 0..1
  reasoning?: string;
  flagForReview: boolean;
}

export interface IQuizSolver {
  solve(obs: Observation): Promise<QuizSolverResult>;
}

/**
 * Vision model reports it still cannot see the full stem + all choices. `solveQuizWithVision` may retry with
 * full-page or other capture modes; callers should still avoid submitting on this reasoning when it remains
 * after those internal retries.
 */
export function isIncompleteQuizVisionResponse(reasoning: string | undefined): boolean {
  if (!reasoning) return false;
  const s = reasoning.trim();
  if (/^INCOMPLETE_VIEWPORT/i.test(s)) return true;
  const lower = s.toLowerCase();
  if (lower.includes("incomplete_viewport")) return true;
  const needles = [
    "only one option",
    "only one answer",
    "only option a is visible",
    "only answer choice",
    "only one answer choice",
    "not all choices",
    "cannot see all",
    "can't see all",
    "other options are not visible",
    "other answer choices are not",
    "partially visible",
    "incomplete screenshot",
    "not visible in the screenshot",
  ];
  return needles.some((n) => lower.includes(n));
}

/** True when the Anthropic API rejected the call (billing, invalid key, rate limit) — do not retry the same path in a tight loop. */
export function isAnthropicAccessError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("credit balance") ||
    m.includes("too low to access") ||
    m.includes("invalid_request_error") ||
    m.includes("authentication") ||
    m.includes("api_key") ||
    m.includes("rate_limit") ||
    m.includes("overloaded") ||
    /\b401\b/.test(m) ||
    /\b402\b/.test(m) ||
    /\b403\b/.test(m) ||
    /\b429\b/.test(m)
  );
}

/** Heuristic: question requires multiple answers (checkboxes), not one radio. */
export function inferQuizMultiSelect(question: string): boolean {
  const q = question.normalize("NFKC").toLowerCase();
  if (
    /select all that apply/.test(q) ||
    /choose all that apply/.test(q) ||
    /check all that apply/.test(q) ||
    /select each (answer|option)/.test(q) ||
    /mark all (that are|which)/.test(q) ||
    /which of the following .{0,40}(select|choose) (two|three|all|multiple)/.test(q) ||
    /\b(select|choose)\s+(two|three|four)\b/.test(q) ||
    /indicate all (correct|true)/.test(q)
  ) {
    return true;
  }
  return false;
}

/** Extract question and choices from observation (from your UI parser). */
export function extractQuiz(obs: Observation): {
  question: string;
  choices: string[];
  multiSelect: boolean;
  passage?: string;
} | null {
  if (obs.state !== "QUIZ_SCREEN") return null;
  const choices = obs.choices ?? [];
  if (choices.length === 0) return null;
  const passage = (obs.quizPassageText ?? "").trim();
  const question = (obs.questionText ?? "").trim() || "Select the best answer from the choices below.";
  const multiSelect = obs.quizMultiSelect === true || inferQuizMultiSelect(question);
  return { question, choices, multiSelect, ...(passage ? { passage } : {}) };
}

/** Combine passage + stem for model prompts (caps passage length). */
export function buildQuizPromptStem(question: string, passage?: string): string {
  const p = (passage ?? "").trim();
  if (!p) return question;
  const cap = 10_000;
  const body = p.length > cap ? p.slice(0, cap) + "\n…" : p;
  return `=== READING PASSAGE / CONTEXT ===\n${body}\n\n=== QUESTION ===\n${question}`;
}

/** Dedupe, sort, clamp indices to [0, maxIdx]. */
export function normalizeChoiceIndices(indices: number[], numChoices: number): number[] {
  const maxIdx = Math.max(0, numChoices - 1);
  return [...new Set(indices.map((i) => Math.floor(i)).filter((i) => i >= 0 && i <= maxIdx))].sort((a, b) => a - b);
}

export type SolveWithClaudeOptions = {
  /** Long reading passage when split from stem in the DOM. */
  passage?: string;
  /** Extra instruction block (e.g. subject-specific nudge). */
  subjectNudge?: string;
};

/**
 * Claude-based solver (prefer Claude 4.5 Sonnet).
 * Uses API key from config (env ANTHROPIC_API_KEY or config.local.json).
 */
export async function solveWithClaude(
  question: string,
  choices: string[],
  subjectHint?: string,
  /** From parser or extractQuiz; false = force single-choice prompt only. */
  multiSelectHint?: boolean,
  /** Optional: similar past items + platform feedback from quiz-learning-memory. */
  learningContext?: string,
  options?: SolveWithClaudeOptions
): Promise<QuizSolverResult> {
  const { getAnthropicApiKey } = await import("./config.js");
  const key = getAnthropicApiKey();
  if (!key || key.length < 20) {
    console.log("[Quiz] API key missing or too short — check ANTHROPIC_API_KEY or config.local.json");
    return {
      choiceIndex: 0,
      confidence: 0,
      flagForReview: true,
      reasoning: "ANTHROPIC_API_KEY not set or invalid",
    };
  }

  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });

  const multiSelect =
    multiSelectHint === true || (multiSelectHint !== false && inferQuizMultiSelect(question));
  const learnBlock =
    learningContext && learningContext.trim().length > 0
      ? `\n\n${learningContext.trim()}\n`
      : "";

  const stem = buildQuizPromptStem(question, options?.passage);
  const nudge = options?.subjectNudge?.trim() ? `\n${options.subjectNudge.trim()}\n` : "";

  const accuracyNote = `\nAccuracy: Use only evidence from the passage (if any), question, and choices. For reading passages, tie the answer to explicit text. Eliminate distractors that contradict the stem. Prefer the precise course-level interpretation over loose paraphrases.\n`;

  const prompt = multiSelect
    ? `You are a precise quiz solver for MULTI-SELECT questions ("select all that apply" style). You must identify EVERY correct option. Indices are 0-based (0 = first choice, 1 = second, ...).

Only set flagForReview true when you are genuinely unsure (confidence < 0.7) or the question is ambiguous.
${accuracyNote}
${nudge}Stem:
${stem}
Choices:
${choices.map((c, i) => `${i}: ${c}`).join("\n")}
${subjectHint ? `Subject hint: ${subjectHint}` : ""}${learnBlock}

Rules:
- Include in choiceIndices ONLY options that are correct. Do not omit a correct option. Do not include an incorrect option.
- Sort choiceIndices ascending in the JSON.
- If exactly one option is correct, still use choiceIndices with one element (e.g. [2]).

You must respond with ONLY a single JSON object, no other text. Example:
{"choiceIndices":[0,2],"confidence":0.95,"reasoning":"A and C are correct because ...","flagForReview":false}`
    : `You are a precise quiz solver. Answer with the best choice index (0-based) and confidence (0.0 to 1.0).
Only set flagForReview true when you are genuinely unsure (confidence < 0.7) or the question is ambiguous. If you are reasonably sure (confidence >= 0.7), set flagForReview false so the answer can be submitted.
${accuracyNote}
${nudge}Stem:
${stem}
Choices:
${choices.map((c, i) => `${i}: ${c}`).join("\n")}
${subjectHint ? `Subject hint: ${subjectHint}` : ""}${learnBlock}

You must respond with ONLY a single JSON object, no other text or explanation. Example:
{"choiceIndex": 0, "confidence": 0.95, "reasoning": "Product of radicals simplifies to sqrt(7x(x+2)) = sqrt(7x²+14x)", "flagForReview": false}`;

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: multiSelect ? 512 : 256,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = (msg.content as { type: "text"; text: string }[])[0]?.text ?? "";
    let text = raw.replace(/```json?\s*|\s*```/g, "").trim();
    // If model returned prose, extract the first JSON object
    if (!text.startsWith("{")) {
      const start = raw.indexOf("{");
      if (start >= 0) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < raw.length; i++) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > start) text = raw.slice(start, end + 1);
      }
    }
    const json = JSON.parse(text) as {
      choiceIndex?: number;
      choiceIndices?: number[];
      confidence?: number;
      reasoning?: string;
      flagForReview?: boolean;
    };
    const confidence = Math.max(0, Math.min(1, json.confidence ?? 0));
    const flagFromModel = json.flagForReview ?? confidence < 0.7;
    if (multiSelect && !Array.isArray(json.choiceIndices) && json.choiceIndex != null) {
      json.choiceIndices = [json.choiceIndex];
    }
    if (multiSelect && Array.isArray(json.choiceIndices) && json.choiceIndices.length > 0) {
      const normalized = normalizeChoiceIndices(json.choiceIndices, choices.length);
      if (normalized.length === 0) {
        return {
          choiceIndex: 0,
          confidence: 0,
          flagForReview: true,
          reasoning: "Model returned empty choiceIndices after normalization",
        };
      }
      return {
        choiceIndex: normalized[0]!,
        choiceIndices: normalized,
        confidence,
        reasoning: json.reasoning,
        flagForReview: confidence >= 0.75 ? false : flagFromModel,
      };
    }
    return {
      choiceIndex: Math.max(0, Math.min(json.choiceIndex ?? 0, choices.length - 1)),
      confidence,
      reasoning: json.reasoning,
      flagForReview: confidence >= 0.75 ? false : flagFromModel,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[Quiz] Solver API error:", msg.slice(0, 120));
    return {
      choiceIndex: 0,
      confidence: 0,
      flagForReview: true,
      reasoning: msg,
    };
  }
}

const OLLAMA_QUIZ_TIMEOUT_MS = Math.min(120_000, Math.max(15_000, parseInt(process.env.OLLAMA_QUIZ_TIMEOUT_MS ?? "60000", 10) || 60_000));

async function solveWithOllamaChat(
  question: string,
  choices: string[],
  multiSelect: boolean,
  learningContext: string | undefined,
  options?: SolveWithClaudeOptions
): Promise<QuizSolverResult> {
  const model = getOllamaQuizModelFromEnv();
  if (!model) {
    return { choiceIndex: 0, confidence: 0, flagForReview: true, reasoning: "OLLAMA_QUIZ_MODEL not set" };
  }
  const stem = buildQuizPromptStem(question, options?.passage);
  const nudge = options?.subjectNudge?.trim() ? `\n${options.subjectNudge.trim()}\n` : "";
  const learnBlock =
    learningContext && learningContext.trim().length > 0 ? `\n\n${learningContext.trim()}\n` : "";
  const accuracyNote = `Use only the passage (if any), stem, and choices. Respond with ONLY one JSON object.\n`;

  const prompt = multiSelect
    ? `You are a quiz solver for multi-select. Indices 0-based.
${accuracyNote}${nudge}Stem:\n${stem}\nChoices:\n${choices.map((c, i) => `${i}: ${c}`).join("\n")}${learnBlock}
Return JSON: {"choiceIndices":[0,2],"confidence":0.9,"reasoning":"...","flagForReview":false}`
    : `You are a quiz solver. Pick one choice index 0-based and confidence 0..1.
${accuracyNote}${nudge}Stem:\n${stem}\nChoices:\n${choices.map((c, i) => `${i}: ${c}`).join("\n")}${learnBlock}
Return JSON: {"choiceIndex":0,"confidence":0.9,"reasoning":"...","flagForReview":false}`;

  const host = getOllamaHost();
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), OLLAMA_QUIZ_TIMEOUT_MS);
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.15, num_predict: multiSelect ? 512 : 384 },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    clearTimeout(to);
    if (!res.ok) {
      return {
        choiceIndex: 0,
        confidence: 0,
        flagForReview: true,
        reasoning: `Ollama HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content ?? "";
    let text = raw.replace(/```json?\s*|\s*```/g, "").trim();
    if (!text.startsWith("{")) {
      const start = raw.indexOf("{");
      if (start >= 0) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < raw.length; i++) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (end > start) text = raw.slice(start, end + 1);
      }
    }
    const json = JSON.parse(text) as {
      choiceIndex?: number;
      choiceIndices?: number[];
      confidence?: number;
      reasoning?: string;
      flagForReview?: boolean;
    };
    const confidence = Math.max(0, Math.min(1, json.confidence ?? 0));
    const flagFromModel = json.flagForReview ?? confidence < 0.7;
    if (multiSelect && Array.isArray(json.choiceIndices) && json.choiceIndices.length > 0) {
      const normalized = normalizeChoiceIndices(json.choiceIndices, choices.length);
      if (normalized.length === 0) {
        return { choiceIndex: 0, confidence: 0, flagForReview: true, reasoning: "Ollama empty choiceIndices" };
      }
      return {
        choiceIndex: normalized[0]!,
        choiceIndices: normalized,
        confidence,
        reasoning: json.reasoning ?? "ollama",
        flagForReview: confidence >= 0.75 ? false : flagFromModel,
      };
    }
    return {
      choiceIndex: Math.max(0, Math.min(json.choiceIndex ?? 0, choices.length - 1)),
      confidence,
      reasoning: json.reasoning ?? "ollama",
      flagForReview: confidence >= 0.75 ? false : flagFromModel,
    };
  } catch (e) {
    clearTimeout(to);
    const msg = e instanceof Error ? e.message : String(e);
    return { choiceIndex: 0, confidence: 0, flagForReview: true, reasoning: `ollama:${msg.slice(0, 200)}` };
  }
}

export type QuizTextSolverRoute = "local" | "cloud";

/**
 * Optional local-first (Ollama) then Claude when confidence is low or review flagged.
 * Set OLLAMA_QUIZ_MODEL and QUIZ_LOCAL_FIRST=1 (default when model is set).
 */
export async function solveQuizTextRouted(params: {
  question: string;
  passage?: string;
  choices: string[];
  multiSelect: boolean;
  learningBlock: string;
  targetSubject?: string;
}): Promise<QuizSolverResult & { solverRoute: QuizTextSolverRoute }> {
  const key: SubjectKey = normalizeSubjectKey(params.targetSubject);
  const preset = getSubjectPreset(key);
  const opts: SolveWithClaudeOptions = {
    passage: params.passage,
    subjectNudge: preset.textPromptNudge || undefined,
  };

  const tryLocal = isQuizLocalFirstEnabled();
  const accept = getQuizLocalAcceptConfidence();

  if (tryLocal) {
    const local = await solveWithOllamaChat(
      params.question,
      params.choices,
      params.multiSelect,
      params.learningBlock,
      opts
    );
    if (local.confidence >= accept && !local.flagForReview) {
      console.log("[Quiz] Routed: local Ollama accepted (confidence=" + local.confidence + " >= " + accept + ")");
      return { ...local, solverRoute: "local" };
    }
    console.log(
      "[Quiz] Routed: escalating to Claude (local conf=" + local.confidence + ", flag=" + local.flagForReview + ")"
    );
  }

  const cloud = await solveWithClaude(
    params.question,
    params.choices,
    params.targetSubject,
    params.multiSelect,
    params.learningBlock,
    opts
  );
  return { ...cloud, solverRoute: "cloud" };
}

const VISION_QUIZ_PROMPT = `You are looking at screenshot(s) of a quiz question on a learning platform (e.g. Apex, Edmentum). Options may be labeled A, B, C, D, E, F or numbered.

Your task: answer the CURRENT question only. Reason carefully.

CRITICAL RULES:
- When MULTIPLE images are provided, they are the SAME page at different scroll positions (top → bottom). Read ALL images together: the stem may start in an early image and choices B–D may appear only in a later image.
- You MUST infer the FULL question stem AND ALL labeled answer choices before answering. If after reviewing EVERY image ANY choice is still missing or unreadable — do NOT guess. Return EXACTLY this JSON and nothing else:
  {"choiceIndex":0,"confidence":0,"reasoning":"INCOMPLETE_VIEWPORT: explain briefly what is missing"}
- Do not pick an answer when reasoning would be INCOMPLETE_VIEWPORT — that wastes credits on a blind guess.
- For reading comprehension, ground the answer in the passage shown; eliminate choices that contradict it.
- IGNORE any "Incorrect", "Correct", "The correct answer is", or checkmarks/X marks — those are feedback from a PREVIOUS question.
- If the question asks you to select MORE THAN ONE answer (e.g. "Select all that apply", "Choose all correct", checkboxes), you MUST return choiceIndices with EVERY correct option index (0 = first option, 1 = second, ...). Sort indices ascending. Do not omit a correct option; do not include a wrong one.
- If only ONE answer is correct (typical radio / single choice), return choiceIndex only (0-based).
- For math: be precise. √(3x) and x√3 are NOT equivalent in general.

Output format: your entire reply must be a single JSON object. Do not write a sentence, greeting, or explanation before or after the JSON. If no quiz is visible, use: {"choiceIndex":0,"confidence":0,"reasoning":"no quiz visible"}

Reply with ONLY one JSON object, no other text. Use ONE of these shapes:

Single-select:
{"choiceIndex": 0, "confidence": 0.9, "reasoning": "brief reason"}

Multi-select:
{"choiceIndices": [0, 2], "confidence": 0.9, "reasoning": "brief reason"}

- confidence: 0.0 to 1.0. Use lower values when unsure.`;

/** First balanced {...} in model output (handles leading prose like "I can see..." or markdown fences). */
function extractFirstJsonObject(raw: string): string | null {
  const cleaned = raw.replace(/```json?\s*|\s*```/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

type VisionCaptureMode = "multi-viewport" | "full-page" | "viewport";

async function captureQuizVisionBuffers(
  driver: IUIDriver,
  mode: VisionCaptureMode
): Promise<Buffer[] | null> {
  try {
    if (mode === "multi-viewport" && typeof driver.captureQuizVisionShots === "function") {
      const arr = await driver.captureQuizVisionShots();
      const out = arr.map((x) => bufferFromDriverScreenshot(x)).filter((b) => b.length > 0);
      return out.length ? out : null;
    }
    if (mode === "full-page" && typeof driver.screenshotForQuizVision === "function") {
      const out = await driver.screenshotForQuizVision();
      const buf = bufferFromDriverScreenshot(out);
      return buf.length ? [buf] : null;
    }
    if (mode === "viewport") {
      if (typeof driver.prepareQuizVisionCapture === "function") {
        await driver.prepareQuizVisionCapture();
      }
      const out = await driver.screenshot();
      const buf = bufferFromDriverScreenshot(out);
      return buf.length ? [buf] : null;
    }
    return null;
  } catch (e) {
    console.log("[Quiz] Vision: capture failed (" + mode + ")", (e as Error)?.message ?? e);
    return null;
  }
}

function visionJsonToResult(json: {
  choiceIndex?: number;
  choiceIndices?: number[];
  confidence?: number;
  reasoning?: string;
}): QuizSolverResult {
  const maxIdx = 12;
  const confidence = Math.max(0, Math.min(1, json.confidence ?? 0));
  const reasonText = json.reasoning ?? "";
  if (isIncompleteQuizVisionResponse(reasonText)) {
    console.log("[Quiz] Vision: incomplete viewport in model reasoning.", reasonText.slice(0, 120));
    return {
      choiceIndex: 0,
      confidence: 0,
      flagForReview: true,
      reasoning: reasonText || "INCOMPLETE_VIEWPORT",
    };
  }
  if (Array.isArray(json.choiceIndices) && json.choiceIndices.length > 0) {
    const normalized = normalizeChoiceIndices(json.choiceIndices, maxIdx + 1);
    if (normalized.length === 0) {
      return { choiceIndex: 0, confidence: 0, flagForReview: true, reasoning: "Empty choiceIndices from vision" };
    }
    console.log(
      "[Quiz] Vision multi: choiceIndices=" + JSON.stringify(normalized),
      "confidence=" + confidence,
      json.reasoning?.slice(0, 60)
    );
    return {
      choiceIndex: normalized[0]!,
      choiceIndices: normalized,
      confidence,
      reasoning: json.reasoning,
      flagForReview: confidence < 0.5,
    };
  }
  const choiceIndex = Math.max(0, Math.min(json.choiceIndex ?? 0, maxIdx));
  console.log("[Quiz] Vision: choiceIndex=" + choiceIndex, "confidence=" + confidence, json.reasoning?.slice(0, 60));
  return {
    choiceIndex,
    confidence,
    reasoning: json.reasoning,
    flagForReview: confidence < 0.5,
  };
}

/**
 * Solve the quiz by sending screenshot(s) to Claude (vision). Prefers multi-viewport captures when the driver
 * implements them, then full-page, then a single viewport — retries with the next strategy when the model
 * returns INCOMPLETE_VIEWPORT.
 * Requires driver.screenshot() and ANTHROPIC_API_KEY.
 */
export async function solveQuizWithVision(
  driver: IUIDriver,
  multiSelectHint?: boolean,
  learningContext?: string,
  /** Subject-specific hint (e.g. English vs Algebra) appended to the vision system prompt. */
  subjectVisionExtra?: string
): Promise<QuizSolverResult> {
  const { getAnthropicApiKey } = await import("./config.js");
  const key = getAnthropicApiKey();
  if (!key || key.length < 20) {
    console.log("[Quiz] Vision: API key missing — check ANTHROPIC_API_KEY");
    return { choiceIndex: 0, confidence: 0, flagForReview: true, reasoning: "API key missing" };
  }

  const visionHint =
    multiSelectHint === true
      ? "\n\nThe parser flagged this as multi-select — prefer returning choiceIndices if the screen shows checkboxes or 'select all that apply'."
      : multiSelectHint === false
        ? "\n\nAssume single-select unless the visible wording clearly requires multiple answers."
        : "";
  const learnVision =
    learningContext && learningContext.trim().length > 0
      ? "\n\n" +
        learningContext.trim() +
        "\n\nApply these learnings only when the visible question clearly involves the same concepts; choice indices still refer to this question's options in order across all images."
      : "";
  const subVision =
    subjectVisionExtra && subjectVisionExtra.trim().length > 0 ? "\n\n" + subjectVisionExtra.trim() : "";
  const userText = VISION_QUIZ_PROMPT + visionHint + learnVision + subVision;

  const modes: VisionCaptureMode[] = [];
  if (typeof driver.captureQuizVisionShots === "function") modes.push("multi-viewport");
  if (typeof driver.screenshotForQuizVision === "function") modes.push("full-page");
  modes.push("viewport");

  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });

  let lastResult: QuizSolverResult | undefined;
  let anyCapture = false;

  for (const mode of modes) {
    const buffers = await captureQuizVisionBuffers(driver, mode);
    if (!buffers || buffers.length === 0) continue;
    anyCapture = true;
    console.log("[Quiz] Vision: calling model with " + buffers.length + " image(s), capture=" + mode);

    try {
      const content = buffers.map((buf) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png" as const,
          data: buf.toString("base64"),
        },
      }));
      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: [...content, { type: "text" as const, text: userText }],
          },
        ],
      });
      const raw = (msg.content as { type: "text"; text: string }[])[0]?.text ?? "";
      const text = extractFirstJsonObject(raw);
      if (!text) {
        console.log("[Quiz] Vision: no JSON object in model response");
        return {
          choiceIndex: 0,
          confidence: 0,
          flagForReview: true,
          reasoning: "No JSON object in vision response",
        };
      }
      const json = JSON.parse(text) as {
        choiceIndex?: number;
        choiceIndices?: number[];
        confidence?: number;
        reasoning?: string;
      };
      const parsed = visionJsonToResult(json);
      lastResult = parsed;
      if (!isIncompleteQuizVisionResponse(parsed.reasoning)) {
        return parsed;
      }
      const next = modes[modes.indexOf(mode) + 1];
      if (next) {
        console.warn(
          "[Quiz] Vision: incomplete after " + mode + " — retrying with " + next + " (same question)."
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("[Quiz] Vision API error:", msg.slice(0, 120));
      return {
        choiceIndex: 0,
        confidence: 0,
        flagForReview: true,
        reasoning: msg,
      };
    }
  }

  if (!anyCapture) {
    console.log("[Quiz] Vision: every capture mode failed or produced empty buffers");
    return {
      choiceIndex: 0,
      confidence: 0,
      flagForReview: true,
      reasoning: "Screenshot failed",
    };
  }
  return (
    lastResult ?? {
      choiceIndex: 0,
      confidence: 0,
      flagForReview: true,
      reasoning: "INCOMPLETE_VIEWPORT: no parseable result",
    }
  );
}

/** Pixel coords for A/B/C/D and Submit from a quiz screenshot. C and D are optional (2-choice e.g. True/False). */
export type QuizClickCoords = {
  A: { x: number; y: number };
  B: { x: number; y: number };
  C?: { x: number; y: number };
  D?: { x: number; y: number };
  Submit: { x: number; y: number };
};

const VISION_COORDS_PROMPT = `This image is a screenshot of a quiz (viewport 1280x720 pixels). Answer options and layout vary: there may be 2 options (e.g. True/False), 3, or 4 (A–D). Positions change from question to question.

Your task: look at the image and assess where each visible answer option and the Submit button actually are. Return the pixel coordinates of the center of each clickable area.

Rules:
- Return ONLY a JSON object. Use integer x,y in pixels.
- Include "A" and "B" for the first two options (they are always present).
- Include "C" and "D" only if a third/fourth option is visible.
- Always include "Submit" for the submit button.
- Measure from the image: do not assume fixed positions. Y coordinates and spacing vary (e.g. 2-choice vs 4-choice layouts).
Example 2 options: {"A":{"x":390,"y":340},"B":{"x":390,"y":380},"Submit":{"x":640,"y":560}}
Example 4 options: {"A":{"x":390,"y":377},"B":{"x":390,"y":419},"C":{"x":390,"y":460},"D":{"x":390,"y":501},"Submit":{"x":640,"y":560}}`;

/**
 * Send screenshot to Claude and get back (x,y) for A, B, C, D, Submit. Use when element/coord click fails.
 */
export async function getQuizClickCoordinatesFromScreenshot(screenshotBuffer: Buffer): Promise<QuizClickCoords | null> {
  const { getAnthropicApiKey } = await import("./config.js");
  const key = getAnthropicApiKey();
  if (!key || key.length < 20) return null;
  const base64 = screenshotBuffer.toString("base64");
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: base64 } },
            { type: "text" as const, text: VISION_COORDS_PROMPT },
          ],
        },
      ],
    });
    const raw = (msg.content as { type: "text"; text: string }[])[0]?.text ?? "";
    const text = extractFirstJsonObject(raw);
    if (!text) return null;
    const json = JSON.parse(text) as Record<string, { x?: number; y?: number }>;
    const get = (k: string) => {
      const v = json[k];
      return v && typeof v.x === "number" && typeof v.y === "number" ? { x: Math.round(v.x), y: Math.round(v.y) } : null;
    };
    const A = get("A"), B = get("B"), C = get("C"), D = get("D"), Submit = get("Submit");
    if (A && B && Submit) return { A, B, ...(C ? { C } : {}), ...(D ? { D } : {}), Submit };
  } catch (_) {}
  return null;
}
