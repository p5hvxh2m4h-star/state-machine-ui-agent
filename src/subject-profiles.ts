/**
 * Subject-specific solver behavior: prompt nudges, optional threshold overrides, and local-first routing.
 * One codebase — profiles replace maintaining separate agent binaries per course.
 */

import type { AgentConfig } from "./types.js";

export type SubjectKey = "English" | "Algebra" | "Biology" | "History" | "default";

const PRESETS: Record<
  SubjectKey,
  {
    /** Appended to text solver prompts (Claude + Ollama). */
    textPromptNudge: string;
    /** Appended to vision prompts (Claude vision). */
    visionNudge: string;
    /** Optional overrides; undefined = use base AgentConfig. */
    minConfidenceToSubmit?: number;
    relaxedMinConfidenceAfterRetries?: number;
    maxQuizSolverRetries?: number;
  }
> = {
  English: {
    textPromptNudge:
      "Subject: English / language arts. For reading passages, ground every elimination in the passage text. Watch tone, purpose, and evidence. Prefer answers that match explicit wording or clear implication over vague associations.",
    visionNudge:
      "English/reading: read any passage block carefully before the stem; answers must be supported by that text.",
    minConfidenceToSubmit: 0.9,
    relaxedMinConfidenceAfterRetries: 0.85,
  },
  Algebra: {
    textPromptNudge:
      "Subject: Algebra. Show implicit steps: simplify, substitute, check domain constraints. Symbols like √(3x) and x√3 differ; do not equate unlike forms unless algebraically equivalent.",
    visionNudge:
      "Algebra/math: transcribe expressions exactly from the image; verify equivalence before choosing.",
    minConfidenceToSubmit: 0.9,
  },
  Biology: {
    textPromptNudge:
      "Subject: Biology. Prefer definitions and process order from standard coursework; distinguish similar terms (e.g. mitosis vs meiosis).",
    visionNudge: "Biology: use diagram labels and axis units when visible.",
  },
  History: {
    textPromptNudge:
      "Subject: History / social studies. Tie answers to cause-effect, dates, and source perspective when the stem asks for interpretation.",
    visionNudge: "History: read any excerpt or timeline in the image before answering.",
  },
  default: {
    textPromptNudge: "",
    visionNudge: "",
  },
};

export function normalizeSubjectKey(subject: string | undefined): SubjectKey {
  const s = (subject ?? "").trim().toLowerCase();
  if (s.startsWith("english")) return "English";
  if (s.startsWith("algebra")) return "Algebra";
  if (s.startsWith("biology")) return "Biology";
  if (s.startsWith("history")) return "History";
  return "default";
}

export function getSubjectPreset(key: SubjectKey) {
  return PRESETS[key] ?? PRESETS.default;
}

/** Merge base config with subject-specific numeric overrides (prompt nudges handled in solver). */
export function mergeAgentConfigForSubject(base: AgentConfig, subject: string | undefined): AgentConfig {
  const key = normalizeSubjectKey(subject);
  const p = getSubjectPreset(key);
  return {
    ...base,
    ...(p.minConfidenceToSubmit != null ? { minConfidenceToSubmit: p.minConfidenceToSubmit } : {}),
    ...(p.relaxedMinConfidenceAfterRetries != null
      ? { relaxedMinConfidenceAfterRetries: p.relaxedMinConfidenceAfterRetries }
      : {}),
    ...(p.maxQuizSolverRetries != null ? { maxQuizSolverRetries: p.maxQuizSolverRetries } : {}),
  };
}

export function getOllamaQuizModelFromEnv(): string {
  return (process.env.OLLAMA_QUIZ_MODEL ?? "").trim();
}

/** When true and OLLAMA_QUIZ_MODEL is set, run local chat first and optionally escalate to Claude. */
export function isQuizLocalFirstEnabled(): boolean {
  if (process.env.QUIZ_LOCAL_FIRST === "0") return false;
  return getOllamaQuizModelFromEnv().length > 0 && process.env.QUIZ_LOCAL_FIRST !== "0";
}

export function getQuizLocalAcceptConfidence(): number {
  const v = parseFloat(process.env.QUIZ_LOCAL_ACCEPT_CONFIDENCE ?? "0.92");
  return Number.isFinite(v) ? Math.min(1, Math.max(0.5, v)) : 0.92;
}

export function getQuizEscalateCloudBelowConfidence(): number {
  const v = parseFloat(process.env.QUIZ_ESCALATE_CLOUD_BELOW ?? "0.88");
  return Number.isFinite(v) ? Math.min(1, Math.max(0.3, v)) : 0.88;
}
