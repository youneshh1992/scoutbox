# M23 P5.6A — Agent Action Classification

Every action the ScoutBox Agent product could offer, classified into the
mandate's five classes (§73) with the regulatory basis for each. The class
decides which steps of the authorization order
(`M23_P56A_AGENT_AUTHORIZATION_CONTRACT.md` §2) apply and which actor may
perform it.

Classes:

- **REGULATED_AGENT_ACTION** — the action is, or is preparatory to, a
  Football Agent Service (FFAR Definitions: "representing … in negotiations
  … including preparatory communication", R-F3) or an Approach (R-F4).
  Only a **licensed natural person** with a currently verified licence, the
  required national registration, and (for the specific client) a
  confirmed representation agreement of sufficient scope may perform it,
  and only after the policy and conflict evaluation pass. Attributable to
  that person; never proxied.
- **ADMINISTRATIVE_ACTION** — agency housekeeping that touches no client
  relationship and no regulated communication: staff, settings, documents
  about the agency itself, finance records the agency already holds.
  Performed by agency staff according to tier; no licence required.
- **CLIENT_ACTION** — performed by the player, coach or guardian on their
  own side: confirming, refusing, withdrawing, consenting, sharing,
  blocking, reporting. Never performable by an agent or agency user on the
  client's behalf.
- **SHARED_WORKFLOW_ACTION** — an action inside a shared object (a
  Transaction Room, a proposal thread) where more than one party writes,
  each within their own lane; the write is regulated for the agent lane and
  a client action for the client lane.
- **COMPLIANCE_ACTION** — verification, review, escalation and policy
  decisions by Trust & Safety, or automatic evaluations by the engine.
  Never an agent's to perform on themself.

Boundary cases are marked **L-14** where the "preparatory communication"
line is a legal-review item (`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md` §8).

---

## 1. Identity, licence and agency membership

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A1 | Create an agent profile (declare FIFA licence number, jurisdictions) | ADMINISTRATIVE_ACTION | R-F1, R-F30 | the individual | Declaring is not verifying. The profile is `unverified` until C1. |
| A2 | Submit licence evidence | ADMINISTRATIVE_ACTION | R-F7, A-2 | the individual | M14 `LICENCE` claim; `document_submitted` is never authoritative. |
| A3 | Declare national registration (e.g. FA registration) | ADMINISTRATIVE_ACTION | R-E1 | the individual | Same treatment as A2. |
| A4 | Declare minors authorisation / accreditation (FA 5.6–5.7; FIFA minors CPD) | ADMINISTRATIVE_ACTION | R-F21, R-E5 | the individual | Same. Validity window (three years for the FA authorisation) stored as `expiresAt`. |
| A5 | Invite a person to the agency; set tier | ADMINISTRATIVE_ACTION | R-F2 (agency is a vehicle) | `agency_admin` | Tier ≠ licence. Setting `tier: licensed_agent` grants nothing until that person's own licence is verified. |
| A6 | Remove a person from the agency | ADMINISTRATIVE_ACTION | R-F10 (agreements are personal) | `agency_admin` | Their agreements do not transfer (assignment is L-10). Their sessions are revoked. |
| A7 | Agency settings (name, jurisdictions, MFA policy) | ADMINISTRATIVE_ACTION | — | `agency_admin` | |
| A8 | Read the agency's compliance dashboard (who is verified, what is stale) | ADMINISTRATIVE_ACTION | R-F28 (clients' duty to check; agencies reasonably want the same) | `agency_admin`, `licensed_agent` (self), `assistant` (read-only) | No client data; verification states only. |

## 2. Prospects, discovery, directory

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A9 | Add an **adult** player to the agency CRM as a prospect | ADMINISTRATIVE_ACTION | P-8 (prospect ≠ client) | any tier | Grants **no** private access (§191). The row holds the player id and public-profile fields only; `orgCanSee` re-evaluated on every read. |
| A10 | Add a **minor** to the CRM | **prohibited** | P-4, S2 | — | Refused `MINOR_APPROACH_NOT_PERMITTED` before any lookup. The only minors pathway starts at A15. |
| A11 | Search / browse adult players | ADMINISTRATIVE_ACTION | existing visibility | any tier | Same `visibleToOrg` as a club. No ranking by fee, subscription or agent. |
| A12 | Read the neutral agent directory (regulator-published facts + agent's own profile) | ADMINISTRATIVE_ACTION / public | P-6, R-F30 | anyone | ScoutBox publishes no sanctions, no client lists (R-F26). |
| A13 | Free-text message to an adult player who is not a client | **REGULATED_AGENT_ACTION** (L-14) | R-F3 "preparatory communication", R-F4 Approach | licensed agent | ScoutBox does not offer a free-text pre-agreement channel to a non-client (DR-9). The only pre-agreement communication is A14, a structured proposal. |
| A14 | Send a representation proposal to an adult player | **REGULATED_AGENT_ACTION** | R-F4 (an Approach), R-F8 (agreement precedes services), R-F12/R-E10 (exclusive-agreement window: manual review, never hard block) | licensed agent with verified licence, national registration for the client's jurisdiction, no prohibited conflict | Structured: scope, term, jurisdiction, legal-advice notice (R-F10). Creates `representationAgreements` in `proposed`; player sees it in the Inbox. Rate-limited and cooled down (§143). |

## 3. Minors pathway (lawful, guardian-controlled)

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A15 | Request guardian approach consent for a specific minor | **REGULATED_AGENT_ACTION** | R-F20 (guardian consent before Approach; timing), R-F21 (accreditation), R-E4–R-E5 (England timing + authorisation), L-6 (other jurisdictions) | licensed agent with **verified** minors accreditation/authorisation for the applicable jurisdiction, and `earliestPermittedApproachAt` ≤ now | The minor's identity is **not** disclosed to the agent by ScoutBox at this step: the request is addressed by a guardian-controlled reference (the guardian or the family initiates or accepts; see DR-15). If the policy has no encoded timing for the jurisdiction: `INSUFFICIENT_DATA` → `MANUAL_REGULATORY_REVIEW_REQUIRED` → fail closed. |
| A16 | Guardian grants / refuses approach consent | CLIENT_ACTION | R-F20 | verified guardian of that minor | Recorded as `regulatoryConsents{kind: guardian_approach}` with policy version. Refusal ends the pathway; a block is offered. |
| A17 | Send a representation proposal for a minor | **REGULATED_AGENT_ACTION** | R-F20–R-F22, R-E4–R-E6 | licensed agent, after A16 granted and still within timing | Proposal routed to the **guardian** (Scout → Parent rule). |
| A18 | Guardian confirms a minor's agreement | CLIENT_ACTION | R-F22 (guardian signature), R-E6 | verified guardian | Also records `regulatoryConsents{kind: guardian_agreement}`. The minor is notified with a contentless summary (existing minors' inbox pattern). |
| A19 | Any agency **discovery** of minors | **prohibited** | P-4, S2 | — | Unchanged; not a pathway. |

## 4. Representation agreements

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A20 | Record an agreement's terms (scope, term ≤ 2 years for players/coaches, jurisdiction, fee terms as data) | **REGULATED_AGENT_ACTION** | R-F8–R-F10, R-E3, R-E7 | licensed agent | ScoutBox does not draft or sign the legal instrument (L-3, L-12); it records terms and stores externally signed evidence. |
| A21 | Upload the signed agreement document | ADMINISTRATIVE_ACTION | R-F25 (record duty), R-E8 (lodging) | agent, or `assistant` on the agent's instruction | Uploading is housekeeping; it never activates the agreement (A22 does). |
| A22 | Client confirms the agreement in ScoutBox | CLIENT_ACTION | P-3 (stricter than law, by choice) | player / coach (adult) or guardian (minor) | Only after this is the agreement `active` and only then does the agent gain client-level access. |
| A23 | Client declines | CLIENT_ACTION | — | client | Proposal → `declined`; cooldown applies to the agent. |
| A24 | Client withdraws / terminates | CLIENT_ACTION | R-F11 (termination for just cause is the parties' matter; ScoutBox records, never adjudicates) | client | Current access ends immediately; history retained. |
| A25 | Agent terminates | **REGULATED_AGENT_ACTION** | R-F11 | licensed agent | Same effect; reason code recorded; client notified. |
| A26 | Amend scope / term | **REGULATED_AGENT_ACTION** + CLIENT_ACTION (re-confirmation) | R-F10 (legal-advice notice again on amendment) | agent proposes, client confirms | A new version; the old stays in history. |
| A27 | Dispute an agreement | CLIENT_ACTION | — | client | → T&S queue (C6). |
| A28 | Record a legal-advice acknowledgement | CLIENT_ACTION | R-F10 (12(4)(a)–(b)), FA 4.5 | client | `regulatoryConsents{kind: legal_advice_ack}`. |
| A29 | Assign / novate an agreement to another agent | **not built** | L-10 | — | Refused `REGULATORY_REVIEW_REQUIRED` until counsel answers L-10. |
| A29b | Perform services for a client under a colleague's agency-party agreement (England, FA 2026-27 reg. 4.1(b)) | **REGULATED_AGENT_ACTION** | R-E2b; L-9 | a licensed, FA-registered colleague at the same agency, with all parties' `agency_performance` consent | Modelled (DR-45); England national scope only; **disabled in production until L-9**; performer recorded per act. |
| A29c | Record the `agency_performance` consent | CLIENT_ACTION (client / guardian) + SHARED_WORKFLOW_ACTION (club party) | FA 3.3 Guidance, 4.1(b)(ii) | every party to the agreement | Consent-ledger row; revocable. |

## 5. Client workspace (agent's view of a confirmed client)

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A30 | Read the client's Passport at `recruitment` visibility | ADMINISTRATIVE_ACTION (read) | existing M15 rule | agent named on the active agreement; `assistant`/`analyst` at the same agency only if the client's agreement `shareWithAgencyStaff: true` (DR-25) | Never `private`; wider only via the client's own share. |
| A31 | Read Trust Score summary | ADMINISTRATIVE_ACTION (read) | DR-21 | agent named on the active agreement | `pro_club` level projection. |
| A32 | Read club interest the **client shared** (trials, published feedback, opportunities) | ADMINISTRATIVE_ACTION (read) | P-3, §191 | agent named on the active agreement | Only what the player has shared through `GET /player/recruitment/shared`'s pattern; never assessments, never decisions. |
| A33 | Write private agent notes about a client | ADMINISTRATIVE_ACTION | — | agent, agency staff per tier | Moderated; never visible to the client, the club or other agencies; tombstoned with the agent's departure? No: they are agency records (DR-26). |
| A34 | Add a client's career / contract metadata (current club, contract end, release clause **as declared**) | ADMINISTRATIVE_ACTION | — | agent | Labelled declared; not a Passport fact; never merges into the Passport (Passport is player-owned, §191). |

## 6. Opportunities

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A35 | Read club opportunities visible to the client (mutual visibility, eligibility) | ADMINISTRATIVE_ACTION (read) | existing `boardFor` rule | agent on active agreement | Read-through of the client's own board; the agent does not apply. |
| A36 | Draft an application for the client to submit | SHARED_WORKFLOW_ACTION | R-F3 (representing in negotiations) | agent drafts (regulated lane); client submits (client lane) | Submission is the client's act because the existing `POST /player/opportunities/:id/apply` is player-authenticated and stays so. |
| A37 | Express interest to a club on the client's behalf | **REGULATED_AGENT_ACTION** | R-F3, R-F4 | licensed agent, active agreement with `scope` covering employment/transfer, policy + conflict evaluation CLEAR or consented | Creates a Transaction (A40) in `interest` state; goes to the club as a request with the agent named, the agreement id, and the verification state. |

## 7. Transactions (P5.6D; contract only here)

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A40 | Open a Transaction (parties, jurisdiction, type ∈ employment_contract \| transfer \| loan \| other_services) | **REGULATED_AGENT_ACTION** | R-F3, R-F13, R-F27 (art. 2 scope) | licensed agent | Conflict evaluation runs at open and on every party or representation change (C8). |
| A41 | Add a party; declare which party the agent represents | **REGULATED_AGENT_ACTION** | R-F13–R-F15 | agent | Each `transactionRepresentations` row needs an active agreement with that party (or a `MANUAL_REGULATORY_REVIEW_REQUIRED` entry for entity clients without a ScoutBox record, DR-18). |
| A42 | Request dual-representation consent | **REGULATED_AGENT_ACTION** | R-F13 (12(8)(a)), R-E7 (6.3) | agent | Only where the engine returned `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED`. |
| A43 | Grant dual-representation consent | CLIENT_ACTION (individual) / SHARED_WORKFLOW_ACTION (engaging entity user) | R-F13, R-E7 | the individual client (or guardian); the club's authorised user | Recorded per party, in advance, with the policy version; never assumed from silence. |
| A44 | Record transaction terms (fee, payer, instalments) as data | **REGULATED_AGENT_ACTION** | R-F24 (suspended), R-E9 | agent | No validation of caps (P-5); the ledger records each applicable rule's `ruleStatus` (`ACTIVE`, `SUSPENDED`, `PARTIALLY_SUSPENDED`, `JURISDICTION_OVERRIDE`, `UNDER_LEGAL_REVIEW`, `UNKNOWN`) and policy version. |
| A45 | Record Other Services alongside (24-month presumption) | **REGULATED_AGENT_ACTION** | R-F17 | agent | The engine flags `OTHER_SERVICES_PRESUMPTION` for review, never adjudicates. |
| A46 | Correspondence inside the Transaction Room | SHARED_WORKFLOW_ACTION | R-F3 (L-14) | each party in its lane | Moderated; regulated for the agent lane. |
| A47 | Close / withdraw a Transaction | **REGULATED_AGENT_ACTION** (agent) / SHARED (club) | — | agent or engaging club user | History retained. |
| A48 | Offer / contract negotiation workflow | **not built** | §195 | — | Out of scope. |

## 8. Documents and finance

| # | Action | Class | Basis | Actor | Notes |
|---|---|---|---|---|---|
| A50 | Upload agency regulatory documents (licence, DBS letter, insurance) | ADMINISTRATIVE_ACTION | — | individual (own), `agency_admin` (agency-level) | M14 evidence vault; `subject_only` / `organisation_internal`. |
| A51 | Record an invoice (data only) | ADMINISTRATIVE_ACTION | P-5 | `finance`, `agency_admin` | ScoutBox processes no money; no fee validation. |
| A52 | Read fee terms of an agreement | ADMINISTRATIVE_ACTION (read) | privacy matrix row "agreement fee terms" | the named agent, `finance`, `agency_admin`; the client | Never other agents, never clubs unless a party to the transaction's terms. |

## 9. Player / guardian controls (existing + new)

| # | Action | Class | Basis | Actor |
|---|---|---|---|---|
| A60 | Block an agency | CLIENT_ACTION | existing | player / guardian |
| A61 | Report an agent (individual) | CLIENT_ACTION | `targetKind: agent` (new) | player / guardian |
| A62 | Share a trial / feedback / opportunity with my agent | CLIENT_ACTION | P-3 | player (adult) / guardian |
| A63 | Revoke a share | CLIENT_ACTION | | player / guardian |
| A64 | Set "who at the agency may see my data" (`shareWithAgencyStaff`) | CLIENT_ACTION | DR-25 | client |
| A65 | Export my agreements and consents | CLIENT_ACTION | GDPR | client |

## 10. Compliance (Trust & Safety and the engine)

| # | Action | Class | Actor | Notes |
|---|---|---|---|---|
| C1 | Review a licence / registration / minors-authorisation claim against the regulator's published source | COMPLIANCE_ACTION | T&S (declared reviewer) | Human review of the FIFA directory / FA list; outcome `verified` with `recheckAt`, or `manual_review_required` / `unverifiable`. Never automatic (no register API). |
| C2 | Mark a licence suspended / expired (on evidence or at `recheckAt` lapse) | COMPLIANCE_ACTION | T&S; automatic for `recheckAt` lapse → `verification_stale` | Stale = not verified for regulated actions. |
| C3 | Evaluate policy for an action (`allowed`, `blocked`, `requiresConsent`, `requiresGuardian`, `requiresMinorAccreditation`, `requiresNationalRegistration`, `requiresLegalReview`, `reasons[]`, `policyVersion`) | COMPLIANCE_ACTION (automatic) | engine | On every regulated mutation (§191 "re-evaluated on regulated mutation: YES"). |
| C4 | Evaluate conflicts for a Transaction | COMPLIANCE_ACTION (automatic) | Conflict Engine | Five outcomes; connected agents included. |
| C5 | Resolve `MANUAL_REGULATORY_REVIEW_REQUIRED` | COMPLIANCE_ACTION | T&S with **per-reviewer attribution** (DR-29) | Result recorded with policy version; the agent still needs every other gate. |
| C6 | Handle a disputed agreement | COMPLIANCE_ACTION | T&S | Existing dispute pattern. |
| C7 | Publish / version a jurisdiction policy set | COMPLIANCE_ACTION | T&S root, dual control | Data change with its own audit event; never a code deploy. |
| C8 | Re-run conflict evaluation on party change | COMPLIANCE_ACTION (automatic) | engine | |
| C9 | Lift a block | COMPLIANCE_ACTION | T&S | Existing. |

---

## 11. What is deliberately **not** an action

- ScoutBox negotiating, advising, or choosing an agent for anyone (P-1;
  §191 "ScoutBox performs football-agent services: NO").
- Paid placement in the directory or in discovery (P-6).
- Bulk proposals / import-as-representation (P-8).
- Any agent write to the Passport, Trust Score, assessments, decisions,
  Rooms, Development plans (§191).
- Automatic reporting to the FIFA Platform or FA lodging (L-16).

## 12. Counts

| Class | Count |
|---|---|
| REGULATED_AGENT_ACTION | 16 (A13*, A14, A15, A17, A20, A25, A26, A37, A40, A41, A42, A44, A45, A47, plus the agent lane of A36/A46) |
| ADMINISTRATIVE_ACTION | 19 |
| CLIENT_ACTION | 15 |
| SHARED_WORKFLOW_ACTION | 4 (A36, A43 entity lane, A46, A47 club lane) |
| COMPLIANCE_ACTION | 9 |
| Prohibited / not built | 5 (A10, A19, A29, A48, A13 as a free-text channel) |

*A13 is classified regulated and then not offered; it is counted so the
boundary is explicit.
