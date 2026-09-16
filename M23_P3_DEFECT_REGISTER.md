# M23 P3 — Defect Register

Defects found while building and verifying the Contact workflow. Each entry
names the evidence, the cause, the fix (or the reason it is deferred) and the
test that now guards it. Severity: **S1** blocks a user journey; **S2**
degrades one; **S3** is cosmetic, hygiene or a test-only coupling.

The rule for this register is the same as P2's: a defect is listed even when
it was caught before it shipped, because *what made it invisible until then*
is the useful part.

| id | sev | surface | defect (as found) | root cause | fix | guard |
|---|---|---|---|---|---|---|
| D1 | S2 | Every M18.1 concurrency-guarded route (Rooms, Briefs, decisions, lifecycle, and now Contact) | `expectedRev` sent as an object whose `toString` is not callable (`{"toString":1}`) crashed the request: an uncaught `TypeError` inside Express, answered as a bare **500** with a stack in the log. Every other malformed `expectedRev` (string, float, negative, missing) was answered with the documented 400/409. | `expectedRevOf` in `m181/concurrency.mjs` called `Number(raw)` on whatever arrived; `Number` invokes `toString` on an object and throws when it is not a function. Pre-existing since M18.1; no suite had sent an object. | `expectedRevOf` returns `NaN` for anything that is not a number or a string, before `Number` runs. The existing "not an integer → refuse" path then answers as designed: `CONTACT_REV_REQUIRED` 400 on Contact routes, `ROOM_VERSION_CONFLICT` 409 elsewhere. No route changed. | m23ContactE2E K7 (object `expectedRev` → 400 `CONTACT_REV_REQUIRED`, never 500); the M18.1/M18.2/M23 suites re-run green on the changed helper. |
| D2 | S2 | Pro + Grassroots Contact tab | The Contact routes' version-conflict code was first named `CONTACT_CONFLICT`. The shared conflict UI (`conflictOf` in `roomsScreens.tsx`, M18.2) recognises a conflict by the suffix `VERSION_CONFLICT`; a 409 from a Contact edit or send would have rendered as a generic error toast and the local edit would have been discarded instead of preserved with the reload / keep-changes choice. | The code was named for the Contact domain rather than for the platform's one conflict convention. Found while wiring `ConflictNotice` into the panel. | Renamed to `CONTACT_VERSION_CONFLICT` in the error table, both routes, the suites, the audit doc and the client error map. | m23ContactE2E K group asserts the exact code; m23E2E Y6 (the `EXTERNAL` set) lists it; `conflictOf` is exercised by m182Live. |
| D3 | S3 | Source hygiene — `m23/contact.mjs`, `scripts/m23ContactE2E.mjs` | The control-character regex in `plainShared` and the corresponding negative fixtures were written with **raw** NUL, BEL and DEL bytes inside the character class. Behaviour was correct, but `grep` reported the module as a binary file, `git diff` would have done the same, and any editor or tool normalising line endings could have silently altered the class. | The file writer emitted the literal characters instead of `\u0000`-style escapes. | Both files rewritten with escapes (`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`, `\u0000`, `\u0007`); `plainShared` re-verified to strip the same set. The same thing happened once more to this register's own D3 row as it was written, and was fixed the same way. A sweep of every `.mjs/.ts/.tsx/.md` in the repo (excluding `node_modules`) finds no raw control byte. | m23ContactE2E U group (stripping asserted on every control range); the sweep is recorded in the implementation doc as a closing check. |
| D4 | S2 | Pro, Grassroots and T&S **login screens**, 390px and 360px — pre-existing, **CLOSED** (M23 P3 closure) | **Reproduced before the fix** on the real club login (built bundle, headless Chromium): at a 390px viewport `document.documentElement.scrollWidth` was **571** (360px: **556**); with a mobile viewport the layout viewport itself widened to 571/556, and "Enter workspace" sat at x 369–495 (360px: 354–480), past the right edge. Offending elements: `div.org-grid` **752px** wide (`display:flex; gap:16px`, no wrap, holding four `button.org-card` at `width:240px`) and `div.enter-row` **600px** wide (`display:flex`, no wrap: name input `width:280px` + password input inline `width:200px` + role select + button). Both had `min-width:auto` and `flex-shrink:1`, but a flex item's `min-width:auto` never shrinks below its content and the cards and inputs were fixed widths, so the row could not shrink — only overflow. `.login { height:100vh }` would additionally have clipped the top of a taller wrapped layout. The previously suggested one-rule fix (`flex-wrap` on `.enter-row`) was **wrong on its own**: the larger offender was the organisation grid. The Grassroots stylesheet already carried the phone rules (its 860px block) and fit; the T&S console's copy of the same CSS overflowed by 6px at 360px (`scrollWidth 366`). | Base rules copied between the three stylesheets without the phone block; the club's 640px block only sized the input. The login screens were never measured at phone width (P2.5 measured pages after login). | Root cause fixed, no overflow hiding. Club `styles.css`: `.org-grid` and `.login .enter-row` gain `flex-wrap: wrap; justify-content: center` (base rules — nothing wraps above 1040px, so the desktop layout is unchanged); `.login` uses `min-height: 100vh; box-sizing: border-box` instead of `height: 100vh`; in the existing 640px block: `.login { padding: 28px 16px; gap: 20px }`, `.login h1 { font-size: 30px }`, `.org-card { width: 100%; max-width: 340px }`, `.login input, .login input.login-pw, .login select { width: 100%; max-width: 340px }`, `.login .enter-row { width: 100% }`, `.login .enter-row button.primary { width: 100%; max-width: 340px }`, `.login .notice { max-width: 340px }`. The password field's inline `style={{ width: 200 }}` (which beat any stylesheet rule) became `className="login-pw"` with `.login input.login-pw { width: 200px }` at desktop — in Pro and Grassroots. T&S `styles.css`: the same `min-height`, `flex-wrap` and a new 640px block with the same input/button/notice rules (its only phone rules; nothing else in the console changes). No markup, behaviour or authentication change: the same fields, roles, password handling, `Enter`-key login and error notice. **After the fix**: 390px `scrollWidth 390 = innerWidth`, button x 25–365, height 37; 360px `scrollWidth 360`, button x 16–344; desktop 1440px button x 994–1174, height 37 — identical to before; T&S 390/360 `scrollWidth = innerWidth`. Login is not translated (its strings are hardcoded English in all three consoles), so FR cannot recreate the overflow; organisation names and standing pills are data and wrap inside the 340px card. | navLive **N17** (new): opens the REAL club login at 390px and 360px with a mobile viewport and asserts `scrollWidth <= innerWidth` on the org picker, with the validation notice on screen, and with a long name typed; asserts the button and every field are inside the viewport and the button is ≥ 34px; walks name → password → role → button with Tab, asserts the focus ring is visible, logs in with Enter; and at 1440px asserts the cards and the enter row are each still one line. Closure commit: see the register footer. |

## D4 closure commit

Recorded after the closure commit was made — see the footer line appended by
that commit.

## Not defects (considered and left)

- **A room's owner keeps room-lead standing when demoted from a role.** The
  Contact suite's first role-downgrade test used a room the demoted user had
  opened and found them still permitted. That is M17's rule (the opener of a
  room is its room lead until reassigned), not a Contact defect; the test was
  reworked to a room opened by someone else (R3), and a reassignment case was
  added (R3c).
- **The M23 pure-fixture suites (`m23E2E`, `m23Perf`, `m23Persistence`) lacked
  `recruitmentContacts`** and failed the journey's required-stores guard the
  moment the store joined it. That guard is doing its job; the fixtures were
  extended. The migration and the store contract, not the fixtures, are what
  production relies on.
- **`POST /player/block` answers 201, not 200.** A test expectation, corrected
  in the live suite.
- **Section headings render upper-case.** `innerText` reports the CSS
  `text-transform`; the live suite matches case-insensitively. No product
  change.
- **A draft for an uncontactable recipient is refused at compose time**
  (`CONTACT_BLOCKED` / `CONTACT_GUARDIAN_REQUIRED` on `POST …/contacts`).
  The first live negative expected drafting to succeed and only sending to be
  refused. The compose-time refusal is the contract (§17: "block before
  compose"); the same rule runs again at send time for drafts written before
  the block, which the live suite now proves both ways (N1e/N1f, N2g/N2h).

## Frozen recruitment lifecycle

No defect in this register changed the lifecycle validator, the journey
projection's case semantics, the M23 P2 error table entries, or the
single-writer rule. `m23E2E` (382 checks) runs green on the tip with only
its fixtures and its drift sweep extended for the new store and codes.
