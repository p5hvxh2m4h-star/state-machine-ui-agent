/**
 * Structured logging: (timestamp, state, observation, action, result).
 * Optional screenshot on failure.
 */

import type { StepLog } from "./types.js";

const logs: StepLog[] = [];

export function logStep(entry: StepLog): void {
  logs.push(entry);
  const obsParts: string[] = [];
  const cardCount = (entry.observation.courseCards as string[] | undefined)?.length;
  if (cardCount != null) obsParts.push(`cards=${cardCount}`);
  if (entry.observation.popupVisible) obsParts.push("popup");
  const buttons = entry.observation.buttons as string[] | undefined;
  if (buttons?.length) obsParts.push(`obs.buttons=[${buttons.slice(0, 8).join(",")}${buttons.length > 8 ? "…" : ""}]`);
  if (entry.observation.state) obsParts.push(`obs.state=${entry.observation.state}`);
  const obsUrl = entry.observation.url as string | undefined;
  if (obsUrl) obsParts.push(`url=${obsUrl.includes("/activity/") ? "…/activity/…" : obsUrl.slice(0, 50)}`);
  const obsStr = obsParts.length ? ` [${obsParts.join(" ")}]` : "";
  const line = [
    entry.timestamp,
    entry.state,
    entry.action.type,
    entry.result.ok ? "ok" : entry.result.error,
    entry.reason ?? "",
    entry.deadlineExceeded ? "DEADLINE" : "",
  ].join(" | ") + obsStr;
  console.log(line);
}

export function getLogs(): StepLog[] {
  return [...logs];
}

export async function flushLogsToFile(path: string): Promise<void> {
  const fs = await import("fs/promises");
  const content = JSON.stringify(logs, null, 2);
  return fs.writeFile(path, content, "utf-8");
}
