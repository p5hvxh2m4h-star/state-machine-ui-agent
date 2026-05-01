# PRNG layer and screen control

## What uses the PRNG?

The **randomness layer** is in `src/prng.ts` and, when the DRBG is enabled, **NIST SP 800-90A Rev. 1 CTR_DRBG** in `src/nist-ctr-drbg.ts` (exposed via `src/aes-drbg.ts`). The implementation uses AES-256, the **Block_Cipher_df** derivation function, **reseed** with derivation, and supports **prediction-resistance**; it is not a “basic” AES-CTR stream. Reference: [NIST SP 800-90A Rev. 1](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-90Ar1.pdf) (June 2015). It is used by:

| Consumer | What it does |
|----------|----------------|
| **`timing.delayWithJitter()`** | Calls `prng.jitterMs(baseMs, jitterMs)` to get a random delay. |
| **`step-runner.runOneStep()`** | Calls `delayWithJitter()` in two places: (1) **before** executing the chosen action (so each click/step is delayed by a PRNG-derived amount), (2) **between retries** when an action fails (backoff delay). |

So the **logic that uses the PRNG** is: the **step runner** (and anything else that calls `delayWithJitter()`). The PRNG is **not** used by the FSM `decide()` function itself — that is deterministic. The helpers `prng.nextInt()` and `prng.pick()` are available for future use (e.g. picking among multiple valid actions at random) but are not called anywhere yet.

## Aspects in which the PRNG is executed

1. **Before every action**  
   When the step runner is about to run an action (click, scroll, LAUNCH, etc.), it waits for `delayWithJitter(config.baseDelayMs, config.jitterMs)`. That delay is computed with the PRNG. So **every step** has a random-looking pause (e.g. 300–450 ms) before the click.

2. **Between retries**  
   If an action fails and is retried, the runner waits `delayWithJitter(...)` again before the next attempt. So **retry backoff** is also PRNG-based.

3. **Optional future use**  
   If you add “instinct” logic (e.g. multiple valid buttons and choose one at random), you would call `prng.pick(validActions)`. That would be another execution point for the PRNG.

4. **Misclick rate (anti-detection)**  
   When `misclickRate` > 0, the driver calls `shouldMisclick(misclickRate)` (DRBG) and, when true, performs a tiny wrong action (e.g. click adjacent choice or move mouse slightly) then corrects. So **misclick decisions** use the same DRBG.

**Summary:** The PRNG/DRBG runs in **timing** (before each action, between retries), **jitter** for click intervals, and **misclick** (optional). All go through `prng` (and when `useAesDrbg: true`, through the NIST CTR_DRBG in `nist-ctr-drbg.ts` / `aes-drbg.ts`). **Step budget:** each step (including answer + submit) is capped at `stepDeadlineMs` (default 12_500 ms ≈ 12–14.5–15 s).

## Will the software take control of my screen and do everything automatically while I see it clicking?

**It controls a browser window that Playwright opens; it does not take over your whole screen.**

- When you run the agent with the **Playwright driver** and **`headless: false`** (the default in the run script can be set to false), Playwright starts a **real browser window** (Chrome/Chromium).
- The script sends commands to that window: go to URL, click this, type that, scroll.
- So **yes:** you will **see** that browser window open and **see it clicking, navigating, and typing** on its own. Everything happens automatically in that window while you watch.
- **No:** the agent does **not** move your physical mouse or control other applications. It only drives the **single browser instance** it launched. Your desktop, other tabs, and other apps are untouched.

So in practice: one automated browser window, fully visible, doing the flow (Edmentum → Apex → quizzes) with PRNG-based delays between actions; you can watch the whole thing.
