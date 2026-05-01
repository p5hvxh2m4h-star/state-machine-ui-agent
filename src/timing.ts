/**
 * Human-like bounded jitter for reliability (avoid race conditions).
 * Uses PRNG: base_delay_ms + [0, jitterMs) — seeded via prng.setPrngSeed() for auditability, else Math.random().
 */

import { jitterMs } from "./prng.js";

export function delayWithJitter(baseDelayMs: number, jitterMsParam: number): Promise<void> {
  const total = jitterMs(baseDelayMs, jitterMsParam);
  return new Promise((r) => setTimeout(r, total));
}

/** Wait until deadline or condition; returns true if condition met, false if deadline exceeded */
export async function waitUntilReady(
  check: () => Promise<boolean>,
  deadlineMs: number,
  pollIntervalMs: number
): Promise<{ ready: boolean; elapsed: number }> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await check()) {
      return { ready: true, elapsed: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { ready: false, elapsed: Date.now() - start };
}

/** Remaining time until deadline (0 if past) */
export function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}
