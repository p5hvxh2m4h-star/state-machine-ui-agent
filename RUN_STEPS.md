# Exact steps to run the software

You **do not** open Chrome or a tab first. The script **opens the browser and tab** and does everything. You only run the commands below.

**Visible browser = better for undetectability:** The script runs with **headless: false** so you **see** the window and see it clicking. That uses a real Chrome window (not headless), so the site gets normal rendering and behavior and is less likely to treat the session as automated. Together with timing jitter and a tiny misclick rate, that’s the intended approach for being harder to detect.

---

## 1. One-time setup

In a terminal (PowerShell or Command Prompt):

```powershell
cd "C:\Users\Parsa A\Apex-Automater"
npm install
npx playwright install chromium
```

If you want to use **your existing Chrome** (same profile, already logged in to Edmentum/Apex):

- **Close Chrome completely** (all windows).
- Install Chrome if you haven’t (Playwright will use it when you pass a profile path).

---

## 2. API key (for quiz answers and optional screen reading)

Either:

- Set the environment variable (recommended):

  ```powershell
  $env:ANTHROPIC_API_KEY = "your-anthropic-api-key-here"
  ```

- Or create a file `config.local.json` in the project folder with:

  ```json
  { "anthropicApiKey": "your-anthropic-api-key-here" }
  ```

  (Do not commit this file; it’s in `.gitignore`.)

---

## 3. Run the agent

### Option A – Script opens its own browser (no profile)

Start from the **Edmentum dashboard** (the “3rd screenshot” – course grid with LAUNCH buttons). Replace the URL with your actual Edmentum URL if it’s different.

```powershell
cd "C:\Users\Parsa A\Apex-Automater"
npx tsx src/run-with-playwright.ts "https://edm.geniussis.com/FEDashboard.aspx"
```

- A **new** browser window opens and goes to that URL.
- If you see a **login** page, log in once manually in that window. The script does not handle login; after you’re in, you can run the same command again so it starts from the dashboard.
- The agent will use the page to find: Virtual Learning, course cards, LAUNCH, then (after LAUNCH) Apex course and options (Resume, Back, Next, Submit, etc.). It **does** know where to click and where to go back based on the built-in Apex and Edmentum logic (buttons and links by text).

To **see** the browser (recommended the first time), use the Edmentum run script (it uses `headless: false` by default):

```powershell
npm run run:edmentum
```

### Option B – Use your Chrome profile (already logged in)

1. **Close Chrome completely** (all windows).
2. Set your Chrome profile path and run the Edmentum flow (browser will be visible):

   ```powershell
   cd "C:\Users\Parsa A\Apex-Automater"
   $env:CHROME_USER_DATA = "C:\Users\Parsa A\AppData\Local\Google\Chrome\User Data"
   npm run run:edmentum
   ```

   Or with a custom URL:

   ```powershell
   npx tsx src/run-edmentum-flow.ts "https://edm.geniussis.com/FEDashboard.aspx"
   ```

   Your profile path is usually: `C:\Users\Parsa A\AppData\Local\Google\Chrome\User Data`

Then the script opens **Chrome with that profile** (same bookmarks, same “apex” / logins) and goes to the URL. You don’t open a tab manually; the script opens the browser and the tab.

---

## 4. What the agent “knows”

- **Where to click:** From the **Edmentum** and **Apex** parsers and the FSM: it looks for buttons/links by text (e.g. “Virtual Learning”, “LAUNCH”, “Resume”, “Back”, “Next”, “Submit”, “PREVIOUS”, course names like “ALVS PT Biology Sem 2”). It doesn’t use screen pixels; it uses the page structure.
- **Where to go back:** It uses actions like **CLICK "Back"** and **EXIT_TO_MODULE_LIST** (e.g. Back button or parent navigation). So it does know “go back” in terms of those controls.

If a site changes its labels or layout, the selectors in `src/parsers/apex-learning.ts` and `src/parsers/edmentum.ts` may need to be updated.

---

## 5. Quick reference (exact steps)

| Step | What to do |
|------|------------|
| 1 | Open PowerShell and run: `cd "C:\Users\Parsa A\Apex-Automater"` |
| 2 | One-time: `npm install` then `npx playwright install chromium` |
| 3 | Set your API key: `$env:ANTHROPIC_API_KEY = "your-key"` (or add `config.local.json`) |
| 4 | Run: **`npm run run:edmentum`** — a Chrome window will open and you will **see it** click, scroll, and navigate. You do **not** open Chrome or a tab yourself first. |
| 5 | If the first page is a login screen, log in once in that same window, then run **`npm run run:edmentum`** again. |
| 6 | (Optional) To use your usual Chrome profile (already logged in): **close all Chrome windows**, then run: `$env:CHROME_USER_DATA = "C:\Users\Parsa A\AppData\Local\Google\Chrome\User Data"` and **`npm run run:edmentum`**. |

The agent **does** know where to click and where to go back: it uses the Edmentum and Apex logic (buttons/links by text: Virtual Learning, LAUNCH, Resume, Back, Next, Submit, PREVIOUS, course names, etc.).

The script currently runs a **fixed number of steps** (e.g. 5). To run longer (e.g. through multiple quizzes), you’ll need a loop that uses the quiz playlist and doesn’t stop after 5 steps; that can be added next if you want.
