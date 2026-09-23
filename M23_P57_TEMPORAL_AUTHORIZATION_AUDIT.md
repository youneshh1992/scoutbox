# M23 P5.7 — Temporal authorization audit

Every authorization or lifecycle decision that reads a clock, and what it
now does when the clock cannot be read. The single rule (type contract,
principle C): **an absent optional bound is open; a present but unreadable
bound is closed.** "Closed" means the decision refuses — the person is not
an adult, the facet is not current, the mandate grants nothing, the window
is not in force.

## 1. Decision inventory

| Decision | Predicate | Clock(s) | Absent | Unreadable | Boundary | Suite |
| --- | --- | --- | --- | --- | --- | --- |
| Is this person an adult (self sign-up, contact routing, visibility, notifications, Combine, Passport)? | `isAdult` → `ageOnMs` | `dob` | not adult | not adult (NaN) | turns N at 00:00 UTC on the birthday; KR 19 | C1–C6, Q |
| Is this player a regulatory minor (agent approach)? | `isRegulatoryMinor` | `dob` | `null` → gate blocks `SUBJECT_DOB_UNKNOWN` | `null` → blocks | same | C8, C9 |
| When may a minor be approached? | `earliestPermittedApproachAt` | `dob` | `MINOR_TIMING_NOT_ENCODED` | same | academic year inclusive on 1 Sep | C10 |
| Does this agent hold a current verification for a regulated action? | `verificationGap` → `effectiveFacetState` | `facet.recheckAt` | absent keeps VERIFIED (frozen A8, legacy) | STALE → `AGENT_VERIFICATION_REQUIRED` | STALE at exactly `recheckAt` | K1–K4b |
| Is this person a member of the agency? | `affiliationActive` | `startedAt`, `endedAt` | start absent → not a member; end absent → open | inactive | start inclusive, end exclusive | K5–K6 |
| Does this mandate grant private-client access? | `agreementGrantsAccess` / `effectiveAgreementStatus` | `startAt`, `endAt`, `confirmedAt` | open boundary; unconfirmed → no | no (F-2/F-3) | start inclusive, end exclusive | K7–K8b |
| Which policy version applies? | `selectPolicyVersion` | `effectiveFrom`, `effectiveTo` | `to` absent → open | never selected | from inclusive UTC midnight, to exclusive | J1–J7b |
| Is a PENDING_IMPLEMENTATION rule active yet? | `ruleStatusAt` | `rule.effectiveFrom` | stays pending | stays pending | inclusive | J8–J9 |
| Is dual-representation consent sufficient? | `consentSufficiency` | `grantedAt`, `revokedAt`, `firstActAt` | `CONSENT_MISSING` | `CONSENT_MISSING` | granted ≤ first act | K9–K11 |
| Is guardian approach consent standing? | `evaluateMinorGate` | `grantedAt`, `revokedAt` | no consent | no consent | granted ≤ now | m23AgentComplianceE2E W |
| Is this transaction document available? | `isExpiredAt(d.expiresAt)` | `expiresAt` | available | unavailable (expired) | expired at the instant | H3, m23AgentTransactionE2E |
| Is this handoff invitation standing? | `effectiveHandoffStatus` | `invitedAt` | expired | expired | 30-day TTL | K12–K13b |
| Is this licence / affiliation claim verified now? | `effectiveStatus` | `validUntil`, `current` | verified (no expiry) | expired | exclusive | I1–I5 |
| Is this staff background check current on the trial day? | `checkState` | `check.expiresAt` | reviewed (no expiry recorded) | expired | day end exclusive | R3–R5, T3 |
| May a trial session be scheduled? | `validateSessionInput` / `validateScheduleInput` | `startsAt`, `endsAt`, `now` | refused (a session needs both) | refused | 15 min–12 h inclusive; not entirely past | M1–M9 |
| May this trial be completed? | `canComplete` | `lastSession.endsAt`, `now` | `last_session_not_ended` | same | ended at `endsAt` | m23TrialE2E |
| May the club contact this player again? | `cooldownFor` | `deliveredAt` | no cooldown | no cooldown (fails open on purpose: it protects the player) | clear at exactly +72 h | L4–L5b |
| Is this attested contact recordable? | `validateExternalRecord` | `occurredAt` | refused | refused | not future (+5 min skew), ≤180 days old | L1–L3 |
| Is this recruitment brief live today? | `briefIsLiveOn` | `activeFrom`, `activeUntil` | open | not live | inclusive days | N7–N8 |
| Is this opportunity / campaign / Combine request open? | string compare / `endOfDayExclusive` | `deadline` | (required) | refused at write; closed at read | through the whole day | R9–R10, m16 |
| Is this open day in the past (no-ghosting)? | string compare on DATE_ONLY | `openTrial.date` | (required) | refused at write | day | R9 |
| Which analytics window? | `resolveWindow` | `from`, `to` | preset | `WINDOW_INVALID` | inclusive days, ≤ today | N1–N3, R7 |
| Should this push be held (quiet hours / school hours)? | `pushDeferred` | wall clock in the person's zone | Europe/London | zone refused at write | minutes inclusive/exclusive as stored | R14 |
| Has the report deadline passed? | `Number.isFinite(reportDueAt)` | `reportDueAt` | unknown, never overdue | unknown | +7 days | m23P4AClosureE2E L4 |

## 2. Authorization precedes validation (§29)

For every hardened route the order is: authenticate → authorise (role,
ownership, visibility) → read the record → validate the date. A caller who
may not act receives the same refusal whether or not the date is well
formed, and an unknown record is 404 to its own club and to a stranger
alike, so a date error never confirms that a record exists.

| Route | Without a token | Wrong principal | Unknown record | Then |
| --- | --- | --- | --- | --- |
| `POST /org/open-trials` | 401 | player token → 401/403 | — | `DATE_INVALID` |
| `POST /admin/staff-checks/:trial/:staff` | 401 `ADMIN_KEY_REQUIRED` | — | 404 `CHECK_NOT_FOUND` | `DATE_INVALID` |
| `POST /org/trials/:id/staff` | 401 | another club → 404 `TRIAL_NOT_FOUND` | 404 | `DATE_INVALID` |
| `POST /guardian/children` | 401 | — | — | `DOB_INVALID` |
| `POST /player/development/plans` | 401 | — | — | `DATE_INVALID` |
| `POST /ts/compliance/policies` | 401 | reviewer (not admin) → 403 `REVIEWER_ROLE_REQUIRED` | — | `POLICY_INPUT_INVALID` |
| `POST /org/verification/licence` | 401 | — | — | `DATE_INVALID` / `INTERVAL_INVALID` |
| `POST /org/rooms/:id/contacts/external` | 401 | contributor → 403 `CONTACT_NOT_PERMITTED`; blocked → 403 `CONTACT_BLOCKED` | 404 | `CONTACT_OCCURRED_AT_INVALID` |
| `POST /auth/player/signup` | (public) | — | — | `DOB_INVALID` before `PASSWORD_REQUIRED` and `GUARDIAN_REQUIRED` — a sign-up reveals nothing |

Asserted live in group S (S1–S7b) and by the frozen P5.6F error-privacy
group (AE), which still passes.

## 3. Server-derived timestamps (§19)

No route in M24–M27 accepts a client `…At` except the validated document
expiry (grep: the only `body.*At` reads in those modules). Every
`createdAt`, `updatedAt`, `confirmedAt`, `grantedAt`, `invitedAt`,
`recordedAt`, `revAt`, `at` in history rows and audit rows is the server's
clock. The two client-supplied instants that are stored — contact
`occurredAt` and evidence `observedAt` — are attestations about the world,
validated (not future beyond skew, not implausibly old) and stored beside a
server `recordedAt`.

## 4. Injected clocks (§20)

Every pure predicate above takes `now`. The live server reads `Date.now()`
at the route and passes it down; `SCOUTBOX_TEST_CLOCK=1` lets the suites
pin it. No predicate in `temporal.mjs`, `m24/shared.mjs`, `m25/policy.mjs`,
`m25/conflict.mjs`, `m23/contact.mjs`, `m23/trial.mjs`, `m14/shared.mjs`,
`m20/metrics.mjs`, `m18/shared.mjs` or `m27/integration.mjs` reads a clock
of its own.

## 5. What P5.7 did not change

- The frozen P5.6B facet reading for an ABSENT recheck clock (A8).
- The frozen P5.6F agreement-term rule (F-2/F-3); it is re-asserted (K8).
- The Contact cooldown's fail-open direction (it is a limit on the club).
- Offer, signing, issuance, acceptance, decline: no object, no route, no
  status value (§51). The suites that assert absence still pass.
