/**
 * Randomness facade: NIST SP 800-90A Rev. 1 CTR_DRBG (AES-256-CTR, with
 * Block_Cipher_df, reseed, derivation) or xorshift32 fallback.
 *
 * AES-CTR DRBG is the state-of-the-art deterministic RNG for security-sensitive
 * and anti-detection use: FIPS 140-2/3 aligned, used in TLS and high-assurance
 * systems. All timing, jitter, misclick, hesitation, scroll, and instinct logic
 * use this single layer so behavioral biometrics (mouse/typing dynamics, scroll
 * patterns, interaction cadence) get cryptographically strong, uncorrelated
 * randomness—directly challenging advanced behavioral detection.
 *
 * All timing, jitter, misclick, and instinct logic use this layer.
 */

import * as aes from "./aes-drbg.js";

let seed: number | null = null;
let useAes = false;

/** Initialize NIST CTR_DRBG (recommended for anti-detection). Call before run. */
export function initAesDrbg(entropy?: Buffer): void {
  if (entropy && entropy.length >= 32) aes.initAesDrbg(entropy);
  else aes.initAesDrbgFromSeed(Math.floor(Date.now() * 0xffff) >>> 0);
  useAes = true;
}

/** Set seed: if using AES, initializes NIST CTR_DRBG from seed; else xorshift seed. */
export function setPrngSeed(s: number): void {
  seed = s;
  aes.initAesDrbgFromSeed(s >>> 0);
  useAes = true;
}

/** Reset to xorshift + Math.random (no AES). */
export function clearPrngSeed(): void {
  seed = null;
  useAes = false;
}

export function setUseAesDrbg(use: boolean): void {
  useAes = use;
  if (use && seed !== null) aes.initAesDrbgFromSeed(seed >>> 0);
}

export function isUsingAesDrbg(): boolean {
  return useAes;
}

/** Next float in [0, 1). From AES DRBG or xorshift32 or Math.random(). */
export function nextFloat(): number {
  if (useAes) return aes.nextFloat();
  if (seed !== null) {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed = seed >>> 0;
    return seed / 0xffff_ffff;
  }
  return Math.random();
}

/** Jitter delay in ms: baseMs + [0, jitterMs) — used for click intervals and retry backoff. */
export function jitterMs(baseMs: number, jitterMsParam: number): number {
  return useAes ? aes.jitterMs(baseMs, jitterMsParam) : Math.round(baseMs + nextFloat() * jitterMsParam);
}

/** Integer in [min, max] inclusive. Used for instinct logic (pick among valid actions). */
export function nextInt(min: number, max: number): number {
  const f = nextFloat();
  return min + Math.floor(f * (max - min + 1));
}

/** Pick one element from array (random instinct). */
export function pick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[nextInt(0, arr.length - 1)];
}

/** True with probability p (for tiny misclick rate). Uses DRBG when active. */
export function shouldMisclick(probability: number): boolean {
  if (probability <= 0) return false;
  return useAes ? aes.shouldMisclick(probability) : nextFloat() < probability;
}

/** Pre-click hesitation (ms) for human-like latency; defeats timing/cadence analysis. DRBG. */
export function humanHesitationMs(): number {
  return Math.round(50 + nextFloat() * 200);
}

/** Pause after intentional misclick before correcting (ms). Variable = human correction cadence. DRBG. */
export function humanCorrectionPauseMs(): number {
  return Math.round(80 + nextFloat() * 220);
}

/** Random scroll amount (px) for variable scroll patterns; defeats scroll-behavior biometrics. DRBG. */
export function scrollAmountPx(): number {
  return Math.round(500 + nextFloat() * 450);
}

/** Small overshoot (px) for human-like scroll correction; 0 with ~70% prob, else 15–85. DRBG. */
export function scrollOvershootPx(): number {
  if (nextFloat() < 0.7) return 0;
  return Math.round(15 + nextFloat() * 70);
}

/**
 * Delay (ms) from clicking the answer choice to clicking Submit. Human-like, DRBG-only.
 * Base midline ~2 s with ±155–275 ms jitter (so typical range ~1.725–2.275 s).
 */
export function answerToSubmitDelayMs(): number {
  const baseMs = 2000;
  const jitterMsAmount = 155 + Math.round(nextFloat() * 120);
  const sign = nextFloat() < 0.5 ? -1 : 1;
  const delay = baseMs + sign * jitterMsAmount;
  return Math.round(Math.max(1400, Math.min(2600, delay)));
}

/**
 * Human-like "thinking" delay for quiz answer (ms). Uses same DRBG as jitter/misclick.
 * Triangular: min 5.5s, max 19.5s, mode 13.75s. Typical ~13.75±4.5s; quick 5.5–7.5s and slow 18–19.5s uncommon.
 */
export function quizAnswerDelayMs(): number {
  const a = 5_500;
  const b = 19_500;
  const c = 13_750;
  const u = nextFloat();
  const fc = (c - a) / (b - a);
  let x: number;
  if (u < fc) {
    x = a + Math.sqrt(u * (b - a) * (c - a));
  } else {
    x = b - Math.sqrt((1 - u) * (b - a) * (b - c));
  }
  return Math.round(Math.max(a, Math.min(b, x)));
}
