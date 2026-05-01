# Why the quiz agent sometimes gets answers wrong

The agent **does** get the answer from Claude. Accuracy depends on **what** Claude sees and **how** we map that to a click.

## Two paths

1. **Text path** (when the parser finds 4 choices in the DOM)  
   - We send Claude: `question` + `choices` as **plain text** from the page.  
   - Claude returns `choiceIndex` (0=A, 1=B, 2=C, 3=D).  
   - We then click by **vision coords** (screenshot → Claude returns pixel x,y for A/B/C/D and Submit) or by DOM locators.

2. **Vision path** (when the parser finds 0 choices)  
   - We send Claude a **screenshot** of the quiz.  
   - Claude returns `choiceIndex` from what it sees in the image.  
   - We click using the same vision coords (screenshot → A/B/C/D/Submit positions).

So Claude is always in the loop. Errors come from **input quality** and **click mapping**, not from “not using Claude.”

---

## Why answers are wrong in practice

### 1. **Parsed text is wrong or mangled (text path)**

Apex often renders math with custom elements (e.g. MathML, spans, special Unicode). The parser uses `innerText` / `aria-label` and similar, which can produce:

- **Mangled math**: e.g. `"𝑥 9 9 x"` instead of `"x/9"`, or `"x ≥ ≥ -1"` (duplicate symbols).
- **Wrong or truncated question**: question text can be cut off, mixed with “Question 4 of 10”, or missing.
- **Wrong order**: DOM order of choices can differ from visual A/B/C/D order, so index 0 might not be “A” on screen.

When that happens, Claude gets **bad or reordered text** and reasons correctly on **wrong data** → wrong `choiceIndex` or right answer but wrong index.

### 2. **Parser finds 0 choices → we use vision for the answer**

When the DOM gives 0 choices, we use the **vision** path: Claude sees the screenshot and picks the answer. That can be **more accurate** than the text path when the DOM text is broken.

So: **“Is it really getting the answer from Claude?”** Yes. When we have 0 parsed choices we use vision (screenshot) for the answer; when we have 4 we use text. Both use Claude.

### 3. **Click goes to the wrong option**

Even with the correct `choiceIndex`:

- **Vision coords**: A second vision call returns pixel (x,y) for A, B, C, D, Submit. If that call misidentifies which region is “A” vs “D”, we click the wrong option.
- **Fixed coords**: If we fall back to hardcoded positions, layout or zoom can make them point to the wrong choice.
- **Index vs position**: If parsed choices are in a different order than the visual A/B/C/D, then `choiceIndex` 0 might not be the top option on screen.

So a correct **answer** from Claude can still become a **wrong click** if the mapping from index → screen position is off.

### 4. **Confidence ≠ correctness**

We retry until confidence ≥ 0.85 (or submit best after 4 tries). High confidence means “Claude is sure,” not “the answer is correct.” Claude can be confidently wrong, especially when the text it sees is mangled or ambiguous.

---

## What would improve accuracy

1. **Prefer vision for the answer when parsed text looks bad**  
   If we have 4 choices but the text looks mangled (e.g. weird Unicode, duplicate symbols, or very short/garbled question), call **vision** (screenshot) for the answer instead of sending that text to Claude. That way Claude reasons from the real screen, not from broken DOM text.

2. **Log exactly what Claude receives (text path)**  
   Log the `question` and `choices` strings we send to the text solver so you can confirm they match what’s on screen (and spot order/mangling).

3. **Use one vision call for both “which answer?” and “where to click?”**  
   Today we sometimes do: (a) text or vision for `choiceIndex`, (b) a separate vision call for coords. Doing a single vision call that returns both the chosen letter (or index) and the click coordinates could reduce index/position mismatches.

4. **Tighten the parser for Apex**  
   Improve choice extraction (e.g. better handling of iframes, shadow DOM, and math) so we get clean, correctly ordered A/B/C/D text when possible; when we can’t, fall back to vision for the answer.

---

## Quick check: what is Claude actually seeing?

Run with logging enabled so you can see the exact text used in the **text** path:

- Set `DEBUG_QUIZ_TEXT=1` (or use the new log in step-runner) and check the console for:
  - `[Quiz] Sent to Claude — question: ...`
  - `[Quiz] Sent to Claude — choices: 0: ... 1: ... 2: ... 3: ...`

If those don’t match what you see on screen (or are mangled), the errors are from **input quality**. If they look correct but the click is wrong, the issue is **click mapping** (coords or order).
