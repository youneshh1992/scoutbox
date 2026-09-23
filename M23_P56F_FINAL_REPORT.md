# M23 P5.6F — ScoutBox Agent final hardening, reconstructed

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

---

## The short version

The original P5.6F was finished and then lost: four commits and a verified
recovery bundle existed only inside a container that was rebuilt before the
milestone's backup push was authorised. Origin still held `b8556c1`, so
everything through P5.6E survived; P5.6F did not.

This is a rebuild of the **behaviour**, not a recovery of the artefacts. It
re-established all three of the original's product defects by reproducing them
against the frozen base — and then found a **fourth that the original missed**.

`agreementGrantsAccess` in `m24/shared.mjs` is the single predicate all 109
Agent-domain routes ask. It had two fail-open holes:

- a mandate whose term **began in a year** granted access today (`startAt` was
  never consulted anywhere);
- an `endAt` that could not be **read** as a number — an ISO string from an
  imported row, a `NaN` — granted access **for ever**.

Both are now one rule: *absent means open and keeps its meaning; present must be
readable and satisfied.*

Applying that same rule to the **age** layer found **F-8**: `new Date(null)` is
the epoch, not an invalid date, so a record with no date of birth computed as a
56-year-old and read as an **adult** — on `isAdult` and on `isRegulatoryMinor`
alike. The M13 prospect import stores exactly that shape. F-2, F-3 and F-8 are
the same mistake in three different fields, and naming the rule is what found the
third.

---

## The 76 items

| # | Item | Answer |
| --- | --- | --- |
| 1 | Reconstruction base | `b8556c1` (origin feature-branch tip, unchanged) |
| 2 | Reason reconstruction was required | the ephemeral container was rebuilt before the authorised backup push; the four P5.6F commits and the scratchpad bundle were lost together |
| 3 | Original lost historical SHAs | `c602f61`, `bb3b53f`, `75625a2`, `46f5f76` — **historical references only, not recreated and not claimed as recovered** |
| 4 | New reconstructed commits | `b92e5e9` (R1 product hardening), `0b73965` (R2 A3/Grassroots), `c55b5aa` (R3 viewports/contention), R4 (documents/closure) |
| 5 | Final reconstructed tip | the commit containing this file — reported exactly in the closing message, because a file cannot state its own commit's hash |
| 6 | Schema | **2307**, unchanged |
| 7 | Migrations | **none added** — 17 declared, and nothing needed an 18th |
| 8 | Stores | none added |
| 9 | **F-2** future-start fail-open | **FIXED** at the root; 22 temporal regression cases |
| 10 | **F-3** malformed-end fail-open | **FIXED** at the root, in `effectiveAgreementStatus` so status and access cannot disagree |
| 11 | **F-5** failed-login per-identifier limiter | **IMPLEMENTED** beside the IP limiter, never instead of it; seven properties measured live |
| 12 | Rate-limit audit | 51 policies. P5.6E's two survive and are re-proved (`opportunity_share` 60/h actor, `transaction_handoff` 30/h org); one-shot state changes deliberately unquota'd with the reason recorded |
| 13 | Final hardening suite | `m23AgentFinalHardeningE2E` — **265 checks, 149 negative (56%)** after the review pass (247/137 at first close) |
| 14 | A1 | **closed** — classified A/B/C/D; twelve `/org` surfaces probed with an agency token, **zero** foreign-org references; category B refused by concealment against a **real** club case id |
| 15 | A2 | **closed as accepted** — a frozen P5.6D property; twelve authorities re-proved as not granted by naming |
| 16 | A3 | **closed by observation** — `m23AgentGrassrootsLive`, 49 checks / 27 negative, in Chromium |
| 17 | Representation | one canonical predicate; all six non-active states, unconfirmed, foreign agent and legacy mirror grant nothing |
| 18 | Legacy authority | a legacy mirror grants no access and yields no integration basis; it may still READ as active, because the predicate withholds authority rather than the record being rewritten |
| 19 | Same-agency | four colleague tiers **and** the agency administrator refused the client record and find no mandate in their own list; the representing agent reads it 200 |
| 20 | Stale sessions | affiliation ended mid-session → refused on the next request across five agent routes, no re-login; reviewer revoked → live session refused |
| 21 | Licence | an unverified facet is refused, and the refusal is about the caller's own state — it names no player |
| 22 | Policy | versioned; the version in force at a date is selected, history stays reachable at its own date, an unsupported jurisdiction selects **nothing** rather than borrowing another's rules, a suspended rule is not active |
| 23 | Conflict | 25 outcome pairs; five forbidden downgrades asserted individually; fingerprint key-order independent |
| 24 | Reviews | attributed; the shared admin key is not a reviewer; a wrong secret and an unknown id share one refusal |
| 25 | Consent | revoked, wrong-party and unknown-id all refused; key + rev on the answer |
| 26 | Minors | byte-identical to a non-existent player; forged age facts refused identically; pathway disabled in **every** jurisdiction value; **and unknown age now fails closed (F-8)** |
| 27 | Guardian | cannot be impersonated; a guardian-managed account cannot act on another's consent |
| 28 | Contact | canonical M23 P3 reused — 428/246 + 82 live, green |
| 29 | Inbox | canonical reused; 535/281 green |
| 30 | Trial | canonical M23 P4B reused — 535/331 + 122 live, green |
| 31 | Passport | player-owned; five candidate agent writers absent |
| 32 | Trust | not agent-editable; two candidate writers absent |
| 33 | Transaction | ten states, 404/215 + 116 live green; no state names an offer or a signing |
| 34 | Documents | nine visibility classes; unknown class fails closed; `T_AND_S_ONLY` writable by nobody |
| 35 | P5 handoff | canonical; key + rev + one shared quota bounding the invite/withdraw loop |
| 36 | Offer boundary | **no Agent writer.** The strings do appear in the pre-existing **club-side** funnel vocabulary, which §15 explicitly does not count — checked, because that is the grep hit that gets misfiled |
| 37 | Signing boundary | no `db.signings` writer in any Agent module |
| 38 | Input validation | sixteen coercions refused by the disclosure parser; term length bounded; `__proto__`/`constructor` are not permissions; a non-string idempotency key is refused rather than coerced |
| 39 | Error privacy | every provoked refusal swept: no 5xx, no stack trace, no file path, no offer/commission/signing vocabulary |
| 40 | Events | no offer, signing or commission event in the registry |
| 41 | Notifications | one factual notice to a named non-client; deep links re-check current authority |
| 42 | Audit | attributed reviewer decisions; dual-control policy publication |
| 43 | Rate limits | see item 12 |
| 44 | Idempotency | `clientKey` in the body (not a header — learned by testing, not assuming); replay labelled `idempotent: true`; different payload → 409; non-string key → 400 |
| 45 | Concurrency | stale rev → 409; the two state-changed-but-session-live cases refused on the next request |
| 46 | Tombstones | a deleted player is no longer named; no resurrected PII |
| 47 | Corruption | the F-2/F-3/F-8 rule **is** the corruption answer: an unreadable value in a security decision refuses |
| 48 | Grassroots direct browser | 49 checks / 27 negative; radius withholding 12 of 14, each withheld id answering 403 identically; the minor branch pinned rather than either-way |
| 49 | Viewports | all six on the Agent portal; **1024 and 768 added this milestone (F-6)**, each asserting content as well as fit |
| 50 | Accessibility | labelled controls, a labelled tablist with exactly one selected, keyboard reachability, `alert`/`status` roles — green in the live suites |
| 51 | EN/FR | French asserted with no English fallback leaking, and the French screen withholds exactly what the English one withholds |
| 52 | Browser console | **zero page errors** in every client in every Agent browser suite |
| 53 | Contention | 5 suites simultaneously, **twice**, identical: 5/5 rc=0, 111s wall, ports measured held then released (18→15→10→5→0), no live survivor |
| 54 | Server suites | **37**, all green, zero failures (current inventory, not the lost run's count) |
| 55 | Browser suites | **11**, all green sequentially, then 5 concurrently |
| 56 | Perf / load | **16**, all green (inventory has 16; the lost run reported 15) |
| 57 | Typechecks | **5/5** |
| 58 | Builds | **5/5** — four Vite, plus the player's `expo export` |
| 59 | Clean boot | `m23BootContract` 61/43: the full server boots on a bare migrated database with no seed |
| 60 | Replay | structurally deterministic — 33 differing leaves, **all 33** clocks or clock-derived ids, **0 structural**; idempotent on a second and third pass; ledger does not grow |
| 61 | Persistence | seven suites, 426 checks; and a write measured surviving a real restart |
| 62 | Fresh clone | **PASS** from the reconstructed tip with nothing reused (0 node_modules / 0 dist / 0 db carried, counted) |
| 63 | Restore test | **executed** — verify clean, target reset to the origin state, fetch from the bundle, every tracked file byte-identical |
| 64 | Current recovery bundle | reported in the closing message, with the R1/R2/R3 bundles listed in `M23_P56F_RECOVERY_RESTORE.md` |
| 65 | Current bundle SHA256 | reported in the closing message — the bundle contains the commit containing this file, so a hash printed here would be the hash of a different bundle |
| 66 | Open Critical | **0** |
| 67 | Open High | **0** |
| 68 | Open Medium | **0** reasonably-fixable |
| 69 | Open relevant Low | **0** security / privacy / authorization / data-integrity needing repair; **2** remain by decision (F-4 stale prose in a frozen doc, F-9 an unconditional pass in a frozen suite) |
| 70 | Known flakes | **0** — the contention group ran twice with identical durations |
| 71 | Release-readiness result | **31 PASS, 0 FAIL, 0 DEFERRED** |
| 72 | Tree | clean |
| 73 | Ahead / behind | ahead of `origin/…/wyk3ec` by the reconstruction commits, behind 0 |
| 74 | Push status | **not pushed** — §32 requires explicit authorization, which is a change from the original milestone precisely because holding everything unpushed is what lost it |
| 75 | PR | **none** |
| 76 | Deployment | **none** |

---

## What changed in production code

| File | Change |
| --- | --- |
| `m24/shared.mjs` | `startBoundaryReached` / `endBoundaryPassed` / `agreementTermCoversNow` — the F-2/F-3 root repair |
| `domain.mjs` | `ageOn` returns NaN for an unreadable dob; `isAdult` requires a finite age — the F-8 repair |
| `m25/policy.mjs` | `isRegulatoryMinor` returns "unknown" for anything that is not a parseable non-empty string |
| `m181/rateLimit.mjs` | the `login_failure` policy, and a `peek()` accessor so a lockout can be tested before a credential |
| `server.mjs` | `loginLockedOut` / `noteLoginFailure` wired into the player, guardian and org lanes |
| `m25/index.mjs` | the same for the reviewer lane |

No frozen architecture redesigned. No migration. No store. No Offer workflow, no
signing writer, no new minor pathway.

## What this report is honest about

1. **The original's release-readiness claim was wrong in one respect.** It
   declared zero open Medium defects while F-8 was present and undetected. The
   reconstruction is not merely a re-creation of the original's result.
2. **F-1 stays withdrawn, and was re-proved by execution** rather than carried on
   trust: the IP limiter fires at attempt 41 with `retryAfterMs`.
3. **Two of this pass's own instruments were broken** — `ss` does not exist here
   (F-7), so every port check was vacuous; and `pgrep -f` matched the calling
   shell and killed this session twice. Both replaced with `/proc`-based checks.
4. **The route count is 109, not the 117 the original reported.** The original's
   counting method is not recoverable; 109 is what this tip measures, by a stated
   method.
5. **The suite counts differ from the lost run's** (247/137 vs 181/127; 48/27 vs
   29/23; 16 perf suites vs 15). Nothing was padded toward or trimmed to the old
   figures.
6. **Three findings were defects in this pass's own evidence** (F-6, F-7, F-9),
   not in the product.
7. **The review pass found the same shape in this pass's own suites.** Six sites
   — two `ok(true)`s, one `neg(true)`, an either-way `if/else`, a swallowed
   `waitForSelector`, and eight `status >= 400` assertions — would have stayed
   green under contradictory products. All pinned; the suites grew 247 → 265
   and 48 → 49, and the register's F-7 entry was narrowed where it had
   overclaimed about a committed script that did not exist.
8. **Two more product findings came out of that same review** (F-11, a guardian
   with two failed-login budgets; F-12, sign-up storing an unreadable date of
   birth) and **one from the user** (F-10, the demo's dead-end login). All three
   fixed with regressions. The first pass had declared itself complete before
   any of them were known.

## Conclusion

**M23 P5.6F RECONSTRUCTION COMPLETE**
**P5.6F WAS REBUILT FROM THE FROZEN b8556c1 BASE AFTER EPHEMERAL CONTAINER LOSS**
**THE ORIGINAL LOST HASHES WERE NOT FABRICATED OR CLAIMED AS RECOVERED**
**THE FINAL HARDENING BEHAVIOR HAS BEEN INDEPENDENTLY REVERIFIED**
**REPRESENTATION TEMPORAL BOUNDARIES FAIL CLOSED**
**FAILED-LOGIN IDENTIFIER PROTECTION IS ACTIVE**
**A1 / A2 / A3 ARE CLOSED**
**SAME-AGENCY ACCESS REMAINS CONTAINED**
**MINORS REMAIN CONCEALED**
**CONFLICT / CONSENT / REVIEW / POLICY SAFETY REMAINS INTACT**
**GRASSROOTS WAS DIRECTLY OBSERVED**
**ALL REQUIRED VIEWPORTS WERE DIRECTLY OBSERVED**
**BROWSER CONTENTION WAS MEASURED WITH A REAL LISTENER PROBE**
**FRESH CLONE AND RESTORE WERE PROVEN**
**ZERO KNOWN CRITICAL DEFECTS**
**ZERO KNOWN HIGH DEFECTS**
**ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS**
**ZERO KNOWN SECURITY / PRIVACY / AUTHORIZATION / DATA-INTEGRITY LOW DEFECTS REQUIRING REPAIR**
**NO OFFER WORKFLOW HAS BEEN IMPLEMENTED**
**NO AGENT SIGNING WRITER HAS BEEN IMPLEMENTED**
**SCOUTBOX AGENT IS RELEASE-READY AS A PRODUCT DOMAIN**
