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
| D4 | S2 | Pro + Grassroots **login screen**, 390px — pre-existing, **deferred** | On a 390px phone the login page does not fit: the layout viewport widens to **571px**, the "Enter workspace" button sits at x 369–495 (past the right edge) and a tap on it can land on the neighbouring role `<select>`. Playwright reported the select intercepting pointer events on every retry. | The `.enter-row` (name input + role select + button) has no wrap rule at phone width. The login screen was not part of P2.5's chrome audit (which measured pages *after* login) and is not a Contact surface. | **Not fixed in P3.** The screen is outside this milestone's scope (§158–§160: no changes beyond the Contact workflow) and touching it would widen the navLive/uiSpotcheck baselines. The live suite proves the Contact tab at 390px by carrying the lead's own stored session into a phone-sized context instead of logging in there. The one-rule fix (`flex-wrap: wrap` on `.enter-row`, full-width button under 480px) is recorded here for the next chrome pass. | Evidence: `scratchpad/m23/loginProbe.mjs` measurements (390px: `scrollWidth 571`, button `x 368.8 w 126.4`); m23ContactLive N6 records why it does not log in at 390px. Open. |

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
