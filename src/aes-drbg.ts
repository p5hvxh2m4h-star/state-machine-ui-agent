/**
 * AES-256-CTR-based DRBG — now backed by full NIST SP 800-90A Rev. 1 CTR_DRBG.
 *
 * This module re-exports the NIST CTR_DRBG implementation (nist-ctr-drbg.ts)
 * so that existing callers (e.g. prng.ts) and any code that imports aes-drbg
 * get the full NIST behavior: Block_Cipher_df, reseed, derivation, and
 * prediction-resistance support.
 *
 * Original "basic" behavior (key/counter set once, no reseed/derivation) has
 * been replaced by the NIST-compliant implementation per user request.
 */

export {
  initNistCtrDrbg as initAesDrbg,
  initNistCtrDrbgFromSeed as initAesDrbgFromSeed,
  nextFloat,
  nextInt,
  pick,
  shouldMisclick,
  jitterMs,
} from "./nist-ctr-drbg.js";