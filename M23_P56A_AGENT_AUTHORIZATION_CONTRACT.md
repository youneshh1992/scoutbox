# M23 P5.6A — Agent Authorization Contract

The authorization model every Agent route (P5.6B onward) implements, in
the order the mandate fixes (§132) and with the error families it names
(§134). This is a contract, not code: nothing here exists in the tree at
`669d060` beyond the seams it names.

Conventions: refusals use the M23 domain-error shape (`sendDomainError`,
`m23/errors.mjs`; public fields limited to `PUBLIC_ERROR_FIELDS`), status
403 for authorization refusals, 404 for concealed resources, 409 for state
conflicts, 422 for policy outcomes that need a further act (consent,
guardian), 503 for provider failure that must fail closed.

---

## 1. Actors

| Actor | Identity | Source of authority |
|---|---|---|
| **Licensed agent** | `db.users` row, `orgId` = an agency org, `agencyAffiliations.tier = licensed_agent`, `agentProfiles` row with a licence claim whose effective status is `verified` and whose `recheckAt` has not lapsed | Personal. Never derived from the agency. |
| **Agency admin / analyst / assistant / finance** | `db.users` row + `agencyAffiliations.tier` | Administrative only. |
| **Client** | player (adult) / coach / guardian (for a minor) | Their own account. |
| **Engaging / releasing club user** | existing org user of a club org, with `roomCan`-style rights inside a Transaction Room only | Club side of a shared workflow. |
| **Trust & Safety** | `x-admin-key` + declared reviewer | Compliance only. |
| **The engine** | code, versioned policy | Evaluations, never mutations of client data. |

A **session flag never grants regulated authority**: `req.body.role`,
`user.role`, `isLead`, `org.verified`, `org.trustedPartner` are all read as
labels only.

## 2. The order (fixed)

Every Agent route applies these steps in this order and stops at the first
refusal. Later steps never run for a caller that failed an earlier one, so
a refusal can never reveal more than the step it failed at.

```
1 authenticate            → 401 (no/invalid Bearer)              existing orgAuth / playerAuth / guardianAuth
2 resolve individual      → 401/403 (removed user, suspended org) existing orgAuth
3 resolve agency membership → 403 AGENCY_MEMBERSHIP_REQUIRED     agencyAffiliations (active row, tier)
4 conceal foreign resource → 404 NOT_FOUND                        tenant check: resource.agencyOrgId === req.org.id, or party membership for shared objects
5 verify licence (regulated only) → 403 AGENT_NOT_VERIFIED | AGENT_LICENCE_INACTIVE | AGENT_NATIONAL_REGISTRATION_REQUIRED | AGENT_MINOR_ACCREDITATION_REQUIRED
6 verify representation scope → 403 REPRESENTATION_REQUIRED | REPRESENTATION_EXPIRED | REPRESENTATION_SCOPE_INSUFFICIENT
7 evaluate policy / conflict → 422 DUAL_REPRESENTATION_CONSENT_REQUIRED | GUARDIAN_CONSENT_REQUIRED | REGULATORY_REVIEW_REQUIRED ; 403 REPRESENTATION_CONFLICT | TRANSACTION_CONFLICT | MINOR_APPROACH_NOT_PERMITTED ; 503 REGULATORY_PROVIDER_UNAVAILABLE
8 evaluate block / safeguarding → 403 NOT_VISIBLE (block, minor wall) ; moderation → 400 MODERATION_BLOCKED
9 mutate                  → rev guard (409 *_REV_CONFLICT), idempotency (200 idempotent / 409 *_IDEMPOTENCY_CONFLICT), then write, history, events, notifications
```

Why 8 comes after 7 and not before: a block or the minor wall must never
be *inferable* from a cheaper refusal. Steps 5–7 refuse on the caller's own
state (their licence, their agreement, the policy), which they already
know; step 8 is the first step whose refusal says anything about the
subject, and it says only `NOT_VISIBLE`, the same word every other product
surface uses. Steps 4 and 8 together guarantee that an agent cannot learn
whether a minor exists, whether a player blocked them, or whether another
agency represents someone, from the shape or timing of a refusal.

Which steps apply per class (`M23_P56A_AGENT_ACTION_CLASSIFICATION.md`):

| Class | Steps |
|---|---|
| ADMINISTRATIVE_ACTION | 1–4, 8 (block/visibility on any read of a player), 9 |
| REGULATED_AGENT_ACTION | 1–9, all |
| CLIENT_ACTION | 1–2 (client auth), 4 (own resource), 8 (moderation of free text), 9 |
| SHARED_WORKFLOW_ACTION | agent lane: all; club lane: 1–4 (club org + transaction party), 8, 9 |
| COMPLIANCE_ACTION | T&S auth; declared reviewer required for C5 (DR-29); 9 |

## 3. Step 5 — licence verification

`agentProfiles` carries a set of verification facets, each an M14 claim:

| Facet | Claim subtype | `verified` means | Required for |
|---|---|---|---|
| FIFA licence | `LICENCE{ scheme: fifa_agent }` | T&S reviewed the FIFA licensed-agents directory entry (R-F30) at `verifiedAt`; `recheckAt = verifiedAt + 30d` (DR-6); CPD status not adverse if known (R-F6) | every REGULATED_AGENT_ACTION |
| National registration | `LICENCE{ scheme: national_agent_registration, memberAssociation }` | T&S reviewed the MA's published list (England: FA registered list, R-E1) | every regulated action whose applicable jurisdiction set contains that MA and whose policy has `nationalRegistration: required` |
| Minors authorisation | `LICENCE{ scheme: minors_authorisation, memberAssociation }` with `expiresAt` (FA: three years, R-E5) | T&S reviewed the letter / FA confirmation | A15, A17, A18-adjacent |
| FIFA minors CPD | `LICENCE{ scheme: fifa_minors_cpd }` | T&S reviewed | A15/A17 where the applicable policy requires it (R-F21) |

Fail-honest state vocabulary (A-2), mapped to claim effective status:

| State | From | Regulated action? |
|---|---|---|
| `verified` | claim `verified`, `recheckAt` in the future | allowed at this step |
| `verification_pending` | `collecting_evidence`, `submitted`, `under_review` | **refused** `AGENT_NOT_VERIFIED` |
| `verification_stale` | `verified` but `recheckAt` lapsed | **refused** `AGENT_LICENCE_INACTIVE` with `reason: 'stale'` (fail closed; §191 "stale/suspended licence behaviour") |
| `manual_review_required` | `requires_human_review` | refused `AGENT_NOT_VERIFIED` |
| `unverifiable` | T&S could not find the entry | refused `AGENT_NOT_VERIFIED` with `reason: 'unverifiable'` |
| `suspended` / `revoked` / `expired` | those claim states | refused `AGENT_LICENCE_INACTIVE` |

There is **no** live regulator integration; the state machine says so in
its `honest` string exactly as M13 F10's credential review does today.
When a provider exists later, `REGULATORY_PROVIDER_UNAVAILABLE` (503) is
the only response to a provider failure; the cached `verified` state
remains usable **until its own `recheckAt`**, never beyond (§191
"Regulatory provider failure may silently allow action: NO").

## 4. Step 6 — representation scope

A regulated action toward a specific client requires a
`representationAgreements` row with:

- `agentUserId === req.orgUser.id` (personal, R-F1; agency membership is
  not enough, §191);
- `status === 'active'` (client-confirmed, not expired, not terminated,
  not disputed);
- `startAt ≤ now < endAt` (two-year maximum enforced at creation for
  players/coaches, R-F9/R-E3; entities may be open-ended, FFAR 12(5));
- `scope` covering the action (`employment`, `transfer`, `commercial`,
  `other_services`; an `interest` toward a club needs `employment` or
  `transfer`);
- `jurisdictionSet` containing the Transaction's applicable jurisdiction
  (an England-only agreement does not authorise a French transaction:
  `REPRESENTATION_SCOPE_INSUFFICIENT`).

Refusals: `REPRESENTATION_REQUIRED` (no active row),
`REPRESENTATION_EXPIRED` (row exists, term lapsed),
`REPRESENTATION_SCOPE_INSUFFICIENT` (row exists, scope/jurisdiction do not
cover). The one agreement-per-pair rule (R-F10, FA 4.4) is enforced at
proposal time (409 `REPRESENTATION_ALREADY_EXISTS`).

Step 6 does not apply to proposals (A14, A17): there is no agreement yet;
the policy step (7) governs them.

## 5. Step 7 — policy and conflict evaluation

### 5.1 Policy output (§18)

```
{
  allowed: boolean,
  blocked: boolean,
  requiresConsent: boolean,           // dual representation consent outstanding
  requiresGuardian: boolean,          // subject is a regulatory minor; guardian consent outstanding
  requiresMinorAccreditation: boolean,
  requiresNationalRegistration: boolean,
  requiresLegalReview: boolean,       // rule state 'doubtful' | 'not_encoded' | policy conflict
  reasons: [ { code, ruleId, state: 'in_force'|'suspended'|'doubtful'|'not_encoded', jurisdiction } ],
  policyVersion: 'jp-<ma>-<n>' | ['jp-fifa-<n>', 'jp-eng-<n>']
}
```

`allowed` is true only when every `requires*` is false and `blocked` is
false. The route maps: `blocked` → 403 with the reason's family;
`requiresConsent` → 422 `DUAL_REPRESENTATION_CONSENT_REQUIRED`;
`requiresGuardian` → 422 `GUARDIAN_CONSENT_REQUIRED`;
`requiresMinorAccreditation` → 403 `AGENT_MINOR_ACCREDITATION_REQUIRED`;
`requiresNationalRegistration` → 403
`AGENT_NATIONAL_REGISTRATION_REQUIRED`; `requiresLegalReview` → 422
`REGULATORY_REVIEW_REQUIRED` (a T&S queue item is created; nothing
proceeds). The evaluation record (input hash, output, policy version, at)
is appended to the target record's `evaluations[]` so the historical
decision preserves its policy version (§191).

### 5.2 Applicable jurisdiction

Resolved once per action and stored on the record:

- for an agreement: the member association where the client is
  registered / domiciled at signing (FFAR art. 2(3)), declared by the
  agent, confirmed by the client at confirmation; if they disagree, the
  agreement cannot activate (`JURISDICTION_MISMATCH`, 409);
- for a Transaction: the MA of the engaging entity plus the MA of the
  releasing entity plus the individual's MA; the policy set is the union,
  the **stricter applicable rule wins** and a contradiction yields
  `MANUAL_REGULATORY_REVIEW_REQUIRED` (P-7, §126);
- for a minors approach: the individual's current MA (England → FA
  formula) and, where the FIFA formula applies, the employing country —
  unknown employing country → `INSUFFICIENT_DATA` → review (L-6).

### 5.3 Versioned policy layer (A-1)

`jurisdictionPolicies` rows (`{ regulator: 'FIFA' | MA code,
effectiveFrom, effectiveTo, policyVersion, rules: { <ruleId>: { state,
params } }, sources: [...] }`). Every evaluation names the versions it
used. Publishing a new version is a COMPLIANCE_ACTION with dual control
(C7). The initial content is exactly the snapshot's verified rules with
their recorded states: FIFA 12(8)–(10) `suspended`, 14/15 `suspended`,
16(1)(b)–(c) `doubtful`, 13 `in_force`, 12(1)–(7) `in_force`; England 6.3–6.5
`in_force`, 5.1–5.8 `in_force`, 7 `in_force` (no cap), 4.7 `in_force`;
U.S. minors `not_encoded`. Nothing here is legal authority (mandate §170);
the versions carry their source URLs and dates.

### 5.4 Conflict evaluation

Delegated to the Conflict Engine (`M23_P56A_CONFLICT_ENGINE_CONTRACT.md`)
for A37, A40–A45. Its five outcomes map: `CLEAR` → continue;
`PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` → `requiresConsent`;
`PROHIBITED_CONFLICT` → `blocked` (`TRANSACTION_CONFLICT` /
`REPRESENTATION_CONFLICT`); `MANUAL_REGULATORY_REVIEW_REQUIRED` →
`requiresLegalReview`; `INSUFFICIENT_DATA` → `requiresLegalReview`.

## 6. Step 8 — block and safeguarding

- `isBlocked(playerId, agencyOrgId)` → `NOT_VISIBLE`. A block also
  suspends an active agreement's access (status stays `active` in the
  ledger; access predicate returns false; DR-28).
- `visibleToOrg(player, agencyOrg)` (S2) for every general read: minor →
  `NOT_VISIBLE`. Unchanged.
- Minors pathway predicate (§7 below) for A15–A18 only.
- Free text → `moderateOrRefuse` (`server.mjs:884-906`); grooming pattern →
  urgent report → system block, as today.
- Report against an agent (`targetKind: 'agent'`) with urgency → block
  the agency and suspend the agent's regulated actions pending T&S.

## 7. The minors invariant (new; layered, not replacing S2)

The global rule stays: **an agency organisation never sees a minor** in
discovery, search, scouting, analytics, Rooms, Contact, Trials or the
directory. The proposed additional invariant (§31 of the final report):

> A licensed agent may hold a regulatory relationship with a minor only
> through a guardian-initiated or guardian-consented pathway in which
> (a) the agent's minors authorisation for the applicable jurisdiction is
> `verified`, (b) `earliestPermittedApproachAt` for that minor under the
> applicable policy is in the past, (c) a `guardian_approach` consent
> exists before any Approach and a `guardian_agreement` consent before
> activation, (d) every one of (a)–(c) is re-evaluated on every read and
> write, and (e) any missing datum fails closed to `NOT_VISIBLE`.

`canAgentAccessMinor(agentUser, minor)` is a **separate** predicate from
`visibleToOrg` and is consulted only by the minors-pathway routes and the
client workspace for an active minor agreement. It never feeds
`orgCanSee`, so nothing outside the pathway changes. The mandate forbids
removing the global rule (§48); this contract keeps it.

`earliestPermittedApproachAt(minor, policySet)`:

- England (R-E4): 1 September of the Academic Year (1 Sep–31 Aug) in which
  the minor turns 16;
- FIFA formula (R-F20): six months before the minor may sign a first
  professional contract under the employing country's law; requires the
  employing country and its first-contract age from the policy set; if
  absent → `INSUFFICIENT_DATA`;
- stricter of the applicable set wins; none encoded → `INSUFFICIENT_DATA`
  → refused.

## 8. Error families (§134) — public shape

| Code | Status | Public fields | Notes |
|---|---|---|---|
| `AGENT_NOT_VERIFIED` | 403 | `facet`, `state` | own state only |
| `AGENT_LICENCE_INACTIVE` | 403 | `facet`, `state` ∈ stale\|suspended\|revoked\|expired | |
| `AGENT_NATIONAL_REGISTRATION_REQUIRED` | 403 | `memberAssociation` | |
| `AGENT_MINOR_ACCREDITATION_REQUIRED` | 403 | `memberAssociation` | never says who the minor is |
| `REPRESENTATION_REQUIRED` | 403 | — | |
| `REPRESENTATION_EXPIRED` | 403 | `agreementId` (own) | |
| `REPRESENTATION_SCOPE_INSUFFICIENT` | 403 | `agreementId`, `required` | |
| `REPRESENTATION_CONFLICT` | 403 | `reasons[].code`, `policyVersion` | codes only |
| `DUAL_REPRESENTATION_CONSENT_REQUIRED` | 422 | `consentsOutstanding[].partyRole` | party *roles*, not names, until each party is in the Room |
| `MINOR_APPROACH_NOT_PERMITTED` | 403 | `reason` ∈ timing\|jurisdiction\|accreditation\|pathway | never a date derived from the minor's DOB for a non-consented agent (DR-16) |
| `GUARDIAN_CONSENT_REQUIRED` | 422 | `consentKind` | |
| `REGULATORY_REVIEW_REQUIRED` | 422 | `reviewId`, `reasons[].code`, `policyVersion` | |
| `TRANSACTION_CONFLICT` | 403 | `reasons[].code`, `policyVersion` | |
| `REGULATORY_PROVIDER_UNAVAILABLE` | 503 | `retryAfter` | reserved for a future provider |
| `NOT_VISIBLE` / `NOT_FOUND` | 403 / 404 | — | unchanged wording |

`PUBLIC_ERROR_FIELDS` grows by exactly: `facet, state, memberAssociation,
required, reasons, policyVersion, consentsOutstanding, consentKind,
reviewId, agreementId`. `reasons` entries are `{code, ruleId, state}`
only; prose stays server-side.

## 9. Events (§135)

| Event | Audience | Payload (minimised) |
|---|---|---|
| `agent_verified` | `org_private` (agency) + `player_private`? no — no player | `{ orgId, userId, facet, state, at }` |
| `representation_created` | `org_private` + `player_private` (client) | `{ orgId, agreementId, playerId, state, at }` |
| `representation_terminated` | same | `{ orgId, agreementId, playerId, by: kind, at }` |
| `guardian_approach_consent_granted` | `org_private` + `guardian_private` | `{ orgId, consentId, at }` — **no playerId in the org copy** |
| `transaction_created` | `org_private` for each party org | `{ orgId, transactionId, at }` |
| `conflict_evaluated` | `org_private` (agency) | `{ orgId, transactionId, outcome, policyVersion, at }` |
| `dual_representation_consented` | `org_private` + party private | `{ orgId, transactionId, partyRole, at }` |

Each needs an `EVENT_REGISTRY` entry and an `EMITTED_EVENTS` line
(`m182/eventRegistry.mjs`, `server.mjs:4285`); the M18.2 suite fails
otherwise. None is `analyticsEligible`.

## 10. Rate limits and cooldowns

Rate-limit actions listed in the reuse audit §19; deterministic product
cooldowns: one proposal per (agent, player) per 30 days after a decline;
one guardian consent request per (agent, guardian, minor) per 90 days after
a refusal; both refused as `*_COOLDOWN` with the same body regardless of
whether the subject exists (anti-enumeration).

## 11. Tenant model

- Agency-private records: `agencyOrgId === req.org.id` on every query.
- Personal records within the agency: `agentUserId` additionally; other
  agents at the same agency see a client only per the privacy matrix
  ("Other Agent at Same Agency" column) — by default **nothing** beyond
  the client's name in the agency's client list (DR-25), because
  same-agency agents are *Connected* for conflict purposes (R-F15) and
  Chinese walls are L-4.
- Shared records (Transactions): party membership; each party sees only
  its lane's data plus the shared tabs (privacy matrix rows "transaction
  terms", "conflict result").
- Client records: the client always sees every record naming them.

## 12. Deletion and departure

- Client account deletion: agreements and consents are tombstoned (reuse
  audit §22), never deleted, pending L-11; the agent sees a tombstone
  with no name.
- Agent departure from the agency: `agencyAffiliations.endedAt`; sessions
  revoked; agreements remain the agent's (personal), `agencyOrgId` frozen
  as history; the agency loses client access the moment the affiliation
  ends; the agent regains it only under a new affiliation *and* a new
  client confirmation (DR-26).
- Licence revocation: every regulated action refused at step 5; existing
  agreements flagged `agent_licence_inactive` for the client to see;
  clients notified.

## 13. §191 answers this contract fixes

- Agency membership alone authorizes regulated agent action: **NO** (step 5 is personal).
- Agent verification alone proves client authorization: **NO** (step 6).
- Agent can add a player to CRM and thereby gain private access: **NO** (A9 is administrative; step 6 applies to every private read).
- Agent can claim representation without client/guardian confirmation and gain private access: **NO** (`active` requires A22/A18).
- Missing minor regulatory data fails closed: **YES** (§7).
- Regulatory provider failure may silently allow action: **NO** (§3).
- Current regulation re-evaluated on regulated mutation: **YES** (§5.1).
- Historical compliance decision preserves policy version: **YES** (`evaluations[]`).
