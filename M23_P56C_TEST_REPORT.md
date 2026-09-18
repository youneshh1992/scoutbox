# M23 P5.6C — test report

Every number here was produced by running the suite named, at the tip this report
was written against. Where a suite's own summary prints a count, that count is what
appears below.

## New suites

| Suite | Checks | Negative | What it proves |
|---|---:|---:|---|
| `scoutbox-server/scripts/m23AgentComplianceE2E.mjs` | 345 | 193 (56%) | The whole compliance contract: reviewer identity, the policy engine, the conflict engine, consents, reviews, minors, error and privacy contracts, plus 30 numbered adversarial cases. |
| `scoutbox-server/scripts/m23AgentCompliancePersistence.mjs` | 83 | 23 (28%) | Schema 2306 as one step; upgrade from a 2305 snapshot; a real boot over it; a clean-boot round trip; corruption contained. |
| `e2e/m23AgentComplianceLive.test.mjs` | 86 | 25 (29%) | The real interfaces, four surfaces, one backend, zero page errors. |

The acceptance suite exercises the pure engines directly (no server) for the parts
that must be exhaustive — the England matrix, every consent-insufficiency reason,
severity ordering, hash determinism — and over HTTP for everything a route decides.

### `m23AgentComplianceE2E`, by group

| Group | Subject |
|---|---|
| A, B | G-C0: credentialed reviewer login, server-derived identity, no secret in any response, revocation mid-session, the last-administrator floor, the shared key refused |
| C, D | Policy versions: selection, effective windows, rule status, overrides, missing jurisdictions; runtime publication under dual control (C14–C26) |
| E, F | The structured policy decision and facet gates, per jurisdiction |
| G, H, I, R | The provider over HTTP: every state, `UNAVAILABLE` writing nothing, a real reference to attributed review, the full review lifecycle including supersede and cancel |
| J–O | The conflict engine: the England matrix, uncertain rules, connected agents, other-services presumption, contexts and representations end to end |
| P, L, S, T | Consents: request preconditions, both lanes, both acknowledgements, the append-only ledger, revocation, races, party changes, the prohibition that cannot be recorded |
| U, V, W | Minors: encoded timing, the closed pathway, invisibility to lookup, the uniform 404, forged dob and guardian flags |
| X, Y, Z | Privacy and permissions: uniform not-found, the error whitelist, the 192-refusal sweep, role boundaries |
| AA–AJ | Concurrency, idempotency, events, notifications, metrics, audit, tombstones |
| #1–#30 | The numbered adversarial cases |

### `m23AgentComplianceLive`, by group

| Group | Journey |
|---|---|
| A | Ana signs in; the compliance screen's provider honesty, policy versions, facet freshness, closed minors pathway |
| B | A context opens CLEAR; one party recorded stays CLEAR; the club with no agreement is refused into attributed review with its id shown |
| C | The admin key gets no reviewer lane; Marcus signs in; an evidence-less approval is refused; with evidence the decision is attributed by name and role |
| D | The clearance becomes PERMITTED_WITH_CONSENT; the ask enters the ledger naming the party role and policy versions |
| E | Kola sees who asks, for what, with whom, and that he may decline; granting is blocked until both acknowledgements; he grants |
| F | Maria, Eastport's recorded signatory, grants for the club; the clearance becomes CLEAR and says why |
| G | Kola revokes; the agent's clearance reopens naming it as revoked; the ledger keeps both rows |
| N1–N9 | The prohibited refusal recording nothing, no invented review, the wording sweep, 390/360, labels, FR, the minor's absent card, the non-signatory club user, the attributed audit feed |

## Regression battery

All green at this tip.

| Suite | Result |
|---|---|
| `m23BootContract` | passed |
| `m182E2E` | passed |
| `m181E2E` | passed |
| `m23Persistence` | 67 checks, 20 negative |
| `m23TrialPersistence` | passed |
| `m23DecisionPersistence` | passed |
| `m162E2E` | passed |
| `m17E2E` | passed |
| `m18E2E` | passed |
| `m23E2E` | passed |
| `m23ContactE2E` | passed |
| `m23TrialE2E` | passed |
| `m23DecisionE2E` | passed |
| `m23AgentE2E` | passed |
| `m23AgentPersistence` | passed |
| `navConfig` | 346 checks (the agent workspace's seventh destination and its deep links) |
| `m23AgentDemoSpotcheck` | passed, zero page errors — extended to cover the compliance screen, a context journey and the whole Trust & Safety console in the demo artifacts |
| `m23AgentLive` | 82 checks, 25 negative |
| `m23ContactLive` | 82 checks, 33 negative |

## Builds and typechecks

Five apps, each `tsc --noEmit` clean and each building: `scoutbox-agent`,
`scoutbox-admin`, `scoutbox-club`, `scoutbox-grassroots`, `scoutbox-player`.
Demo artifacts rebuilt from this tip.

## What the browser suite found that the server suite did not

Two defects, both closed, both now guarded in **both** layers:

1. **A prohibited combination was recordable** as "declared, pending review", because
   review outranked prohibition in the severity order. The server suite only exercised
   the ordering where the individual was declared second, which was refused correctly.
   The browser journey declared the entity second and caught it. (Defect C14.)
2. **The item a reviewer was deciding vanished mid-decision** when starting it moved it
   out of the status filter, unmounting the form with the typed reason and evidence in
   it. No server check could see this; it is purely a rendering-and-state defect.
   (Defect C15.)

This is the argument for keeping the live suite: it is not a duplicate of the
acceptance suite at a slower speed, it reaches states the acceptance suite's call
order does not.

## Coverage the suites deliberately do not claim

- **Live register integrations.** There are none, so nothing tests them. The provider
  is tested for being honest about their absence.
- **A live minor pathway.** Closed everywhere; the suites test that it is closed.
- **Legal correctness of the encoded rules.** The suites test that ScoutBox applies
  what it encoded, with the status it recorded. Whether that encoding matches a
  regulator's current position on a given day is a question for the people who
  publish the version, which is why publication is attributed and dual-controlled.
- **Load and perf.** No P5.6C perf suite exists; the engine is pure and the
  projections are small, but that is an argument, not a measurement.
