# M23 P5.6C — authorization matrix

Every row is enforced on the **server**, on every request. Client-side filtering in
any app is convenience only: hiding a destination is never authorization, and typing
a hidden route hits the same rules.

## Actors

| Actor | How the server knows | Where it comes from |
|---|---|---|
| Agency member | org session + active `agencyAffiliation` | P5.6B |
| Licensed agent | affiliation carries tier `licensed_agent` | P5.6B |
| Agency administrator | tier `agency_admin` | P5.6B |
| Player | player session | core |
| Guardian-managed player | player session + under-18 | core |
| Club signatory | `hasVerLevel(db, orgId, userId, 'verification_admin')` | M14 |
| Trust & Safety reviewer | session of kind `ts_reviewer`, role `trust_safety_reviewer` | P5.6C |
| Trust & Safety administrator | same, role `trust_safety_admin` | P5.6C |
| Shared admin key | `x-admin-key` header | legacy operator access |

## Compliance capabilities (agency side)

| Capability | Tiers |
|---|---|
| `compliance.read` | every tier (own records; an administrator also sees the agency's review items) |
| `compliance.contexts.write` | `licensed_agent` only |

An analyst, assistant, finance member or administrator can read their own (empty)
compliance state. None of them can open a context, declare a representation,
request a consent or re-check a facet: those are regulated acts, and only a licensed
agent performs them — after their own facets pass.

## Routes

### Agent workspace — `/org/agent/compliance/*`
| Route | Who | Preconditions beyond the capability |
|---|---|---|
| `GET overview`, `GET policies`, `GET contexts`, `GET contexts/:id` | `compliance.read` | own records only; a colleague's context is `CONTEXT_NOT_FOUND` (404, not 403) |
| `POST facets/:facet/recheck` | `compliance.contexts.write` | a facet must exist |
| `POST contexts` | `compliance.contexts.write` | profile exists; facet gate passes for every named jurisdiction; every party resolvable and visible |
| `POST contexts/:id/parties` | owner + `compliance.contexts.write` | context open; role not already filled; party visible and adult |
| `POST contexts/:id/representations` | owner + `compliance.contexts.write` | full pipeline: visibility and blocks → agreement → scope → facet gate → conflict → consent |
| `POST contexts/:id/representations/:repId/withdraw` | owner, own representation | — |
| `POST contexts/:id/evaluate`, `POST contexts/:id/close` | owner | — |
| `POST contexts/:id/consents/request` | owner + `compliance.contexts.write` | an **ACTIVE** rule must make consent the deciding question; party must exist |

A context is **personal to the agent who opened it**. A same-agency colleague gets
404, not 403, so the existence of a colleague's transaction is not disclosed.

### Player — `/player/agent/consents*`
| Route | Who | Refusal otherwise |
|---|---|---|
| `GET` | the player | a guardian-managed account gets `{ items: [], minor: true }` |
| `POST :id/{grant,decline,revoke}` | the player named as the subject | another player: `CONSENT_NOT_FOUND`; a minor: `COMPLIANCE_ACTION_NOT_PERMITTED` |

### Club — `/org/compliance/consents*`
| Route | Who | Refusal otherwise |
|---|---|---|
| `GET` | any user of the club named as the party | non-club org: `COMPLIANCE_ACTION_NOT_PERMITTED`; the projection reports `signatory` |
| `POST :id/{grant,decline,revoke}` | the club's recorded verification administrator | anyone else: refused; the agent: `CONSENT_NOT_FOUND` |

### Trust & Safety — `/ts/*` (all behind `reviewerAuth`)
| Route | Reviewer | Administrator |
|---|---|---|
| `GET /ts/me` | yes | yes |
| `GET/POST /ts/reviewers`, `POST /ts/reviewers/:id/revoke` | no (`REVIEWER_ROLE_REQUIRED`) | yes |
| `GET /ts/compliance/reviews`, `/:id`, `start`, `resolve`, `cancel`, `supersede` | yes | yes |
| `GET /ts/compliance/policies` | yes | yes |
| `POST /ts/compliance/policies` (propose) | no | yes |
| `POST /ts/compliance/policies/:id/approve` | no | yes, and **not** the proposer |
| `GET /ts/compliance/audit`, `/metrics` | yes | yes |

### Shared admin key
| Route | Access |
|---|---|
| `GET /admin/compliance/reviews`, `/policies` | read-only |
| every `/ts/*` route | **refused** `REVIEWER_AUTH_REQUIRED` (401) |
| `POST /admin/verification/orgs/:id/appoint-root` | permitted — records a club's authority, not a reviewer's |

## Facts the server derives and never trusts from a request body

`reviewerId` · agent licence status · any verification state · policy version ·
role or tier · agency membership · representation status · guardian relationship ·
consent timestamps · conflict result · party age or date of birth · signatory
authority.

The acceptance suite sends each of these in a body where the field name would be
plausible, and asserts the outcome is unchanged.

## Refusal codes, grouped

- **401** `REVIEWER_AUTH_REQUIRED`, `REVIEWER_REVOKED`, `REVIEWER_CREDENTIALS_INVALID`
- **403** `REVIEWER_ROLE_REQUIRED`, `AGENT_VERIFICATION_REQUIRED`,
  `AGENT_VERIFICATION_STALE`, `AGENT_LICENCE_INACTIVE`,
  `AGENT_NATIONAL_REGISTRATION_REQUIRED`, `AGENT_DOMESTIC_AUTHORISATION_REQUIRED`,
  `AGENT_MINOR_AUTHORISATION_REQUIRED`, `REPRESENTATION_REQUIRED`,
  `REPRESENTATION_EXPIRED`, `REPRESENTATION_SCOPE_INSUFFICIENT`,
  `REPRESENTATION_CONFLICT`, `MINOR_APPROACH_NOT_PERMITTED`, `SIGNATORY_REQUIRED`,
  `POLICY_DUAL_CONTROL_REQUIRED`, `COMPLIANCE_ACTION_NOT_PERMITTED`
- **404** uniform not-found: `CONTEXT_NOT_FOUND`, `PARTY_NOT_FOUND`,
  `CONSENT_NOT_FOUND`, `REVIEW_NOT_FOUND`, `POLICY_NOT_FOUND`, `REVIEWER_NOT_FOUND`
- **409** state and race: `CONTEXT_CLOSED`, `*_VERSION_CONFLICT`,
  `*_IDEMPOTENCY_CONFLICT`, `CONTEXT_PARTY_EXISTS`, `REVIEW_NOT_PENDING`,
  `REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE`, `REVIEW_REQUIRES_POLICY_VERSION`,
  `CONSENT_NOT_PENDING`, `CONSENT_ALREADY_REQUESTED`, `POLICY_VERSION_EXISTS`,
  `POLICY_NOT_PROPOSED`, `REVIEWER_EXISTS`, `LAST_REVIEWER_ADMIN`
- **422** needs something from someone: `CONSENT_REQUIRED`, `CONSENT_REVOKED`,
  `GUARDIAN_CONSENT_REQUIRED`, `REGULATORY_REVIEW_REQUIRED`,
  `JURISDICTION_UNSUPPORTED`, `COMPLIANCE_INSUFFICIENT_DATA`
- **503** honest unavailability: `REGULATORY_PROVIDER_UNAVAILABLE`,
  `POLICY_UNAVAILABLE`
- **500** `COMPLIANCE_STATE_UNKNOWN` — reached only if a stored state is
  uninterpretable; it never reads as permission.

## Rate policies

`compliance_context_write` 60/hour per actor · `compliance_consent_request` 30/hour ·
`compliance_consent_response` 30/hour · `ts_review_decision` 120/hour ·
`ts_policy_publish` 10/day.

## No pay-to-clear

No subscription, plan or payment state is read anywhere in the compliance path. The
metrics endpoint is process-only: counts and durations, no person, no ranking. An
agency cannot buy a clearance, a faster review or a different verdict.
