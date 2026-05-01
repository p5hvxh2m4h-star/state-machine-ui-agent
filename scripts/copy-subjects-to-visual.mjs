/**
 * Copies src/learning-subjects.json → visual/subjects.json for the graph server + static fallback.
 * Runs from npm postbuild; run manually after editing subjects without a full build.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "learning-subjects.json");
const dst = path.join(root, "visual", "subjects.json");

if (!fs.existsSync(src)) {
  console.warn("copy-subjects-to-visual: missing", src);
  process.exit(0);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log("Copied learning-subjects.json → visual/subjects.json");
