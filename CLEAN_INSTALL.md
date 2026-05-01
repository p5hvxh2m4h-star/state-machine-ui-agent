# Clean install (remove junk and fix warnings)

## What went wrong

You ran **one** command: `npm install then npx playwright install chromium`.  
That made npm install extra packages named **"then"**, **"npx"**, **"install"**, **"chromium"** (and **"playwright"** again). Those brought in deprecated deps (npx, glob, rimraf, inflight) and caused the warnings.

The correct way is **two separate commands**:  
1) `npm install`  
2) `npx playwright install chromium`

---

## 1. Uninstall / clean

### If you ran the bad command in the project folder

In PowerShell:

```powershell
cd "C:\Users\Parsa A\Apex-Automater"
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
```

### If you ran it in `C:\WINDOWS\system32` (or any other folder)

Remove the junk install there so it doesn’t stay in system32:

```powershell
cd C:\WINDOWS\system32
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
```

---

## 2. Proper install (project folder only)

Always run from the **project folder**:

```powershell
cd "C:\Users\Parsa A\Apex-Automater"
npm install
```

Then, in a **separate** command:

```powershell
npx playwright install chromium
```

No code changes are needed. Your app code stays the same.

---

## 3. About the remaining warnings

- **npx deprecated:** You are not installing the `npx` package. That warning appears only if something (or the bad install) added it. After a clean install in the project folder, you shouldn’t see it.
- **inflight / glob / rimraf:** These often come from **transitive** dependencies (dependencies of Playwright or other tools). We can’t remove them without those packages updating. They are deprecated but still work; the warnings are safe to ignore. If you want fewer of them, we can try updating `playwright` (and other deps) to newer versions in `package.json`; that may pull in newer dependency trees and reduce warnings.

---

## 4. Quick copy-paste (all steps)

```powershell
cd "C:\Users\Parsa A\Apex-Automater"
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
npm install
npx playwright install chromium
```

After this you have a clean install. Use **`npm run run:edmentum`** to run the agent.
