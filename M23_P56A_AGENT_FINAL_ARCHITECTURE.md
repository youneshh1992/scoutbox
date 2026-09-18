# M23 P5.6A — ScoutBox Agent Final Architecture

The frozen architecture for the ScoutBox Agent product, assembled from the
twelve sibling P5.6A documents. Nothing described here is built at the
P5.6A tip; the phase plan (§10) says what each later phase builds. Where a
choice depends on a regulatory uncertainty, the snapshot's uncertainty
register (`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md` §9) and the
legal-review items (§8 there) govern; this document does not restate them
as settled.

---

## 1. One sentence

ScoutBox Agent is a **compliance-first workspace for licensed football
agents and their agencies**, built on the existing ScoutBox server as a
third platform beside Pro and Grassroots, in which every regulated act is
attributable to one verified natural person, authorised by a
client-confirmed agreement, evaluated against a versioned jurisdiction
policy and a conflict engine, and in which no Player, Club, Trial or
Decision privacy boundary that exists today is weakened.

## 2. Entity diagram

```
                 ┌──────────────────────┐
                 │  jurisdictionPolicies │  (versioned; FIFA + per-MA; states in_force/suspended/doubtful/not_encoded)
                 └──────────┬───────────┘
                            │ read by every evaluation
   ┌──────────┐   affiliated ┌──────────────┐  tier      ┌──────────────────┐
   │ db.orgs  │◄────────────│ agencyAffil. │──────────► │ db.users (agent) │
   │ type=    │             └──────────────┘            └────────┬─────────┘
   │ agency   │                                                   │ 1:1
   │ platform │                                          ┌────────▼─────────┐     ┌──────────────┐
   │ = agent  │                                          │  agentProfiles   │────►│ db.verClaims │ (LICENCE subtypes, recheckAt)
   └──────────┘                                          └────────┬─────────┘     └──────────────┘
                                                                  │ agentUserId (personal)
                     client confirms / guardian confirms ┌────────▼─────────────┐
   ┌──────────┐      ◄──────────────────────────────────│ representationAgree- │───► evaluations[] (policyVersions)
   │ players  │                                          │ ments                │───► versions[]   (legal-advice ack per version)
   │ guardians│                                          └────────┬─────────────┘
   │ (clubs)  │                                                   │ agreementId
   └──────────┘                                          ┌────────▼─────────────┐
                                                         │ transactionRepresen- │  (agent × party role × transaction)
                                                         │ tations              │
                                                         └────────┬─────────────┘
                                                                  │
   ┌────────────────────┐   party membership              ┌───────▼──────────────┐
   │ engaging / releas- │◄────────────────────────────────│  agentTransactions   │───► evaluations[] (Conflict Engine)
   │ ing club orgs      │                                 │  (Transaction Room)  │───► terms.versions[] (data only)
   └────────────────────┘                                 └───────┬──────────────┘
                                                                  │
                                                         ┌────────▼─────────────┐
                                                         │ regulatoryConsents   │  append-only ledger:
                                                         │                      │  dual_representation, guardian_approach,
                                                         └──────────────────────┘  guardian_agreement, legal_advice_ack,
                                                                                   client_staff_sharing, revocation
   Unchanged, read-through only:  Passport (M15)  Trust Score (M162)  blocks  guardians  requests/Inbox  notifications
   Never reachable from any agent entity:  assessments (M12)  Recruitment Cases/Rooms (M17)  formal decisions (M23 P5)  Development plans (M21)
```

## 3. Trust-boundary diagram

```
 ┌─────────────────────────── ScoutBox server (one process, one db) ───────────────────────────┐
 │                                                                                                │
 │   Pro club app        Grassroots app        Agent app (P5.6B)        Player app     T&S console│
 │   platform=main       platform=grassroots   platform=agent           player/guardian  admin key │
 │        │                    │                    │                        │              │       │
 │        ▼                    ▼                    ▼                        ▼              ▼       │
 │   orgAuth ──────────── orgAuth ──────────── orgAuth + affiliation    playerAuth /    x-admin-key│
 │   (club org)           (grassroots org)    (agency org, tier)        guardianAuth   + reviewer  │
 │        │                    │                    │                        │              │       │
 │  ══════╪════════════════════╪════════════════════╪════════════════════════╪══════════════╪═══════│
 │        │   BOUNDARY 1: visibleToOrg (agency ∧ minor → false) — global, unchanged            │
 │        │   BOUNDARY 2: orgCanSee = visibleToOrg ∧ ¬isBlocked — every read, every product     │
 │  ══════╪════════════════════╪════════════════════╪════════════════════════╪══════════════╪═══════│
 │        │                    │                    │                                                │
 │        │                    │            BOUNDARY 3 (new): licence verified (personal)            │
 │        │                    │            BOUNDARY 4 (new): agreement active + client-confirmed    │
 │        │                    │            BOUNDARY 5 (new): policy + conflict evaluation           │
 │        │                    │            BOUNDARY 6 (new): minors pathway predicate (guardian)    │
 │        │                    │                    │                                                │
 │   club-private ──────── club-private ─────── agency-private ──── client-private ──── T&S-full     │
 │   (Cases, assessments,  (same)              (agreements, notes,  (agreements, consents,           │
 │    decisions, Rooms)                         transactions lane)   shares, blocks)                  │
 │        ▲                                          ▲                                                │
 │        └──────── never crosses ───────────────────┘   (no route, no projection, no event)         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Boundaries 1–2 exist today and are not modified. Boundaries 3–6 are
additive and apply only inside the Agent product's routes. A Transaction
Room is the one place a club org and an agency org share an object; each
sees its own lane plus the shared tabs (Parties, Representation, Conflict
outcome + codes, Consents, Terms it is party to, Correspondence, Timeline).

## 4. Data-ownership diagram

```
 Owner            Owns (authoritative writer)                                 Others may
 ───────────────  ────────────────────────────────────────────────────────  ──────────────────────────────────────────
 Player           profile, Passport, Trust inputs, shares, blocks, reports,   agent: read per matrix; never write
                  agreement confirmation/withdrawal/dispute, consents,
                  staff-sharing choice
 Guardian         the same for each minor child; guardian consents            agent: state only
 Licensed agent   agentProfiles.declared, proposals, agreement terms,         agency admin: business summary; T&S: full
                  agent-side termination, transaction lane, own notes*
 Agency           affiliations, agency documents, invoices, notes*, prospects agents: their own; clients: nothing
 Club             its Cases, assessments, decisions, Rooms, Trials, Contact,  agent: only what the player shares onward
                  its transaction lane, its dual-representation consent
 T&S              verification outcomes, review resolutions (attributed),     —
                  policy versions (dual control), block lifts
 The engine       evaluations[] (append-only, versioned)                      nobody edits
 * notes are agency records (DR-26)
```

## 5. Identity, agency, membership, verification

- **Agent = `db.users` row + `agentProfiles` row.** Personal, survives
  agency changes. Verification facets are M14 claims with subtypes;
  effective state recomputed at read time plus `recheckAt` (30 d,
  DR-6). No register integration; T&S human review against the FIFA
  directory / FA list; the `honest` string says so (DR-4).
- **Agency = `db.orgs{type:'agency', platform:'agent'}`.** Tenant for
  administrative data and the agency's business records. Never a
  licensee (R-F2).
- **Membership = `agencyAffiliations`** with tier; invariants copied from
  `db.verAdmins` (no self-promotion, dual control, last-admin).
- **Staff roles:** `licensed_agent`, `agency_admin`, `analyst`,
  `assistant`, `finance`. Only `licensed_agent` + verified licence
  performs `REGULATED_AGENT_ACTION`. The login `role` string is cosmetic.

## 6. Platform separation

`org.platform ∈ main | grassroots | agent`, stored (today it is derived
from `level`). Login refuses mismatches symmetrically
(`PLATFORM_MISMATCH`), `GET /orgs?platform=agent` lists agencies for the
Agent app only, and agency orgs lose the club-only capabilities they hold
by accident (Rooms, DR-23).

## 7. Client authority, agreements, minors

- Proposal → client (or guardian) confirmation → `active`. Nothing is
  private-readable before `active` (DR-7).
- Two-year cap for players/coaches; one agreement per pair; legal-advice
  acknowledgement per version; jurisdiction declared + confirmed.
- Termination by either side ends access instantly and keeps history;
  disputes go to T&S.
- **Minors:** the global rule stays. The pathway is guardian-first
  (DR-15), gated by the agent's verified minors authorisation for the
  applicable MA, `earliestPermittedApproachAt` (England: 1 Sep of the
  academic year of the 16th birthday; FIFA formula needs the employing
  country's first-contract age, else `INSUFFICIENT_DATA`), prior guardian
  approach consent, guardian agreement consent, all re-evaluated on every
  read and write, all failing closed. `isRegulatoryMinor` (under 18) is a
  separate predicate from `isAdult` (DR-14).

## 8. Transactions and the Conflict Engine

- `agentTransactions` + `transactionRepresentations` + consents; the
  Transaction Room's eleven tabs (mandate §60): Overview, Parties,
  Representation, Conflict, Consents, Opportunities, Documents, Terms
  (reserved for the future Offer boundary), Correspondence, Timeline,
  Compliance.
- Room roles (new, not M17's): `representing_agent`, `party_individual`,
  `party_guardian`, `party_club_signatory`, `party_club_member`,
  `agency_admin_observer`, `trust_safety`. Capabilities per role live in a
  table like `roomCan` but in the Agent module.
- The engine is pure, versioned, deterministic, with five outcomes,
  connected-agent attribution, suspended/doubtful/not_encoded handling,
  Other Services presumption and Interests; T&S resolutions require a
  declared reviewer (DR-29).

## 9. Privacy, events, notifications, audit, analytics

- Matrix: `M23_P56A_AGENT_PRIVACY_MATRIX.md`; invariants become test
  group L. Rows 9 (assessments) and 10 (decisions) are absolute: no agent
  column ever.
- Events: seven (§135), `org_private` + `payload.orgId`, none
  analytics-eligible; registry entries + `EMITTED_EVENTS`.
- Notifications: existing `notify()` with new types in a `representation`
  category and a mandatory `compliance` category.
- Audit: `/org/audit` gains agent action sets; `safeDetail` never carries
  fee terms, note bodies or reason prose.
- Analytics: no agent analytics in P5.6B–D; if added later, a separate
  context that never reads club-private stores; no ranking.

## 10. Phase plan

| Phase | Scope | Exit gate |
|---|---|---|
| **P5.6B — Agent core app** | B1 agent identity (`agentProfiles`) + agency tenancy (`platform`, `agencyAffiliations`, tiers, invariants) + migration 2305; B2 verification facets on M14 (subtypes, `recheckAt`, fail-honest states, T&S review queue) and the compliance dashboard; B3 representation agreements (propose → confirm → active → terminate/dispute; versions; legal-advice ack; jurisdiction; legacy migration of `db.representations`); B4 Clients workspace (Overview, Representation, Career/Contract as declared, Documents, Activity; Opportunities/Trials/Transactions read-through where the client shared); B5 Inbox integration (`representation_proposal` request type; player + guardian response; notifications); B6 Opportunities read-through; B7 `scoutbox-agent` shell + nav (six sections, §11) + EN/FR + 390/360 + a11y + demo mode; B8 Player/Club integration (player "My Agent" view, staff-sharing consent, share-with-agent controls, report `targetKind: agent`; club app refuses agency logins; `representation` nav item leaves the club app); B9 `m24AgentE2E`, persistence, boot contract, perf, `m24AgentLive`, fresh-clone recovery, docs. **No minors pathway routes** in B (the predicate and policy data exist; routes are C). | groups A–D, K, L, O, P, Q, R green; zero-defect gate; every existing suite green |
| **P5.6C — Conflict & compliance engine** | `jurisdictionPolicies` store + dual-control publish; policy evaluation (§18 output); Conflict Engine (pure) + `evaluations[]`; minors gate + guardian consent routes (groups H, I, J); T&S review queue with per-reviewer attribution (prerequisite); `m24ConflictE2E`, `m24MinorsE2E`. | groups E–J, N, S green; L-1/L-4/L-6 status re-checked against the snapshot before enabling any non-England overlay |
| **P5.6D — Transaction workspace** | `agentTransactions`, `transactionRepresentations`, Transaction Room (tabs, roles, lanes), consent requests/grants, terms as data, agency invoices (data only), Document Vault visibility `parties_only`, club-side party routes and signatory flag. **No Offer Workflow.** | group M green; matrix invariants re-run with clubs in the Room |
| **P5.6E — Parity integration** | Contact channel binding to a verified counterparty; `player.agentName` replaced by the confirmed agreement; Trial/opportunity share-with-agent flows; club Case one-way link; removal of the M13 F10 write routes; parity checklist (§12) signed off. | parity definition met; batteries green; bundle + fresh clone |

## 11. Navigation proposal (Agent app)

Six top-level sections, matching the mandate's audit (§111): **Home**
(action centre: verification state, pending confirmations, reviews,
stale licences), **Clients** (list → client tabs: Overview,
Representation, Career/Contract, Opportunities, Trials, Transactions,
Documents, Activity), **Opportunities**, **Transactions** (list →
Transaction Room), **Inbox**, **Agency** (tabs: Team, Licensed Agents,
Compliance, Agreements, Documents, Finance, Audit, Settings). Role
filtering is convenience only; the server stays authoritative
(`nav.ts:7-10` pattern). `navConfig`'s loop gains the Agent app's
`nav.ts` + `i18n.ts`; section count 6 pinned.

## 12. Product-parity definition (§183)

The Agent app reaches parity when each of the following holds and is
tested: canonical auth (Bearer sessions, `orgAuth`, MFA nudge);
persistence through `storeContract` with boot-contract test and migration;
roles via `agencyAffiliations`; tenant isolation (404 for foreign
resources, matrix group L); `rev` + 409 conflict UX (`conflict.tsx`
pattern); idempotency keys on every mutation; rate policies registered;
events in the registry with `EMITTED_EVENTS`; notification types mapped;
audit projection; EN/FR dictionaries complete (navConfig check); 390/360
layouts; keyboard + screen-reader pass; demo mode with fixtures; live
browser suite; fresh-clone recovery documented and exercised.

## 13. What P5.6A fixed and what it did not

- Fixed: D-P56A-1 (Trust Score agency-relationship keying and lifecycle),
  `m162/trust.mjs`, regression in `m162E2E`.
- Documented, not fixed (not §186-eligible, or belongs to a later phase):
  unvalidated `org.type`; free-text `representativeName`; cosmetic
  `'Agent'` role string; `representation` withdraw notification addressed
  to the first agency user; unreachable grassroots `AgencyWall` copy;
  `trust_safety_only` SSE audience unreachable; T&S shared key without
  per-reviewer identity (pre-existing, becomes a P5.6C prerequisite);
  `db.representations` 36-month cap vs the two-year rule (legacy lane,
  migrated in P5.6B, no regulated authority flows from it today or after).
