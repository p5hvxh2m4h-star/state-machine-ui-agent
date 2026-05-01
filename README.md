# Apex-Automater

Deterministic FSM-based UI automation: states, observations, actions, transition rules, and a per-step time budget. Safe for testing (auditable, no random clicking).

**It will automatically read your screen and click:** use the included **Playwright driver** (`PlaywrightDriver`). It launches a browser, reads the page (optionally with **Claude** to parse content into state/buttons/quiz), and performs clicks (Back, Next, Submit, choices). **Randomness / anti-detection:** Default is **NIST SP 800-90A Rev. 1 CTR_DRBG** (AES-256, with derivation function and reseed) in `nist-ctr-drbg.ts` / `aes-drbg.ts` + `prng.ts`. Used for: **click intervals**, **jitter**, **tiny misclick rate** (then correct), and **random instinct** (`prng.pick()`). Step budget **~12–14.5–15 s** per answer+submit (`stepDeadlineMs`). Call `initRandomLayer(config)` before running steps. See **docs/PRNG_AND_SCREEN_CONTROL.md**.

**Known context:**  
- **Apex Learning** (`siteContext: "apex"`): course.apexlearning.com — Resume, unit cards, lesson strip, quiz.  
- **Edmentum** (`siteContext: "edmentum"`): edm.geniussis.com FEDashboard — Virtual Learning, course grid (scroll → click subject → LAUNCH).  

**Full flow:** Apex menu → Edmentum grid (3rd screenshot) → scroll, click subject, LAUNCH → Apex course → options under course name (units / Resume). See **FLOW.md**.  

**Quiz playlist:** The handwritten list (English 2.2.3–2.3.4, Algebra 2.2.3–2.5.3, Biology TEST 2.3.2, History 3.1.2/3.1.5) is in `quiz-playlist.ts` (`DEFAULT_QUIZ_PLAYLIST`); the agent can target these specifically.

## Core idea

- **State** = where you are (`MAIN_MENU`, `MODULE_LIST`, `LESSON_SCREEN`, `QUIZ_SCREEN`).
- **Observations** = what’s visible (e.g. header `"2.2.3"`, buttons: Back / Next / Submit).
- **Actions** = what the agent can do (click Next, navigate to lesson, exit to module list).
- **Transition rules** = if you see X, do Y, then move to state Z (deterministic, auditable).

## Features

- **Lesson code parsing**: `"2.2.3"` → `[2,2,3]`; next lesson `[2,2,4]`, parent `[2,2]`.
- **Decision policy**: task completed → Next; next missing → exit to parent; deadline exceeded → safe exit.
- **Timing**: Bounded jitter (`base_delay_ms + jitter_ms`), wait for UI readiness (element + optional network idle).
- **Step budget**: Hard cap per step (default 13.5s); on timeout → exit to safe state and log.
- **Error handling**: Retries (configurable), screenshot on failure, structured logs (timestamp, state, observation, action, result).
- **Quiz**: Extract question + choices → classify → solve with Claude (prefer Sonnet 4) → return answer with confidence; low confidence → flag/skip.

## Setup

```bash
cd Apex-Automater
npm install
npx playwright install chromium
npm run build
```

**Claude API key** (for quiz solving and optional screen reading): set `ANTHROPIC_API_KEY` in the environment, or create `config.local.json` in the project root with `{"anthropicApiKey":"sk-ant-..."}`. Do not commit that file (it’s in `.gitignore`).

## Usage

**Quick run with Playwright (reads screen + clicks):**

```bash
npx tsx src/run-with-playwright.ts "https://your-lesson-site.com"
```

Or use `PlaywrightDriver` in code: it opens a browser, navigates, and can use **Claude to read the screen** (parse HTML into state/buttons/quiz). Set `useClaudeScreenReader: true` (default) and ensure your API key is in env or `config.local.json`.

For a custom stack, implement `IUIDriver` (see `src/driver.ts`) with Playwright, Puppeteer, or OpenClaw browser MCP:

- `getObservation()` — parse current state, header, buttons, quiz text/choices.
- `execute(action)` — perform click/navigate/refresh; return `ActionResult`.
- `screenshot(path?)` — optional; used on failure.
- `refresh()` — optional; used after timeout.

Then use the agent:

```ts
import { step, handleQuizScreen, DEFAULT_CONFIG } from "apex-automater";
import { yourDriver } from "./your-driver.js";

let state = "MODULE_LIST";
while (state !== "SAFE_EXIT") {
  const out = await step(state, yourDriver, {
    isTaskCompleted: (obs) => /* your rule */,
    doesNextLessonExist: (code) => /* your rule */,
  });
  state = out.nextState;
  if (out.deadlineExceeded) break;
}
```

On `QUIZ_SCREEN`, call `handleQuizScreen(obs)` to get a submit index (or skip/flag), then `driver.execute({ type: "SUBMIT_ANSWER", choiceIndex })`.

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `stepDeadlineMs` | 13500 | Hard cap per step (then safe exit). |
| `maxRetries` | 3 | Retries per action before fail. |
| `baseDelayMs` | 300 | Base delay before/after actions. |
| `jitterMs` | 150 | Added random delay for stability. |
| `readinessPollIntervalMs` | 200 | Poll interval for UI ready. |

## Logs

Step logs are printed and kept in memory. Use `getLogs()` / `flushLogsToFile(path)` from `logger.js` to persist.
