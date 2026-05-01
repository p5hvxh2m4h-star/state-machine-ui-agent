/**
 * Playwright UI driver: launches browser, reads the screen, clicks elements.
 * Supports known context (e.g. Apex Learning) or Claude/generic parsing.
 */

import type { IUIDriver } from "./driver.js";
import type { Observation, Action, ActionResult } from "./types.js";
import { parseLessonCode } from "./state-machine.js";
import { readScreenWithClaude } from "./screen-reader-claude.js";
import { getApexObservation } from "./parsers/apex-learning.js";
import { getEdmentumObservation } from "./parsers/edmentum.js";
import { getQuizClickCoordinatesFromScreenshot } from "./quiz-solver.js";

import type { Page, Frame, Browser, BrowserContext } from "playwright";
import {
  nextFloat,
  jitterMs,
  shouldMisclick,
  humanHesitationMs,
  humanCorrectionPauseMs,
  answerToSubmitDelayMs,
  scrollAmountPx,
  scrollOvershootPx,
} from "./prng.js";
import { delayWithJitter } from "./timing.js";

const LETTERS_ABCDEF = ["A", "B", "C", "D", "E", "F"] as const;

/** Multi-select: click each choice row (checkbox / label) by letter; tries main frame then iframes. */
async function tryMultiSelectPlaywrightLocators(page: Page, indices: number[]): Promise<boolean> {
  const uniq = [...new Set(indices)]
    .map((i) => Math.floor(i))
    .filter((i) => i >= 0 && i <= 5)
    .sort((a, b) => a - b);
  if (uniq.length === 0) return false;
  const contexts: (Page | Frame)[] = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const ctx of contexts) {
    try {
      let allOk = true;
      for (const idx of uniq) {
        const L = LETTERS_ABCDEF[idx];
        if (!L) {
          allOk = false;
          break;
        }
        const startRe = new RegExp(`^\\s*${L}[.)]\\s`, "i");
        let clicked = false;
        const cb = ctx.getByRole("checkbox", { name: startRe }).first();
        if ((await cb.count()) > 0) {
          await cb.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await cb.click({ timeout: 5000 }).catch(() => {});
          clicked = true;
        }
        if (!clicked) {
          const row = ctx
            .locator("mat-checkbox, label, div.sia-distractor, [class*='choice'], [class*='option'], [role='checkbox']")
            .filter({ hasText: startRe })
            .first();
          if ((await row.count()) > 0) {
            await row.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await row.click({ timeout: 5000 }).catch(() => {});
            clicked = true;
          }
        }
        if (!clicked) {
          allOk = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      if (allOk) {
        console.log("[SUBMIT_ANSWER] multi-select Playwright locator clicks:", uniq.join(","));
        return true;
      }
    } catch {
      /* try next context */
    }
  }
  return false;
}

/** One vision API call: coords for A–D + Submit, then click each selected index in order. */
async function tryMultiSelectVisionCoords(page: Page, indices: number[]): Promise<boolean> {
  const uniq = [...new Set(indices)]
    .map((i) => Math.floor(i))
    .filter((i) => i >= 0 && i <= 3)
    .sort((a, b) => a - b);
  if (uniq.length === 0) return false;
  const buf = await page.screenshot().catch(() => null);
  if (!buf || !Buffer.isBuffer(buf)) return false;
  const visionCoords = await getQuizClickCoordinatesFromScreenshot(Buffer.from(buf));
  if (!visionCoords) return false;
  const letters = ["A", "B", "C", "D"] as const;
  for (const idx of uniq) {
    const letter = letters[Math.min(idx, 3)]!;
    const coord = visionCoords[letter];
    if (!coord) return false;
    await page.mouse.click(coord.x, coord.y).catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
  const sub = visionCoords.Submit;
  await page.mouse.click(sub.x, sub.y).catch(() => {});
  console.log("[SUBMIT_ANSWER] multi-select vision coords:", uniq.join(","));
  return true;
}

export interface PlaywrightDriverOptions {
  /** Start URL (optional; call navigate(url) later). */
  startUrl?: string;
  /** Use Claude to parse page content into Observation (when siteContext is not set). */
  useClaudeScreenReader?: boolean;
  /** Selector for main content sent to Claude (default "body"). */
  contentSelector?: string;
  /** Headless (default true). */
  headless?: boolean;
  /** Known UI: "apex" = Apex course.apexlearning.com; "edmentum" = Edmentum FEDashboard grid. */
  siteContext?: "apex" | "edmentum" | "generic";
  /** Tiny misclick rate 0..0.02 for anti-detection (e.g. 0.008 = 0.8%). */
  misclickRate?: number;
  /** Use your Chrome profile (e.g. already logged in). Close Chrome before running. Path like C:\\Users\\You\\AppData\\Local\\Google\\Chrome\\User Data */
  userDataDir?: string;
}

const defaultObservation: Observation = {
  state: "MAIN_MENU",
  buttons: [],
  ready: false,
};

/** Hosts where quiz stems are often in nested scrollers — run scroll prep + multi-viewport capture. */
function isQuizVisionScrollSite(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("apexlearning") ||
    u.includes("apexvs.com") ||
    u.includes("edmentum") ||
    u.includes("geniussis") ||
    u.includes("geniusais")
  );
}

/** Apex forward strip: "Lesson 2.2", "Unit 5 Intro", etc. Often in an iframe; label may be split across nodes — use filter(hasText). */
async function clickLessonNavInAllFrames(page: Page, label: string): Promise<boolean> {
  const trimmed = label.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");
  const needsStripNudge = /^Unit\s+\d+\s+Intro$/i.test(trimmed) || /^Lesson\s+\d+\.\d+$/i.test(trimmed);
  const maxSteps = needsStripNudge ? 20 : 1;

  const tryClickInAllFramesOnce = async (): Promise<boolean> => {
    for (const frame of page.frames()) {
      try {
        const row = frame.locator("a, button, [role='button'], [role='link']").filter({ hasText: re });
        if ((await row.count()) > 0) {
          await row.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await row.first().click({ timeout: 8000 });
          return true;
        }
        if ((await frame.getByRole("link", { name: re }).count()) > 0) {
          const loc = frame.getByRole("link", { name: re }).first();
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await loc.click({ timeout: 8000 });
          return true;
        }
        if ((await frame.getByRole("button", { name: re }).count()) > 0) {
          const loc = frame.getByRole("button", { name: re }).first();
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await loc.click({ timeout: 8000 });
          return true;
        }
        const byText = frame.getByText(re).first();
        if ((await byText.count()) > 0) {
          await byText.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await byText.click({ timeout: 8000 });
          return true;
        }
      } catch {
        /* try next frame */
      }
    }
    return false;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (step === 0 && needsStripNudge) {
      await scrollApexActivityStripsToEnd(page);
      await new Promise((r) => setTimeout(r, 140));
    } else if (step > 0) {
      if (step === 1 || step % 5 === 0) await scrollApexActivityStripsToEnd(page);
      await nudgeApexActivityStripForward(page);
      await new Promise((r) => setTimeout(r, 160));
    }
    if (await tryClickInAllFramesOnce()) return true;
  }
  return false;
}

/** Jump strip scroll to the far right (last tiles like 3.2.7 sit beside the `>` control). */
async function scrollApexActivityStripsToEnd(page: Page): Promise<void> {
  const scrollEnd = () => {
    const looksLikeStrip = (el: Element): boolean => {
      const h = el as HTMLElement;
      const t = (h.innerText ?? "").slice(0, 1200);
      const cls = (h.className?.toString?.() ?? "") + (h.id ?? "");
      return (
        /\d+\.\d+\.\d+/.test(t) ||
        /lesson|activity|strip|carousel|scroll|horizontal|step|sia-|overview|quiz/i.test(cls + t)
      );
    };
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const h = el as HTMLElement;
      try {
        const st = getComputedStyle(h);
        if (st.overflowX !== "auto" && st.overflowX !== "scroll") continue;
        if (h.scrollWidth <= h.clientWidth + 5) continue;
        if (!looksLikeStrip(h)) continue;
        h.scrollLeft = h.scrollWidth - h.clientWidth;
      } catch {
        /* keep scanning */
      }
    }
  };
  await page.evaluate(scrollEnd).catch(() => {});
  for (const frame of page.frames()) {
    await frame.evaluate(scrollEnd).catch(() => {});
  }
}

/**
 * Scroll horizontal activity strips / click right chevrons so tiles like 3.2.7 (past 3.2.6) enter view.
 * Apex keeps siblings in DOM but off-viewport until the strip is scrolled.
 */
async function nudgeApexActivityStripForward(page: Page): Promise<void> {
  const hop = 320;
  const scrollOverflowX = (px: number) => {
    const looksLikeStrip = (el: Element): boolean => {
      const h = el as HTMLElement;
      const t = (h.innerText ?? "").slice(0, 1200);
      const cls = (h.className?.toString?.() ?? "") + (h.id ?? "");
      return (
        /\d+\.\d+\.\d+/.test(t) ||
        /lesson|activity|strip|carousel|scroll|horizontal|step|sia-|overview|quiz/i.test(cls + t)
      );
    };
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const h = el as HTMLElement;
      try {
        const st = getComputedStyle(h);
        if (st.overflowX !== "auto" && st.overflowX !== "scroll") continue;
        if (h.scrollWidth <= h.clientWidth + 5) continue;
        if (!looksLikeStrip(h)) continue;
        const max = h.scrollWidth - h.clientWidth;
        h.scrollLeft = Math.min(max, h.scrollLeft + px);
      } catch {
        /* keep scanning */
      }
    }
  };

  await page.evaluate(scrollOverflowX, hop).catch(() => {});
  for (const frame of page.frames()) {
    await frame.evaluate(scrollOverflowX, hop).catch(() => {});
  }

  for (const frame of page.frames()) {
    try {
      const withSvg = frame.locator("button, [role='button'], a").filter({ has: frame.locator("svg") });
      const n = await withSvg.count();
      if (n >= 2) {
        await withSvg.nth(n - 1).click({ timeout: 2000 }).catch(() => {});
        return;
      }
      const aria = frame.locator(
        "[aria-label*='next' i], [aria-label*='right' i], [title*='next' i], [data-direction='right'], [class*='right'][class*='arrow']"
      );
      if ((await aria.count()) > 0) {
        await aria.first().click({ timeout: 2000 }).catch(() => {});
        return;
      }
      const roleNext = frame.getByRole("button", { name: /^(next|forward)$/i });
      if ((await roleNext.count()) > 0) {
        await roleNext.first().click({ timeout: 2000 }).catch(() => {});
        return;
      }
      const chevOnly = frame.locator("button, [role='button'], a").filter({ hasText: /^[>›»]$/ });
      if ((await chevOnly.count()) > 0) {
        await chevOnly.last().click({ timeout: 2000 }).catch(() => {});
        return;
      }
    } catch {
      /* next frame */
    }
  }
}

/**
 * Click the horizontal unit nav tab **LESSON U.V** (last resort after activity tiles in `tryClickLessonCodeOnce`).
 * If this tab is already selected, return false — otherwise `click()` is a no-op success and the agent loops.
 */
async function tryClickApexHeaderLessonTab(page: Page, codeParts: number[]): Promise<boolean> {
  if (codeParts.length < 3) return false;
  const u = codeParts[0]!;
  const v = codeParts[1]!;
  const tabName = new RegExp(`^(LESSON|Lesson)\\s+${u}\\.${v}\\s*$`, "i");
  const ctxs: (Page | Frame)[] = [page, ...page.frames()];
  for (const ctx of ctxs) {
    try {
      const byTab = ctx.getByRole("tab", { name: tabName });
      if ((await byTab.count()) > 0) {
        const first = byTab.first();
        const sel = await first.getAttribute("aria-selected").catch(() => null);
        if (sel === "true") return false;
        await first.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await first.click({ timeout: 8000 });
        return true;
      }
      const inChrome = ctx
        .locator("header, [class*='header'], nav, [role='navigation'], [role='tablist'], [class*='tab']")
        .locator("a, button, [role='tab'], [role='button']")
        .filter({ hasText: new RegExp(`^(LESSON|Lesson)\\s+${u}\\.${v}\\s*$`, "i") });
      const n = await inChrome.count();
      for (let i = 0; i < Math.min(n, 24); i++) {
        const el = inChrome.nth(i);
        const t = (await el.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
        if (tabName.test(t)) {
          const sel = await el.getAttribute("aria-selected").catch(() => null);
          if (sel === "true") return false;
          await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 8000 });
          return true;
        }
      }
    } catch {
      /* next ctx */
    }
  }
  return false;
}

/**
 * One attempt for a single dotted code (e.g. 4.1.2 or 4.1).
 * @param isPrefixFallback — when true, `4.1` must not match longer activity codes like `4.1.1` / `4.1.2`
 *   (those contain `4.1` as a substring). Uses `(?!\\.\\d)` so unit/lesson tiles like `Lesson 4.1` still match.
 */
async function tryClickLessonCodeForParts(
  page: Page,
  codeParts: number[],
  isPrefixFallback = false
): Promise<boolean> {
  if (codeParts.length === 0) return false;
  const needle = codeParts.join(".");
  const exact = new RegExp(`^\\s*${needle.replace(/\./g, "\\.")}\\s*$`);
  const escaped = needle.replace(/\./g, "\\.");
  const embedded = isPrefixFallback
    ? new RegExp(`\\b${escaped}(?!\\.\\d)`)
    : new RegExp(`\\b${escaped}\\b`);
  for (const frame of page.frames()) {
    try {
      const tile = frame
        .locator("a, button, [role='button'], [role='link'], [class*='card'], [class*='activity'], [class*='tile']")
        .filter({ hasText: embedded });
      const tileCount = await tile.count();
      for (let ti = 0; ti < tileCount; ti++) {
        try {
          const t = tile.nth(ti);
          await t.scrollIntoViewIfNeeded({ timeout: 5000 });
          await t.click({ timeout: 8000 });
          return true;
        } catch {
          /* try next tile / strategy */
        }
      }

      const textLocators = [
        frame.getByText(exact),
        frame.getByText(needle, { exact: true }),
        frame.getByText(embedded),
      ];
      for (const group of textLocators) {
        const nc = await group.count();
        for (let ni = 0; ni < nc; ni++) {
          try {
            const el = group.nth(ni);
            await el.scrollIntoViewIfNeeded({ timeout: 5000 });
            await el.click({ timeout: 8000 });
            return true;
          } catch {
            /* next */
          }
        }
      }
    } catch {
      /* next frame */
    }
  }
  return false;
}

/**
 * One attempt: full activity tile **U.V.Z**, then **LESSON U.V** header tab (unit intro / band navigation).
 *
 * No **U.V**-only prefix click here: on English lesson strips, `\b3\.1(?!\.\d)` often matches the wrong row
 * (e.g. "3.1" in "3.1.1" labels or "3.1 Study") and opens **3.1.1 Checkup** instead of **3.1.4**. Strip scroll
 * + full triple + header tab is enough for Biology-style intros.
 */
async function tryClickLessonCodeOnce(page: Page, codeParts: number[]): Promise<boolean> {
  if (await tryClickLessonCodeForParts(page, codeParts)) return true;
  if (codeParts.length >= 3 && (await tryClickApexHeaderLessonTab(page, codeParts))) return true;
  return false;
}

/** Apex Angular: "Activity Completed" / similar dialogs block footer CONTINUE; dismiss without advancing the lesson sequence. */
async function tryDismissApexBlockingOverlays(page: Page): Promise<void> {
  const tryIn = async (ctx: Page | Frame): Promise<boolean> => {
    try {
      const notYet = ctx.getByRole("button", { name: /not\s*yet/i });
      if ((await notYet.count()) > 0) {
        await notYet.first().click({ timeout: 4000 });
        await new Promise((r) => setTimeout(r, 280));
        return true;
      }
    } catch {
      /* keep going */
    }
    return false;
  };
  if (await tryIn(page)) return;
  for (const frame of page.frames()) {
    if (await tryIn(frame)) return;
  }
  await page.keyboard.press("Escape").catch(() => {});
}

/** Click a lesson code (e.g. 3.4.2) wherever it appears (multi-frame). Nudges horizontal strip until found. */
async function clickLessonCodeInAllFrames(page: Page, codeParts: number[]): Promise<boolean> {
  const maxStripNudges = 40;
  for (let step = 0; step <= maxStripNudges; step++) {
    if (step > 0) {
      // Far-right tiles (e.g. 3.2.7 by the `>`) need max scroll or many hops; snap to end periodically.
      if (step === 3 || step === 7 || step % 6 === 0) {
        await scrollApexActivityStripsToEnd(page);
        await new Promise((r) => setTimeout(r, 120));
      }
      await nudgeApexActivityStripForward(page);
      await new Promise((r) => setTimeout(r, 140));
    }
    if (await tryClickLessonCodeOnce(page, codeParts)) return true;
  }
  return false;
}

/**
 * Apex stacks a flashcard PREVIOUS/NEXT (often disabled) before the real activity footer controls.
 * Clicks the last enabled matching button outside `.flashcard-nav-button`.
 */
/** Header control (briefcase) — returns to the activity/module map; avoids footer CONTINUE → next sequential item. */
async function clickApexActivitiesButton(page: Page, target: string): Promise<boolean> {
  if (!/^activities$/i.test(target.trim())) return false;
  const u = page.url();
  if (!u.includes("apexlearning") && !u.includes("apexvs.com")) return false;
  const contexts: (Page | Frame)[] = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const ctx of contexts) {
    try {
      const role = ctx
        .getByRole("button", { name: /^activities$/i })
        .or(ctx.getByRole("link", { name: /^activities$/i }));
      if ((await role.count()) > 0) {
        await role.first().scrollIntoViewIfNeeded().catch(() => {});
        await role.first().click({ timeout: 8000 });
        return true;
      }
      const byAria = ctx.locator("[aria-label*='Activities' i], [title*='Activities' i]");
      if ((await byAria.count()) > 0) {
        const first = byAria.first();
        await first.scrollIntoViewIfNeeded().catch(() => {});
        await first.click({ timeout: 8000 });
        return true;
      }
    } catch {
      /* try next frame */
    }
  }
  return false;
}

async function clickApexFooterNavButton(page: Page, target: string): Promise<boolean> {
  const t = target.trim().toUpperCase();
  if (t !== "PREVIOUS" && t !== "NEXT") return false;
  const u = page.url();
  if (!u.includes("apexlearning") && !u.includes("apexvs.com")) return false;

  const candidates = page
    .locator("button:not(.flashcard-nav-button), [role='button']:not(.flashcard-nav-button)")
    .filter({ hasText: new RegExp(t, "i") });
  const count = await candidates.count();
  for (let i = count - 1; i >= 0; i--) {
    const btn = candidates.nth(i);
    if (!(await btn.isEnabled().catch(() => false))) continue;
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 8000 });
    return true;
  }
  return false;
}

/** Click RESUME inside the activity card/tile that also shows the lesson code (e.g. 3.2.5 Quiz — In Progress). */
async function clickResumeNearLessonCodeInAllFrames(page: Page, codeParts: number[]): Promise<boolean> {
  const needle = codeParts.join(".");
  const embedded = new RegExp(`\\b${needle.replace(/\./g, "\\.")}\\b`);
  for (const frame of page.frames()) {
    try {
      const card = frame
        .locator("[class*='card'], [class*='activity'], [class*='tile'], section, article, [role='region']")
        .filter({ hasText: embedded })
        .first();
      if ((await card.count()) === 0) continue;
      const resumeInCard = card
        .getByRole("button", { name: /RESUME/i })
        .or(card.getByRole("link", { name: /RESUME/i }))
        .or(card.locator("a, button, [role='button']").filter({ hasText: /^RESUME$/i }));
      if ((await resumeInCard.count()) > 0) {
        const el = resumeInCard.first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 8000 });
        return true;
      }
    } catch {
      /* next frame */
    }
  }
  return false;
}

/** Close Genius SIS / Edmentum modals that cover the course grid (Announcements, etc.). */
async function tryDismissEdmentumBlockingModals(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes("geniussis") && !url.includes("edmentum")) return false;

  const tryClick = async (loc: ReturnType<Page["locator"]>): Promise<boolean> => {
    if ((await loc.count()) === 0) return false;
    const first = loc.first();
    if (!(await first.isVisible().catch(() => false))) return false;
    await first.click({ timeout: 4000, force: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 450));
    return true;
  };

  const candidates = [
    page.locator("#ctl00_ContentPlaceHolder1_AnnouncementList1_Panel1 .modal-footer button").filter({ hasText: /^CLOSE$/i }),
    page.locator("#ctl00_ContentPlaceHolder1_AnnouncementList1_Panel1").getByRole("button", { name: /close/i }),
    page.locator("[id*='AnnouncementList']").getByRole("button", { name: /close/i }),
    page.locator(".modal.show").getByRole("button", { name: /^CLOSE$/i }),
    page.locator(".modal.show").getByRole("button", { name: /close|dismiss/i }),
    page.getByRole("button", { name: /^CLOSE$/i }),
  ];

  for (const loc of candidates) {
    if (await tryClick(loc)) return true;
  }

  const dialogClose = page.locator("[role='dialog'].modal.show [aria-label*='close' i], [role='dialog'].modal.show .close");
  if (await tryClick(dialogClose)) return true;

  return false;
}

/**
 * Playwright-based driver. Call init() then use getObservation/execute/screenshot/refresh.
 */
export class PlaywrightDriver implements IUIDriver {
  private page: Page | null = null;
  private browser: Browser | null = null;
  private persistentContext: BrowserContext | null = null;
  /** Same as persistentContext when using userDataDir; otherwise the context from browser.newContext(). Used to detect new tabs. */
  private context: BrowserContext | null = null;
  private readonly options: PlaywrightDriverOptions & {
    startUrl: string;
    useClaudeScreenReader: boolean;
    contentSelector: string;
    headless: boolean;
    siteContext: "apex" | "edmentum" | "generic";
    misclickRate: number;
    userDataDir?: string;
  };

  constructor(options: PlaywrightDriverOptions = {}) {
    this.options = {
      startUrl: options.startUrl ?? "about:blank",
      useClaudeScreenReader: options.useClaudeScreenReader ?? true,
      contentSelector: options.contentSelector ?? "body",
      headless: options.headless ?? true,
      siteContext: options.siteContext ?? "generic",
      misclickRate: options.misclickRate ?? 0,
      userDataDir: options.userDataDir,
    };
  }

  private async getObservationByContext(page: Page): Promise<Observation> {
    const url = page.url();
    // After LAUNCH we may be on Apex; use the right parser by URL when possible
    if (url.includes("apexlearning.com") || url.includes("apexvs.com")) {
      return getApexObservation(page);
    }
    if (url.includes("geniussis.com") || url.includes("edmentum")) {
      return getEdmentumObservation(page);
    }
    if (this.options.siteContext === "edmentum") return getEdmentumObservation(page);
    if (this.options.siteContext === "apex") return getApexObservation(page);
    return this.getObservationGeneric(page);
  }

  private async getObservationGeneric(page: Page): Promise<Observation> {
    const content = await page.locator(this.options.contentSelector).first().innerText().catch(() => "");
    const html = await page.locator(this.options.contentSelector).first().innerHTML().catch(() => "");
    if (this.options.useClaudeScreenReader && content.length > 0) {
      const parsed = await readScreenWithClaude(html || content);
      const state = (parsed.state as Observation["state"]) ?? defaultObservation.state;
      const lessonCode = parsed.headerText ? parseLessonCode(parsed.headerText) ?? undefined : undefined;
      return {
        state,
        lessonCode: lessonCode ?? undefined,
        headerText: parsed.headerText,
        buttons: Array.isArray(parsed.buttons) ? parsed.buttons : [],
        questionText: parsed.questionText,
        choices: parsed.choices,
        ready: parsed.ready ?? true,
        networkIdle: true,
      };
    }
    const buttons: string[] = [];
    const btnHandles = await page.getByRole("button").allTextContents();
    const linkHandles = await page.locator("a[href]").allTextContents();
    for (const t of [...btnHandles, ...linkHandles]) {
      const s = (t ?? "").trim();
      if (s && !buttons.includes(s)) buttons.push(s);
    }
    const bodyText = content.slice(0, 2000);
    const code = parseLessonCode(bodyText) ?? undefined;
    return {
      state: "LESSON_SCREEN",
      lessonCode: code ?? undefined,
      headerText: bodyText.split(/\n/)[0]?.trim(),
      buttons,
      ready: true,
      networkIdle: true,
    };
  }

  /** Fixed viewport so x,y coordinates (e.g. for quiz choices) stay the same every run. */
  private static readonly FIXED_VIEWPORT = { width: 1280, height: 720 };

  /** Launch browser and optional navigate to startUrl. */
  async init(): Promise<void> {
    const { chromium } = await import("playwright");
    const viewport = PlaywrightDriver.FIXED_VIEWPORT;
    if (this.options.userDataDir) {
      this.persistentContext = await chromium.launchPersistentContext(this.options.userDataDir, {
        channel: "chrome",
        headless: this.options.headless,
        viewport,
      });
      this.context = this.persistentContext;
      const pages = this.persistentContext.pages();
      this.page = pages.length > 0 ? pages[0]! : await this.persistentContext.newPage();
      if (this.page) await this.page.setViewportSize(viewport);
    } else {
      this.browser = await chromium.launch({ headless: this.options.headless });
      const ctx = await this.browser.newContext({ viewport });
      this.context = ctx;
      this.page = await ctx.newPage();
    }
    if (this.page && this.options.startUrl && this.options.startUrl !== "about:blank") {
      await this.page.goto(this.options.startUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
  }

  /** Close browser. */
  async close(): Promise<void> {
    if (this.persistentContext) await this.persistentContext.close();
    else if (this.browser) await this.browser.close();
    this.persistentContext = null;
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  /** If a new tab was opened (e.g. course link with target="_blank"), switch to it. Call after a CLICK that might open a new tab. */
  private async switchToNewTabIfOpened(currentPage: Page): Promise<void> {
    if (!this.context) return;
    const pages = this.context.pages();
    if (pages.length <= 1) return;
    const other = pages.find((p) => p !== currentPage && (p.url().includes("apexvs.com") || p.url().includes("apexlearning.com"))) ?? pages[pages.length - 1]!;
    if (other && other !== currentPage) {
      this.page = other;
      await other.bringToFront();
    }
  }

  private getPage(): Page {
    if (!this.page) throw new Error("PlaywrightDriver not initialized; call init() first.");
    return this.page;
  }

  async getObservation(): Promise<Observation> {
    const page = this.getPage();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      const url = page.url();
      if (url.includes("apexlearning.com") || url.includes("apexvs.com")) {
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
        await page.waitForFunction(
          () => {
            const body = document.body?.innerText ?? "";
            return body.includes("Resume") || body.includes("Unit") || body.includes("My Dashboard") || body.includes("Enrollments") || body.length > 500;
          },
          { timeout: 8000 }
        ).catch(() => {});
        return getApexObservation(page);
      }
      if (this.options.siteContext === "apex") return getApexObservation(page);
      if (this.options.siteContext === "edmentum") {
        const timeoutMs = 8000;
        const fallback: Observation = { state: "EDMENTUM_COURSE_GRID", buttons: ["LAUNCH"], ready: true };
        return await Promise.race([
          getEdmentumObservation(page),
          new Promise<Observation>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
        ]);
      }
      return this.getObservationGeneric(page);
    } catch (e) {
      return { ...defaultObservation, ready: false };
    }
  }

  /** Fast check that the page is loadable. Avoids full getObservation in the readiness loop. */
  async isPageReady(): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    try {
      if (page.isClosed()) return false;
      await page.locator("body").innerText({ timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Navigate the active tab (e.g. back to Edmentum dashboard between subjects). */
  async navigateTo(url: string): Promise<void> {
    const page = this.getPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }

  async execute(action: Action): Promise<ActionResult> {
    const page = this.getPage();
    await page.bringToFront().catch(() => {});
    await tryDismissApexBlockingOverlays(page);
    try {
      switch (action.type) {
        case "CLICK": {
          const target = action.target;
          const lessonCode = action.lessonCode;
          if (/^Lesson\s+\d+\.\d+$/i.test(target.trim()) || /^Unit\s+\d+\s+Intro$/i.test(target.trim())) {
            const clickedNav = await clickLessonNavInAllFrames(page, target.trim());
            if (clickedNav) {
              await new Promise((r) => setTimeout(r, humanHesitationMs()));
              const pagesBefore = this.context?.pages().length ?? 0;
              const popupPromise = this.context ? this.context.waitForEvent("page", { timeout: 6000 }).catch(() => null) : Promise.resolve(null);
              const popup = await popupPromise;
              if (popup) {
                this.page = popup;
                await popup.bringToFront();
              } else {
                const pagesAfter = this.context?.pages().length ?? 0;
                if (pagesAfter > pagesBefore) {
                  const newPage = this.context!.pages()[pagesAfter - 1]!;
                  this.page = newPage;
                  await newPage.bringToFront();
                }
              }
              return { ok: true, nextState: "LESSON_SCREEN" };
            }
          }
          // Apex activity map: "4.1.2" — getByText hits a hidden label <div> first; use card/tile click + strip nudge.
          const trimmedTarget = target.trim();
          const tripleParts =
            /^\d+\.\d+\.\d+$/.test(trimmedTarget) ? parseLessonCode(trimmedTarget) : null;
          if (tripleParts && tripleParts.length >= 3 && (await clickLessonCodeInAllFrames(page, tripleParts))) {
            await new Promise((r) => setTimeout(r, humanHesitationMs()));
            const pagesBeforeTriple = this.context?.pages().length ?? 0;
            const popupPromiseTriple = this.context
              ? this.context.waitForEvent("page", { timeout: 6000 }).catch(() => null)
              : Promise.resolve(null);
            const popupTriple = await popupPromiseTriple;
            if (popupTriple) {
              this.page = popupTriple;
              await popupTriple.bringToFront();
            } else {
              const pagesAfterTriple = this.context?.pages().length ?? 0;
              if (pagesAfterTriple > pagesBeforeTriple) {
                const newPage = this.context!.pages()[pagesAfterTriple - 1]!;
                this.page = newPage;
                await newPage.bringToFront();
              }
            }
            return { ok: true, nextState: "LESSON_SCREEN" };
          }
          const re = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const doClick = async (): Promise<void> => {
            if ((await page.getByRole("button", { name: re }).count()) > 0) {
              await page.getByRole("button", { name: re }).first().click({ timeout: 8000 });
            } else if ((await page.getByRole("link", { name: re }).count()) > 0) {
              await page.getByRole("link", { name: re }).first().click({ timeout: 8000 });
            } else {
              await page.getByText(re).first().click({ timeout: 8000 });
            }
          };
          /** Apex often shows REVIEW on completed unit intros while older parsers assumed RESUME. */
          const doClickResumeOrReview = async (): Promise<void> => {
            try {
              await doClick();
            } catch (firstErr) {
              if (!/RESUME/i.test(target)) throw firstErr;
              if ((await page.getByRole("button", { name: /review/i }).count()) > 0) {
                await page.getByRole("button", { name: /review/i }).first().click({ timeout: 8000 });
              } else if ((await page.getByRole("link", { name: /review/i }).count()) > 0) {
                await page.getByRole("link", { name: /review/i }).first().click({ timeout: 8000 });
              } else {
                await page.getByText(/^REVIEW$/i).first().click({ timeout: 8000 });
              }
            }
          };
          await new Promise((r) => setTimeout(r, humanHesitationMs()));
          if (this.options.misclickRate > 0 && shouldMisclick(this.options.misclickRate)) {
            await page.mouse.move(10 + Math.floor(nextFloat() * 30), 10 + Math.floor(nextFloat() * 30)).catch(() => {});
            await delayWithJitter(80, 80);
          }
          const pagesBefore = this.context?.pages().length ?? 0;
          const popupPromise = this.context ? this.context.waitForEvent("page", { timeout: 6000 }).catch(() => null) : Promise.resolve(null);
          if (/RESUME/i.test(target)) {
            const scoped =
              lessonCode &&
              lessonCode.length > 0 &&
              (await clickResumeNearLessonCodeInAllFrames(page, lessonCode));
            if (!scoped) {
              await doClickResumeOrReview();
            }
          } else if (await clickApexActivitiesButton(page, target)) {
            /* header Activities — back to module map */
          } else if (await clickApexFooterNavButton(page, target)) {
            /* footer PREVIOUS/NEXT — not flashcard controls */
          } else {
            await doClick();
          }
          const popup = await popupPromise;
          if (popup) {
            this.page = popup;
            await popup.bringToFront();
          } else {
            const pagesAfter = this.context?.pages().length ?? 0;
            if (pagesAfter > pagesBefore) {
              const newPage = this.context!.pages()[pagesAfter - 1]!;
              this.page = newPage;
              await newPage.bringToFront();
            }
          }
          return { ok: true, nextState: "LESSON_SCREEN" };
        }
        case "SUBMIT_ANSWER": {
          const timeout = 8000;
          /** Multi-select: click checkbox (or labeled choice) for each index, then Submit once. */
          const multiClickByIndices = (indices: number[]) => {
            const uniq = [...new Set(indices)]
              .map((i) => Math.floor(i))
              .filter((i) => i >= 0 && i <= 7)
              .sort((a, b) => a - b);
            if (uniq.length === 0) return false;
            const sidebar = /Sem\s*2|Algebra|Biology|English|History|Unit\s*\d|Rational|Radical|Trigonometry|Statistical/i;
            const mathLike = (s: string) => /√|²|\d\s*[+x]|x\s*[+\d]/.test(s);
            const sel =
              "[class*='choice'], [class*='option'], [class*='answer'], [class*='sia-distractor'], [id*='multiple-choice'], label, li, [role='checkbox'], mat-checkbox";
            const withLetter: { letter: string; el: Element; len: number }[] = [];
            const walk = (root: Document | ShadowRoot | Element) => {
              const q = (root as Document).querySelectorAll?.(sel);
              if (!q) return;
              for (const el of Array.from(q)) {
                const t = ((el as HTMLElement).innerText ?? "").trim();
                const m = t.match(/^\s*([A-F])[.)]\s*(.+)/);
                if (!m || m[2].length < 2 || m[2].length > 2000) continue;
                if (sidebar.test(m[2]) && !mathLike(m[2])) continue;
                /* Multi-select: keep long non-math choice text (biology "select all that apply"). */
                withLetter.push({ letter: m[1], el, len: t.length });
              }
              (root as Document).querySelectorAll?.("*")?.forEach((el) => {
                if (el.shadowRoot) walk(el.shadowRoot);
              });
            };
            walk(document);
            const letters = ["A", "B", "C", "D", "E", "F"];
            const byLetter: Element[] = [];
            for (const letter of letters) {
              const forLetter = withLetter.filter((w) => w.letter === letter).sort((a, b) => a.len - b.len);
              if (forLetter.length > 0) byLetter.push(forLetter[0].el);
            }
            const clickOne = (el: Element): boolean => {
              (el as HTMLElement).scrollIntoView?.({ block: "center", behavior: "instant" });
              const mat = el.closest?.("mat-checkbox");
              const host = mat ?? el;
              const cb =
                (host as Element).querySelector?.("input[type='checkbox']") ??
                host.shadowRoot?.querySelector?.("input[type='checkbox']");
              if (cb) {
                const input = cb as HTMLInputElement;
                if (!input.checked) {
                  input.checked = true;
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.dispatchEvent(new Event("change", { bubbles: true }));
                  input.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
                }
                return true;
              }
              (host as HTMLElement).click?.();
              return true;
            };
            for (const idx of uniq) {
              const el = byLetter[idx];
              if (!el) return false;
              if (!clickOne(el)) return false;
            }
            return true;
          };
          if (action.choiceIndices && action.choiceIndices.length > 0) {
            const uniqueSorted = [...new Set(action.choiceIndices)]
              .map((i) => Math.floor(i))
              .filter((i) => i >= 0 && i <= 7)
              .sort((a, b) => a - b);
            let multiOk = await page.evaluate(multiClickByIndices, uniqueSorted).catch(() => false);
            if (!multiOk) {
              for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                multiOk = await frame.evaluate(multiClickByIndices, uniqueSorted).catch(() => false);
                if (multiOk) break;
              }
            }
            if (!multiOk) {
              multiOk = await tryMultiSelectPlaywrightLocators(page, uniqueSorted);
            }
            let multiUsedVisionCoords = false;
            if (!multiOk) {
              multiOk = await tryMultiSelectVisionCoords(page, uniqueSorted);
              multiUsedVisionCoords = multiOk;
            }
            if (multiOk) {
              if (!multiUsedVisionCoords) {
                console.log("[SUBMIT_ANSWER] multi-select checkbox clicks:", uniqueSorted.join(","));
              }
              await new Promise((r) => setTimeout(r, answerToSubmitDelayMs()));
              if (!multiUsedVisionCoords) {
                const submitBtn = page.getByRole("button", { name: /submit|next|ok/i }).first();
                if ((await submitBtn.count()) > 0) {
                  for (let i = 0; i < 25; i++) {
                    const enabled = await submitBtn.evaluate((el) => !(el as HTMLButtonElement).disabled).catch(() => false);
                    if (enabled) {
                      await submitBtn.click({ timeout }).catch(() => {});
                      break;
                    }
                    await new Promise((r) => setTimeout(r, jitterMs(40, 45)));
                  }
                }
              }
              await new Promise((r) => setTimeout(r, 80));
              const advanceBtn = page.getByRole("button", { name: /next question|next|continue|view summary/i }).first();
              if ((await advanceBtn.count()) > 0) await advanceBtn.click({ timeout: 2000 }).catch(() => {});
              return { ok: true, nextState: "MODULE_LIST" };
            }
            console.warn("[SUBMIT_ANSWER] multi-select: all strategies failed — not using single-choice fallback (would mis-click).");
            return { ok: false, error: "multi-select: could not click all choices", recoverable: true };
          }
          const choiceIndex = action.choiceIndex ?? 0;
          // Prefer in-page click by visible "A." "B." "C." "D."; target the actual radio input or its label so selection registers.
          // Run in main frame first, then in each iframe (quiz may be inside an iframe).
          const inPageClickScript = (index: number) => {
            const sidebar = /Sem\s*2|Algebra|Biology|English|History|Unit\s*\d|Rational|Radical|Trigonometry|Statistical/i;
            const mathLike = (s: string) => /√|²|\d\s*[+x]|x\s*[+\d]/.test(s);
            const sel = "[class*='choice'], [class*='option'], [class*='answer'], [class*='sia-distractor'], [id*='multiple-choice'], label, li, [role='radio'], mat-radio-button";
            const withLetter: { letter: string; el: Element; len: number }[] = [];
            const walk = (root: Document | ShadowRoot | Element) => {
              const q = (root as Document).querySelectorAll?.(sel);
              if (!q) return;
              for (const el of Array.from(q)) {
                const t = ((el as HTMLElement).innerText ?? "").trim();
                const m = t.match(/^\s*([A-D])[.)]\s*(.+)/);
                if (!m || m[2].length < 2 || m[2].length > 280) continue;
                if (sidebar.test(m[2]) && !mathLike(m[2])) continue;
                if (!mathLike(m[2]) && m[2].length > 30) continue;
                withLetter.push({ letter: m[1], el, len: t.length });
              }
              (root as Document).querySelectorAll?.("*")?.forEach((el) => {
                if (el.shadowRoot) walk(el.shadowRoot);
              });
            };
            walk(document);
            const byLetter: Element[] = [];
            for (const letter of ["A", "B", "C", "D"]) {
              const forLetter = withLetter.filter((w) => w.letter === letter).sort((a, b) => a.len - b.len);
              if (forLetter.length > 0) byLetter.push(forLetter[0].el);
            }
            const doClick = (el: Element): boolean => {
              if (!el) return false;
              (el as HTMLElement).scrollIntoView?.({ block: "center", behavior: "instant" });
              (el as HTMLElement).click();
              return true;
            };
            if (byLetter.length >= 2) {
              const target = byLetter[Math.min(index, byLetter.length - 1)];
              if (!target) return false;
              const host = target.closest?.("mat-radio-button");
              if (host) {
                const input = host.querySelector?.("input[type='radio']") ?? host.shadowRoot?.querySelector?.("input[type='radio']");
                if (input) { doClick(input); return true; }
                const label = host.querySelector?.("label") ?? host.shadowRoot?.querySelector?.("label");
                if (label) { doClick(label); return true; }
              }
              const inLabel = target.closest?.("label") as HTMLLabelElement | null;
              if (inLabel?.control) {
                doClick(inLabel.control);
                return true;
              }
              const container = target.closest?.("div, li, [role='radio']");
              const radioInContainer = container?.querySelector?.("input[type='radio']");
              if (radioInContainer) { doClick(radioInContainer); return true; }
              return doClick(target);
            }
            const radios: Element[] = [];
            const collectRadios = (root: Document | ShadowRoot | Element) => {
              const r = (root as Document).querySelectorAll?.("mat-radio-button, [role='radio']");
              if (r) radios.push(...Array.from(r));
              (root as Document).querySelectorAll?.("*")?.forEach((el) => {
                if (el.shadowRoot) collectRadios(el.shadowRoot);
              });
            };
            collectRadios(document);
            const radio = radios[Math.min(index, Math.max(0, radios.length - 1))];
            if (radio) {
              const host = radio.closest?.("mat-radio-button") ?? radio;
              const input = host.querySelector?.("input[type='radio']") ?? host.shadowRoot?.querySelector?.("input[type='radio']");
              if (input) doClick(input);
              else doClick(radio);
              return true;
            }
            return false;
          };
          let clickedInPage = await page.evaluate(inPageClickScript, choiceIndex).catch(() => false);
          if (!clickedInPage) {
            for (const frame of page.frames()) {
              if (frame === page.mainFrame()) continue;
              clickedInPage = await frame.evaluate(inPageClickScript, choiceIndex).catch(() => false);
              if (clickedInPage) break;
            }
          }
          if (this.options.siteContext === "apex" || this.options.siteContext === "edmentum") {
            console.log("[SUBMIT_ANSWER] in-page click (by A/B/C/D):", clickedInPage ? "succeeded" : "failed, using locator fallback");
          }
          if (clickedInPage) {
            await new Promise((r) => setTimeout(r, answerToSubmitDelayMs()));
            const submitBtn = page.getByRole("button", { name: /submit|next|ok/i }).first();
            if ((await submitBtn.count()) > 0) {
              for (let i = 0; i < 25; i++) {
                const enabled = await submitBtn.evaluate((el) => !(el as HTMLButtonElement).disabled).catch(() => false);
                if (enabled) {
                  await submitBtn.click({ timeout }).catch(() => {});
                  break;
                }
                await new Promise((r) => setTimeout(r, jitterMs(40, 45)));
              }
            }
            await new Promise((r) => setTimeout(r, 80));
            const advanceBtn = page.getByRole("button", { name: /next question|next|continue|view summary/i }).first();
            if ((await advanceBtn.count()) > 0) await advanceBtn.click({ timeout: 2000 }).catch(() => {});
            return { ok: true, nextState: "MODULE_LIST" };
          }

          // Approach 2: Set the radio checked programmatically and dispatch change/click so the app registers selection (no user click)
          const setRadioProgrammatically = (index: number) => {
            const radios: HTMLInputElement[] = [];
            const walk = (root: Document | ShadowRoot | Element) => {
              const q = (root as Document).querySelectorAll?.("input[type='radio']");
              if (q) for (const el of Array.from(q)) radios.push(el as HTMLInputElement);
              (root as Document).querySelectorAll?.("*")?.forEach((el) => {
                if (el.shadowRoot) walk(el.shadowRoot);
              });
            };
            walk(document);
            if (radios.length <= index) return false;
            const target = radios[index]!;
            target.checked = true;
            target.dispatchEvent(new Event("change", { bubbles: true }));
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
            return true;
          };
          let programmaticOk = await page.evaluate(setRadioProgrammatically, choiceIndex).catch(() => false);
          if (!programmaticOk) {
            for (const frame of page.frames()) {
              if (frame === page.mainFrame()) continue;
              programmaticOk = await frame.evaluate(setRadioProgrammatically, choiceIndex).catch(() => false);
              if (programmaticOk) break;
            }
          }
          if (programmaticOk) {
            console.log("[SUBMIT_ANSWER] programmatic radio selection (set checked + events)");
            await new Promise((r) => setTimeout(r, answerToSubmitDelayMs()));
            const submitBtn = page.getByRole("button", { name: /submit|next|ok/i }).first();
            if ((await submitBtn.count()) > 0) {
              for (let i = 0; i < 25; i++) {
                const enabled = await submitBtn.evaluate((el) => !(el as HTMLButtonElement).disabled).catch(() => false);
                if (enabled) {
                  await submitBtn.click({ timeout }).catch(() => {});
                  break;
                }
                await new Promise((r) => setTimeout(r, jitterMs(40, 45)));
              }
            }
            await new Promise((r) => setTimeout(r, 80));
            const advanceBtn = page.getByRole("button", { name: /next question|next|continue|view summary/i }).first();
            if ((await advanceBtn.count()) > 0) await advanceBtn.click({ timeout: 2000 }).catch(() => {});
            return { ok: true, nextState: "MODULE_LIST" };
          }

          // Fallback: click at (x,y). Try vision first (screenshot → Claude returns coords for A/B/C/D + Submit), else use fixed coords.
          if ((this.options.siteContext === "apex" || this.options.siteContext === "edmentum") && page.url().includes("/activity/") && page.url().includes("assessment")) {
            await page.evaluate(() => { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }).catch(() => {});
            await new Promise((r) => setTimeout(r, 80));

            const apexChoiceCoords = [
              { x: 390, y: 377 },  // A
              { x: 390, y: 419 },  // B
              { x: 390, y: 460 },  // C
              { x: 390, y: 501 },  // D
            ];
            const letters = ["A", "B", "C", "D"] as const;
            let submitCoords: { x: number; y: number } | null = null;
            let visionCoordsResult: Record<string, { x: number; y: number }> | null = null;
            let iframeOffsetX = 0;
            let iframeOffsetY = 0;
            let clickX = apexChoiceCoords[Math.min(choiceIndex, apexChoiceCoords.length - 1)]!.x;
            let clickY = apexChoiceCoords[Math.min(choiceIndex, apexChoiceCoords.length - 1)]!.y;
            const buf = await page.screenshot().catch(() => null);
            if (buf && Buffer.isBuffer(buf)) {
              const visionCoords = await getQuizClickCoordinatesFromScreenshot(Buffer.from(buf)).catch(() => null);
              if (visionCoords) {
                visionCoordsResult = visionCoords as Record<string, { x: number; y: number }>;
                const letter = letters[Math.min(choiceIndex, 3)]!;
                const choiceCoord = visionCoords[letter];
                if (choiceCoord) {
                  clickX = choiceCoord.x;
                  clickY = choiceCoord.y;
                  submitCoords = visionCoords.Submit;
                  console.log("[SUBMIT_ANSWER] using vision coords for " + letter + " (" + clickX + "," + clickY + ")");
                }
              }
            }
            if (submitCoords == null) {
              const coord = apexChoiceCoords[Math.min(choiceIndex, apexChoiceCoords.length - 1)]!;
              clickX = coord.x;
              clickY = coord.y;
              const frames = page.frames();
              for (const frame of frames) {
                if (frame === page.mainFrame()) continue;
                const url = frame.url();
                if (url.includes("assessment") || url.includes("activity")) {
                  try {
                    const el = await frame.frameElement();
                    if (el) {
                      const box = await el.boundingBox();
                      if (box) {
                        iframeOffsetX = box.x;
                        iframeOffsetY = box.y;
                        clickX = box.x + coord.x;
                        clickY = box.y + coord.y;
                        console.log("[SUBMIT_ANSWER] quiz in iframe: using offset (x=" + Math.round(clickX) + ", y=" + Math.round(clickY) + ")");
                        break;
                      }
                    }
                  } catch (_) {}
                }
              }
            }

            await new Promise((r) => setTimeout(r, humanHesitationMs()));
            const correctClickX = clickX;
            const correctClickY = clickY;
            const numVisibleChoices = visionCoordsResult
              ? [visionCoordsResult.A, visionCoordsResult.B, visionCoordsResult.C, visionCoordsResult.D].filter(Boolean).length
              : 4;
            const choiceCount = Math.max(2, numVisibleChoices);
            if (this.options.misclickRate > 0 && shouldMisclick(this.options.misclickRate) && choiceCount > 1) {
              const wrongIdx = (choiceIndex + 1) % choiceCount;
              const wrongCoord = visionCoordsResult?.[letters[wrongIdx]!] ?? apexChoiceCoords[Math.min(wrongIdx, 3)]!;
              const wrongX = wrongCoord.x + iframeOffsetX;
              const wrongY = wrongCoord.y + iframeOffsetY;
              await page.mouse.click(wrongX, wrongY).catch(() => {});
              await new Promise((r) => setTimeout(r, humanCorrectionPauseMs()));
              clickX = correctClickX;
              clickY = correctClickY;
            }
            const letter = "ABCD"[choiceIndex] ?? String(choiceIndex);
            console.log("[SUBMIT_ANSWER] coordinate fallback: clicking at (" + Math.round(clickX) + "," + Math.round(clickY) + ") for choice " + choiceIndex + " (" + letter + ")");
            await page.mouse.click(clickX, clickY).catch((e) => {
              console.log("[SUBMIT_ANSWER] coordinate click failed:", (e as Error)?.message ?? e);
            });
            await new Promise((r) => setTimeout(r, answerToSubmitDelayMs()));
            let submitClicked = false;
            const trySubmit = async (ctx: Page | Frame) => {
              const btn = ctx.getByRole("button", { name: /submit|next|ok/i }).first();
              if ((await btn.count()) === 0) return false;
              await btn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
              await new Promise((r) => setTimeout(r, 100));
              for (let i = 0; i < 25; i++) {
                const enabled = await btn.evaluate((el) => !(el as HTMLButtonElement).disabled).catch(() => false);
                if (enabled) {
                  await btn.click({ timeout }).catch(() => {});
                  return true;
                }
                await new Promise((r) => setTimeout(r, jitterMs(40, 45)));
              }
              return false;
            };
            submitClicked = await trySubmit(page);
            if (!submitClicked) {
              for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                submitClicked = await trySubmit(frame);
                if (submitClicked) break;
              }
            }
            if (submitClicked) {
              console.log("[SUBMIT_ANSWER] coordinate click then Submit (scrolled into view)");
            } else if (submitCoords) {
              await page.mouse.click(submitCoords.x, submitCoords.y).catch(() => {});
              console.log("[SUBMIT_ANSWER] coordinate click Submit (locator failed)");
            }
            await new Promise((r) => setTimeout(r, 80));
            await new Promise((r) => setTimeout(r, humanHesitationMs()));
            const advanceBtn = page.getByRole("button", { name: /next question|next|continue|view summary/i }).first();
            if ((await advanceBtn.count()) > 0) await advanceBtn.click({ timeout: 2000 }).catch(() => {});
            return { ok: true, nextState: "MODULE_LIST" };
          }

          let clickCtx: Page | Frame = page;
          // Fallback: locator-based options (div.sia-distractor, mat-radio-button, etc.)
          let options = await page.locator("div.sia-distractor").all();
          if (options.length < 2) options = await page.locator("mat-radio-button").all();
          if (options.length < 2) options = await page.locator("input[type='radio']").all();
          if (options.length < 2) {
            for (const frame of page.frames()) {
              if (frame === page.mainFrame()) continue;
              let frameOpts = await frame.locator("div.sia-distractor").all();
              if (frameOpts.length < 2) frameOpts = await frame.locator("mat-radio-button").all();
              if (frameOpts.length < 2) frameOpts = await frame.locator("input[type='radio']").all();
              if (frameOpts.length < 2) frameOpts = await frame.locator("[role='radio']").all();
              if (frameOpts.length >= 2) {
                options = frameOpts;
                clickCtx = frame;
                break;
              }
            }
          }
          if (options.length === 0) options = await page.locator("[role='radio']").all();
          if (options.length === 0) options = await page.locator("[data-choice], .choice, [class*='choice'], [class*='option']").all();
          let n = options.length;
          // Require at least 2 options to trust light-DOM (avoid single nav/sidebar element). Otherwise use shadow-DOM path.
          const tryShadowFirst = n < 2;
          // Apex often uses custom divs — find by "A." "B." "C." "D." with math-like text (exclude sidebar). Then shadow-DOM fallback.
          if (n === 0) {
            const evalMark = () => {
              const sidebar = /Sem\s*2|Algebra|Biology|English|History|Unit\s*\d|Rational|Radical|Trigonometry|Statistical/i;
              const mathLike = (s: string) => /√|²|\d\s*[+x]|x\s*[+\d]/.test(s);
              const candidates = document.querySelectorAll("[class*='choice'], [class*='option'], [class*='answer'], [class*='sia-distractor'], [id*='multiple-choice'], label, li, [role='radio']");
              const withLetter: { letter: string; el: Element; len: number }[] = [];
              for (const el of Array.from(candidates)) {
                const t = ((el as HTMLElement).innerText ?? "").trim();
                const m = t.match(/^\s*([A-D])[.)]\s*(.+)/);
                if (!m || m[2].length < 2 || m[2].length > 280) continue;
                if (sidebar.test(m[2]) && !mathLike(m[2])) continue;
                if (!mathLike(m[2]) && m[2].length > 30) continue;
                withLetter.push({ letter: m[1], el, len: t.length });
              }
              const byLetter: Element[] = [];
              for (const letter of ["A", "B", "C", "D"]) {
                const forLetter = withLetter.filter((w) => w.letter === letter).sort((a, b) => a.len - b.len);
                if (forLetter.length > 0) byLetter.push(forLetter[0].el);
              }
              if (byLetter.length < 2) return false;
              byLetter.slice(0, 4).forEach((el, i) => { (el as HTMLElement).setAttribute("data-apex-choice-index", String(i)); });
              return true;
            };
            let marked = await clickCtx.evaluate(evalMark).catch(() => false);
            if (!marked) {
              for (const frame of page.frames()) {
                if (frame === page.mainFrame()) continue;
                marked = await frame.evaluate(evalMark).catch(() => false);
                if (marked) {
                  clickCtx = frame;
                  break;
                }
              }
            }
            if (marked) {
              const byIndex = await clickCtx.locator("[data-apex-choice-index]").all();
              if (byIndex.length >= 2) {
                options = byIndex;
                n = options.length;
              }
            }
          }
          // If no options or only one (likely wrong element), choices may be in shadow DOM. Click via evaluate.
          if (n === 0 || tryShadowFirst) {
            const choiceIndex = action.choiceIndex ?? 0;
            const clicked = await page.evaluate(
              (index: number) => {
                const sidebar = /Sem\s*2|Algebra|Biology|English|History|Unit\s*\d|Rational|Radical|Trigonometry|Statistical/i;
                const mathLike = (s: string) => /√|²|\d\s*[+x]|x\s*[+\d]/.test(s);
                const sel = "[class*='choice'], [class*='option'], [class*='answer'], [class*='sia-distractor'], [id*='multiple-choice'], label, li, [role='radio'], mat-radio-button";
                const withLetter: { letter: string; el: Element; len: number }[] = [];
                const walk = (root: Document | ShadowRoot | Element) => {
                  const q = (root as Document).querySelectorAll?.(sel);
                  if (!q) return;
                  for (const el of Array.from(q)) {
                    const t = ((el as HTMLElement).innerText ?? "").trim();
                    const m = t.match(/^\s*([A-D])[.)]\s*(.+)/);
                    if (!m || m[2].length < 2 || m[2].length > 280) continue;
                    if (sidebar.test(m[2]) && !mathLike(m[2])) continue;
                    if (!mathLike(m[2]) && m[2].length > 30) continue;
                    withLetter.push({ letter: m[1], el, len: t.length });
                  }
                  (root as Document).querySelectorAll?.("*")?.forEach((el) => {
                    if (el.shadowRoot) walk(el.shadowRoot);
                  });
                };
                walk(document);
                const byLetter: Element[] = [];
                for (const letter of ["A", "B", "C", "D"]) {
                  const forLetter = withLetter.filter((w) => w.letter === letter).sort((a, b) => a.len - b.len);
                  if (forLetter.length > 0) byLetter.push(forLetter[0].el);
                }
                if (byLetter.length >= 2) {
                  const target = byLetter[Math.min(index, byLetter.length - 1)];
                  if (target) {
                    (target as HTMLElement).click();
                    return true;
                  }
                }
                // Fallback: click nth mat-radio-button (or [role=radio]) in document + shadow
                const radios: Element[] = [];
                const collectRadios = (root: Document | ShadowRoot | Element) => {
                  const r = (root as Document).querySelectorAll?.("mat-radio-button, [role='radio']");
                  if (r) radios.push(...Array.from(r));
                  (root as Document).querySelectorAll?.("*")?.forEach((el) => {
                    if (el.shadowRoot) collectRadios(el.shadowRoot);
                  });
                };
                collectRadios(document);
                const radio = radios[Math.min(index, Math.max(0, radios.length - 1))];
                if (radio) {
                  (radio as HTMLElement).click();
                  return true;
                }
                return false;
              },
              choiceIndex
            ).catch(() => false);
            if (clicked) {
              await new Promise((r) => setTimeout(r, answerToSubmitDelayMs()));
              const submitBtn = page.getByRole("button", { name: /submit|next|ok/i }).first();
              if ((await submitBtn.count()) > 0) {
                for (let i = 0; i < 25; i++) {
                  const enabled = await submitBtn.evaluate((el) => !(el as HTMLButtonElement).disabled).catch(() => false);
                  if (enabled) {
                    await submitBtn.click({ timeout }).catch(() => {});
                    break;
                  }
                  await new Promise((r) => setTimeout(r, jitterMs(40, 45)));
                }
              }
              return { ok: true, nextState: "MODULE_LIST" };
            }
            if (tryShadowFirst) {
              return { ok: false, error: "No choices (radios or text) found", recoverable: true };
            }
          }
          if (n === 0) {
            if (action.choiceText) {
              const snippet = action.choiceText.replace(/\s+/g, " ").trim().slice(0, 50);
              const byText = clickCtx.getByText(snippet, { exact: false }).first();
              if ((await byText.count()) > 0) {
                await byText.click({ timeout });
                const submit = clickCtx.getByRole("button", { name: /submit|next|ok/i }).first();
                if ((await submit.count()) > 0) await submit.click({ timeout });
                return { ok: true, nextState: "MODULE_LIST" };
              }
            }
            return { ok: false, error: "No choices (radios or text) found", recoverable: true };
          }
          const resolvedChoiceIndex = action.choiceIndex ?? 0;
          let targetEl = options[resolvedChoiceIndex] ?? options[0]!;
          if (action.choiceText && action.choiceText.length > 0) {
            const needle = action.choiceText.replace(/\s+/g, " ").trim().slice(0, 80);
            for (let i = 0; i < options.length; i++) {
              const el = options[i]!;
              const labelId = await el.getAttribute("id").catch(() => null);
              let text = "";
              if (labelId) {
                text = (await clickCtx.locator(`label[for="${labelId}"]`).first().innerText({ timeout: 3000 }).catch(() => "")).trim();
              }
              if (!text) {
                text = (await el.evaluate((node) => (node as HTMLInputElement).labels?.[0]?.textContent ?? node.parentElement?.textContent ?? "")).trim();
              }
              const normalized = text.replace(/\s+/g, " ").trim().slice(0, 80);
              if (needle.length >= 3 && (normalized.includes(needle) || needle.includes(normalized))) {
                targetEl = el;
                break;
              }
            }
          }
          if (this.options.misclickRate > 0 && shouldMisclick(this.options.misclickRate) && n > 1 && targetEl) {
            const wrongIdx = (resolvedChoiceIndex + 1) % n;
            await options[wrongIdx]!.click().catch(() => {});
            await new Promise((r) => setTimeout(r, humanCorrectionPauseMs()));
          }
          // Angular Material: hidden input is cdk-visually-hidden and mat-radio-group intercepts — click label or mat-radio-button
          let clickTarget: Awaited<ReturnType<Page["locator"]>> = targetEl;
          const isInput = await targetEl.evaluate((el: Element) => el.tagName === "INPUT").catch(() => false);
          if (isInput) {
            const id = await targetEl.getAttribute("id").catch(() => null);
            if (id) {
              const label = clickCtx.locator(`label[for="${id}"]`).first();
              if ((await label.count()) > 0) clickTarget = label;
            }
            if (clickTarget === targetEl) {
              const matRadio = clickCtx.locator("mat-radio-button").nth(resolvedChoiceIndex);
              if ((await matRadio.count()) > 0) clickTarget = matRadio;
            }
          }
          await new Promise((r) => setTimeout(r, humanHesitationMs()));
          await clickTarget.click({ timeout });
          await new Promise((r) => setTimeout(r, answerToSubmitDelayMs()));
          const submitBtn = clickCtx.getByRole("button", { name: /submit|next|ok/i }).first();
          if ((await submitBtn.count()) > 0) {
            for (let i = 0; i < 25; i++) {
              const enabled = await submitBtn.evaluate((el) => !(el as HTMLButtonElement).disabled).catch(() => false);
              if (enabled) {
                await submitBtn.click({ timeout });
                break;
              }
              await new Promise((r) => setTimeout(r, jitterMs(40, 45)));
            }
          }
          await new Promise((r) => setTimeout(r, 80));
          const advanceBtn = clickCtx.getByRole("button", { name: /next question|next|continue|view summary/i }).first();
          if ((await advanceBtn.count()) > 0) await advanceBtn.click({ timeout: 2000 }).catch(() => {});
          return { ok: true, nextState: "MODULE_LIST" };
        }
        case "NAVIGATE": {
          await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          return { ok: true, nextState: "EDMENTUM_COURSE_GRID" };
        }
        case "REFRESH":
          await page.reload({ waitUntil: "domcontentloaded" });
          return { ok: true, nextState: "MAIN_MENU" };
        case "EXIT_TO_MODULE_LIST":
        case "EXIT_TO_PARENT": {
          const back = page.getByRole("button", { name: /^back$/i }).first();
          if ((await back.count()) > 0) {
            await back.click({ timeout: 5000 }).catch(() => {});
          } else if (await clickApexFooterNavButton(page, "PREVIOUS")) {
            /* activity footer, not flashcard */
          } else {
            const prev = page.getByRole("button", { name: /^previous$/i }).first();
            if ((await prev.count()) > 0) {
              await prev.click({ timeout: 5000 }).catch(() => {});
            } else {
              await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
            }
          }
          return { ok: true, nextState: "MODULE_LIST" };
        }
        case "NAVIGATE_LESSON": {
          await tryDismissApexBlockingOverlays(page);
          let clicked = await clickLessonCodeInAllFrames(page, action.code);
          if (!clicked && /\/activity\//i.test(page.url())) {
            if (await clickApexActivitiesButton(page, "Activities")) {
              await page.waitForLoadState("domcontentloaded").catch(() => {});
              await new Promise((r) => setTimeout(r, 500));
              clicked = await clickLessonCodeInAllFrames(page, action.code);
            }
            if (!clicked) {
              const back = page.getByRole("button", { name: /^back$/i }).first();
              if ((await back.count()) > 0) {
                await back.click({ timeout: 6000 }).catch(() => {});
                await page.waitForLoadState("domcontentloaded").catch(() => {});
                await new Promise((r) => setTimeout(r, 500));
                clicked = await clickLessonCodeInAllFrames(page, action.code);
              }
            }
          }
          if (clicked) {
            return { ok: true, nextState: "LESSON_SCREEN" };
          }
          return {
            ok: false,
            error: `Lesson ${action.code.join(".")} not found on page`,
            recoverable: true,
          };
        }
        case "SCROLL_DOWN": {
          await new Promise((r) => setTimeout(r, humanHesitationMs()));
          const scrollPx = scrollAmountPx();
          const overshoot = scrollOvershootPx();
          await page.evaluate((px: number) => {
            const main = document.querySelector("main") || document.querySelector("[role='main']") || document.querySelector("#content, .content, [class*='content']") || document.documentElement;
            if (main && main.scrollHeight > main.clientHeight) (main as HTMLElement).scrollTop += px;
            window.scrollBy(0, px);
          }, scrollPx).catch(() => {});
          await page.mouse.wheel(0, scrollPx);
          if (overshoot > 0) {
            await new Promise((r) => setTimeout(r, Math.round(40 + nextFloat() * 80)));
            await page.evaluate((px: number) => {
              const main = document.querySelector("main") || document.querySelector("[role='main']") || document.documentElement;
              if (main) (main as HTMLElement).scrollTop -= px;
              window.scrollBy(0, -px);
            }, overshoot).catch(() => {});
            await page.mouse.wheel(0, -overshoot);
            await new Promise((r) => setTimeout(r, Math.round(30 + nextFloat() * 50)));
            await page.evaluate((px: number) => {
              const main = document.querySelector("main") || document.querySelector("[role='main']") || document.documentElement;
              if (main) (main as HTMLElement).scrollTop += px;
              window.scrollBy(0, px);
            }, overshoot).catch(() => {});
            await page.mouse.wheel(0, overshoot);
          }
          return { ok: true, nextState: page.url().includes("geniussis") ? "EDMENTUM_COURSE_GRID" : "MODULE_LIST" };
        }
        case "SCROLL_TOP": {
          await new Promise((r) => setTimeout(r, humanHesitationMs()));
          await page.evaluate(() => {
            const main = document.querySelector("main") || document.querySelector("[role='main']") || document.querySelector("#content, .content, [class*='content']") || document.documentElement;
            if (main && main.scrollHeight > main.clientHeight) (main as HTMLElement).scrollTop = 0;
            window.scrollTo(0, 0);
          }).catch(() => {});
          return { ok: true, nextState: page.url().includes("geniussis") ? "EDMENTUM_COURSE_GRID" : "MODULE_LIST" };
        }
        case "CLICK_SUBJECT": {
          await tryDismissEdmentumBlockingModals(page);
          const full = action.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(full, "i");
          const partial = action.subject.split(/\s+/).slice(0, 3).join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const rePartial = new RegExp(partial, "i");
          const locators = [
            () => page.getByRole("link", { name: re }).first(),
            () => page.getByText(re).first(),
            () => page.getByRole("link", { name: rePartial }).first(),
            () => page.getByText(rePartial).first(),
          ];
          for (const loc of locators) {
            const el = loc();
            if ((await el.count()) > 0) {
              try {
                await el.click({ timeout: 8000 });
              } catch {
                await tryDismissEdmentumBlockingModals(page);
                await el.click({ timeout: 8000 });
              }
              return { ok: true, nextState: "EDMENTUM_COURSE_GRID" };
            }
          }
          return { ok: false, error: `Course not found: ${action.subject}`, recoverable: true };
        }
        case "LAUNCH": {
          // Give the card/UI a moment to update after CLICK_SUBJECT (expand, reveal LAUNCH)
          await page.waitForTimeout(600);
          const launchSelectors = [
            () => page.locator("[class*='card'], [class*='tile'], [class*='course']").filter({ hasText: /ALVS PT/i }).getByRole("button", { name: /LAUNCH/i }).first(),
            () => page.locator("[class*='card'], [class*='tile'], [class*='course']").filter({ hasText: /ALVS PT/i }).locator("a, button").filter({ hasText: /LAUNCH/i }).first(),
            () => page.getByRole("button", { name: /LAUNCH/i }).first(),
            () => page.getByRole("link", { name: /LAUNCH/i }).first(),
            () => page.locator("input[type='button'], input[type='submit']").filter({ hasText: /LAUNCH/i }).first(),
            () => page.locator("button, a, [role='button'], input[type='button'], input[type='submit']").filter({ hasText: /LAUNCH/i }).first(),
            () => page.locator("a, button, [role='button'], [role='link']").filter({ hasText: /LAUNCH/i }).first(),
            () => page.getByText(/LAUNCH/i).first(),
            () => page.locator("[class*='card'], [class*='tile'], [class*='course'], [class*='launch']").filter({ hasText: /LAUNCH/i }).locator("a, button, [role='button'], [onclick], [class*='btn'], [class*='button']").first(),
            // LAUNCH text may be inside a span; click the clickable ancestor (button/a or element with onclick)
            () => page.locator("//*[contains(translate(text(), 'LAUNCH', 'launch'), 'launch') or contains(., 'LAUNCH')]/ancestor::*[self::a or self::button or self::input[@type='button' or @type='submit'] or @role='button' or @role='link' or @onclick][1]").first(),
          ];
          for (const sel of launchSelectors) {
            const el = sel();
            if ((await el.count()) > 0) {
              try {
                await el.scrollIntoViewIfNeeded();
                await el.click({ timeout: 6000, force: true });
                return { ok: true, nextState: "APEX_LMS_DASHBOARD" };
              } catch {
                // selector matched but click failed (covered, detached, etc.); try next
              }
            }
          }
          return { ok: false, error: "LAUNCH button/link not found", recoverable: true };
        }
        case "DISMISS_POPUP": {
          if (await tryDismissEdmentumBlockingModals(page)) {
            return { ok: true, nextState: page.url().includes("geniussis") ? "EDMENTUM_COURSE_GRID" : "MODULE_LIST" };
          }
          const selectors = [
            () => page.getByRole("button", { name: /close|x|dismiss|ok/i }).first(),
            () => page.locator("[aria-label*='lose' i], [aria-label*='ismiss' i]").first(),
            () => page.getByRole("link", { name: /close|dismiss/i }).first(),
            () => page.locator("[class*='modal'] button, [class*='popup'] button").first(),
          ];
          for (const sel of selectors) {
            const el = sel();
            if ((await el.count()) > 0) {
              await el.click({ timeout: 3000 }).catch(() => {});
              return { ok: true, nextState: page.url().includes("geniussis") ? "EDMENTUM_COURSE_GRID" : "MODULE_LIST" };
            }
          }
          return { ok: false, error: "No popup close control found", recoverable: true };
        }
        case "NOOP":
          return { ok: true, nextState: "MAIN_MENU" };
        default:
          return { ok: false, error: "Unknown action", recoverable: true };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, recoverable: true };
    }
  }

  /**
   * Scroll assessment/quiz content through long stems and lazy regions so vision / multi-capture
   * can see the full question and all choices (not only the first viewport).
   */
  async prepareQuizVisionCapture(): Promise<void> {
    const page = this.getPage();
    const u = page.url();
    if (!isQuizVisionScrollSite(u)) return;
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.evaluate((c) => {
          const sel =
            "main, [role='main'], article, [class*='assessment'], [class*='content'], #content, mat-sidenav-content, .mat-drawer-content, [class*='sia-']";
          const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          for (const el of nodes) {
            try {
              const sh = el.scrollHeight;
              const ch = el.clientHeight;
              if (sh <= ch + 32) continue;
              const max = sh - ch;
              if (c === 0) el.scrollTop = 0;
              else if (c === 1) {
                for (let p = 0; p <= 10; p++) el.scrollTop = (max * p) / 10;
                el.scrollTop = max;
              } else {
                el.scrollTop = Math.round(max * 0.25);
                el.scrollTop = max;
              }
            } catch {
              /* next */
            }
          }
          const doc = document.documentElement;
          const body = document.body;
          const h = Math.max(0, Math.max(doc.scrollHeight, body.scrollHeight) - window.innerHeight);
          if (c === 0) window.scrollTo(0, 0);
          else if (c === 1) {
            for (let p = 0; p <= 8; p++) window.scrollTo(0, (h * p) / 8);
            window.scrollTo(0, h);
          } else window.scrollTo(0, h);
        }, cycle);
        await new Promise((r) => setTimeout(r, cycle === 0 ? 70 : 100));
      }
      await page.mouse.wheel(0, 420).catch(() => {});
      await new Promise((r) => setTimeout(r, 90));
      const lastRadioOrLabel = page
        .locator("mat-radio-button, label, [class*='sia-distractor'], [id*='multiple-choice-label'], [class*='choice']")
        .last();
      if ((await lastRadioOrLabel.count()) > 0) {
        await lastRadioOrLabel.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      }
      await page.getByRole("button", { name: /submit/i }).first().scrollIntoViewIfNeeded({ timeout: 3500 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      await page
        .evaluate(() => {
          const q = document.querySelector(
            "[class*='question'], [class*='stem'], [class*='prompt'], [data-stem]"
          ) as HTMLElement | null;
          if (q) q.scrollIntoView({ block: "start", inline: "nearest" });
        })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 90));
    } catch {
      /* best-effort */
    }
  }

  /** Single full-page capture after scroll prep (one tall image for Claude). */
  async screenshotForQuizVision(): Promise<Buffer> {
    await this.prepareQuizVisionCapture();
    const page = this.getPage();
    const buf = await page.screenshot({ fullPage: true, type: "png", animations: "disabled" });
    return Buffer.from(buf);
  }

  /** Several viewport captures at different scroll offsets — best when the stem requires many scrolls. */
  async captureQuizVisionShots(): Promise<Buffer[]> {
    await this.prepareQuizVisionCapture();
    const page = this.getPage();
    const u = page.url();
    if (!isQuizVisionScrollSite(u)) {
      const buf = await page.screenshot({ fullPage: true, type: "png", animations: "disabled" });
      return [Buffer.from(buf)];
    }
    const positions = await page.evaluate(() => {
      const cands = Array.from(
        document.querySelectorAll("main, [role='main'], mat-sidenav-content, .mat-drawer-content")
      ) as HTMLElement[];
      let root: HTMLElement = document.documentElement;
      let best = 0;
      for (const el of cands) {
        const d = el.scrollHeight - el.clientHeight;
        if (d > best) {
          best = d;
          root = el;
        }
      }
      const max = Math.max(0, root.scrollHeight - root.clientHeight);
      if (max < 80) return [0];
      const uniq = [...new Set([0, Math.round(max * 0.28), Math.round(max * 0.55), Math.round(max * 0.82), max])].sort(
        (a, b) => a - b
      );
      return uniq;
    });
    const shots: Buffer[] = [];
    for (const top of positions) {
      await page.evaluate((t) => {
        const nodes = Array.from(
          document.querySelectorAll("main, [role='main'], mat-sidenav-content, .mat-drawer-content")
        ) as HTMLElement[];
        for (const el of nodes) {
          try {
            el.scrollTop = t;
          } catch {
            /* */
          }
        }
        window.scrollTo(0, t);
      }, top);
      await new Promise((r) => setTimeout(r, 170));
      shots.push(Buffer.from(await page.screenshot({ type: "png", animations: "disabled" })));
    }
    return shots.length > 0 ? shots : [Buffer.from(await page.screenshot({ type: "png" }))];
  }

  async screenshot(path?: string): Promise<string | Buffer> {
    const page = this.getPage();
    if (path) {
      await page.screenshot({ path });
      return path;
    }
    const buf = await page.screenshot();
    return Buffer.from(buf);
  }

  async refresh(): Promise<void> {
    await this.getPage().reload({ waitUntil: "domcontentloaded" });
  }

  /** Navigate to URL (convenience). */
  async navigate(url: string): Promise<void> {
    await this.getPage().goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  }

  /**
   * If the current page is the Edmentum/EdOptions login (PublicWelcome.aspx), fill email/password and click Sign me in.
   * Returns true if login form was found and submitted, false otherwise.
   */
  async performEdmentumLogin(email: string, password: string): Promise<boolean> {
    const page = this.getPage();
    const url = page.url();
    if (!url.includes("geniussis") && !url.includes("geniusais") && !url.includes("edmentum")) return false;
    try {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      const loginInput = page.getByPlaceholder("Login")
        .or(page.getByLabel("Login"))
        .or(page.locator('input[type="email"]'))
        .or(page.locator('input[type="text"]').first())
        .or(page.locator("input:not([type='password']):not([type='submit']):not([type='hidden'])").first());
      const passwordInput = page.getByPlaceholder("Password")
        .or(page.getByLabel("Password"))
        .or(page.locator('input[type="password"]')).first();
      const signInBtn = page.getByRole("button", { name: /sign\s*me\s*in/i }).or(page.getByText("Sign me in").first());
      if ((await loginInput.count()) === 0 || (await passwordInput.count()) === 0) return false;
      await new Promise((r) => setTimeout(r, humanHesitationMs()));
      await loginInput.first().fill(email, { timeout: 8000 });
      await delayWithJitter(180, 220);
      await passwordInput.fill(password, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, humanCorrectionPauseMs()));
      await signInBtn.first().click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * If the Edmentum "Announcements" modal is visible, click its CLOSE button so the dashboard is usable.
   * Call this after login once the redirect has completed.
   */
  async dismissEdmentumAnnouncement(): Promise<boolean> {
    const page = this.getPage();
    try {
      const dialog = page.locator('[role="dialog"]').first();
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      const closeBtn = dialog.getByRole("button", { name: /close/i })
        .or(dialog.locator("button").filter({ hasText: /close/i }))
        .or(dialog.getByText("CLOSE", { exact: true }))
        .first();
      await closeBtn.click({ timeout: 5000 });
      await new Promise((r) => setTimeout(r, 500));
      return true;
    } catch {
      try {
        const closeBtn = page.getByRole("button", { name: /^close$/i }).or(page.getByText("CLOSE", { exact: true })).first();
        await closeBtn.click({ timeout: 3000 });
        return true;
      } catch (_) {
        return false;
      }
    }
  }
}
