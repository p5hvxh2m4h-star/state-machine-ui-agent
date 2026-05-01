/**
 * Use Claude to read the screen: screenshot or HTML → structured Observation.
 * Uses same API key as quiz solver (config).
 */

import type { Observation } from "./types.js";
import { getAnthropicApiKey } from "./config.js";

export interface ClaudeScreenReaderOptions {
  /** Model for vision/reading (default claude-sonnet-4 with vision). */
  model?: string;
}

/**
 * Send page content (HTML or text) to Claude and get back structured observation.
 * Use when DOM selectors are unknown or UI is dynamic.
 */
export async function readScreenWithClaude(
  pageContent: string,
  options: ClaudeScreenReaderOptions = {}
): Promise<Partial<Observation>> {
  const key = getAnthropicApiKey();
  if (!key) {
    return { ready: false, state: "MAIN_MENU", buttons: [] };
  }

  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const model = options.model ?? "claude-sonnet-4-20250514";

  const prompt = `You are parsing a web page for a state-machine UI agent. Given the following page content, extract:
1. state: one of MAIN_MENU, MODULE_LIST, LESSON_SCREEN, QUIZ_SCREEN (best guess from content).
2. headerText: any visible lesson/section code like "2.2.3" or title.
3. buttons: list of button/link labels that look clickable (e.g. Back, Next, Submit).
4. questionText: if this looks like a quiz question, the question text only.
5. choices: if quiz, the answer choices as array of strings.
6. ready: true if the page looks loaded (no loading spinners described).

Reply with JSON only, no markdown:
{"state":"...","headerText":"...","buttons":[],"questionText":"...","choices":[],"ready":true}`;

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt + "\n\nPage content:\n" + pageContent.slice(0, 30000) }],
    });
    const text = (msg.content as { type: "text"; text: string }[])[0]?.text ?? "{}";
    const json = JSON.parse(text.replace(/```json?\s*|\s*```/g, "").trim()) as Partial<Observation>;
    return { ...json, ready: json.ready ?? true };
  } catch (e) {
    return { ready: false, state: "MAIN_MENU", buttons: [], questionText: undefined, choices: [] };
  }
}
