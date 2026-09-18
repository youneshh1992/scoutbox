# M23 P5.6C — implementation

What was built, where it lives, and how it attaches to what already existed.

## Modules

| File | Role |
|---|---|
| `m25/policyVersions.mjs` | The encoded jurisdiction versions, as data: rule ids, operative status, text status, source references, parameters, overrides. |
| `m25/policy.mjs` | Pure: version selection, policy sets, rule lookup with status, scope resolution, the structured policy decision, facet gaps, the minor gate, representation scope. |
| `m25/conflict.mjs` | Pure: the conflict engine, consent sufficiency, outcome severity, canonical input hashing. |
| `m25/provider.mjs` | The verification provider abstraction and the local synthetic test provider. |
| `m25/errors.mjs` | The status table (null-prototype) and the public error body whitelist. |
| `m25/audit.mjs` | Compliance audit rows and the attributed reviewer decision record. |
| `m25/index.mjs` | `registerCompliance(ctx)`: reviewer identity, policies, facets, contexts, consents, reviews, projections, routes. |

Purity is not decorative: `policy.mjs` and `conflict.mjs` are imported directly by the
acceptance suite and exercised without a server, which is how the England matrix and
every consent-insufficiency reason are tested exhaustively.

## Stores and the migration

Migration `m250_001_compliance_stores`, schema **2306** — the schema was advanced
exactly once, and `m23AgentCompliancePersistence` §1 asserts there is exactly one step
above 2305 and nothing above 2306.

Five stores, each `migration`-guaranteed in `storeContract.mjs` and listed in
`PRODUCTION_REQUIRED_STORES`: `tsReviewers`, `jurisdictionPolicies`,
`regulatoryReviews`, `regulatoryConsents`, `complianceContexts`.

The step also, idempotently and without destroying anything:
1. seeds the three P5.6A policy versions as **published** rows attributed to
   `migration 2306`;
2. gives every agent profile an **empty** `domestic_authorisation` container;
3. raises one PENDING review item for each facet already sitting in
   `MANUAL_REVIEW_REQUIRED` and each relationship already `disputed`, requested by
   the migration, started and decided by nobody.

It invents no reviewer identity. Re-running it, including a partially-applied re-run
where the stores exist but the step record is missing, creates nothing twice.

## The fourth facet

P5.6A DR-53: a licence is not a national registration, and neither is a domestic
authorisation. `FACETS` is now four — `fifa_licence`, `national_registration`,
`domestic_authorisation`, `minors_authorisation` — each with its own state,
provenance and re-check window. The USA version requires the domestic one
(background check); England does not.

## The provider abstraction

`createVerificationProvider({ synthetic })` returns one of two providers:

- **`none`** (production today): every real reference answers
  `MANUAL_REVIEW_REQUIRED` with the note that it is queued for attributed review.
- **local synthetic test provider** (`AGENT_VERIFICATION_TEST_PROVIDER=1`, never in
  production): `TEST-VERIFIED-`, `TEST-INACTIVE-`, `TEST-STALE-`,
  `TEST-UNAVAILABLE-`, `TEST-NOTVERIFIED-` prefixes drive each state.

States: `VERIFIED`, `NOT_VERIFIED`, `INACTIVE`, `STALE`, `UNAVAILABLE`,
`MANUAL_REVIEW_REQUIRED`. Two rules matter more than the list. **`UNAVAILABLE` never
permits**: a provider outage answers 503 and writes nothing, so an outage cannot be
mistaken for a pass. And a `STALE` facet is told to the agent once, through a
`compliance` notification, rather than silently degrading.

## Contexts

A compliance context is the **minimal** record an evaluation needs: type,
jurisdictions, parties (role, kind, id), the agent's representations, the evaluation
history, and a rev. It is explicitly not a Transaction Room — no terms, no offer, no
fee, no negotiation, no signing — and its own projection says so in a field the UI
renders.

The regulated act is `POST …/representations`. Its pipeline, in order: idempotency →
rate limit → profile → party visibility and blocks → agreement → scope and status →
facet gate per jurisdiction → conflict engine with the proposal included → consent →
insufficient data → attributed review → rev → mutate → audit → event. A refusal at
any step records **nothing**, and the suite checks the store afterwards to prove it.

## Reviews

Four kinds: `verification_facet`, `representation_dispute`, `representation_declared`,
`conflict_evaluation`. Statuses: `PENDING`, `IN_REVIEW`, `APPROVED`, `REJECTED`,
`CANCELLED`, `SUPERSEDED`. A decision carries the reviewer's id, name and role, a
reason code, a written reason, evidence references and the resulting state. Approvals
require evidence. Decided items are superseded, never edited. Closing a context
cancels its open items rather than orphaning them.

## Wiring into the existing platform

- `server.mjs` creates one provider and passes it to both the agent and compliance
  modules; mounts `/ts` behind `reviewerAuth` (503 until the module is registered);
  sets `req.reviewer` for a `ts_reviewer` session in the admin middleware; merges the
  compliance hooks into the agent module (`Object.assign(m24Ctx.hooks, m25Ctx.hooks)`);
  calls `onPlayerDeleted` from the deletion path.
- `m24/index.mjs` submits facets through the provider, gates the approach route on the
  policy decision, records policy versions on an agreement, routes a client dispute
  into the attributed lane, and merges compliance rows into the agency audit feed.
- `m14/review.mjs` reports a real reviewer as `authenticated_reviewer` instead of a
  shared-key actor.
- `m182/eventRegistry.mjs`, `notificationPrefs.mjs` (mandatory `compliance`
  category), `m181/rateLimit.mjs` and `m182/audit.mjs` gain their P5.6C entries.

## Clients

| App | Surface |
|---|---|
| `scoutbox-agent` | A seventh destination, **Conflicts & compliance**: counts, provider honesty, policy versions in effect, facet freshness with re-check, contexts with their clearance and reasons, declare and withdraw, consent requests, the consent ledger, attributed review items, minors readiness. Strict `#/compliance/<ctxId>` deep link. The fourth facet is submittable on the profile screen. |
| `scoutbox-admin` | An **Agents** group with its own reviewer sign-in, the review queue, the policy versions with dual-controlled approval, reviewer identities and the attributed decision record. |
| `scoutbox-player` | An **Agent consent** card: who asks, the agent's licence state, the transaction, the other party, two acknowledgements before granting, revoke at any time. Absent for under-18s. |
| `scoutbox-club` | The consent lane on the verification console, because only the club's recorded verification administrator can bind the club. A non-signatory reads the ask. |

EN and FR throughout, demo mirrors for each, and a refusal is always rendered from
the server's codes rather than re-derived.

## What was deliberately not built

No Transaction Room, no offer workflow, no autonomous negotiation, no fee or
commission field anywhere, no minor pathway, no live register integration, and no
route that takes a minor as a subject.
