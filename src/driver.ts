/**
 * UI driver interface — implement with Playwright, Puppeteer, or OpenClaw browser MCP.
 * Agent calls these; actual DOM/browser is outside this package.
 */

import type { Observation, Action, ActionResult } from "./types.js";

export interface IUIDriver {
  /** Get current observation (parse header, buttons, quiz content). */
  getObservation(): Promise<Observation>;

  /** Execute action; return result and effective next state. */
  execute(action: Action): Promise<ActionResult>;

  /** Take screenshot (e.g. on failure). Path or buffer. */
  screenshot(path?: string): Promise<string | Buffer>;

  /**
   * Optional: scroll the quiz/assessment viewport so answer choices (often below graphs/long stems)
   * are in view before vision screenshots. No-op if not implemented.
   */
  prepareQuizVisionCapture?(): Promise<void>;

  /**
   * Optional: full-page PNG after prepare (long stems + all choices in one image).
   * Prefer `captureQuizVisionShots` when stems require many scrolls.
   */
  screenshotForQuizVision?(): Promise<string | Buffer>;

  /**
   * Optional: several viewport screenshots at different scroll positions (top / mid / bottom)
   * so vision sees the full question when one viewport is insufficient.
   */
  captureQuizVisionShots?(): Promise<Buffer[]>;

  /** Refresh page (e.g. after timeout). */
  refresh(): Promise<void>;

  /** Optional: navigate the main tab to a URL (e.g. Edmentum dashboard between subjects). */
  navigateTo?(url: string): Promise<void>;

  /**
   * Optional: fast check that the page is loadable (avoid full getObservation in readiness loop).
   * If not implemented, step-runner uses getObservation().ready instead.
   */
  isPageReady?(): Promise<boolean>;
}
