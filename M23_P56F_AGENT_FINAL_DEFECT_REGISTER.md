# M23 P5.6F — the Agent final defect register (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

Nine entries. Four are product defects repaired at the root, two are defects in
this milestone's own evidence, one is a weak assertion in a frozen suite, one is
a documentation divergence, and one is a finding whose first framing was wrong.

**F-8 is new**: the original P5.6F pass did not find it.

---

## F-1 — "no login route is rate limited" — **NOT A DEFECT (withdrawn)**

| | |
| --- | --- |
| **Severity** | none — the claim was false |
| **Component** | `/auth/*` |

**What was claimed.** A scan of every login handler's body finds no call to the
rate limiter, so credential guessing looks unbounded on every lane.

**Why it is wrong.** The control is **Express middleware, not an in-handler
call**: `app.use('/auth', authLimiter)` at `server.mjs:587`, 40 attempts per
minute per IP, mounted since M7 and covering every `/auth/*` route including one
registered thousands of lines later by `m25`. No scan of route bodies can see it.

**Re-proved by execution in the reconstruction, not carried over on trust:** a
burst of wrong org credentials against a live server was refused **429 at attempt
41**, with `retryAfterMs` in the body — the shape `adapters.mjs` produces, not the
shape the F-5 fix produces.

**Recorded because** a register that lists only confirmed defects hides how nearly
a false one was shipped. The real finding in this area is F-5.

---

## F-2 — a mandate that has not started grants access

| | |
| --- | --- |
| **Severity** | **HIGH** — authorization |
| **Origin** | P5.6B `m24/shared.mjs`, inherited by every later milestone |
| **Component** | `agreementGrantsAccess` — the one predicate all 109 Agent routes ask |
| **Release blocking** | yes, and blocked until fixed |

**Reproduction**, run against the frozen base before any change:

```js
agreementGrantsAccess({ status: 'active', confirmedAt: now - 1000,
  agentUserId: 'u', clientId: 'p',
  startAt: now + 31_536_000_000, endAt: now + 63_072_000_000 }, 'u', now)
// → true.  The term begins in a year.
```

**Root cause.** The predicate checked the agent, the confirmation and the
effective status; `effectiveAgreementStatus` only ever looked at `endAt`.
`startAt` was **never consulted anywhere in the tree**, although P5.6A step 6
states the rule as `startAt ≤ now < endAt`.

**Fix.** `startBoundaryReached` inside the predicate: an absent start is open, a
present start must be a finite number and must have passed.

**Regression.** Hardening group A — 22 temporal cases including `startAt` in the
future, a millisecond in the future, `NaN`, an ISO string and `Infinity`.

---

## F-3 — a malformed end date read as "open-ended"

| | |
| --- | --- |
| **Severity** | **MEDIUM** — data integrity, fail-open |
| **Origin** | P5.6B `m24/shared.mjs` |
| **Release blocking** | yes, and blocked until fixed |

**Reproduction.**

```js
agreementGrantsAccess({ ...live, endAt: '2024-01-01T00:00:00.000Z' }, 'u', now) // → true
agreementGrantsAccess({ ...live, endAt: NaN }, 'u', now)                        // → true
agreementGrantsAccess({ ...live, endAt: String(now - 86400000) }, 'u', now)     // → true
```

**Root cause.** `if (a.status === 'active' && typeof a.endAt === 'number' && a.endAt <= now)`
— a non-number fails the guard and falls through to "not expired", so a mandate
that ended in 2024 granted access for ever. `NaN` is a number, and `NaN <= now`
is false, so it fell through the same way.

**Fix.** `endBoundaryPassed`: absent is open-ended (legal for an entity, FFAR
12(5)); present but unreadable is **over**. Placed in
`effectiveAgreementStatus` so a projection cannot read `active` while access is
refused — status and access cannot disagree.

**Regression.** Hardening group A, cases A8–A8d, plus A10b asserting the status
agreement.

---

## F-4 — the conflict-engine contract prints a stale severity order

| | |
| --- | --- |
| **Severity** | **LOW** — documentation |
| **Origin** | P5.6A `M23_P56A_CONFLICT_ENGINE_CONTRACT.md` §2 |
| **Release blocking** | no |

The contract prints `INSUFFICIENT_DATA` > `MANUAL_REGULATORY_REVIEW_REQUIRED` >
`PROHIBITED_CONFLICT` > … while `m25/conflict.mjs` implements
`PROHIBITED_CONFLICT: 4, INSUFFICIENT_DATA: 3, MANUAL_REGULATORY_REVIEW_REQUIRED: 2,
PERMITTED_WITH_CONSENT: 1, CLEAR: 0`.

**The code is right**, and its own comment explains why: a prohibition under an
ACTIVE rule is a definite answer while review and insufficient-data are the
*absence* of one, so no missing fact may soften it — and no reviewer could approve
such an item anyway (`REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE`). §6 of this mandate
requires exactly that.

**Disposition:** the frozen P5.6A document is not rewritten. Hardening group G
pins the *implemented* order across all 25 outcome pairs plus the five forbidden
downgrades, so the code cannot drift toward the stale prose.

---

## F-5 — the login throttle is IP-scoped and spent by successes

| | |
| --- | --- |
| **Severity** | **MEDIUM** — availability, plus defence in depth for credential guessing |
| **Origin** | M7 `adapters.mjs` / `server.mjs:587`; reaches the Agent domain through `/auth/reviewer/login` (P5.6C) |
| **Release blocking** | no — repaired anyway, because the repair is small and the lane it guards is the compliance lane |

**What is wrong**, both parts demonstrated live:

1. **Successes spend the anti-guessing budget.** `authLimiter` counts every
   `/auth/*` request. So one tenant's ordinary sign-in traffic can deny another's
   sign-in from the same egress IP.
2. **The budget is per address, not per account.** A distributed attacker gets
   40/min from each address; a shared-NAT office shares one bucket.

**Fix — beside the IP limiter, never instead of it.** `login_failure`, 20 per 15
minutes, keyed by the identifier tried. Each property measured against a live
server:

| Property | Measured |
| --- | --- |
| per identifier | first 429 at request **22** for one reviewer id |
| a success costs nothing | **30 consecutive successful logins**, then a wrong secret still answered **401**, not 429 |
| tested before the credential | the **correct** secret during lockout → **429** |
| case is not a fresh budget | `TSR-DEV-ADMIN` shares `tsr-dev-admin`'s bucket → 429 |
| no existence oracle | a real id and `ghost-never-existed` both lock at request 22, and their 429 bodies are **byte-identical** |
| another account is unaffected | a different reviewer signed in **200** from the same IP — which an IP-scoped limit alone cannot satisfy |
| malformed identifiers | `null`, `[]`, `{}`, `'   '`, absent → uniform 401, no crash, no bypass |

**On the exact threshold.** The repo's limiter convention is `n > max`, so
`max: 20` means 21 failures are answered and the 22nd request is refused. That is
the same convention as all 50 other policies; §3 permits a closely equivalent
value where repo conventions justify it, and this document states the measured
behaviour rather than the round number.

**Remaining risk, unchanged.** M7's middleware still counts successes, and this
build's limiter is per-process (`capability()` says so rather than pretending
otherwise). Changing M7's middleware is a platform change outside an Agent
milestone; the per-account budget makes the guessing case safe without it.

---

## F-6 — the Agent portal had never been rendered at 1024 or 768

| | |
| --- | --- |
| **Severity** | **LOW** — test coverage |
| **Origin** | P5.6B–E: no suite ever set either width on `scoutbox-agent` |
| **Release blocking** | no — but it was a claim the checklist could not support |

Re-established independently in the reconstruction by grepping each suite for
`width: <n>`: 1440 in five suites, 1280 in one, 390 in four, 360 in three, and
**1024 and 768 in none of them**.

**Fix.** Eight checks in `m23AgentLive` (82 → 90) and eight in
`m23AgentTransactionLive` (108 → 116), on the client detail and the transaction
workspace. Each width pairs the overflow measurement with a **content**
assertion — a tab count and the list's own text — because a blank page has no
horizontal scroll either, and eight overflow-only checks would pass while the
thing under test was broken.

---

## F-7 — the port-release evidence was produced by a command that does not exist

| | |
| --- | --- |
| **Severity** | **LOW** — verification integrity (no product impact) |
| **Origin** | this session's scratchpad runners (the contention runner and a `browser-battery.sh` before it) — neither was ever a tracked file |
| **Release blocking** | no |

`ss` is **not installed** in this container: `command -v ss` finds nothing, and it
is absent from `/usr/sbin`, `/sbin` and `/usr/bin`. Every
`ss -ltn | grep -E ':(…)'` therefore produced empty output and reported "zero
listeners" — before a run, during it, and after it, whether or not a port was
held.

A check that cannot fail is worse than no check, because it appears in the
evidence column.

**Fix.** `listeners.mjs`, parsing `/proc/net/tcp` and `/proc/net/tcp6` for state
`0A`, exiting non-zero when a watched port is held. The difference is visible in
the evidence: the observer log now shows the held-port set descending
**18 → 15 → 10 → 5 → 0** as the five concurrent suites finish. It also caught six
held ports and then their release during an earlier reap, which an `ss`-based
check reported as "zero" throughout.

**Scope, corrected in the review pass.** An earlier draft of this entry said the
same idiom sat in a committed `browser-battery.sh` and that earlier milestones'
leak detector had therefore never run. That overstated it: `git grep "ss -ltn"`
finds **no tracked file** using `ss` — the inert checks lived only in this
session's scratchpad runners. The correct statement is narrower and still worth
making: **the P5.6F contention proof's own first attempt was vacuous**, and the
repository previously shipped **no** port-release tooling at all. The probes are
now committed under `e2e/tools/` (`listeners.mjs`, `survivors.mjs`, `reap.mjs`,
`contention.sh`), so a fresh clone can reproduce the measurement rather than
trust a log.

**Related, and also fixed:** `pgrep -f "node .*server.mjs"` matches the calling
shell's own command line and killed this session twice with exit 144. Process
identity now comes from `/proc/<pid>/comm` plus argv (`reap.mjs`,
`survivors.mjs`), and the survivor check ignores state `Z` — a zombie has already
exited and holds no port or memory, so reporting one as a leak would make the
check cry wolf.

---

## F-8 — a missing date of birth read as an ADULT (**new; the original pass missed this**)

| | |
| --- | --- |
| **Severity** | **MEDIUM** — safeguarding, fail-open |
| **Origin** | `domain.mjs` `ageOn`/`isAdult`, and `m25/policy.mjs` `isRegulatoryMinor` |
| **Component** | the platform's age choke point — 65 `isAdult` call sites |
| **Release blocking** | yes, and blocked until fixed |

**Reproduction** against the frozen base:

```js
isAdult({ dob: null })          // → true   (a 56-year-old, born at the epoch)
isAdult({ dob: 0 })             // → true
isAdult({ dob: false })         // → true
isRegulatoryMinor(null)         // → false  ("NOT_A_MINOR", gate not blocked)
```

**Root cause.** `new Date(null)` is **not** an invalid date — it is the epoch. So
`ageOn(null)` computed 56 and every adult gate passed. `0` and `false` coerce the
same way. Only `undefined`, `''` and an unparseable string failed closed, and
they did so *by accident* rather than by rule.

**Reachability — checked, not assumed.** Both registration paths reject a falsy
dob (`NAME_AND_DOB_REQUIRED`), so this is not reachable through sign-up. But the
M13 prospect import treats `dob` as **optional** (`m13/imports.mjs:71`,
`if (rec.dob && …)`) and projects a missing one as **`dob: null`**
(`m13/imports.mjs:293`). A record with no date of birth is therefore a real
shape, and "age unknown" is a real state.

**Fix at the root.** `ageOn` returns `NaN` unless `dob` is a non-empty string that
parses; `isAdult` requires a finite age; `isRegulatoryMinor` returns `null` for
anything that is not a parseable non-empty string. Unknown age is now **never**
adult, and `evaluateMinorGate` blocks with `SUBJECT_DOB_UNKNOWN`.

NaN rather than a thrown error is deliberate: every caller either compares it
(`>= adultAge`, `< required` — both false for NaN, the closed answer) or renders
it (JSON `null`, i.e. "unknown").

**Blast radius, measured.** 65 `isAdult` call sites. Twelve frozen suites re-run
green, including `m23TrialE2E` (535 checks) and `m23AgentIntegrationE2E` (535) —
the fix is strictly more protective and breaks no valid flow. A real 17-year-old
is still a minor and a real adult is still an adult.

**Why the original pass missed it.** It audited the representation and auth
layers, where it found F-2 and F-3, and did not carry the same reasoning into the
age layer. F-2, F-3 and F-8 are **the same mistake in three different fields**:
an unreadable value in a security decision treated as an absent constraint.

---

## F-9 — an unconditional pass in a frozen suite

| | |
| --- | --- |
| **Severity** | **LOW** — test integrity |
| **Origin** | P5.6E `e2e/m23AgentIntegrationLive.test.mjs` |
| **Release blocking** | no |

```js
} else neg(true, 'N1 (the grassroots app has no seeded club for this fixture; …)');
```

`neg(true, …)` always passes and counts toward that suite's negative total, so a
grassroots check that could not run was recorded as a grassroots check that
passed. §7 forbids this shape.

**Disposition:** recorded, not rewritten. The frozen suite keeps its history, and
the new `m23AgentGrassrootsLive` supersedes it by entering the real grassroots app
with a club that IS seeded (`org-hackneymarsh`) and asserting 48 real checks. The
reason for recording rather than editing is that changing a frozen suite's
assertions to improve its numbers is the same act, in the other direction, as
padding them.

---

## F-10 — the agent demo was a dead end for anyone not on its roster

| | |
| --- | --- |
| **Severity** | **LOW** — user-facing, demo mode only |
| **Origin** | P5.6B `scoutbox-agent/src/agentDemo.ts` |
| **Found by** | the user, opening the published demo after the milestone closed |
| **Release blocking** | no |

The demo's login invents a *user* for any unrecognised name but never invents an
*affiliation*, so every request afterwards was refused
`AGENCY_MEMBERSHIP_REQUIRED` under a generic "That did not load." — and nothing
told you that only `Ana Costa`, `Tomás Rivera` or `Ben Okoro` would work.

**The refusal is correct** and was not changed: the real server refuses a
non-member identically, because only an administrator adds one. The fix offers
the roster on the login screen (derived from the fixtures, so it cannot drift)
and leaves the free-text path refusing a stranger, byte for byte.

**Why no suite caught it:** every suite signs in as a seeded identity — the one
name that works. The bug existed only for a human typing their own name.
`m23AgentDemoSpotcheck` now asserts both the roster and the stranger's refusal.

---

## F-11 — a guardian had two failed-login budgets (**review pass**)

| | |
| --- | --- |
| **Severity** | **LOW** — security, defence in depth |
| **Origin** | F-5's own wiring (this milestone) |
| **Release blocking** | no |

`/auth/guardian/login` accepts `guardianId` **or** `email`, and F-5 keyed the
budget by whichever was tried. One account, two names, **two** budgets: a guesser
alternating them got 42 attempts per window instead of 21.

**Fix.** After the account resolves, the lockout is also checked against the
canonical `guardian:<id>` bucket, and a failure charges both the tried name and
the canonical one. **Regression** AA6–AA8b, on a fresh server so the per-IP
budget cannot be what fires: lock the account by id (429 at attempt 22), then
the same account by email is *already* locked — even with the right password.

The player and org lanes were checked for the same shape: `findPlayer` is exact
id only, and an org resolves by `orgId` only, so neither has an alias.

---

## F-12 — sign-up stored a date of birth it could not read (**review pass**)

| | |
| --- | --- |
| **Severity** | **LOW** — data integrity |
| **Origin** | M7 registration, exposed by F-8's analysis |
| **Release blocking** | no |

Registration refused an **absent** dob (`NAME_AND_DOB_REQUIRED`) but not an
**unreadable** one: `dob: 12345`, `'not-a-date'`, an array or an object were all
stored. Before F-8 such an account computed as a 56-year-old; after F-8 it fails
closed as "age unknown" — safer, but still an account whose age can never be
established, created by the platform itself.

**Fix.** Both sign-up paths refuse `400 DOB_INVALID` when `ageOn(dob)` is not
finite. **Regression** AD6–AD7: four unreadable shapes refused, a readable adult
date still signs up (201).

**F-12b — and the first fix was itself incomplete.** Re-proving F-12 for the
push audit with a wider set of shapes found that `2010-02-30` was **accepted on
both paths**. `new Date('2010-02-30')` is not an invalid date in V8 — it rolls
over to 2 March — so "is `ageOn` finite?" said yes, and the platform created an
account, and a guardian-created child, with a birthday that does not exist. 31
April and 29 February in a non-leap year behave the same; month 13 was already
refused only because ISO parsing happens to reject it.

**Root fix.** One reading of a date of birth for the whole platform:
`parseDob` in `domain.mjs` accepts a `YYYY-MM-DD` string only when the parsed
day prints back as the same string. `ageOn` and `isRegulatoryMinor` both use
it, so a rolled-over date is now "age unknown" everywhere — including for any
such row an import already stored — and both sign-up paths refuse it. Every dob
the seed and the suites write is canonical `YYYY-MM-DD` (checked with `git
grep` before tightening), so nothing valid is refused; a real leap day still
reads. **Regression** AD8–AD8g (pure) and AD6/AD7c (live, both paths).

The lesson is the one this milestone keeps relearning: "is it parseable?" is
not "is it a date". The first F-12 fix asked the first question.

---

## The review pass, and what it found in its own work

A second reviewer went through the milestone with the same adversarial brief
the milestone applied to P5.6A–E. Besides F-11 and F-12, it found that the
reconstruction's **own suites contained the shape it had filed as F-9**:

| Where | What | Now |
| --- | --- | --- |
| hardening V3 | `ok(true, …)` inside an `if (status === 200)`, with an `else` that also passed — two contradictory products would both have been green | pinned to 200, plus an assertion that the record reads as terminated |
| hardening N1 | `neg(true, …)` in the 404 branch | a real condition: 404, **or** 200 with zero rows and zero total |
| hardening D6, D8, T1, T2, A13, J4, J6, V4 | `status >= 400` — nearly `!== 200` | exact statuses (404 / 403 / 401 / 409), with the error code printed into the evidence |
| Grassroots G1, G2 | `ok(true, …)` after a `waitForSelector` | the club-card count, and the workspace naming its club |
| Grassroots G7 | `if (200) … else refused` — either-way | pinned to 200: Hackney Marsh is seeded verified with the safeguarding contract signed |
| Grassroots G8 | `waitForSelector(...).catch(() => {})` then `ok(true, …)` — **exactly the F-9 shape** | the wait is unswallowed and the entry screen is counted |

The suites grew from 247 → **265** (hardening) and 48 → **49** (Grassroots) with
these, and every added check can fail. The point of recording this is not
self-flagellation; it is that "no weak assertions" was a claim the first pass
made about itself, and the claim was wrong in six places. A milestone that
audits everything except its own instruments will report a clean bill it has
not earned.

---

## Two §34 quota observations

Both P5.6E quotas survive in the base and are re-proved rather than rewritten:
`opportunity_share` 60/hour per actor, `transaction_handoff` 30/hour per org.

Deliberately unquota'd, with the reason recorded: the one-shot state changes
(`clients/:id/terminate`, context `close`, representation `withdraw`, party
`remove`). Each is refused by **state** after its first success, so a quota would
add a mechanism without bounding anything.

---

## Inherited findings

| From | Finding | State |
| --- | --- | --- |
| P5.6E A1 | an agency org reaches generic `/org` list infrastructure | **classified and closed** — A/B/C/D, twelve surfaces probed, zero foreign references, and category B refused by concealment against a REAL case id |
| P5.6E A2 | a transaction draft may name an adult non-client | **accepted**, mitigations re-proved |
| P5.6E A3 | the Grassroots journey was never observed | **closed by observation** — 48 checks |
| P5.6E E-1…E-16 | sixteen defects | fixed in their own milestones; regressions green here |
| P5.6C G-C0 | no attributed reviewer identity | closed in P5.6C; re-tested here |

---

## The exit position

| Class | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 0 | 0 | **0** |
| High | 1 (F-2) | 1 | **0** |
| Medium | 3 (F-3, F-5, **F-8**) | 3 | **0** |
| Low | 7 (F-4, F-6, F-7, F-9, F-10, F-11, F-12) | 5 (F-6, F-7, F-10, F-11, F-12) | **2** by decision (F-4, F-9 — both documentation/frozen-suite, neither a product risk) |
| Withdrawn | 1 (F-1) | — | — |
| Weak assertions in this milestone's own suites | 6 sites | 6 | **0** |

| | |
| --- | --- |
| Open Critical | **0** |
| Open High | **0** |
| Open reasonably-fixable Medium | **0** |
| Open security / privacy / authorization / data-integrity Low needing repair | **0** |
| Known unresolved Agent test flakes | **0** |
| Accepted architectural property | **1** — A2 |
| Product-shape question | **1** — A1 |

Four of the twelve findings were defects in this milestone's own evidence rather
than in the product (F-6, F-7, F-9, and the six weak assertions the review pass
found in the reconstruction's own suites). A hardening pass that finds nothing
wrong with its own instruments has probably not looked at them — and the review
pass proved that of the first pass, too.
