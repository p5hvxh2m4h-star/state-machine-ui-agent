/**
 * Known context: Apex Learning (Biology Sem 2) UI.
 * Parses dashboard, lesson strip (3.1.1, 3.1.2 Quiz, RESUME), and unit cards into Observation.
 */

import type { Observation } from "../types.js";
import { parseLessonCode } from "../state-machine.js";
import { inferQuizMultiSelect } from "../quiz-solver.js";
import { parseQuizScoreFromBody, parseQuizSummaryQuestionOutcomesFromBody } from "../quiz-metrics.js";
import type { Page, Frame } from "playwright";

/** Cap wait time for any single parser operation (avoid 30s default). */
const PARSER_TIMEOUT_MS = 6000;

/** Selectors tuned for Apex Learning — adjust if DOM differs. */
const SELECTORS = {
  // Dashboard: Resume card with "3.1.2 Quiz: Adaptations in Populations"
  resumeSection: "[class*='resume'], [data-testid*='resume']",
  resumePlayButton: "a[href*='quiz'], [class*='resume'] a, [class*='resume'] button",
  // Unit progress and cards
  unitProgress: "[class*='unit'], [class*='progress'] [class*='circle'], [aria-label*='Unit']",
  unitCards: "a[href*='unit'], [class*='unit-card'], [class*='course-unit']",
  // Lesson strip
  lessonStripItems: "[class*='lesson'], [class*='activity'], [class*='step']",
  resumeButton: "text=RESUME",
  // Quiz screen (Apex often uses divs/labels, not native radios)
  quizQuestion: "[class*='question'], [class*='quiz'] [class*='prompt'], [class*='q-text'], [class*='assessment'] [class*='content']",
  quizChoices: "[class*='choice'], [class*='option'], [class*='answer'], [class*='response'], label[class*='option'], label[class*='choice'], input[type='radio']",
} as const;

export type ApexScreen =
  | "LMS_DASHBOARD"  // apexvs.com My Dashboard — course list (Algebra II Sem 2, Biology Sem 2, ...)
  | "DASHBOARD"      // course.apexlearning.com: Resume, unit cards
  | "LESSON_STRIP"   // Unit/Lesson view: 3.1.1, 3.1.2 Quiz, RESUME
  | "QUIZ"           // Quiz question + choices
  | "UNKNOWN";

/**
 * Determine which Apex screen we're on from page content.
 * Order matters: `/activity/` is both the horizontal activity map (3.2.1 … 3.2.7) and the assessment.
 * Activity tiles match [class*='quiz'] / "Quiz" in text — those must NOT win over the map, or we stay in
 * QUIZ_SCREEN and SUBMIT_ANSWER loops on a page with no radios.
 */
export async function detectApexScreen(page: Page): Promise<ApexScreen> {
  const url = page.url();
  const body = await page.locator("body").innerText({ timeout: PARSER_TIMEOUT_MS }).catch(() => "");
  const bodyLower = body.toLowerCase();
  if (url.includes("apexvs.com") && (body.includes("My Dashboard") || body.includes("Enrollments"))) return "LMS_DASHBOARD";

  const radioInput = await page.locator("input[type='radio']").count().catch(() => 0);
  const radioRole = await page.locator("[role='radio']").count().catch(() => 0);
  const radioCount = Math.max(radioInput, radioRole);
  const hasQuestionOf = /question\s+\d+\s+of\s+\d+/i.test(body);
  /** Inside a scored item: stem shows "Question N of M" and the choice list is present. */
  const looksLikeLiveQuizItem = hasQuestionOf && radioCount >= 2;

  if (url.includes("/activity/")) {
    const triples = body.match(/\d+\.\d+\.\d+/g) ?? [];
    const uniqueCodes = new Set(triples);
    // Map shows many sibling activities; intro-only screens usually expose one code.
    const looksLikeActivityMap =
      uniqueCodes.size >= 3 ||
      (uniqueCodes.size >= 2 &&
        /\b(REVIEW|RESUME|START|Not Started|Completed|In Progress)\b/i.test(body) &&
        /\blesson\s+\d+\.\d+\b/i.test(body));
    if (looksLikeActivityMap && !looksLikeLiveQuizItem) {
      return "LESSON_STRIP";
    }
  }

  const quizCount = await page.locator(SELECTORS.quizQuestion).count().catch(() => 0);
  // PREVIOUS appears on lesson/video footers too — do not treat that alone as an assessment screen.
  if (body.includes("Submit") || body.includes("SUBMIT") || quizCount > 0) return "QUIZ";
  if (url.includes("/activity/") || (bodyLower.includes("start") && (body.includes("Not Started") || body.includes("not started") || /\d+\.\d+\.\d+/.test(body)))) return "LESSON_STRIP";
  if ((bodyLower.includes("start") && /\d+\.\d+\.\d+/.test(body)) || (body.includes("RESUME") && body.match(/\d+\.\d+\.\d+/))) return "LESSON_STRIP";
  if (url.includes("course.apexlearning.com") && (body.includes("Unit 1") || body.includes("Unit 2") || body.includes("Resume"))) return "DASHBOARD";
  if (body.includes("Resume") && body.match(/\d+\.\d+\.\d+\s*(Quiz|Test)/)) return "DASHBOARD";
  return "UNKNOWN";
}

/**
 * Parse Apex LMS "My Dashboard" (course list: Algebra II Sem 2, Biology Sem 2, ...).
 * Body text alone can miss course titles (async render, iframes); also scan link/button labels.
 */
export async function parseApexLmsDashboard(page: Page): Promise<Observation> {
  const body = await page.locator("body").innerText().catch(() => "");
  const buttons: string[] = [];
  const courseNames = ["Algebra II Sem 2", "Biology Sem 2", "English 10 Sem 2", "U.S. History Sem 2"];
  const push = (s: string) => {
    if (!buttons.includes(s)) buttons.push(s);
  };
  for (const name of courseNames) {
    if (body.includes(name)) push(name);
  }
  const coursePatterns: { label: string; re: RegExp }[] = [
    { label: "Algebra II Sem 2", re: /\bAlgebra\s+II\s+Sem\s*2\b/i },
    { label: "Biology Sem 2", re: /\bBiology\s+Sem\s*2\b/i },
    { label: "English 10 Sem 2", re: /\bEnglish\s+10\s+Sem\s*2\b/i },
    { label: "U.S. History Sem 2", re: /\bU\.?\s*S\.?\s*History\s+Sem\s*2\b|\bALVS\s+PT\s+U\.?\s*S\.?\s*History\b/i },
  ];
  for (const { label, re } of coursePatterns) {
    if (re.test(body)) push(label);
  }
  for (const frame of page.frames()) {
    try {
      const links = frame.locator("a, [role='link'], [role='button'], button");
      const n = await links.count();
      for (let i = 0; i < Math.min(n, 100); i++) {
        const t = (await links.nth(i).innerText().catch(() => "")).trim().replace(/\s+/g, " ");
        if (t.length < 10 || t.length > 200) continue;
        for (const { label, re } of coursePatterns) {
          if (re.test(t)) push(label);
        }
      }
    } catch {
      /* next frame */
    }
  }
  return {
    state: "APEX_LMS_DASHBOARD",
    buttons,
    ready: true,
    networkIdle: true,
  };
}

/**
 * Parse Apex dashboard into Observation (MAIN_MENU / MODULE_LIST).
 */
export async function parseApexDashboard(page: Page): Promise<Observation> {
  const buttons: string[] = ["Resume"];
  let headerText: string | undefined;
  let lessonCode: number[] | undefined;

  // Resume card: "3.1.2 Quiz: Adaptations in Populations" — find element containing lesson code
  const resumeSection = page.locator(SELECTORS.resumeSection).first();
  if ((await resumeSection.count()) > 0) {
    const text = await resumeSection.innerText().catch(() => "");
    const match = text.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      headerText = match[1];
      lessonCode = parseLessonCode(match[1]) ?? undefined;
    }
  }
  if (!headerText) {
    const anyCode = await page.getByText(/\d+\.\d+\.\d+/).first().innerText().catch(() => "");
    const m = anyCode.match(/(\d+\.\d+\.\d+)/);
    if (m) {
      headerText = m[1];
      lessonCode = parseLessonCode(m[1]) ?? undefined;
    }
  }

  // Unit labels (Unit 1, Unit 2, ...) as clickable
  const unitEls = page.locator(SELECTORS.unitCards);
  const n = await unitEls.count();
  for (let i = 0; i < Math.min(n, 10); i++) {
    const t = await unitEls.nth(i).innerText().catch(() => "").then((s) => s.trim());
    if (t && !buttons.includes(t)) buttons.push(t);
  }
  const progressEls = page.locator(SELECTORS.unitProgress);
  const pn = await progressEls.count();
  for (let i = 0; i < Math.min(pn, 5); i++) {
    const t = await progressEls.nth(i).getAttribute("aria-label").catch(() => null)
      ?? (await progressEls.nth(i).innerText().catch(() => "")).trim();
    if (t && !buttons.includes(t)) buttons.push(t);
  }

  const body = await page.locator("body").innerText().catch(() => "");
  for (const u of ["Unit 1", "Unit 2", "Unit 3", "Unit 4", "Unit 5"]) {
    if (body.includes(u) && !buttons.includes(u)) buttons.push(u);
  }
  const unitTitleMatch = body.match(/Unit \d+:\s*[A-Za-z\s]+/g);
  if (unitTitleMatch) {
    for (const t of unitTitleMatch) {
      const trimmed = t.trim();
      if (trimmed.length < 50 && !buttons.includes(trimmed)) buttons.push(trimmed);
    }
  }

  return {
    state: "APEX_COURSE",
    lessonCode,
    headerText,
    buttons,
    ready: true,
    networkIdle: true,
  };
}

/**
 * True when the unit **INTRODUCTION** tab is selected (horizontal nav). On that screen the full-page
 * text still lists many activity triples — we must not set `lessonCode` from the first triple in `body`.
 */
async function detectApexUnitIntroSelected(page: Page, bodyHead: string): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const intro = frame.getByRole("tab", { name: /^INTRODUCTION$/i }).first();
      if ((await intro.count()) > 0) {
        const aria = await intro.getAttribute("aria-selected").catch(() => null);
        if (aria === "true") return true;
        const cls = (await intro.getAttribute("class").catch(() => "")) ?? "";
        if (/\b(mdc-tab--active|mat-mdc-tab--active|tab.*active)\b/i.test(cls)) return true;
      }
    } catch {
      /* next frame */
    }
  }
  const head = bodyHead.slice(0, 9000);
  if (
    /\bUnit\s+\d+\s+Overview\b/i.test(head) &&
    /\bINTRODUCTION\b/.test(head) &&
    /\bLESSON\s+\d+\.\d+\b/i.test(head) &&
    !/\bin\s+progress\b/i.test(head.slice(0, 2500))
  ) {
    return true;
  }
  return false;
}

/**
 * Parse Apex lesson strip (3.1.1, 3.1.2 Quiz In Progress, RESUME, 3.1.3 Explore) into Observation.
 * Do not assume RESUME is always present — completed unit intros often show **REVIEW** instead.
 */
export async function parseApexLessonStrip(page: Page): Promise<Observation> {
  const buttons: string[] = [];
  let headerText: string | undefined;
  let lessonCode: number[] | undefined;

  const frames = page.frames();
  let combinedBody = "";
  for (const frame of frames) {
    const b = await frame.locator("body").innerText().catch(() => "");
    combinedBody += "\n" + b;
  }
  const mainBody = await page.locator("main, [role='main'], .content, body").first().innerText().catch(() => "");
  const body = combinedBody.length >= mainBody.length ? combinedBody : mainBody;

  const apexUnitIntroActive = await detectApexUnitIntroSelected(page, body);

  let pageProgress: { current: number; total: number } | undefined;
  const pageOfM = body.match(/\b(\d+)\s+of\s+(\d+)\b/i);
  if (pageOfM) {
    const cur = parseInt(pageOfM[1]!, 10);
    const tot = parseInt(pageOfM[2]!, 10);
    if (tot > 0 && cur > 0 && cur <= tot) pageProgress = { current: cur, total: tot };
  }

  // Prefer the triple on the "In Progress" tile (Wrap-Up strip); first triple in body is often a completed 3.4.1, etc.
  // On unit intro (INTRODUCTION tab), body lists many future codes — do not pin lessonCode to an arbitrary triple.
  if (!apexUnitIntroActive) {
    const allTriples = [...body.matchAll(/\b(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]!);
    if (allTriples.length > 0) {
      let picked = allTriples[0]!;
      const ip = body.search(/\bin\s+progress\b/i);
      if (ip >= 0) {
        const win = body.slice(Math.max(0, ip - 240), Math.min(body.length, ip + 100));
        const near = [...win.matchAll(/\b(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]!);
        if (near.length > 0) picked = near[near.length - 1]!;
      }
      headerText = picked;
      lessonCode = parseLessonCode(picked) ?? undefined;
    }
  }

  for (const frame of frames) {
    const stripItems = frame.locator(SELECTORS.lessonStripItems);
    const n = await stripItems.count();
    for (let i = 0; i < Math.min(n, 15); i++) {
      const t = (await stripItems.nth(i).innerText().catch(() => "")).trim();
      const code = t.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
      if (code && !buttons.includes(code)) buttons.push(code);
    }

    // Forward/back lesson arrows — scan every frame (strip often lives in an iframe).
    const lessonNavEls = frame
      .locator("a, button, [role='button'], [role='link']")
      .filter({ hasText: /Lesson\s+\d+\.\d+/i });
    const ln = await lessonNavEls.count().catch(() => 0);
    for (let i = 0; i < Math.min(ln, 12); i++) {
      const raw = (await lessonNavEls.nth(i).innerText().catch(() => "")).trim().replace(/\s+/g, " ");
      const m = raw.match(/(Lesson\s+\d+\.\d+)/i);
      if (!m) continue;
      const label = m[1].replace(/\s+/g, " ");
      if (!buttons.includes(label)) buttons.push(label);
    }
  }

  // Tab chrome / split layout: "Lesson 2.2" may appear in body text but not as a single interactive node match.
  for (const m of body.matchAll(/\bLesson\s+\d+\.\d+\b/gi)) {
    const label = m[0].replace(/\s+/g, " ");
    if (!buttons.includes(label)) buttons.push(label);
  }

  // Unit-to-unit navigation arrow labels (e.g. "Unit 4 Intro") live on the activity map; the top lesson strip
  // does not jump units, so we must treat these as clickable buttons for plan navigation.
  for (const frame of frames) {
    const unitIntroEls = frame
      .locator("a, button, [role='button'], [role='link']")
      .filter({ hasText: /\bUnit\s+\d+\s+Intro\b/i });
    const un = await unitIntroEls.count().catch(() => 0);
    for (let i = 0; i < Math.min(un, 8); i++) {
      const raw = (await unitIntroEls.nth(i).innerText().catch(() => "")).trim().replace(/\s+/g, " ");
      const m = raw.match(/\b(Unit\s+\d+\s+Intro)\b/i);
      if (!m) continue;
      const label = m[1].replace(/\s+/g, " ");
      if (!buttons.includes(label)) buttons.push(label);
    }
  }
  // Fallback: sometimes the label is present in body text but not matched as a single node.
  for (const m of body.matchAll(/\bUnit\s+\d+\s+Intro\b/gi)) {
    const label = m[0].replace(/\s+/g, " ");
    if (!buttons.includes(label)) buttons.push(label);
  }

  // Activity tiles (e.g. "3.4.2 Test (CST)") — not always matched by lessonStripItems; collect triples from body.
  const seenCodes = new Set(buttons);
  for (const m of body.matchAll(/\b\d+\.\d+\.\d+\b/g)) {
    const code = m[0];
    if (!seenCodes.has(code)) {
      seenCodes.add(code);
      buttons.push(code);
    }
    if (buttons.length > 80) break;
  }

  // Actual primary CTAs (avoid phantom RESUME when UI shows REVIEW only) — search all frames
  let hasReview = false;
  let hasResume = false;
  let hasStart = false;
  for (const frame of frames) {
    if (!hasReview) {
      hasReview =
        (await frame.getByRole("button", { name: /review/i }).count()) > 0 ||
        (await frame.getByRole("link", { name: /review/i }).count()) > 0 ||
        (await frame.getByText(/^REVIEW$/i).count()) > 0;
    }
    if (!hasResume) {
      hasResume =
        (await frame.getByRole("button", { name: /resume/i }).count()) > 0 ||
        (await frame.getByRole("link", { name: /resume/i }).count()) > 0 ||
        (await frame.locator(SELECTORS.resumeButton).count()) > 0 ||
        (await frame.locator("a, button, [role='button'], [role='link']").filter({ hasText: /^RESUME$/i }).count()) > 0;
    }
    if (!hasStart) {
      hasStart =
        (await frame.getByRole("button", { name: /start/i }).count()) > 0 ||
        (await frame.getByRole("link", { name: /start/i }).count()) > 0;
    }
  }

  if (hasReview) buttons.push("REVIEW");
  if (hasResume) buttons.push("RESUME");
  if (hasStart || /(^|\s)start(\s|$)/i.test(body)) buttons.push("START");

  for (const frame of frames) {
    if ((await frame.getByRole("button", { name: /next/i }).count()) > 0) {
      buttons.push("Next");
      break;
    }
  }
  for (const frame of frames) {
    if ((await frame.getByRole("button", { name: /continue/i }).count()) > 0) {
      buttons.push("CONTINUE");
      break;
    }
  }
  for (const frame of frames) {
    if ((await frame.getByRole("button", { name: /previous/i }).count()) > 0) {
      buttons.push("PREVIOUS");
      break;
    }
  }
  for (const frame of frames) {
    if ((await frame.getByRole("button", { name: /back/i }).count()) > 0 && !buttons.includes("PREVIOUS")) {
      buttons.push("Back");
      break;
    }
  }

  if (apexUnitIntroActive && !buttons.includes("INTRODUCTION")) {
    buttons.push("INTRODUCTION");
  }

  return {
    state: "MODULE_LIST",
    lessonCode,
    headerText,
    buttons,
    ready: true,
    networkIdle: true,
    pageProgress,
    stripTextSample: body.slice(0, 25_000),
    apexUnitIntroActive,
  };
}

/**
 * Parse body/main text for "A." "B." "C." "D." or "1." "2." or "(A)" "(B)" choice lines (Apex assessment).
 * Supports multiline choice text (e.g. "A.\n√7x² + 14x").
 */
function parseChoicesFromText(text: string): string[] {
  let choices: string[] = [];
  // Same-line: "A." or "A)" followed by content on same line
  const linePattern = /^\s*([A-D])[.)\]\s]*\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = linePattern.exec(text)) !== null) {
    choices.push(m[2].trim());
  }
  if (choices.length >= 2 && choices.length <= 6) return choices;
  choices = [];
  // Multiline: "A." then any chars until next "B." or end of string
  const multiPattern = /\b([A-D])[.)\]\s]*\s*([\s\S]+?)(?=\s+[A-D][.)\]\s]\s*|$)/g;
  while ((m = multiPattern.exec(text)) !== null) {
    const t = m[2].trim().replace(/\s+/g, " ").slice(0, 300);
    if (t.length > 0) choices.push(t);
  }
  if (choices.length >= 2 && choices.length <= 6) return choices;
  choices = [];
  const loosePattern = /\b([A-D])[.)\]\s]*\s*([^\n]+?)(?=\s+[A-D][.)\]\s]|\s*$)/g;
  while ((m = loosePattern.exec(text)) !== null) {
    choices.push(m[2].trim());
  }
  if (choices.length >= 2 && choices.length <= 6) return choices;
  const split = text.split(/\s+[A-D][.)\]\s]*\s+/);
  if (split.length >= 5) {
    for (let i = 1; i <= 4; i++) {
      const s = split[i]?.trim().split(/\s+[A-D][.)\]\s]*\s+/)[0]?.trim() ?? "";
      if (s.length > 0) choices.push(s.slice(0, 300));
    }
  }
  if (choices.length >= 2 && choices.length <= 6) return choices;
  choices = [];
  const numberedLine = /^\s*([1-4])[.)]\s*(.+)$/gm;
  while ((m = numberedLine.exec(text)) !== null) {
    choices.push(m[2].trim());
  }
  if (choices.length >= 2 && choices.length <= 6) return choices;
  const numberedLoose = /\b([1-4])[.)]\s*([^\n]+?)(?=\s+[1-4][.)]|\s*$)/g;
  while ((m = numberedLoose.exec(text)) !== null) {
    choices.push(m[2].trim());
  }
  if (choices.length >= 2 && choices.length <= 6) return choices;
  return [];
}

/**
 * Parse Apex quiz screen into Observation (QUIZ_SCREEN).
 * Includes quiz intro page (page/1 with "START →" at bottom) and actual questions (Submit, choices).
 * If the quiz is in an iframe, uses that frame for parsing.
 */
/** Wait up to maxMs for condition; poll every intervalMs. */
async function waitFor(
  check: () => Promise<boolean>,
  maxMs: number = 3000,
  intervalMs: number = 500
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Graded MCQ: Apex shows NEXT QUESTION + learner's choice is selected — click Next, do not re-run vision.
 * Uses the same frame as radios (ctx) or scans other frames if the footer lives elsewhere.
 */
async function detectGradedMcqFeedbackDom(c: Page | Frame): Promise<boolean> {
  try {
    const body = await c.locator("body").innerText().catch(() => "");
    const looksLikeMcq =
      /question\s+\d+\s+of\s+\d+/i.test(body) &&
      (/SUBMIT/i.test(body) || (await c.locator("input[type='radio']").count().catch(() => 0)) >= 2);
    if (!looksLikeMcq) return false;
    const nextLoc = c
      .getByRole("button", { name: /next\s+question/i })
      .or(c.getByRole("link", { name: /next\s+question/i }));
    const nextVisible =
      (await nextLoc.count()) > 0 && (await nextLoc.first().isVisible().catch(() => false));
    const hasCheckedRadio =
      (await c.locator("input[type='radio']:checked").count()) > 0 ||
      (await c.locator("[role='radio'][aria-checked='true']").count()) > 0 ||
      (await c.locator("[class*='mat-radio-checked'], [class*='radio-checked'], [aria-selected='true']").count()) > 0;
    return Boolean(nextVisible && hasCheckedRadio);
  } catch {
    return false;
  }
}

export async function parseApexQuiz(page: Page): Promise<Observation> {
  await waitFor(async () => {
    const mainRadios = await page.locator("input[type='radio'], [role='radio']").count().catch(() => 0);
    if (mainRadios >= 2) return true;
    const frames = page.frames();
    if (frames.length > 1) return true;
    const bodyLen = (await page.locator("body").innerText().catch(() => "")).length;
    if (bodyLen > 400) return true;
    return false;
  });

  let ctx: Page | Frame = page;
  const mainRadios = await page.locator("input[type='radio']").count().catch(() => 0);
  const frames = page.frames();
  let frameRadios: number[] = [];
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    const n = await frame.locator("input[type='radio']").count().catch(() => 0);
    frameRadios.push(n);
    if (n >= 2) {
      ctx = frame;
      break;
    }
  }
  if (ctx === page && mainRadios < 2) {
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      const n = await frame.locator("[role='radio']").count().catch(() => 0);
      if (n >= 2) {
        ctx = frame;
        break;
      }
    }
  }

  let questionText: string | undefined;
  const questionEl = ctx.locator(SELECTORS.quizQuestion).first();
  if ((await questionEl.count()) > 0) {
    questionText = (await questionEl.innerText().catch(() => "")).trim() || undefined;
  }
  let main =
    (await ctx.locator("[role='main'], main, [class*='content'], [class*='assessment'], [class*='question']").first().innerText().catch(() => "")) ?? "";
  if (main.length < 200) {
    main = (await ctx.locator("body").innerText().catch(() => "")) ?? "";
  }
  if (!questionText && main.length > 100) {
    const withoutNav = main.replace(/\s*(PREVIOUS|SUBMIT|Next|Back|Question \d+ of \d+)\s*/gi, " ").trim();
    if (withoutNav.length > 50) questionText = withoutNav.slice(0, 2000);
  }

  let choices: string[] = [];
  // Wait briefly for quiz DOM (Apex may render choices after load)
  await new Promise((r) => setTimeout(r, 800));
  // Apex structure: full answer text is in the container (div.sia-distractor / div#sia-multiple-choice-label-*).
  // Extract using accessible name (aria-label, aria-labelledby, then innerText) so we don't drop labels that aren't in innerText.
  const getAccessibleChoiceLabels = (): string[] => {
    const sel1 = "[class*='sia-distractor'], [id^='sia-distractor-']";
    const sel2 = "[id^='sia-multiple-choice-label-'], [id*='multiple-choice-label']";
    let nodes = Array.from(document.querySelectorAll(sel1));
    if (nodes.length < 4) nodes = Array.from(document.querySelectorAll(sel2));
    if (nodes.length < 4) return [];
    const root = document;
    const getAccessibleName = (el: Element): string => {
      const ariaLabel = (el as HTMLElement).getAttribute?.("aria-label")?.trim();
      if (ariaLabel && ariaLabel.length > 0) return ariaLabel.replace(/\s+/g, " ").slice(0, 300);
      const labelledBy = (el as HTMLElement).getAttribute?.("aria-labelledby");
      if (labelledBy) {
        const ids = labelledBy.split(/\s+/).filter(Boolean);
        const parts = ids.map((id) => root.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean);
        if (parts.length > 0) return parts.join(" ").replace(/\s+/g, " ").slice(0, 300);
      }
      const inner = (el as HTMLElement).innerText?.trim().replace(/\s+/g, " ") ?? "";
      return inner.slice(0, 300);
    };
    const out: string[] = [];
    for (let i = 0; i < Math.min(4, nodes.length); i++) {
      const name = getAccessibleName(nodes[i]).replace(/^\s*[A-D][.)]\s*/i, "").trim();
      if (name.length > 0) out.push(name);
    }
    return out;
  };
  let apexLabels = await page.evaluate(getAccessibleChoiceLabels).catch(() => []);
  if (apexLabels.length < 4) {
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      apexLabels = await frame.evaluate(getAccessibleChoiceLabels).catch(() => []);
      if (apexLabels.length >= 4) break;
    }
  }
  if (apexLabels.length >= 4) {
    choices = apexLabels.slice(0, 4);
  }
  let apexContainers = await ctx.locator("div.sia-distractor, [class*='sia-distractor'], [id^='sia-distractor-']").all();
  if (apexContainers.length < 4) apexContainers = await ctx.locator("div[id^='sia-multiple-choice-label-']").all();
  if (choices.length < 4 && apexContainers.length >= 4) {
    for (let i = 0; i < 4; i++) {
      const raw = (await apexContainers[i]!.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
      const stripped = raw.replace(/^\s*[A-D][.)]\s*/i, "").trim();
      if (stripped.length > 0) choices.push(stripped.slice(0, 300));
    }
    if (choices.length >= 4) choices = choices.slice(0, 4);
  }
  // Fallback: find choice text via evaluate (includes shadow DOM); try main page then each frame
  if (choices.length < 4) {
    const evalChoiceText = (): string[] => {
      const out: string[] = [];
      const walk = (root: Document | ShadowRoot | Element): void => {
        try {
          const q = (root as Document).querySelectorAll?.("[class*='sia-distractor'], [id^='sia-distractor-'], [id*='multiple-choice-label']") ?? [];
          for (const el of Array.from(q)) {
            const t = (el as HTMLElement).innerText?.trim().replace(/\s+/g, " ") ?? "";
            const m = t.match(/^\s*[A-D][.)]\s*(.+)$/);
            if (m && m[1].length > 2 && m[1].length < 250 && (m[1].includes("√") || /\d|²|^[x0-9+]/.test(m[1]))) out.push(m[1]);
          }
          const iter = (root as Document).querySelectorAll?.("*") ?? [];
          for (const el of Array.from(iter)) {
            if ((el as Element).shadowRoot) walk((el as Element).shadowRoot!);
          }
        } catch (_) {}
      };
      walk(document);
      return out.slice(0, 6);
    };
    let fromEvaluate = await page.evaluate(evalChoiceText).catch(() => []);
    if (fromEvaluate.length < 4) {
      for (const frame of frames) {
        if (frame === page.mainFrame()) continue;
        fromEvaluate = await frame.evaluate(evalChoiceText).catch(() => []);
        if (fromEvaluate.length >= 4) break;
      }
    }
    if (fromEvaluate.length >= 4 && choices.length < 4) choices = fromEvaluate.slice(0, 4);
    // Also collect by A/B/C/D text in any element (including shadow) for math-like content
    if (choices.length < 4) {
      const byLetter = await page.evaluate((): string[] => {
        const sidebar = /Sem\s*2|Algebra|Biology|English|History|Unit\s*\d|Rational|Radical|Trigonometry|Statistical/i;
        const mathLike = (s: string) => /√|²|\d\s*[+x]|x\s*[+\d]/.test(s);
        const withLetter: { letter: string; text: string }[] = [];
        const walk = (root: Document | ShadowRoot | Element) => {
          try {
            const q = (root as Document).querySelectorAll?.("[class*='choice'], [class*='option'], [class*='answer'], [class*='sia-distractor'], [id*='multiple-choice'], label, li, [role='radio'], mat-radio-button") ?? [];
            for (const el of Array.from(q)) {
              const t = ((el as HTMLElement).innerText ?? "").trim();
              const m = t.match(/^\s*([A-D])[.)]\s*(.+)/);
              if (!m || m[2].length < 2 || m[2].length > 280) continue;
              if (sidebar.test(m[2]) && !mathLike(m[2])) continue;
              withLetter.push({ letter: m[1], text: m[2].replace(/\s+/g, " ").slice(0, 300) });
            }
            const iter = (root as Document).querySelectorAll?.("*") ?? [];
            for (const el of Array.from(iter)) {
              if ((el as Element).shadowRoot) walk((el as Element).shadowRoot!);
            }
          } catch (_) {}
        };
        walk(document);
        const byLetterSorted: string[] = [];
        for (const letter of ["A", "B", "C", "D"]) {
          const found = withLetter.filter((w) => w.letter === letter).sort((a, b) => a.text.length - b.text.length);
          if (found.length > 0) byLetterSorted.push(found[0].text);
        }
        return byLetterSorted.slice(0, 4);
      }).catch(() => []);
      if (byLetter.length >= 2 && choices.length < 2) choices = byLetter;
    }
  }

  let radioEls = ctx.locator("input[type='radio']");
  let radioCount = await radioEls.count();
  if (radioCount === 0) {
    radioEls = ctx.locator("[role='radio']");
    radioCount = await radioEls.count();
  }
  if (radioCount === 0 || (typeof process !== "undefined" && process.env?.DEBUG_APEX_QUIZ === "1")) {
    console.log("[parseApexQuiz] mainRadios=" + mainRadios, "frameRadios=" + JSON.stringify(frameRadios), "ctxRadios=" + radioCount, "ctxIsFrame=" + (ctx !== page));
  }
  let bodyTextForLog = "";
  if (choices.length < 4) {
  if (radioCount >= 2) {
    for (let i = 0; i < Math.min(radioCount, 6); i++) {
      const el = radioEls.nth(i);
      let text = await el.evaluate((node) => {
        const input = node as HTMLInputElement;
        const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
        const labelText = label?.textContent?.trim() ?? "";
        const parent = node.closest("li, [role='radio'], [class*='option'], [class*='choice'], label, div") || node.parentElement;
        const rowText = parent?.textContent?.trim().replace(/\s+/g, " ").slice(0, 400) ?? "";
        const stripLetter = rowText.replace(/^\s*[A-D][.)]\s*/i, "").trim();
        if (stripLetter.length > 2) return stripLetter;
        if (rowText.length > 2) return rowText.replace(/\s+/g, " ").trim().slice(0, 200);
        return labelText;
      }).catch(() => "");
      text = (text || "").trim();
      if (text.length > 0) choices.push(text);
    }
    if (choices.length >= 4) choices = choices.slice(0, 4);
  }
  }
  if (choices.length < 4) {
    const choiceEls = ctx.locator(SELECTORS.quizChoices);
    const n = await choiceEls.count();
    for (let i = 0; i < Math.min(n, 6); i++) {
      const el = choiceEls.nth(i);
      const text = (await el.innerText().catch(() => "")).trim().replace(/^\s*[A-D][.)]\s*/i, "").trim();
      if (text.length > 0) choices.push(text.slice(0, 300));
    }
    if (choices.length >= 4) choices = choices.slice(0, 4);
  }
  const bodyText = (await ctx.locator("body").innerText({ timeout: 4000 }).catch(() => "")) ?? "";
  bodyTextForLog = bodyText;
  let textSources: string[] = main.length >= 200 ? [main, bodyText] : [bodyText];
  // If no radios found, include all frames' body text (quiz may be in iframe)
  if (radioCount < 2 && frames.length > 1) {
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      const frameBody = await frame.locator("body").innerText({ timeout: 2000 }).catch(() => "");
      if (frameBody.length > 100) textSources.push(frameBody);
    }
  }
  let textChoices: string[] = [];
  for (const src of textSources) {
    if (src.length < 50) continue;
    textChoices = parseChoicesFromText(src);
    if (textChoices.length >= 4) break;
  }
  if (textChoices.length < 2 && bodyText.length >= 50) {
    const byLabel = await ctx.evaluate(() => {
      const out: string[] = [];
      const re = /^\s*([A-D])[.)]\s*(.+)/s;
      const walk = (node: Node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          const text = (el as HTMLElement).innerText?.trim() ?? "";
          if (text && re.test(text)) {
            const m = text.match(re);
            if (m && m[2]) out.push(m[2].trim().replace(/\s+/g, " ").slice(0, 300));
          }
        }
        for (const c of node.childNodes) walk(c);
      };
      walk(document.body);
      return out.slice(0, 6);
    }).catch(() => []);
    if (byLabel.length >= 2) textChoices = byLabel;
  }
  // Fallback: find elements that look like choice rows (e.g. "A. √7x² + 14x")
  if (textChoices.length < 4 && choices.length < 4) {
    const byRow = await ctx.evaluate(() => {
      const out: string[] = [];
      const nodes = document.querySelectorAll("[class*='choice'], [class*='option'], [class*='answer'], label, li, [class*='response'], [role='radio']");
      for (const el of Array.from(nodes)) {
        let t = (el as HTMLElement).innerText?.trim().replace(/\s+/g, " ") ?? "";
        if (!t || t.length < 4) continue;
        // One container may hold all 4 choices: "Question A. √7x²+14x B. √7x²+x C. ... D. ..."
        if (/[A-D][.)]\s*.+[A-D][.)]\s*.+/.test(t)) {
          const segments = t.split(/\s+[A-D][.)]\s*/).map((s) => s.trim()).filter((s) => s.length > 0);
          if (segments.length >= 5) {
            for (let i = 1; i <= 4; i++) out.push(segments[i].slice(0, 200));
            return out.slice(0, 4);
          }
          if (segments.length >= 4) {
            for (let i = 0; i < 4; i++) out.push(segments[i].slice(0, 200));
            return out.slice(0, 4);
          }
        }
        const match = t.match(/^\s*[A-D][.)]\s*(.+)$/);
        if (match && match[1].length > 1 && match[1].length < 250) out.push(match[1]);
      }
      return out.slice(0, 6);
    }).catch(() => []);
    if (byRow.length >= 2 && textChoices.length < byRow.length) textChoices = byRow;
  }
  // Last resort: split body/main by choice markers even if we got one big blob
  if (textChoices.length < 4 && (bodyText.length > 200 || main.length > 200)) {
    const src = main.length >= bodyText.length ? main : bodyText;
    const split = src.split(/\s+[A-D][.)]\s*/);
    if (split.length >= 5) {
      const four: string[] = [];
      for (let i = 1; i <= 4 && i < split.length; i++) {
        const chunk = (split[i] ?? "").trim().split(/\s+[A-D][.)]\s*/)[0]?.trim().slice(0, 200) ?? "";
        if (chunk.length > 0) four.push(chunk);
      }
      if (four.length >= 4) textChoices = four;
    }
  }
  if (textChoices.length === 4 && choices.length < 4) {
    choices = textChoices;
    const src = main.length >= 100 ? main : bodyText;
    const beforeFirst = src.split(/\s+[A-D][.)]\s+/)[0] ?? "";
    const qMatch = beforeFirst.replace(/\s*Question \d+ of \d+\s*/gi, " ").trim();
    if (qMatch.length > 20) questionText = qMatch.slice(0, 2000);
  } else if (textChoices.length >= 2 && choices.length < 2) {
    choices = textChoices;
  }
  const navLabels = ["Submit", "SUBMIT", "Back", "Previous", "PREVIOUS", "Next", "RESUME", "Continue", "CONTINUE"];
  const sidebarPattern = /(Sem\s*2|Unit\s*\d+|Algebra|Biology|English|History|Rational|Radical|Trigonometry|Statistical)/i;
  choices = choices.filter((c) => {
    const t = c.trim();
    if (t.length <= 1) return false;
    if (navLabels.some((n) => t === n || t.startsWith(n + " "))) return false;
    if (sidebarPattern.test(t) && !t.includes("√") && !/\d+\s*[+x²]/.test(t)) return false;
    if (t.length <= 2 && !/^[A-D]$/i.test(t)) return false;
    return true;
  });
  if (choices.length === 0 && textChoices.length >= 2) {
    choices = textChoices.filter((c) => {
      const t = c.trim();
      if (t.length <= 1 || t.length >= 200) return false;
      if (navLabels.some((n) => t === n || t.startsWith(n + " "))) return false;
      if (sidebarPattern.test(t) && !t.includes("√") && !/\d+\s*[+x²]/.test(t)) return false;
      return true;
    });
  }
  if (choices.length > 6) {
    choices = choices.slice(0, 4);
  }
  if (choices.length >= 4 && choices.length <= 6) {
    choices = choices.slice(0, 4);
  }
  if (choices.length > 0 && !questionText && main.length > 50) {
    const beforeFirstChoice = main.split(/\s+[A-D][.)]\s+/)[0] ?? "";
    const qMatch = beforeFirstChoice.replace(/\s*Question \d+ of \d+\s*/gi, " ").trim();
    if (qMatch.length > 20) questionText = qMatch.slice(0, 2000);
  }
  if (!questionText && main.length > 80) {
    questionText = main.replace(/\s*(PREVIOUS|SUBMIT|Next|Back)\s*/gi, " ").trim().slice(0, 2000);
  }
  if (questionText && questionText.length < 30 && main.length > 100) {
    const match = main.match(/(.{0,20}(?:which choice|equivalent|product below|acceptable values).{10,400}?)(?=\s+[A-D][.)]|$)/is);
    if (match && match[1]) questionText = match[1].replace(/\s+/g, " ").trim().slice(0, 1500);
  }

  const buttons: string[] = ["Submit", "SUBMIT", "Next", "Previous", "PREVIOUS", "Back"];
  const body = await ctx.locator("body").innerText().catch(() => "");
  /**
   * Post-quiz **score / itemized results** (You earned X of Y, EXPAND ALL, doneCompleted). Must be detected **before**
   * `looksLikeMcq`: leftover DOM often still has "Question N of N", SUBMIT in chrome, and radio inputs — otherwise we
   * never set `quizSummaryReached`, the plan never advances off the completed quiz, and the agent loops map ↔ summary.
   */
  const looksLikeFinalResultsScreen =
    /\byou\s+earned\s+\d+\s+out\s+of\s+\d+/i.test(body) &&
    (/\bcompleted\b/i.test(body) ||
      /done\s*completed/i.test(body) ||
      /\bdonecompleted\b/i.test(body.toLowerCase()) ||
      /\bEXPAND\s+ALL\b/i.test(body));
  // "continue" often appears in question text or chrome; on MCQ screens SUBMIT is the real CTA — do not tag CONTINUE.
  const looksLikeMcq =
    !looksLikeFinalResultsScreen &&
    /question\s+\d+\s+of\s+\d+/i.test(body) &&
    (/SUBMIT/i.test(body) || (await ctx.locator("input[type='radio']").count().catch(() => 0)) >= 2);
  /**
   * After submit, Apex shows NEXT QUESTION + a selected choice — body regex often misses "Correct" (styling/iframe).
   * If we skip this, the agent loops on vision (INCOMPLETE_VIEWPORT) instead of clicking Next.
   */
  let feedbackDomGraded = await detectGradedMcqFeedbackDom(ctx);
  if (!feedbackDomGraded && ctx !== page) {
    feedbackDomGraded = await detectGradedMcqFeedbackDom(page);
  }
  if (!feedbackDomGraded) {
    for (const frame of page.frames()) {
      if (frame === ctx) continue;
      if (await detectGradedMcqFeedbackDom(frame)) {
        feedbackDomGraded = true;
        break;
      }
    }
  }
  if (
    !looksLikeMcq &&
    (/continue/i.test(body) || (await ctx.getByRole("button", { name: /continue/i }).count()) > 0)
  ) {
    if (!buttons.includes("CONTINUE")) buttons.push("CONTINUE");
  }
  // On live MCQ screens, body text often contains "start" (e.g. "get started"); do not tag START or CLICK beats SUBMIT_ANSWER.
  if (
    !looksLikeMcq &&
    (/start/i.test(body) || (await ctx.getByRole("button", { name: /start/i }).count()) > 0)
  ) {
    if (!buttons.includes("START")) buttons.push("START");
  }
  if (/view summary/i.test(body) || (await ctx.getByRole("button", { name: /view summary/i }).count()) > 0) {
    if (!buttons.includes("View Summary")) buttons.push("View Summary");
  }
  let hasActivitiesBtn = false;
  try {
    hasActivitiesBtn =
      (await ctx.getByRole("button", { name: /^activities$/i }).count()) > 0 ||
      (await ctx.getByRole("link", { name: /^activities$/i }).count()) > 0 ||
      (await ctx.locator("[aria-label*='Activities' i]").count()) > 0;
  } catch {
    hasActivitiesBtn = false;
  }
  if (hasActivitiesBtn && !buttons.includes("Activities")) buttons.push("Activities");
  /** Apex often shows graded feedback as a bold line "Correct" / "Correct!" (not "that's correct") — must count as feedback so we click NEXT QUESTION, not re-run vision. */
  const standaloneCorrectFeedbackLine =
    /(?:^|[\n\r])[\s\u00a0]*\bCorrect\b[\s\u00a0]*(?:!|\.)?[\s\u00a0]*(?:[\n\r]|$)/m.test(body) &&
    !/(?:^|[\n\r])[\s\u00a0]*Correct\s+\w/m.test(body);
  /** Same as above but case-insensitive (some themes use lowercase in the accessibility tree). */
  const standaloneCorrectLineInsensitive =
    /(?:^|[\n\r])[\s\u00a0]*\bcorrect\b[\s\u00a0]*(?:!|\.)?[\s\u00a0]*(?:[\n\r]|$)/im.test(body) &&
    !/(?:^|[\n\r])[\s\u00a0]*correct\s+\w/im.test(body);
  /** Graded screen with NEXT QUESTION but unusual copy (e.g. short Incorrect line without "X Incorrect"). */
  const feedbackAfterNextQuestionCta =
    looksLikeMcq &&
    /NEXT\s+QUESTION/i.test(body) &&
    /(?:^|[\n\r])[\s\u00a0]*\bIncorrect\b[\s\u00a0]*(?:!|\.)?[\s\u00a0]*(?:[\n\r]|$)/m.test(body) &&
    !/\bCorrect!\b/i.test(body) &&
    !standaloneCorrectFeedbackLine;
  const feedbackVisible =
    /the correct answer is/i.test(body) ||
    /\bX\s*Incorrect\b/i.test(body) ||
    /that'?s (right|correct)/i.test(body) ||
    /\bCorrect!\b/i.test(body) ||
    standaloneCorrectFeedbackLine ||
    standaloneCorrectLineInsensitive ||
    feedbackAfterNextQuestionCta ||
    feedbackDomGraded;

  if (process.env.DEBUG_QUIZ_FEEDBACK === "1") {
    console.log(
      "[parseApexQuiz] feedbackVisible=",
      !!feedbackVisible,
      "feedbackDomGraded=",
      feedbackDomGraded,
      "looksLikeMcq=",
      looksLikeMcq
    );
  }

  /** Learner attempt result when feedback strip is visible (for learning-graph red/green pings). */
  let feedbackOutcome: "correct" | "incorrect" | undefined;
  if (feedbackVisible) {
    if (/\bX\s*Incorrect\b/i.test(body) || /the correct answer is/i.test(body) || feedbackAfterNextQuestionCta) {
      feedbackOutcome = "incorrect";
    } else if (/that'?s\s+not\s+(?:the\s+)?correct/i.test(body) || /\bnot\s+correct\b/i.test(body)) {
      feedbackOutcome = "incorrect";
    } else if (
      /that'?s\s+(right|correct)\b/i.test(body) ||
      /\bCorrect!\b/.test(body) ||
      /\byou\s+got\s+it\s+right\b/i.test(body) ||
      standaloneCorrectFeedbackLine ||
      standaloneCorrectLineInsensitive ||
      feedbackDomGraded
    ) {
      feedbackOutcome = "correct";
    }
  }
  /** Final score / completion (not live MCQ) — plan can advance; prefer header Activities over CONTINUE. */
  const quizResultsCompleted =
    looksLikeFinalResultsScreen ||
    (!looksLikeMcq &&
      (/\bcompleted\b/i.test(body) || /done\s*completed/i.test(body) || /\bdonecompleted\b/i.test(body.toLowerCase())) &&
      (/\byou\s+earned\s+\d+\s+out\s+of\s+\d+/i.test(body) ||
        /\b\d+\s+out\s+of\s+\d+\s+points/i.test(body) ||
        /\bearned\s+\d+\s+out\s+of\s+\d+/i.test(body)));
  /**
   * Itemized results (e.g. Question 17 … points / CHECK) + CONTINUE — not a live MCQ.
   * Without this, hasSubmit still wins in the FSM and the agent loops on vision instead of clicking Continue.
   */
  const questionNumberLabels = body.match(/\bquestion\s+\d{1,2}\b/gi);
  const quizInterimItemizedSummary =
    !looksLikeMcq &&
    (/continue/i.test(body) || buttons.includes("CONTINUE")) &&
    /\bquestion\s+\d{1,2}\b/i.test(body) &&
    (/\b\d+\s*points?\b/i.test(body) ||
      /\bCHECK\b/i.test(body) ||
      /[✓✔]/u.test(body) ||
      (questionNumberLabels !== null && questionNumberLabels.length >= 2));
  const quizSummaryReached =
    buttons.includes("View Summary") ||
    /\bview\s+summary\b/i.test(body) ||
    (/\b(your\s+score|score\s+for\s+this|performance\s+(on\s+this|summary)|assessment\s+summary|results?\s+summary)\b/i.test(body) &&
      !looksLikeMcq) ||
    quizResultsCompleted ||
    quizInterimItemizedSummary;

  if (choices.length === 0 && bodyTextForLog) {
    console.log("[parseApexQuiz] bodyLength=" + bodyTextForLog.length, "snippet=" + JSON.stringify(bodyTextForLog.slice(0, 280).replace(/\s+/g, " ")));
    // Diagnose why: iframe, late iframe, or shadow DOM?
    const diag = await (async () => {
      const frames = page.frames();
      // Minimal evaluate so we always get numbers (no shadow walk — can throw/serialize badly)
      const mainInfo = await page.evaluate(() => {
        let sia = 0, multi = 0, bodyLen = 0;
        try {
          sia = document.querySelectorAll("[class*='sia-distractor'], [id^='sia-distractor-']").length;
        } catch (_) {}
        try {
          multi = document.querySelectorAll("[id*='multiple-choice-label']").length;
        } catch (_) {}
        try {
          bodyLen = document.body ? (document.body.innerText || "").length : 0;
        } catch (_) {}
        return { sia, multi, shadowRootCount: 0, inShadowSia: 0, inShadowMulti: 0, bodyLen };
      }).catch(() => null);
      const mainSafe = mainInfo ?? { sia: -1, multi: -1, shadowRootCount: 0, inShadowSia: 0, inShadowMulti: 0, bodyLen: bodyTextForLog.length };
      const frameInfos: { url: string; name: string; sia: number; multi: number; bodyLen: number }[] = [];
      for (const frame of frames) {
        if (frame === page.mainFrame()) continue;
        const info = await frame.evaluate(() => {
          try {
            return {
              sia: document.querySelectorAll("[class*='sia-distractor'], [id^='sia-distractor-']").length,
              multi: document.querySelectorAll("[id*='multiple-choice-label']").length,
              bodyLen: document.body ? (document.body.innerText || "").length : 0,
            };
          } catch (_) {
            return { sia: -1, multi: -1, bodyLen: -1 };
          }
        }).catch(() => ({ sia: -1, multi: -1, bodyLen: -1 }));
        frameInfos.push({ url: frame.url().slice(0, 80), name: frame.name() || "(unnamed)", ...info });
      }
      return { main: mainSafe, frames: frameInfos, frameCount: frames.length };
    })().catch((e) => {
      console.log("[parseApexQuiz] DIAG error:", (e as Error)?.message ?? e);
      return null;
    });
    if (diag) {
      const m = diag.main;
      console.log("[parseApexQuiz] DIAG: main: sia=" + m.sia + " multi=" + m.multi + " shadowRoots=" + m.shadowRootCount + " inShadowSia=" + m.inShadowSia + " inShadowMulti=" + m.inShadowMulti + " bodyLen=" + m.bodyLen);
      console.log("[parseApexQuiz] DIAG: frameCount=" + diag.frameCount + (diag.frames?.length ? " iframes=" + JSON.stringify(diag.frames) : " (no iframes)"));
      if ((m.sia >= 4 || m.multi >= 4) && choices.length === 0) {
        const table = await page.evaluate(() => {
          const sel1 = "[class*='sia-distractor'], [id^='sia-distractor-']";
          const sel2 = "[id^='sia-multiple-choice-label-'], [id*='multiple-choice-label']";
          let nodes = Array.from(document.querySelectorAll(sel1));
          if (nodes.length < 4) nodes = Array.from(document.querySelectorAll(sel2));
          const root = document;
          const getLabel = (el: Element): string => {
            const ariaLabel = (el as HTMLElement).getAttribute?.("aria-label")?.trim();
            if (ariaLabel) return ariaLabel.slice(0, 60);
            const labelledBy = (el as HTMLElement).getAttribute?.("aria-labelledby");
            if (labelledBy) {
              const parts = labelledBy.split(/\s+/).map((id) => root.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean);
              if (parts.length) return parts.join(" ").slice(0, 60);
            }
            return ((el as HTMLElement).innerText ?? "").trim().slice(0, 60);
          };
          return nodes.slice(0, 4).map((el, i) => {
            const rect = (el as HTMLElement).getBoundingClientRect?.();
            const style = (el as HTMLElement).ownerDocument?.defaultView?.getComputedStyle?.(el as HTMLElement);
            const visible = rect && rect.width > 0 && rect.height > 0 && style?.getPropertyValue("display") !== "none" && style?.getPropertyValue("visibility") !== "hidden";
            return {
              index: i,
              tagName: (el as Element).tagName,
              role: (el as HTMLElement).getAttribute?.("role") ?? "",
              ariaLabel: (el as HTMLElement).getAttribute?.("aria-label") ?? "",
              ariaLabelledby: (el as HTMLElement).getAttribute?.("aria-labelledby") ?? "",
              innerTextLen: ((el as HTMLElement).innerText ?? "").length,
              visible: !!visible,
              width: rect?.width ?? 0,
              height: rect?.height ?? 0,
              label: getLabel(el),
            };
          });
        }).catch(() => []);
        console.log("[parseApexQuiz] DIAG: 4 nodes table (sia/multi=4 but choices=0):");
        table.forEach((row: { index: number; tagName: string; role: string; ariaLabel: string; ariaLabelledby: string; innerTextLen: number; visible: boolean; width: number; height: number; label: string }) => {
          console.log(`  [${row.index}] tag=${row.tagName} role=${row.role} aria-label=${JSON.stringify(row.ariaLabel.slice(0, 40))} aria-labelledby=${JSON.stringify(row.ariaLabelledby)} innerTextLen=${row.innerTextLen} visible=${row.visible} bbox=${row.width}x${row.height} label=${JSON.stringify(row.label.slice(0, 50))}`);
        });
      }
    }
  }
  let outChoices = choices;
  let outQuestion = questionText;
  if (quizInterimItemizedSummary) {
    outChoices = [];
    outQuestion = undefined;
  }
  /** Reading passage split from stem for the text solver (passage + question + choices). */
  let quizPassageText: string | undefined;
  if (!quizInterimItemizedSummary && looksLikeMcq && outQuestion && outQuestion.length > 20) {
    try {
      const passageLoc = ctx
        .locator(
          "[class*='passage'], [class*='reading-passage'], [id*='passage'], [data-testid*='passage'], article[class*='passage']"
        )
        .first();
      if ((await passageLoc.count()) > 0) {
        const pt = (await passageLoc.innerText().catch(() => "")).trim();
        if (pt.length > 80) quizPassageText = pt.slice(0, 12000);
      }
      if (!quizPassageText) {
        const anchor = outQuestion.slice(0, Math.min(100, outQuestion.length));
        const pos = main.indexOf(anchor);
        if (pos > 100) {
          const pre = main
            .slice(0, pos)
            .replace(/\s*Question\s+\d+\s+of\s+\d+\s*/gi, " ")
            .trim();
          if (pre.length > 120) quizPassageText = pre.slice(0, 12000);
        }
      }
    } catch {
      /* ignore passage extraction errors */
    }
  }
  const quizScoreSnapshot = quizSummaryReached ? parseQuizScoreFromBody(body) : undefined;
  const quizSummaryPerQuestion = quizSummaryReached ? parseQuizSummaryQuestionOutcomesFromBody(body) : undefined;
  return {
    state: "QUIZ_SCREEN",
    questionText: outQuestion,
    choices: outChoices,
    quizMultiSelect: outQuestion ? inferQuizMultiSelect(outQuestion) : false,
    buttons,
    ready: true,
    networkIdle: true,
    feedbackVisible: !!feedbackVisible,
    ...(feedbackOutcome ? { feedbackOutcome } : {}),
    ...(feedbackVisible ? { quizFeedbackTextSample: body.slice(0, 8000) } : {}),
    quizSummaryReached,
    ...(quizScoreSnapshot ? { quizScoreSnapshot } : {}),
    ...(quizSummaryPerQuestion && quizSummaryPerQuestion.length > 0 ? { quizSummaryPerQuestion } : {}),
    ...(quizPassageText ? { quizPassageText } : {}),
  };
}

/**
 * Full Apex observation: detect screen then parse.
 * Uses a 6s cap per operation so the parser never blocks the step for long.
 */
export async function getApexObservation(page: Page): Promise<Observation> {
  page.context().setDefaultTimeout(PARSER_TIMEOUT_MS);
  try {
    const url = page.url();
    const screen = await detectApexScreen(page);
    let obs: Observation;
    switch (screen) {
    case "LMS_DASHBOARD":
      obs = await parseApexLmsDashboard(page);
      break;
    case "DASHBOARD":
      obs = await parseApexDashboard(page);
      break;
    case "LESSON_STRIP":
      obs = await parseApexLessonStrip(page);
      break;
    case "QUIZ":
      obs = await parseApexQuiz(page);
      break;
    default:
      obs = {
        state: "MAIN_MENU",
        buttons: [],
        ready: true,
        networkIdle: true,
      };
  }
    obs.url = url;
    return obs;
  } finally {
    page.context().setDefaultTimeout(30000);
  }
}
