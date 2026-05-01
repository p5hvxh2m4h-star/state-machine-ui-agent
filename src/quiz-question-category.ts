/**
 * Coarse question category for metrics / evaluation (not academic labeling — routing & reports only).
 */

export type QuizQuestionCategory =
  | "multi_select"
  | "reading_comprehension"
  | "math_like"
  | "science_like"
  | "humanities"
  | "general";

export function inferQuizQuestionCategory(input: {
  subject?: string;
  passage?: string;
  question: string;
  multiSelect: boolean;
}): QuizQuestionCategory {
  if (input.multiSelect) return "multi_select";
  const p = (input.passage ?? "").trim();
  const q = (input.question ?? "").trim();
  const combined = (p + "\n" + q).toLowerCase();
  if (p.length > 120 || /\bpassage\b|\bread\b|\baccording to\b|\bthe author\b|\bexcerpt\b/i.test(combined)) {
    return "reading_comprehension";
  }
  const sub = (input.subject ?? "").toLowerCase();
  if (sub.includes("algebra") || /[√²∫∑π]|\\frac|\\sqrt|equation|slope|polynomial/i.test(combined)) {
    return "math_like";
  }
  if (sub.includes("biology") || /\bcell\b|\bmitosis\b|\bdna\b|\becosystem\b/i.test(combined)) {
    return "science_like";
  }
  if (sub.includes("history") || sub.includes("english")) return "humanities";
  return "general";
}
