/**
 * Mock UI driver for testing — replace with Playwright/Puppeteer/OpenClaw implementation.
 */

import type { IUIDriver } from "./driver.js";
import type { Observation, Action, ActionResult } from "./types.js";

export const mockObservation: Observation = {
  state: "MODULE_LIST",
  lessonCode: [2, 2, 3],
  headerText: "2.2.3",
  buttons: ["Back", "Next"],
  ready: true,
  networkIdle: true,
};

export const mockDriver: IUIDriver = {
  async getObservation(): Promise<Observation> {
    return { ...mockObservation };
  },
  async execute(_action: Action): Promise<ActionResult> {
    return { ok: true, nextState: "LESSON_SCREEN" };
  },
  async screenshot(path?: string): Promise<string | Buffer> {
    return path ?? Buffer.from("");
  },
  async refresh(): Promise<void> {},
};
