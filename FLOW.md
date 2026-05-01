# Full navigation flow (user context)

## 1. Entry: "apex" menu

- **Where it says "apex"** = menu to go into other quizzes (browser bookmark or Apex Learning link).
- Opens to the **3rd screenshot**: Edmentum FEDashboard (edm.geniussis.com) — Virtual Learning module.

## 2. Edmentum: 3rd screenshot (course grid)

- **URL:** `edm.geniussis.com/FEDashboard.aspx` (or similar).
- **Step 2:** Go to the Virtual Learning module (link circled in green).
- **Step 3:** Grid of course cards: Science Help, ALVS PT Biology Sem 2, ALVS PT Algebra II Sem 2, ALVS PT English 10 Sem 2, ALVS PT U.S. History Sem 2, etc.
- **Agent:** Scroll down a little → **click the subject** (course card, e.g. "ALVS PT Biology Sem 2") → **press LAUNCH**.

## 3. After LAUNCH: Apex course (course.apexlearning.com)

- **Opens to:** Biology Sem 2 (or whichever course was launched): Resume "3.1.2 Quiz: Adaptations in Populations", unit progress (Unit 1–5), unit cards (Unit 1: Heredity, Unit 2: Genes and Traits, Unit 3: Natural Selection, …).
- **Agent:** Press one of the **options under the course name** — e.g. unit cards, or the **Resume** play button for the quiz.

## 4. 7th screenshot: course name literally clicked

- **Screen:** Apex LMS "My Dashboard" (alhs.apexvs.com/lms/#!/page/DashBoard): course names as links (Algebra II Sem 2, Biology Sem 2, English 10 Sem 2, U.S. History Sem 2).
- This is the view when the **course name** is clicked (e.g. from a menu or from the grid before LAUNCH).

## 5. Quizzes to do (handwritten list — last screenshot)

| Subject  | Quiz codes        |
|----------|-------------------|
| English  | 2.2.3, 2.2.5, 2.2.7, 2.3.2, 2.3.4 |
| Algebra  | 2.2.3, 2.2.4, 2.3.3, 2.4.3, 2.5.3 |
| Biology  | TEST 2.3.2                        |
| History  | 3.1.2, 3.1.5                      |

The agent uses **quiz-playlist.ts** (`DEFAULT_QUIZ_PLAYLIST`) to target these specifically.

## PRNG and “random instinct” logic

- **All randomness** uses the same PRNG (`src/prng.ts`): seeded xorshift32, or `Math.random()` if no seed.
- **Click intervals:** `delayWithJitter(base, jitter)` uses `prng.jitterMs()` — every delay is PRNG-derived (auditable).
- **Instinct logic:** When multiple valid actions exist (e.g. several course cards or several buttons), the agent can use `prng.pick(validActions)` to choose one by PRNG so behavior is reproducible with the same seed and still “random” in practice.
