/**
 * Starts the learning-graph SSE server (if needed) and opens the neural-net page fullscreen.
 * Set DISABLE_LEARNING_GRAPH_UI=1 to skip. GRAPH_VIZ_PORT overrides port (default 8765).
 * LEARNING_GRAPH_BROWSER = full path to Chrome/Edge executable (optional).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_PORT = Number(process.env.GRAPH_VIZ_PORT) || 8765;
const GRAPH_PATH = "/learning-neural-net.html?live=1";
const GRAPH_URL = `http://127.0.0.1:${GRAPH_PORT}${GRAPH_PATH}`;

let serverChild: ChildProcess | null = null;
let registeredExit = false;

function registerExitHandlers(): void {
  if (registeredExit) return;
  registeredExit = true;
  const stop = () => {
    cleanupLearningGraphUi();
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    cleanupLearningGraphUi();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanupLearningGraphUi();
    process.exit(143);
  });
}

async function httpPing(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(600, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port: number, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpPing(port)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Learning graph server did not respond on port ${port}`);
}

function findWindowsBrowser(): string | null {
  const env = process.env.LEARNING_GRAPH_BROWSER?.trim();
  if (env && existsSync(env)) return env;
  const candidates = [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["LocalAppData"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** Kiosk / app window fills the screen (no browser chrome). */
function openFullscreen(url: string): void {
  const platform = process.platform;
  if (platform === "win32") {
    const exe = findWindowsBrowser();
    if (exe) {
      spawn(exe, ["--kiosk", url], { detached: true, stdio: "ignore" }).unref();
      console.log("[LearningGraph UI] Opened kiosk window:", exe.split("\\").pop());
      return;
    }
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", shell: false }).unref();
    console.warn("[LearningGraph UI] No Edge/Chrome found — opened default browser (not kiosk). Set LEARNING_GRAPH_BROWSER.");
    return;
  }
  if (platform === "darwin") {
    spawn("open", ["-a", "Microsoft Edge", "--args", "--kiosk", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export function cleanupLearningGraphUi(): void {
  if (serverChild && !serverChild.killed) {
    try {
      serverChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    serverChild = null;
  }
}

/**
 * If port is free, spawns `scripts/learning-graph-sse.mjs`, waits for HTTP, opens kiosk URL.
 * If something already serves that port, only opens the browser.
 */
export async function launchLearningGraphUiIfEnabled(): Promise<void> {
  if (process.env.DISABLE_LEARNING_GRAPH_UI === "1") {
    console.log("[LearningGraph UI] Disabled (DISABLE_LEARNING_GRAPH_UI=1).");
    return;
  }

  registerExitHandlers();

  const script = join(root, "scripts", "learning-graph-sse.mjs");
  if (!existsSync(script)) {
    console.warn("[LearningGraph UI] Missing", script);
    return;
  }

  const alreadyUp = await httpPing(GRAPH_PORT);
  if (!alreadyUp) {
    serverChild = spawn(process.execPath, [script], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GRAPH_VIZ_PORT: String(GRAPH_PORT) },
    });
    serverChild.on("error", (err) => {
      console.warn("[LearningGraph UI] Server spawn failed:", err.message);
    });
    console.log(`[LearningGraph UI] Starting server on port ${GRAPH_PORT}…`);
  } else {
    console.log(`[LearningGraph UI] Server already up on port ${GRAPH_PORT}.`);
  }

  try {
    await waitForServer(GRAPH_PORT);
  } catch (e) {
    console.warn("[LearningGraph UI]", (e as Error).message);
    return;
  }

  openFullscreen(GRAPH_URL);
  console.log("[LearningGraph UI]", GRAPH_URL);
}
