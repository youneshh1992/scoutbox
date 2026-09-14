# M23 — Reuse Audit

Written before any persistence exists, because §4 and §5 make it the gate. The
question this document answers is not "what shall we build" but **"what is
already here, and why is that not enough"** — asked once per proposed store,
and answered with file paths rather than intentions.

M23 is an orchestration milestone. The honest measure of success is how little
new durable truth it introduces.

---

## Part A — What already exists

Twenty-seven preflight areas, condensed to the facts that change a decision.

### A1. The recruitment case is already canonical, and the Room is already a facet

`db.recruitmentCases` — declared `m12/shared.mjs:16`, guaranteed by migration
step `m182_002_collections_present`. A case is a Room **iff `case.room` is
truthy** (`isRoom()`, `m17/rooms.mjs:53`). M17 stated the rule in its own source
(`m17/shared.mjs:11-16`): *"`db.recruitmentCases` (M12) is ALREADY the workspace
layer… A Room is a FACET of a case, not a second pipeline."*

§6 says do not undo this. Nothing in M23 does.

### A2. There is already one authoritative lifecycle, with a real transition table

`ROOM_STATUSES` — 13 values, `m17/shared.mjs:21-35`:

```
watching · under_review · shortlisted · priority
trial_requested · trial_scheduled · trial_completed
offer_consideration · offer_made · signed
withdrawn · archived · closed
```

`ROOM_TRANSITIONS` (`m17/shared.mjs:132-148`) is a complete adjacency table with
no escape hatch. `case.stage` is a **pure derivation** of `room.status` written
by exactly one function, `applyStatus()` (`m17/rooms.mjs:73-83`), and a boot
assertion (`m17/index.mjs:35-47`) throws if any status maps to a stage that does
not exist or has no transition list.

This is the single most important finding in the audit. §7 offers seventeen
stage values; thirteen already exist under different names with a proven table,
a boot assertion, an M20 funnel reading them and four regression suites pinning
them. **The reconciliation is in `M23_MATRIX.md` §L.**

### A3. Decisions are already append-only, already idempotent, already taxonomised

`db.roomDecisions`, written only by `recordDecision()` (`m17/rooms.mjs:996`).
Supersede is `prev.supersededById = d.id` then push — nothing is ever edited or
deleted. Nineteen reason codes in four categories, plus **28 prohibited codes**
refused by their own error (`ROOM_REASON_PROHIBITED`) and a boot assertion that
throws if a prohibited code ever leaks into the allowed taxonomy.

It already carries `clientKey` idempotency (`m17/rooms.mjs:1028-1034`).

§29-§31 are satisfied by reuse. M23 records decisions **through this function**.

### A4. Trials exist in four unrelated shapes

| Concept | Store | What it really is |
|---|---|---|
| Contact/trial **request** | `db.requests` | the invitation + response flow, guardian-routed |
| The accepted **trial** | `db.trials` | status is `awaiting_report` \| `reported` — a *report gate*, not a schedule |
| Trial **day** logistics | `trial.day` sub-object | staff checks, consents, arrival, check-ins, `statusEvents[]` |
| Grassroots **open trial** | `db.openTrials` | a public session with registrations |

The critical finding: **`db.trials.status` has exactly two values and neither is
a scheduling state.** Cancellation and postponement are appended to
`trial.day.statusEvents[]` (`m12/journeys.mjs:628-642`), not represented as
status. Attendance is a row on `player.attendance` written by check-in.

### A5. No offer object exists — at all

Searched `offer`, `invitation`, `proposal` across every `.mjs` in
`scoutbox-server`. What exists is **two status strings** (`offer_consideration`,
`offer_made`), **one recommendation value** (`'offer'`), and a **derived count**
in `roomFunnel()`. There is no offer record, no terms, no expiry, no recipient,
no acceptance path, no player-facing surface.

`db.signings` is created directly by `POST /org/players/:id/signing` with no
preceding offer of any kind.

### A6. There is no general idempotency mechanism

No `Idempotency-Key` header handling, no middleware, no store. Four local
patterns exist; the only one shaped like an API is `clientKey` on room decisions.
§83 asks for idempotency on nine actions. That is a real gap.

### A7. Two recruitment stores are created only by seed

**`db.trials` and `db.requests` have no `??=` anywhere in any module.** They
exist because `seed.mjs:512-513` creates them, plus the retroactive M20
migration step `m200_001_analytics_sources_present`. M20 found this for
`db.trials`; the audit finds `db.requests` has the identical defect and it has
never been called out. §115 asked for exactly this re-audit.

### A8. The reuse seams are already named and already used by two milestones

`ctx.createRoomForPlayer` (`m17/rooms.mjs:745`) and `ctx.reopenRoom` (`:713`) are
the only sanctioned cross-milestone room writers. M18 (Second Look) and M19
(Watchlists) already go through them rather than touching `db.recruitmentCases`.
M23 does the same.

`buildShared(ctx)` (`m12/shared.mjs:44`) supplies `isLead`, `requireLead`,
`orgCanSee`, `audit`, `paginate`, `guardianOwnsChild`, `checkEligibility`,
`distanceBand`, `isAdult`.

### A9. Safeguarding is structural, not a setting

- `visibleToOrg()` (`domain.mjs:71-82`) — agencies see **no** minor,
  unconditionally; grassroots fails closed on missing location and enforces
  `GRASSROOTS_RADIUS_KM = 50`.
- `routedTo = minor ? 'guardian' : 'player'` (`server.mjs:1815`) — the existing
  contact routing rule. Scout → Parent, never Scout → Child.
- `guardianManagedOnly` / `guardianOwnsChild` — the two route gates.
- `orgCanSee` re-runs blocks on **every** read; rooms return `{visible:false}`
  rather than stale data.

M23 adds no new safeguarding logic. It composes these.

### A10. Passport already refuses to treat recruitment as history

`m15/shared.mjs:188` carries the comment *"A trial is NEVER employment."*
Trials reach the Passport as `trialsSummary = {total, withReport}` (counts), and
own-org detail is `{id, org, date, hasReport}` — **existence and a boolean,
never report content**. Assessments appear as existence only.

There is no path by which a rejection, an interest, a Room note or an offer
could enter a Passport today, because nothing writes them there.

### A11. Everything else that M23 must not re-invent

| Need | Existing | Location |
|---|---|---|
| Concurrency | `guardRev` / `bumpRev` / `revMeta` | `m181/concurrency.mjs` |
| Rate limiting | `RATE_LIMIT_POLICY` (throws on unknown action) | `m181/rateLimit.mjs` |
| Events | `EVENT_REGISTRY` + `EMITTED_EVENTS` + `minimizePayload` | `m182/eventRegistry.mjs`, `server.mjs:3910` |
| Notifications | 15 categories, 6-hour unread coalescing | `m182/notificationPrefs.mjs`, `server.mjs:625` |
| Migrations | `MIGRATIONS` array, `SCHEMA_VERSION = 2200` | `m182/migrations.mjs` |
| Audit trail | `audit()` writing `record.history[]` | `m12/shared.mjs:67` |
| Conflict UX | `conflictOf` + `ConflictNotice` | `scoutbox-club/src/conflict.tsx` |
| Dirty-form guard | `registerDirtyGuard` … `installDirtyGuard` | `scoutbox-club/src/dirtyGuard.ts` |
| Second Look | 17 change types, `changeFingerprint` (timestamp deliberately excluded) | `m18/shared.mjs` |
| Analytics | 24 metrics, mandatory `limitation`, `SMALL_N_MIN = 5` | `m20/metrics.mjs` |
| Funnel source | `transitions(room)` reading `room.history` | `m20/funnels.mjs:42` |

---

## Part B — The reuse gate, one candidate at a time

§5 asks four questions per proposed store. Answered honestly, including where
the answer is "reuse it".

---

### B1. Lifecycle transition history → **REUSE `case.history`**

**1. What existing store was considered?** `case.history[]`, appended by
`audit()` (`m12/shared.mjs:67`) and by M17's `activity()`.

**2. Why can it not represent this concept?** It can, completely. It already
carries `{action, at, by, detail}` and is already append-only.

**3. Would extending it break old invariants?** No — and this is the decisive
point. **M20's funnel reads `room.history` for exactly two actions**
(`room_status_changed`, `room_reopened`, `m20/funnels.mjs:42-54`). A separate
M23 transition log would mean two histories that can disagree, and the analytics
funnel would silently read the older one.

**4. Durable truth or projection?** Durable — and it already exists.

**Decision: no new store.** Every M23 transition goes through `applyStatus()` so
it lands in the same history M20 already reads. §9's required fields map onto
the existing entry shape.

---

### B2. Recruitment contact → **REUSE `db.requests`, extended additively**

**1. What existing store was considered?** `db.requests` (`server.mjs:1792`) —
`{type:'contact'|'trial', status:'pending'|'accepted'|'declined', routedTo,
guardianId, trialDetails, contactChannel}`.

**2. Why can it not represent this concept?** It represents most of it already,
and better than a new store would: it is **the** club→player approach, it
already routes minors to the guardian, and its accept/decline routes live on the
guardian and player routers so **a club cannot forge a response today**. What it
lacks is §12's four-state distinction — it has "created" and "responded" but no
*internal decision to contact* and no *recorded external contact*.

**3. Would extending it break old invariants?** The two additions are additive
fields with defaults, so existing readers (the player Inbox, the
`REPORTS_OUTSTANDING` gate, M18's change producers) are untouched. The risk is
real but bounded, and it is smaller than the risk of a parallel contact store
that the Inbox does not know about.

**4. Durable truth or projection?** Durable.

**Decision: extend, do not duplicate.** `db.requests` gains a delivery state and
a channel, plus `rev` for §80. The *internal decision to contact* is **not a
record at all** — it is a lifecycle transition with an actor, a timestamp and a
reason, which is precisely what §9 asks for and what B1 already provides.

A **recorded external contact** is the one genuinely new row: org-private
metadata asserting that someone phoned a guardian. It is stored as a request
with an explicit external channel and a delivery state that **never claims
delivery**, satisfying §13 and negative test 75.

---

### B3. Recruitment offer → **NEW store `db.recruitmentOffers`**

**1. What existing store was considered?** `db.signings`, `db.squadInvites`,
`db.requests`, and the `offer_made` room status.

**2. Why can it not represent this concept?**
- `db.signings` is the *result*, created after the fact, with billing side
  effects (`server.mjs:2146`) and a player-level change. An offer that has not
  been accepted is not a signing, and creating one to represent a proposal would
  fire an invoice.
- `db.squadInvites` is grassroots squad membership with its own
  `pending_guardian` flow — a different relationship and a different audience.
- `db.requests` is an approach, with no terms, no validity window and no
  authorisation step.
- `offer_made` is a **status string**. It has no recipient, no content and no
  response.

**3. Would extending it break old invariants?** Extending `db.signings` would be
the worst available option: it would make an unaccepted proposal indistinguishable
from a completed signing in the Passport, the Trust engine and M20 — the exact
misrepresentation §46 and §157 forbid.

**4. Durable truth or projection?** Durable business truth. A club made a
specific proposal to a specific person on a specific date; that fact must
survive withdrawal, expiry and rejection.

**Decision: new store, narrowly scoped.** No financial terms, no legal terms, no
registration fields — §37 and §39 are explicit, and the product has no safe
model for any of them.

---

### B4. Trial scheduling and response → **EXTEND `db.trials`**

**1. What existing store was considered?** `db.trials` plus its `day`
sub-object, and `db.requests` for the invitation.

**2. Why can it not represent this concept?** Partially. The invitation and
response already exist on `db.requests` and are already guardian-routed and
un-forgeable — reuse those. What `db.trials` cannot express is **scheduling
state**: its `status` is a two-value report gate, so "scheduled", "in progress",
"cancelled" and "no show" have nowhere to live. §19 asks for those and §24
insists attendance is not inferred from status.

**3. Would extending it break old invariants?** This is the sharpest risk in the
milestone. `trial.status` is read by the `REPORTS_OUTSTANDING` gate
(`server.mjs:1776`), by M17's `trialStateFor()`, by M15's Passport summary and by
M18's change producer. **Widening the existing `status` enum would break all
four.** So M23 does not widen it: scheduling state goes in a separate,
additive field, and `status` keeps its two values and its exact current meaning.

**4. Durable truth or projection?** Durable.

**Decision: extend additively, never widen `trial.status`.** Cancellation and
rescheduling continue to append to `day.statusEvents[]`, which already preserves
history exactly as §22 and §23 require.

---

### B5. Trial assessment → **REUSE `db.assessments`**

**1. What existing store was considered?** `db.assessments`.

**2. Why can it not represent this concept?** It already does, and it is better
than anything M23 would write: templates with descriptive anchors, a frozen
`attributesSnapshot`, `notObserved` that is never averaged as zero, immutability
once submitted (409 `NOT_A_DRAFT`), a server-enforced blind second-opinion rule,
and — decisively for §27 — an existing internal/shared split where
`publishedFeedback` is the **only** door to the player.

**3. Would extending it break old invariants?** No extension is needed.

**4. Durable truth or projection?** Durable, and already stored.

**Decision: no new store, and explicitly no `trialScore`.** §25 forbids one;
the existing model has no field for it and none is added.

---

### B6. Outcome → **REUSE `db.outcomeReports` + `db.signings`, project once**

**1. What existing store was considered?** `db.outcomeReports`
(`registrationStatus: registered | released | left | unknown`), `db.signings`,
`case.decision.outcome`, `application.outcome`, `trial.report`.

**2. Why can it not represent this concept?** The canonical post-signing outcome
already exists with a confirmation/dispute flow. The genuine problem is the
opposite of a missing store: there are **five different things called
"outcome"** and §48 forbids adding a sixth.

**3. Would extending it break old invariants?** N/A.

**4. Durable truth or projection?** The terminal outcome is a **projection** over
room status, the current decision, the offer state and any signing — exactly
what §48 asks for and precisely why it must not be persisted as a field.

**Decision: no new store. One derived terminal outcome, computed in the journey
projection.**

---

### B7. Idempotency → **NEW, minimal, shared mechanism**

**1. What existing store was considered?** The `clientKey` column on
`db.roomDecisions`, and M21's plan-creation retry.

**2. Why can it not represent this concept?** `clientKey` is scoped to one
record type and resolved by scanning that record type. §83 needs it on nine
different actions across four record types.

**3. Would extending it break old invariants?** No — the existing `clientKey`
behaviour is preserved as-is so M17's suite stays green.

**4. Durable truth or projection?** Neither, strictly — it is infrastructure.
But a replayed "send offer" that creates a second offer is a durable business
error, so the key must persist.

**Decision: one small shared helper, following the `clientKey` shape that is
already proven, returning the original result with `idempotent: true` rather
than repeating the action.**

---

### B8. Hold → **REUSE the lifecycle + decision, one additive field**

**1. What existing store was considered?** `db.roomDecisions` (which already has
`continue_monitoring` and `not_current_priority` reason codes) and `room`.

**2. Why can it not represent this concept?** A decision records *that* the club
paused; §33 additionally wants a review date and an owner that the UI can render
as due/overdue on read.

**3. Would extending it break old invariants?** No.

**4. Durable truth or projection?** Durable, and small.

**Decision: no new store.** A hold is a lifecycle status plus a decision plus a
`reviewAt` — and, per §33, **no scheduler**. Due/overdue is computed at read
time, as M21 already does for development actions.

---

## Part C — The score

| | |
|---|---|
| New durable stores | **1** — `db.recruitmentOffers` |
| Stores extended additively | 2 — `db.requests`, `db.trials` |
| Stores reused unchanged | 6 — `recruitmentCases`, `roomDecisions`, `assessments`, `outcomeReports`, `signings`, `case.history` |
| Parallel replacements created | **0** |
| New scoring concepts | **0** |

One new store for an entire end-to-end workflow is the number this audit was
written to justify. The offer earns it because nothing in the product can
represent an unaccepted proposal without lying about it.

---

## Part D — The seed-only store defect, re-audited (§115)

M20 discovered `db.trials` had only ever been created by `seed.mjs`. The
re-audit finds the defect is **wider than recorded**:

| Store | Module `??=` | Migration | Status |
|---|---|---|---|
| `db.trials` | **none** | `m200_001` | covered retroactively |
| `db.requests` | **none** | `m200_001` | covered retroactively — **never previously called out** |
| `db.channels` | **none** | none | **uncovered** |
| `db.blocks` | **none** | none | **uncovered** |
| `db.reports` | **none** | none | **uncovered** |
| `db.plans` | **none** | none | **uncovered** |
| `db.openTrials` | `server.mjs:162` | none | fine |
| `db.signings` | `server.mjs:154` | `m200_001` | fine |

`db.blocks` is the one that matters most: `isBlocked()` reads it on every
visibility check, and a snapshot restored without it would throw inside the
safeguarding path. M23's migration covers the recruitment-relevant ones and
records the rest.

**The rule this establishes, and which M23 follows:** a new store is created in
`m182/migrations.mjs`, never as a bare `db.x ??= []` in a module.

---

## Part E — What M23 must not touch

Confirmed present, confirmed correct, confirmed out of scope:

- **Trust** (`m162/`) — evidence confidence only. No recruitment outcome is an
  input. §60, §145.
- **Matching** (`m19/`) — criteria and explanations, no score. Workflow fields
  do not become matching inputs. §56, §147.
- **Second Look** (`m18/`) — 17 canonical change types, fingerprint excludes the
  timestamp. A workflow checkbox is not a material change. §59, §149.
- **M22 CV** — `realWorldValidation.status = "not_completed"`,
  `combineVerifiedProtocols = []`. Unchanged. §61, §146.
- **Development** (`m21/`) — plans start explicitly, by a person. §54, §148.
