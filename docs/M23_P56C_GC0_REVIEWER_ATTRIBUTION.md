# M23 P5.6C — G-C0: attributed Trust & Safety reviewer identity

**Status: CLOSED.** G-C0 was the P5.6A/P5.6B blocking gate: ScoutBox had no way to
record *who* made an authoritative compliance decision. Every prior lane used the
shared admin key, so a decision was, in the record, anonymous. P5.6C could not be
declared complete while that remained true, because every other mechanism here —
verifying a licence facet, resolving a dispute, confirming a declared
representation, settling an uncertain rule — ends in a human decision that must
carry a name.

## What was wrong

- The Trust & Safety console authenticated with `x-admin-key`, a **shared secret**.
  Anyone holding it was indistinguishable from anyone else holding it.
- M14 review actions recorded an actor of `{ kind: 'system' }` or a bare label.
  There was no reviewer record to point at, no role, and no way to revoke one
  person's access without rotating the key for everybody.
- A shared key cannot express dual control, so no decision could be split across
  two people by construction.

## What P5.6C does

### A reviewer is a record, not a header
`db.tsReviewers` (migration 2306) holds `{ id, name, role, status, secretHash,
createdAt, createdBy, revokedAt, revokedBy, rev, history }`. `role` is one of
`trust_safety_reviewer` or `trust_safety_admin`. Secrets are stored as scrypt
hashes through the same `hashPassword`/`verifyPassword` adapters the rest of the
platform uses; no plaintext secret exists in the store, and a persistence check
asserts that (`m23AgentCompliancePersistence` §4).

### The server derives the identity; the client never asserts it
`POST /auth/reviewer/login` takes `{ reviewerId, secret }` and mints a session of
kind `ts_reviewer` in `db.sessions`. `reviewerAuth` resolves `req.reviewer` from
that session alone. A request body may carry `reviewerId`, `decidedAt` or `at` —
the routes ignore all three, and the acceptance suite passes them deliberately to
prove it. The uniform refusal for an unknown id, a wrong secret and a revoked
reviewer is one code: `REVIEWER_CREDENTIALS_INVALID`.

### The shared key is read-only and non-authoritative
Every `/ts/*` route sits behind `reviewerAuth`. The shared admin key reaches:
- `GET /admin/compliance/reviews` and `GET /admin/compliance/policies` — read-only
  projections, so an operator can *see* the queue without being able to decide it.
- `POST /admin/verification/orgs/:id/appoint-root` — an M14 power that predates
  P5.6C and remains, because it records a *club's* authority, not a reviewer's.

It reaches nothing that decides a compliance question. The Trust & Safety console
says this in the UI rather than leaving it implicit: the Agents group renders a
credentialed sign-in and the sentence "This console's admin key is not a reviewer
identity."

### Legacy records are preserved as unattributed
Decisions made before P5.6C are **not** back-filled with an invented name. Where a
reviewer identity is absent, the audit projection reports the actor as
`Trust & Safety (attributed)` for a real `ts_reviewer`, and the reviewer list
carries `legacyNote` explaining that earlier shared-key actions cannot be
attributed to a person. Nothing is rewritten to look better than it was.

### Revocation is immediate and keeps the past
Revoking a reviewer sets `status: 'revoked'` and deletes that reviewer's sessions,
so an in-flight console loses the lane on its next request (`REVIEWER_REVOKED`).
Decisions the reviewer already made keep their name: attribution is history, not a
live permission. At least one active `trust_safety_admin` must remain
(`LAST_REVIEWER_ADMIN`).

### Dual control where one signature is not enough
Publishing a jurisdiction policy version takes two administrators: one proposes,
a **different** one approves (`POLICY_DUAL_CONTROL_REQUIRED` otherwise). This is
the only mechanism in P5.6C that changes what the rules *are*, so it is the only
one that requires two people.

### Where reviewers come from
- **Production:** the operator bootstrap `TS_REVIEWER_BOOTSTRAP_ID`,
  `TS_REVIEWER_BOOTSTRAP_NAME`, `TS_REVIEWER_BOOTSTRAP_SECRET`, applied once at
  boot when the store is empty. After that, an administrator provisions the rest.
- **Development only** (`DEV_LOGINS`, and only when no reviewer exists): three
  seeds — `tsr-dev-admin` (Priya Shah), `tsr-dev-reviewer` (Marcus Bell),
  `tsr-dev-admin2` (Léa Fontaine). The migration itself creates **no** reviewer:
  `m23AgentCompliancePersistence` asserts `db.tsReviewers` is empty after an
  upgrade, so no identity is ever invented by a schema step.

## What a reviewer may and may not do

A reviewer resolves **facts**: a reference that no register can confirm, a
disputed relationship, an entity representation with no ScoutBox agreement,
evidence that settles a missing fact. Two refusals bound that power:

| Situation | Refusal |
|---|---|
| The snapshot is `PROHIBITED_CONFLICT`, or a reason is `PROHIBITED_COMBINATION` / `COMBINATION_NOT_PERMITTED` under an ACTIVE rule | `REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE` (409) |
| A conflict item turns on a rule whose operative status is uncertain or unencoded | `REVIEW_REQUIRES_POLICY_VERSION` (409) |

An approval must cite at least one evidence reference. A decided item is never
edited: reconsideration creates a **new** review that `supersedes` the old one,
and the original decision object is retained untouched.

## Verification

- `m23AgentComplianceE2E` group A/B: 18 checks on identity, the shared key, wrong
  secrets, revocation mid-session, the last-administrator floor, and the absence
  of any secret hash in a response.
- `m23AgentCompliancePersistence` §2/§3/§4: the migration invents no reviewer; a
  migrated item is resolved by a named reviewer and the attribution is on disk;
  reviewer rows hold a hash and never a plaintext secret; a reviewer session
  survives a restart.
- `m23AgentComplianceLive` group C: the console's own sign-in, the shared key
  getting no lane, an evidence-less approval refused, and a decision attributed by
  name and role in the real browser.
