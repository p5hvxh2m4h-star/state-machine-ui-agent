/**
 * Known context: Edmentum FEDashboard (edm.geniussis.com).
 * Flow: Virtual Learning module → grid of course cards → scroll, click subject, LAUNCH.
 */

import type { Observation } from "../types.js";
import type { Page } from "playwright";

const SELECTORS = {
  virtualLearningLink: "text=Virtual Learning",
  courseCards: "[class*='course'], [class*='card'], [class*='tile']",
  launchButton: "text=LAUNCH",
  courseTitle: "h2, h3, [class*='title']",
};

export type EdmentumScreen = "DASHBOARD" | "COURSE_GRID" | "UNKNOWN";

export async function detectEdmentumScreen(page: Page): Promise<EdmentumScreen> {
  const url = page.url();
  if (!url.includes("geniussis.com") && !url.includes("edmentum")) return "UNKNOWN";
  const body = await page.locator("body").innerText().catch(() => "");
  if (body.includes("Virtual Learning") && body.includes("LAUNCH")) return "COURSE_GRID";
  if (body.includes("Step 1") && body.includes("Launch")) return "DASHBOARD";
  return "UNKNOWN";
}

/** Detect post-login popup/modal and a close control (submenu or button). */
async function detectPopupAndCloseButton(page: Page): Promise<{ popupVisible: boolean; popupCloseLabel?: string }> {
  // Genius SIS / Edmentum: announcements use Panel1 + Bootstrap modal; blocks course grid clicks until CLOSED.
  const announcement = page.locator(
    "[id*='AnnouncementList'], .modal.show[role='dialog'], [role='dialog'].modal.show"
  );
  const annCount = await announcement.count();
  for (let i = 0; i < Math.min(annCount, 8); i++) {
    const panel = announcement.nth(i);
    const visible = await panel.isVisible().catch(() => false);
    if (!visible) continue;
    const t = await panel.innerText().catch(() => "");
    if (t.length < 8) continue;
    const id = (await panel.getAttribute("id").catch(() => null)) ?? "";
    const looksAnnouncement =
      /announcement/i.test(t) ||
      /AnnouncementList/i.test(id) ||
      /requesting semester|course extension|final grade/i.test(t);
    if (!looksAnnouncement) continue;

    const closeBtn = panel.locator(".modal-footer button, button").filter({ hasText: /^CLOSE$/i }).first();
    if ((await closeBtn.count()) > 0) return { popupVisible: true, popupCloseLabel: "CLOSE" };
    const anyClose = panel.getByRole("button", { name: /close|dismiss|ok/i }).first();
    if ((await anyClose.count()) > 0) {
      const label = (await anyClose.innerText().catch(() => "")).trim() || "Close";
      return { popupVisible: true, popupCloseLabel: label };
    }
    return { popupVisible: true, popupCloseLabel: "CLOSE" };
  }

  const dialog = page.locator("[role='dialog'], [class*='modal'], [class*='popup'], [class*='overlay']").filter({ visible: true }).first();
  if ((await dialog.count()) === 0) return { popupVisible: false };

  const dialogText = await dialog.innerText().catch(() => "");
  if (!dialogText || dialogText.length < 10) return { popupVisible: false };

  const closePatterns = [/close/i, /dismiss/i, /\bx\b/i, /ok\b/i];
  for (const re of closePatterns) {
    const btn = dialog.getByRole("button", { name: re }).first();
    if ((await btn.count()) > 0) {
      const label = (await btn.innerText().catch(() => "")).trim() || "Close";
      return { popupVisible: true, popupCloseLabel: label };
    }
    const link = dialog.getByRole("link", { name: re }).first();
    if ((await link.count()) > 0) {
      const label = (await link.innerText().catch(() => "")).trim() || "Close";
      return { popupVisible: true, popupCloseLabel: label };
    }
  }
  const ariaClose = dialog.locator("[aria-label*='lose' i], [aria-label*='ismiss' i], [title*='lose' i]").first();
  if ((await ariaClose.count()) > 0) return { popupVisible: true, popupCloseLabel: "Close" };
  return { popupVisible: true, popupCloseLabel: "Close" };
}

/** Parse Edmentum course grid into Observation (course cards, LAUNCH). */
export async function getEdmentumObservation(page: Page): Promise<Observation> {
  const screen = await detectEdmentumScreen(page);
  const buttons: string[] = ["LAUNCH", "Virtual Learning"];
  const courseCards: string[] = [];

  const { popupVisible, popupCloseLabel } = await detectPopupAndCloseButton(page);
  if (popupVisible && popupCloseLabel && !buttons.includes(popupCloseLabel)) {
    buttons.push(popupCloseLabel);
  }

  const body = await page.locator("main, [role='main'], body").first().innerText().catch(() => "");

  // Fast pass: extract "ALVS PT ... Sem 2" from body so we get courses even if DOM selectors are slow
  const alvsSem2 = /ALVS PT\s+[A-Za-z0-9.\s]+\s+Sem\s*2/g;
  let match: RegExpExecArray | null;
  while ((match = alvsSem2.exec(body)) !== null) {
    const t = match[0].trim();
    if (t.length > 10 && !courseCards.includes(t)) courseCards.push(t);
  }

  // Course titles from cards (ALVS PT Biology Sem 2, English Help, etc.)
  const cardEls = page.locator(SELECTORS.courseCards);
  const n = await cardEls.count();
  for (let i = 0; i < Math.min(n, 20); i++) {
    const titleEl = cardEls.nth(i).locator(SELECTORS.courseTitle).first();
    const t = (await titleEl.innerText().catch(() => "")).trim();
    if (t && !courseCards.includes(t)) courseCards.push(t);
  }
  // Fallback: match course names from body text (line start)
  if (courseCards.length === 0) {
    for (const line of body.split("\n")) {
      const m = line.match(/^(ALVS PT|English Help|Math Help|Science Help|Social Studies Help|ALVS PT [^0-9]+)/);
      if (m && !courseCards.includes(m[1].trim())) courseCards.push(m[1].trim());
    }
  }
  // Fallback: match "ALVS PT ... Sem 2" or "ALVS PT ..." anywhere in line
  if (courseCards.length === 0) {
    const courseLike = /(ALVS PT\s+[A-Za-z0-9\s]+(?:Sem\s*2)?|English Help|Math Help|Science Help|Social Studies Help|ALVS PT [A-Za-z]+\s+Sem\s*2)/gi;
    for (const line of body.split("\n")) {
      const matches = line.match(courseLike);
      if (matches) {
        for (const name of matches) {
          const t = name.trim();
          if (t.length > 5 && !courseCards.includes(t)) courseCards.push(t);
        }
      }
    }
  }
  // Fallback: find by visible text containing "ALVS PT" (different DOM structure)
  if (courseCards.length === 0) {
    try {
      const link = page.getByText(/ALVS PT|English 10|Algebra II|Biology|U\.?S\.? History/i).first();
      if ((await link.count()) > 0) {
        const t = (await link.innerText().catch(() => "")).trim();
        if (t && t.length < 80 && !courseCards.includes(t)) courseCards.push(t);
      }
    } catch {
      // ignore
    }
  }

  // ALVS course list screen: "Course Name" + links like "Algebra II Sem 2", "Biology Sem 2" (no LAUNCH button)
  const alvsListCourseNames = ["Algebra II Sem 2", "Biology Sem 2", "English 10 Sem 2", "U.S. History Sem 2"];
  if (body.includes("Course Name") || (body.includes("ALVS") && body.includes("Sem 2"))) {
    for (const name of alvsListCourseNames) {
      if (body.includes(name) && !courseCards.includes(name)) courseCards.push(name);
    }
  }
  // Fallback: collect all elements that contain "ALVS PT" (handles grid where each card has title)
  if (courseCards.length === 0 || !courseCards.some((c) => c.includes("ALVS PT"))) {
    try {
      const alvsEls = page.getByText(/ALVS PT\s+/i);
      const count = await alvsEls.count();
      for (let i = 0; i < Math.min(count, 10); i++) {
        const t = (await alvsEls.nth(i).innerText().catch(() => "")).trim();
        const name = t.split(/\n/)[0]?.trim() || t;
        if (name.length > 10 && name.length < 80 && !courseCards.includes(name)) {
          courseCards.push(name);
        }
      }
    } catch {
      // ignore
    }
  }

  const state = screen === "COURSE_GRID" ? "EDMENTUM_COURSE_GRID" : "EDMENTUM_DASHBOARD";
  return {
    state,
    buttons: [...buttons, ...courseCards],
    courseCards,
    ready: true,
    networkIdle: true,
    url: page.url(),
    popupVisible: popupVisible || undefined,
    popupCloseLabel: popupCloseLabel || undefined,
  };
}
