# M23 P5.6A — Agent Store Proposal

The persistence proposal for P5.6B–D. **No schema is advanced in P5.6A**
(`schemaVersion` stays 2304; no migration is written). Each proposed store
answers the mandate's eight questions (§119): concept / existing reusable
store? / new store required? / reason / owner / tenant model / PII level /
history model.

Conventions the new stores inherit: module-registered through
`storeContract.mjs` so they exist after clean boot and upgrade (M23-D2);
append-only `history[]` in the M23 shape `{ id, at, action, by: { kind,
userId, name }, detail }`; `rev / revAt / revBy` via
`m181/concurrency.mjs`; `keys{}` for idempotency; tombstoning instead of
deletion for person-shaped fields; every regulatory record carries the
`policyVersions` it was evaluated under.

---

## 1. `agentProfiles`

| Question | Answer |
|---|---|
| Concept | The licensed natural person: one row per `userId` that claims to be a football agent, holding declared licence facts and links to the M14 claims that verify them. |
| Existing reusable store? | Partly: `db.verClaims` (M14) holds the *verification*; `db.users` holds the identity. Neither holds the agent-specific declared facts (licence number, scheme, jurisdictions, CPD window) or the `recheckAt` clock. |
| New store required? | **YES.** |
| Reason | Verification must stay claim-based (M14 contract: no account-level `verified: true`); the profile is the *subject* the claims attach to and the place the fail-honest state is projected from. Putting licence numbers on `db.users` would leak them into every org-user projection. |
| Owner | The individual (their declared facts); T&S (verification outcomes). The agency owns nothing here. |
| Tenant model | Personal: keyed by `userId`; readable by the individual, T&S, and (state only) the agency the person is affiliated to and the parties to a transaction they represent in. **Survives agency departure**: a profile is not tenanted to an org. |
| PII level | High (licence number is a personal regulatory identifier; DBS/authorisation facts). |
| History model | Append-only `history[]`; verification transitions live in `db.verEvents`; the profile stores claim ids, never claim copies. |

Shape:

```
{ id, userId, declared: { fifaLicenceNumber, fifaLicenceSince, jurisdictions: [ma], nationalRegistrations: [{ ma, ref }], minorsAuthorisations: [{ ma, ref, validUntil }] },
  claims: { fifa: claimId|null, national: { [ma]: claimId }, minors: { [ma]: claimId }, cpd: claimId|null },
  recheckAt, lastRecheckOutcome, publicProfile: { displayName, languages, bio (moderated) },
  createdAt, updatedAt, rev, revAt, revBy, history: [] }
```

## 2. `agencyAffiliations`

| Question | Answer |
|---|---|
| Concept | Membership of a person in an agency org with a tier and a window. |
| Existing reusable store? | `db.users.orgId` (one org per user, no tier, no window); `db.verAdmins` (verification RBAC, wrong domain); M14 `AGENCY_AFFILIATION` claim (evidence, not membership). |
| New store required? | **YES.** |
| Reason | Tier is authority for administrative actions and an input to connectedness (R-F15); a window (`startedAt`, `endedAt`) is needed so history stays attributed after departure and connectedness is evaluated *as at* a transaction date. `db.users.orgId` stays as the login tenant; the affiliation row is the authority record. |
| Owner | The agency (`agency_admin`). |
| Tenant model | Agency-private (`agencyOrgId`); the individual sees their own; T&S sees all. |
| PII level | Low–medium (name via `userId`, tier). |
| History model | Append-only; tier changes are new history entries; `endedAt` closes, never deletes. Invariants copied from `verAdmins`: no self-promotion, dual control for `agency_admin` transfer, last-admin protection. |

Shape: `{ id, agencyOrgId, userId, tier ∈ licensed_agent|agency_admin|analyst|assistant|finance, startedAt, endedAt|null, endedReason, evidenceClaimId|null, rev…, history: [] }`.

## 3. `representationAgreements`

| Question | Answer |
|---|---|
| Concept | The agent ↔ client mandate: proposed by a licensed agent, confirmed by the client (or guardian), scoped, termed, jurisdictioned, versioned, terminable, disputable. |
| Existing reusable store? | `db.representations` (M13 F10): agency-level, adult-only, free-text representative, 36-month cap, no jurisdiction, no legal-advice acknowledgement, no guardian path, no policy version. |
| New store required? | **YES.** `db.representations` is **not extended in place** because its keying (`agencyOrgId` as the party) is wrong for R-F1 and changing the meaning of an existing store's rows underneath M13/M162/M15/M17 readers is riskier than a migration that maps old rows into the new store as `legacy_agency_level`. |
| Reason | R-F1, R-F8–R-F11, R-E3, R-E7, R-F20–R-F22. |
| Owner | Joint: the agent (proposal, terms, agent-side termination) and the client (confirmation, withdrawal, dispute, sharing settings). Neither may edit the other's lane. |
| Tenant model | Party-scoped: `agentUserId` (personal), `agencyOrgId` (frozen at creation for the agency's business record), `clientKind/clientId`, `guardianId` for a minor. Reads by agency staff per the privacy matrix and the client's `shareWithAgencyStaff`. |
| PII level | High (a regulatory relationship; for a minor, safeguarding-relevant). |
| History model | Append-only `history[]`; `versions[]` for amendments (each version carries its own legal-advice acknowledgement); `evaluations[]` (policy outputs with versions); `status` ladder `draft → proposed → active → (expired \| terminated_by_client \| terminated_by_agent \| declined \| disputed)`; tombstone on client deletion keeps `{ id, agentUserId, agencyOrgId, clientKind, jurisdiction, startAt, endAt, terminatedAt, policyVersions, statusHistory }` (L-11 pending). |

Shape:

```
{ id, agentUserId, agencyOrgId, clientKind ∈ player|coach|club, clientId|externalRef, guardianId|null, isRegulatoryMinor,
  jurisdiction: { memberAssociation, declaredBy, confirmedByClient }, scope: [employment|transfer|commercial|other_services],
  agencyParty: boolean,                       // FA 2026-27 3.3 Guidance / 4.1(b): the agency is also a party (R-E2b, DR-45)
  agencyPerformanceConsentId: consentId|null, // all-parties written consent letting a licensed colleague perform; England only; disabled until L-9
  exclusive: boolean, startAt, endAt (≤ 24 months after startAt for player/coach), legalAdviceNotice: { shownAt, acknowledgedConsentId },
  feeTerms: { …as data, policyState } | null, documents: [evidenceId], shareWithAgencyStaff: boolean,
  status, proposedAt, confirmedAt, confirmedBy: { kind, id }, terminatedAt, terminatedBy, terminationReasonCode, disputedAt,
  versions: [ { n, at, by, changes, legalAdviceAcknowledgedConsentId } ], evaluations: [ { at, inputHash, output, policyVersions } ],
  legacy: { fromRepresentationId, regulatoryStatus: 'not_regulated_record' } | null,
  keys: {}, rev, revAt, revBy, history: [] }
```

Relation to `db.representations`: read-only after the P5.6B migration;
rows copied into `representationAgreements` with `agentUserId: null`,
`legacy.regulatoryStatus: 'not_regulated_record'`, and `status` mapped
(`active` → `active` for the *player-facing* relationship only; the
authorization contract's step 6 treats `agentUserId: null` as
`REPRESENTATION_REQUIRED` for every regulated action, so a legacy row
never authorises anything). The old write routes are removed in P5.6E; the
old store is dropped from `storeContract` one milestone later.

## 4. `agentTransactions`

| Question | Answer |
|---|---|
| Concept | A regulated Transaction (FFAR Def.): parties, type, jurisdictions, terms as data, conflict evaluations, consents, correspondence. The Transaction Room's record. |
| Existing reusable store? | `db.recruitmentCases` (club-private, single-club, holds assessments/decisions links). **Not reusable** (reuse audit §17). |
| New store required? | **YES.** |
| Reason | Multi-party, multi-jurisdiction, with a consent ledger and evaluation history that must be visible to each party in its lane and never expose club-private content. |
| Owner | Opened by the agent; each party owns its lane; ScoutBox owns the evaluation history. |
| Tenant model | Party membership: `parties[].orgId` (clubs) / `clientId` (individuals) / `representations[].agencyOrgId`; a caller must be a party or a representing agent to read; each read projects the caller's lane plus shared tabs. |
| PII level | High (financial terms, identities). |
| History model | Append-only `history[]`, `evaluations[]`, `consents: [consentId]`, `terms: { versions[] }`, `status` ladder `interest → open → terms_recorded → completed \| withdrawn \| closed`; person-shaped fields tombstoned on subject removal, ids/states/times/policy versions kept. |

## 5. `transactionRepresentations`

| Question | Answer |
|---|---|
| Concept | Who represents which party in a given Transaction, backed by which agreement. |
| Existing reusable store? | None. |
| New store required? | **YES**, as a separate store rather than an array on the transaction. |
| Reason | The Conflict Engine's unit of evaluation is the (agent, party role, transaction) triple, including connected agents; England's tripartite exception (FA 4.4) and `declaredOnly` entity representations need their own status and evidence; a separate store makes "one row per representation with its own rev and history" cheap to reason about and to tombstone. |
| Owner | The representing agent (creation), the party (acknowledgement). |
| Tenant model | Follows the transaction's party membership. |
| PII level | Medium. |
| History model | Append-only; `status ∈ declared \| verified \| withdrawn`; `declaredOnly` rows carry the review id that resolved them. |

Shape: `{ id, transactionId, agentUserId, agencyOrgId (as at), partyRole, agreementId|null, declaredOnly, declaredEvidenceId|null, status, reviewId|null, createdAt, withdrawnAt, rev…, history }`.

## 6. `regulatoryConsents`

| Question | Answer |
|---|---|
| Concept | The consent ledger: `dual_representation`, `agency_performance` (FA 2026-27 R-E2b; all parties to the agreement; England only), `guardian_approach`, `guardian_agreement`, `legal_advice_ack`, `client_staff_sharing` (the `shareWithAgencyStaff` change as a consent so it is attributable and revocable). |
| Existing reusable store? | Box Cam / Combine consent lives on player prefs (`boxPrefsFor`), M14 tokens are single-use; neither is a ledger. |
| New store required? | **YES.** |
| Reason | Consents must be advance, attributable, revocable, versioned by policy and provable in order (R-F13 "prior written consent", R-F20 "prior written consent", R-F10 legal-advice acknowledgement). A ledger row is the only shape that supports "was this consent in force at time T under policy V". |
| Owner | The granting person (client, guardian, club signatory). |
| Tenant model | Subject-scoped: readable by the grantor, the counterparty named on the record (state only for some kinds; matrix row 5), T&S. |
| PII level | High for guardian kinds (links a guardian to a minor's regulatory relationship). |
| History model | **Append-only, never edited**: revocation is a new row `{ kind: revocation, of: consentId }`; the ledger is the history. `policyVersions` on every row. |

Shape: `{ id, kind, subject: { kind, id }, grantedBy: { kind, id, displayName }, counterparty: { agentUserId, agencyOrgId }, transactionId|null, agreementId|null, partyRole|null, particulars: { fullParticularsProvided, legalAdviceOffered, wording: evidenceId|null }, grantedAt, expiresAt|null, policyVersions, of|null, keys, history }`.

## 7. `jurisdictionPolicies` (seventh; not PII)

| Question | Answer |
|---|---|
| Concept | The versioned policy layer (A-1). |
| Existing reusable store? | `m162/shared.mjs` `POLICY` with `TRUST_SCORE_POLICY_VERSION` is the pattern (versioned policy as data), but it is code, not a store. |
| New store required? | **YES** (data, not code, because circulars and judgments change states without a deploy; C7). |
| Reason | R-F16, L-1, L-7, P-7. |
| Owner | T&S root, dual control. |
| Tenant model | Global, read by every evaluation. |
| PII level | None. |
| History model | Immutable versions; a new version is a new row with `supersedes`. |

Shape: `{ id: 'jp-<jurisdiction>-<season>-<n>', regulator, jurisdiction, effectiveFrom, effectiveTo|null, policyVersion, supersedes|null, rules: { [ruleId]: { ruleStatus ∈ ACTIVE|SUSPENDED|PARTIALLY_SUSPENDED|JURISDICTION_OVERRIDE|PENDING_IMPLEMENTATION|UNDER_LEGAL_REVIEW|UNKNOWN, params, sourceRef: [ { source, version, effectiveDate, retrievedDate, url } ], note } }, publishedBy: [reviewerA, reviewerB], publishedAt }`. A rule that exists in source text while its enforcement is suspended is a row with `ruleStatus: SUSPENDED` (or `UNDER_LEGAL_REVIEW` when the suspension's own status is unsettled), never a deleted row. Initial versions: `jp-fifa-2025-1`, `jp-eng-2026-27-1`, `jp-usa-2024-1` (contents in the authorization contract §5.3).

## 8. Stores considered and rejected

| Candidate | Decision |
|---|---|
| `agentProspects` (CRM rows) | **Merged into an agency-private list on `agencyAffiliations`' org**: proposal is a small `agencyProspects` store `{ id, agencyOrgId, playerId, addedBy, addedAt, note (moderated), removedAt }` — adult only, grants nothing; listed here so it is not forgotten; PII low; append-only. |
| `agentNotes` | Part of `agencyProspects` / an `agencyClientNotes` store keyed by `agreementId`; agency-owned (DR-26). |
| `agentInvoices` | `db.invoices` already exists for org billing (`/admin/invoices`); agency fee invoices are a different concept (agent → client / club) and get `agencyInvoices` in P5.6D, data only. |
| An Offer store | Out of scope (§195). |
| Extending `db.representations` in place | Rejected (see §3). |

## 9. Existing stores touched by P5.6B (additive only)

| Store | Change |
|---|---|
| `db.orgs` | `platform` field; validation of `type`. |
| `db.verClaims` | licence subtypes in `metadata.scheme`; `recheckAt`. |
| `db.verEvidence` | new subject kinds; `parties_only` visibility. |
| `db.requests` | new `type: 'representation_proposal'` routed like any other. |
| `db.notifications` | new types mapped to categories. |
| `db.blocks` | unchanged. |
| `storeContract.mjs` | the seven new stores plus `agencyProspects`, guaranteed at boot and on upgrade (M23-D2 rule). |

## 10. Migration sketch (P5.6B, `schemaVersion 2305`)

1. Create the eight containers if absent.
2. For each `db.orgs` row with `type === 'agency'`: set `platform: 'agent'`.
3. For each `db.representations` row: insert a `representationAgreements`
   row as described in §3 with `legacy` set; leave the source row in place.
4. Seed `jurisdictionPolicies` with `jp-fifa-2025-1` and
   `jp-eng-2026-27-1` (FA 2026-27, in force 1 Jun 2026) from the
   currency-closed snapshot's rule statuses, sources and retrieved dates;
   `jp-usa-2024-1` with every rule `UNKNOWN` except licence, background
   check and SafeSport.
5. Boot contract test (`m23BootContract` pattern) asserts all eight exist
   on a clean boot and after upgrade from 2304.
