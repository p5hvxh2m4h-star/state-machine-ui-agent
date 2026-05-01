/**
 * Example: run the agent with Playwright (reads screen, clicks).
 * Usage: npx tsx src/run-with-playwright.ts [URL]
 * Uses AES-CTR DRBG for timing/jitter/misclick; step budget ~12–14.5–15 s per answer+submit.
 */

import { PlaywrightDriver } from "./playwright-driver.js";
import { step, initRandomLayer } from "./index.js";
import { launchLearningGraphUiIfEnabled } from "./launch-learning-graph-ui.js";
import { DEFAULT_CONFIG } from "./types.js";

const url = process.argv[2] ?? "https://example.com";

async function main() {
  initRandomLayer({ ...DEFAULT_CONFIG, useAesDrbg: true });

  await launchLearningGraphUiIfEnabled().catch((e) => console.warn("[LearningGraph UI]", e));

  const driver = new PlaywrightDriver({
    startUrl: url,
    useClaudeScreenReader: true,
    headless: false,
    misclickRate: DEFAULT_CONFIG.misclickRate ?? 0,
  });
  await driver.init();

  let state = "MAIN_MENU";
  const maxSteps = 5;
  let steps = 0;

  while (state !== "SAFE_EXIT" && steps < maxSteps) {
    const out = await step(state, driver, {
      config: DEFAULT_CONFIG,
      isTaskCompleted: () => false,
      doesNextLessonExist: () => false,
    });
    state = out.nextState;
    steps++;
    if (out.deadlineExceeded) break;
  }

  await driver.close();
  console.log("Done. State:", state);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
