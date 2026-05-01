/**
 * Optional multi-subject run plan for run-edmentum-flow.ts — load only when you pass `--plan path/to/file.json`.
 * No built-in default; sequence differs each session, so you generate the JSON per run or use CLI args for one subject.
 */

import { readFileSync, existsSync } from "fs";

export interface RunPlanItem {
  code: string;
  /** Log hint only; navigation still uses `code`. */
  isTest?: boolean;
}

export interface RunPlanSegment {
  subject: string;
  items: RunPlanItem[];
  /** When true, this segment is ignored (e.g. course work already finished). */
  skip?: boolean;
  /**
   * Lesson codes the agent must never open or complete (e.g. "2.4.4" when it sits next to the real target on the strip).
   * If landed on one, the agent exits to the activity map (Activities / Back) then navigates only to `items` codes.
   */
  skipCodes?: string[];
}

export interface RunPlan {
  segments: RunPlanSegment[];
}

/** Load and validate a plan file. Returns null if missing, invalid, or empty. */
export function loadRunPlan(path: string): RunPlan | null {
  if (!path || !existsSync(path)) {
    console.error("Run plan file not found:", path);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as RunPlan;
    if (!data.segments?.length) {
      console.error("Run plan has no segments:", path);
      return null;
    }
    data.segments = data.segments.filter((s) => !s.skip);
    if (!data.segments.length) {
      console.error("Run plan has no segments after removing skipped entries:", path);
      return null;
    }
    return data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to read run plan:", path, msg);
    return null;
  }
}
