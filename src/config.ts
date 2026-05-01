/**
 * Config: API key from env (preferred) or from config.local.json (gitignored).
 * Do not commit config.local.json or .env.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_LOCAL_PATH = join(process.cwd(), "config.local.json");

type LocalConfigFile = {
  anthropicApiKey?: string;
  edmentumEmail?: string;
  edmentumPassword?: string;
};

function loadLocalConfig(): LocalConfigFile {
  if (!existsSync(CONFIG_LOCAL_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_LOCAL_PATH, "utf-8");
    return JSON.parse(raw) as LocalConfigFile;
  } catch {
    return {};
  }
}

/** Anthropic API key: env ANTHROPIC_API_KEY first, then config.local.json */
export function getAnthropicApiKey(): string | undefined {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  const fromFile = loadLocalConfig().anthropicApiKey?.trim();
  return (fromEnv || fromFile) || undefined;
}

/** Edmentum login: env EDMENTUM_EMAIL first, then config.local.json `edmentumEmail` */
export function getEdmentumEmail(): string {
  const fromEnv = process.env.EDMENTUM_EMAIL?.trim();
  if (fromEnv) return fromEnv;
  return loadLocalConfig().edmentumEmail?.trim() ?? "";
}

/** Edmentum login: env EDMENTUM_PASSWORD first, then config.local.json `edmentumPassword` */
export function getEdmentumPassword(): string {
  const fromEnv = process.env.EDMENTUM_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  return loadLocalConfig().edmentumPassword?.trim() ?? "";
}
