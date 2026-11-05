# Football agents: authorisation, compliance and transactions

The Agent workspace: agents and agencies, client relationships, authorisation, the conflict and policy engines, consent, minors, transactions and how agents connect to club recruitment. The regulatory research behind it is [`../reference/agent-regulatory-snapshot-2026-09.md`](../reference/agent-regulatory-snapshot-2026-09.md).

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## Football agents: authorisation and compliance

**Principle.** A licence belongs to a person, not to the agency. A typed licence number does not count as verification, and only the client's confirmation creates a relationship. ScoutBox is infrastructure: it never negotiates, advises, recommends or ranks agents, and it never files with regulators. (P56B_AGENT_IMPLEMENTATION; P56A_REGULATORY_SNAPSHOT §6 P-1..P-8)

**Actors and tiers** (`domains/agents/core/` agents, `domains/agents/compliance/` compliance)
- The agency is a tenant; the regulated actor is the licensed individual, whose `agentProfiles` record survives leaving. (DR-2)
- `tiers[]` ⊂ `licensed_agent, agency_admin, analyst, assistant, finance`. First member of an empty agency becomes admin; thereafter only admins add members; no self-promotion, no removing the last admin. Ending membership revokes sessions at once; attributions stay.
- Only `licensed_agent`: own profile, verification, own clients, request/terminate, player lookup, opportunities, compliance contexts, transactions. Other tiers see a client summary only if the client enabled `shareWithAgencyStaff` (default off), never data. Only `agency_admin` writes team/settings and reads the audit. (`domains/agents/core/shared.mjs` PERMISSIONS)
- Session labels (`user.role`, `isLead`, typed job title) grant nothing. Agent login refused for non-agency orgs. No agent surface in Grassroots. (DR-43)

**Action classes** (P56A_ACTION_CLASSIFICATION): regulated (licensed, verified, in scope, policy pass; never proxied), administrative (by tier), client (never by an agent), shared-workflow, compliance (T&S or engine). Agents never write Passport, Trust, assessments, decisions, Rooms or development plans.

**Fixed authorisation order** (AUTHORIZATION_CONTRACT §2): authenticate → individual → agency membership → conceal foreign (404) → licence facets (regulated only) → representation scope → policy/conflict → block/safeguarding/moderation (`NOT_VISIBLE`) → mutate (rev guard, idempotency). Stop at the first refusal; see §3 on block ordering.

**Fail closed, or send to review** (DR-52, frozen)
- A missing objective condition fails closed at the step that owns it. That covers licence, registration, scope, guardian consent, and a combination an ACTIVE rule prohibits.
- Uncertainty becomes `MANUAL_REGULATORY_REVIEW_REQUIRED` plus an attributed review item. That covers a rule that is `UNDER_LEGAL_REVIEW` or `UNKNOWN`, conflicting overlays, and a scope that cannot be resolved.
- Neither path proceeds. Uncertainty is never permission, and the engine never picks the convenient reading.

**Verification facets** (P56C_IMPLEMENTATION; DR-53)
- There are four separate facets, each with its own state, provenance and 30-day `recheckAt`: `fifa_licence`, `national_registration[MA]`, `domestic_authorisation`, `minors_authorisation[MA]`.
- A VERIFIED facet becomes STALE once `recheckAt` passes, and the agent is told once, within about a minute, by the agent sweep (before S11a, only when they opened their compliance page). An agent who has left the agency is not told.
- Requirements by jurisdiction:
  - INT needs `fifa_licence`.
  - ENG also needs `national_registration.ENG`.
  - USA also needs `domestic_authorisation` (a background check).
- Editing the declared licence number resets the FIFA facet.
- The production provider is `none`: every submission ends `MANUAL_REVIEW_REQUIRED` and goes to attributed review. A synthetic provider exists only under `AGENT_VERIFICATION_TEST_PROVIDER=1`.
- A provider outage (`UNAVAILABLE`) never permits: it returns 503 and writes nothing.

**Representation agreements** (P56B §6; code)
- States: `proposed, active, declined, terminated_by_client, terminated_by_agent, disputed`, plus `expired` (derived from the clock, never written).
- Client: `proposed`→`active` (confirm) / `declined` / `disputed`; `active`→`terminated_by_client` / `disputed`. Agent: `proposed`/`active`→`terminated_by_agent` only. Everything else is terminal.
- Term 1–24 months (default 12). Scope ⊂ `employment, transfer, commercial, other_services`; unknown scope refused. One agreement per agent–client pair. (DR-10)
- After a decline or an end, a 30-day cooldown before the same agent re-asks; a dispute blocks re-requests indefinitely.
- Access = `agreementGrantsAccess` (term covers now) ∧ `orgCanSee`, re-checked on every read. A future-start agreement reads `active` but grants nothing. A block suspends access without changing status. (DR-28)
- An active agreement ending within 30 days tells its agent once, by the agent sweep (before S11a, only when they opened their home page); an agent who has left the agency is not told.
- The player card shows the licence *state*, never the number; nothing for minors. Player deletion tombstones agreements (ids only; pending → `declined`; reason and names nulled).

**Minors** (P56C_MINOR_COMPLIANCE; AUTHORIZATION_CONTRACT §7)
- Agents never see under-18s (`/org/agent/players` or anywhere); no route takes a minor as subject.
- A minor named as a party gets the same `PARTY_NOT_FOUND` 404 as an unknown, blocked or invisible player, so refusals never reveal age. A client-supplied `dob` or guardian flag is ignored.
- `MINOR_PATHWAY_PRODUCTION_ENABLED` is false for ENG, INT and USA; `evaluateMinorGate` shows subject-free readiness only ("pathway not enabled").
- Guardian-managed accounts have no agent consents (`{items:[], minor:true}`); actions return `COMPLIANCE_ACTION_NOT_PERMITTED`.
- `canAgentAccessMinor` must never feed `visibleToOrg`/`orgCanSee`.
- England timing (`ENG-5.1`: 1 September of the academic year the minor turns 16) is never generalised; FIFA timing is unresolved (`timingEncoded:false`).
- Before any pathway opens: ACTIVE rules with resolvable timing under dual control, a deliberate flag flip, guardian-first consent, individual minors accreditation checked against a real register, safeguarding review and age-oracle audit.

**Policy engine** (P56C_POLICY_ENGINE; `domains/agents/compliance/policy.mjs`, `policyVersions.mjs`)
- Policy is data; no jurisdiction conditionals in routes or clients. Only published versions inside their effective window are read. A rule's parameters are typed against the engine's vocabulary (`RULE_PARAMS`): publishing an unknown parameter, or one of the wrong type, is refused.
- `ruleStatus` (separate from `textStatus`): `ACTIVE` decides; `SUSPENDED`/`PENDING_IMPLEMENTATION` → `NO_ACTIVE_RULE_DECIDES` (never permission); `PARTIALLY_SUSPENDED`/`UNDER_LEGAL_REVIEW`/`UNKNOWN` → review; `JURISDICTION_OVERRIDE` names both rule ids.
- The set is always INT plus each named member association; anything unencoded → `JURISDICTION_UNSUPPORTED`/`POLICY_NOT_ENCODED`.
- Seeded: `jp-fifa-2025-1` (FFAR 12(8)–(10) `UNDER_LEGAL_REVIEW` with overrides to England; 19 `SUSPENDED`; `FIFA-RSTP-2027` pending from 2027-01-01); `jp-eng-2026-27-1` (6.3 ACTIVE with consent, particulars and legal-advice offer; 6.4 prohibition; 6.5 connected agents; 7.13 partially suspended); `jp-usa-2024-1` (multiple representation and minors `UNKNOWN`).
- `evaluatePolicy` returns structured flags and reasons (rule id, status, version); callers never re-derive.
- Publication: one T&S admin proposes (10/day), a *different* one approves (`POLICY_DUAL_CONTROL_REQUIRED`). Existing verdicts never change; open contexts get `reEvaluationPending`. A consent naming only a superseded version is stale.

**Conflict engine** (P56C_CONFLICT_ENGINE; `domains/agents/compliance/conflict.mjs`)
- Pure, deterministic, with an `inputHash`. Outcomes: `CLEAR` (never called "compliant"); `PERMITTED_WITH_CONSENT` (alias; the long name `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` is stored); `PROHIBITED_CONFLICT` (no consent or reviewer cures it); `MANUAL_REGULATORY_REVIEW_REQUIRED`; `INSUFFICIENT_DATA`. Severity is monotonic.
- England: one party → `CLEAR`; individual + engaging → consent from both; individual + releasing → prohibited; engaging + releasing → `COMBINATION_NOT_PERMITTED`; permitted with consents on record → `CLEAR`.
- Connected agents (same agency by default, DR-20) count as one; reasons judge only the evaluated agent.
- `other_services` presumption → review, not prohibition. Missing, removed or minor party → `INSUFFICIENT_DATA`. Scope is never defaulted to national.
- Re-runs on every mutation; evaluations appended, never overwritten; an earlier clearance never authorises a later act.

**Compliance contexts** (P56C_IMPLEMENTATION): the minimal record an evaluation needs; not a Transaction Room, no terms or fees. The regulated act `POST …/representations` runs idempotency → rate limit → visibility/blocks → agreement → scope → facets → conflict → consent → review → rev → mutate → audit; any refusal records nothing.

**Consent ledger** (P56C_CONSENT_MODEL)
- One row per party, context and agent; requestable only where an ACTIVE rule makes consent decisive. Append-only, server clock; a revocation is its own row (`regulatory_consent_revocations`, once per consent) and the grant is never edited.
- Who answers: the player in their own app (never under-18s); for a club, only its `verification_admin` signatory; never the agent.
- A grant needs both `acknowledgedParticulars` and `acknowledgedLegalAdvice`; a decline needs neither.
- A consent counts only if it is granted and not revoked, matches the context, agent and party role, came from the signatory, preceded the second-earliest `firstActAt`, names a version where the rule is ACTIVE, and (England) the request carried particulars and a legal-advice offer.
- Revocation stops future acts immediately and undoes nothing; a revoked consent needs a new request. No fee, terms or other party's data on the card. Notifications are in the mandatory `compliance` category.

**Attributed T&S reviewers (G-C0)** (P56C_GC0_REVIEWER_ATTRIBUTION)
- Reviewers are rows of `ts_reviewers` (roles `trust_safety_reviewer`, `trust_safety_admin`; scrypt-hashed secrets); `/auth/reviewer/login` creates a `ts_reviewer` session. A `reviewerId` or timestamp in the body is ignored. The shared admin key is read-only and decides nothing.
- Revocation kills sessions but keeps past decisions attributed; at least one admin must remain. Bootstrap via `TS_REVIEWER_BOOTSTRAP_*` only; no reviewer is invented and nothing is back-filled.
- Approvals need evidence. Reviewers resolve facts only: they cannot override an ACTIVE prohibition (`REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE`) or decide on an uncertain rule (`REVIEW_REQUIRES_POLICY_VERSION`). Decided items are superseded, never edited.

**Other.** The compliance path carries no fee, commission or terms and reads no payment state (clearance cannot be bought). Audit rows hold no content.

## Football agents: transactions and integration with recruitment

### Transaction: what it is
- A transaction (`agent_transactions` and its child tables, ids `atx-`; repositories/agentTransactions.mjs since S11c) is a permissioned, auditable multi-party workspace (Player, Agent, Engaging Club, Releasing Club). ScoutBox is not a legal actor: it never negotiates, proposes, accepts, signs, judges validity or overrides a compliance prohibition, and every state screen says so. (M23_P56D_TRANSACTION_MODEL)
- Transaction ≠ recruitment case ≠ Offer ≠ signing. No status or type names an offer (`"offer"` type is refused); the transaction module never writes recruitment cases, offers or `db.signings`. (P56D_TRANSACTION_MODEL)
- Types: the four conflict-engine `CONTEXT_TYPES` imported, not copied: `employment_contract`, `transfer`, `loan`, `other_services`. (P56D_FINAL_REPORT)
- No fee, commission, salary, escrow or payment field anywhere. "Terms" are versioned working-particular summaries scoped to a party, never amounts; recording one is not an offer. (P56D_TRANSACTION_DOCUMENT_MODEL)
- Parties: roles `individual` (player), `engaging_entity`, `releasing_entity` (clubs). One party per role. Releasing entity only for `transfer`/`loan`. Identity by canonical id; names resolved live at projection. `playerId`/`engagingOrgId`/`releasingOrgId` are derived from `parties[]`, never written. Parties are never deleted (tombstoned with history). (P56D_TRANSACTION_MODEL)
- Each party confirms its own participation: the player in the player app, each club only through its recorded verification administrator (signatory; otherwise `SIGNATORY_REQUIRED`). The agent's act is a representation binding, not a confirmation. An agent can never act for a club. (P56D_TRANSACTION_MODEL)
- A DRAFT may name an adult non-client as a party; that grants no data or authority beyond a "you have been named" notice. Progress needs a binding to the agent's own active agreement. (M23_P56F_A1_A2_A3_CLOSURE)
- Duplicate rule: a second live transaction with the same individual, type and clubs on both sides is `TRANSACTION_DUPLICATE_CONTEXT` 409. A loan beside an employment contract, a different engaging club, or a fresh one after a terminal state are allowed. (P56E_TRANSACTION_HANDOFF_CONTRACT)
- On account removal the transaction keeps its shape and tombstones the person (labels emptied, their documents dropped, representations withdrawn). (P56D_TRANSACTION_MODEL)
- Lists: the agent's, a club's and Trust & Safety's transaction lists page newest first by cursor (`?limit=&cursor=` → `{ items, nextCursor }`, a junk limit, cursor or status filter is a 400); the agent's `counts` cover every transaction, not the page. The player's list is not paged. The apps read the first page.

### State machine (domains/agents/transactions/transaction.mjs)
- Ten states; terminal are CANCELLED, CLOSED, ARCHIVED. `CLOSED` deliberately not `COMPLETED`, so it can't read as a signed transfer. READY means "ScoutBox's encoded rules currently permit", never legally valid. (P56D_TRANSACTION_STATE_MACHINE)
- Actor (licensed agent) transitions: DRAFT→PARTIES_CONFIRMED|CANCELLED; PARTIES_CONFIRMED→CANCELLED; COMPLIANCE_PENDING/BLOCKED→ACTIVE|CANCELLED (ACTIVE then refused by compliance with the real reason); READY→ACTIVE|ON_HOLD|CANCELLED; ACTIVE→ON_HOLD|CLOSED|CANCELLED; ON_HOLD→ACTIVE|CLOSED|CANCELLED; CANCELLED/CLOSED→ARCHIVED.
- Compliance transitions: PARTIES_CONFIRMED→READY|PENDING|BLOCKED; PENDING→READY|BLOCKED|PARTIES_CONFIRMED; BLOCKED→READY|PENDING|PARTIES_CONFIRMED; READY and ACTIVE→PENDING|BLOCKED. DRAFT, ON_HOLD and terminal states are never moved by compliance. No actor reaches READY/PENDING/BLOCKED; compliance never cancels, closes, archives or activates.
- Every status write: must be writable (no safeguarding hold); idempotency key checked before the transition; ACTIVE refuses a stale snapshot; hold/cancel/close need a closed-list reason code, and any other move is refused one; `expectedRev` or 409. ON_HOLD→ACTIVE runs a full recheck (no auto-resume). ARCHIVED is read-only for everyone including the owner. Cancel deletes nothing.
- The projection carries `allowedTransitions` for this caller; the UI renders exactly those buttons.
- `offerBoundary.canStartOfferWorkflow` = READY-or-ACTIVE + parties confirmed + compliance clear and current + required consents active + representation effective, with named `blockers[]`. It creates nothing.

### Compliance integration
- A transaction owns exactly one P5.6C compliance context (`compliance_contexts`) and reads its verdict; it never re-implements evaluation. `transactionRepresentations` is the truth about who acts for whom; the context's inline representations are rebuilt from it before every evaluation. Bindings reference `agreementId` (scope/status read live); without a ScoutBox agreement a binding is `declaredOnly`, ineffective, and waits for an attributed review. (P56D_TRANSACTION_COMPLIANCE_INTEGRATION)
- Named pending reasons only (no generic pending): PARTIES_NOT_CONFIRMED, REPRESENTATION_MISSING (both map back to PARTIES_CONFIRMED state), CONSENT_REQUIRED, MANUAL_REVIEW, INSUFFICIENT_DATA, PROVIDER_UNAVAILABLE (fail-honest), JURISDICTION_UNSUPPORTED, FACET_NOT_VERIFIED. `PROHIBITED_CONFLICT` → blocked; no reviewer can approve past it.
- A safeguarding block is evaluated before compliance; CLEAR never overrides a block.
- Staleness: `partyRevisionOf` hashes parties, agent, representations, consents, facets, policy versions, blocks, minor state. Stale reasons: NO_SNAPSHOT, INPUTS_CHANGED, POLICY_CHANGED (a policy version published for the jurisdiction flags the transaction's context; until re-evaluated it cannot go ACTIVE), EXPIRED. A stale snapshot authorises nothing; `clear` reports the current answer.
- The snapshot names the evaluation it was taken from (or the facet gate that refused before the engine ran); its outcome, reason codes, policy versions and consent requirements are that evaluation's own.
- Every material mutation re-resolves representation, scope, licence facets, policy, conflict, consents, blocks and minor gate (fixed 18-step order; a foreign transaction is concealed as 404; party role comes from `parties[]`). Body-supplied auth facts are ignored. (P56D_TRANSACTION_AUTH_MATRIX)
- Consents reuse the consent ledger (`regulatory_consents`); each party answers on its own surface; revocation bites at the next mutation. A party sees only its own consent.
- Jurisdiction comes from party data, never the client; unsupported → 422.
- Minors: `MINOR_PATHWAY_DISABLED` fails closed before the engine; guardian stays a distinct party and consent actor; agent never substitutes for a guardian.
- Only licensed agents create/write transactions (not analysts, assistants, finance, agency admins, clubs or players). Agency audit shows reviewers as "Trust & Safety (attributed)", never by name.

### Documents, notes, timeline
- Transaction documents (`transaction_documents`) hold classification/provenance only; bytes stay in the canonical evidence store behind a re-authorised `evidenceRef` (no signed URLs). No digital signing; no writer knows a signature instant, so `signedAt` is always null. Nine fixed document types. Versions supersede (owner only); expired reads as not found. (P56D_TRANSACTION_DOCUMENT_MODEL)
- Nine visibility classes: AGENT_PRIVATE (representing agent only; not the agency admin), PLAYER_PRIVATE, ENGAGING_/RELEASING_CLUB_PRIVATE, PLAYER_/ENGAGING_/RELEASING_AGENT_SHARED, ALL_TRANSACTION_PARTIES, T_AND_S_ONLY (only T&S; nobody may write it). Write is narrower than read; the player may never write club-side classes; unknown class fails closed. (P56D_TRANSACTION_PRIVACY_MATRIX)
- Notes: same classes minus T_AND_S_ONLY, never a timeline entry. Document timeline entries reach only the parties the document's class admits, and never carry its label.
- Timeline actors are shown as roles.
- Links to opportunities, trials and threads are references only; a linked thread still needs Inbox authorisation. No projection reads club recruitment data.
- Events are ids-only. Compliance notifications go to the mandatory `compliance` category; other traffic to mutable `transaction_updates`. (P56D_FINAL_REPORT)

### Integration decision layer (m27)
- `m27` alone decides an agent's access to other apps' work. (P56E_INTEGRATION_MODEL)
- Fixed rule order, first refusal wins: SURFACE → BASIS → SUBJECT → AGE → BLOCK → SCOPE → DISCLOSURE → SHARE → LICENCE → COMPLIANCE. Ten surfaces, all adult-only; regulated ones (contact, trial coordination, opportunity share, transaction initiation) need `employment` or `transfer` scope. `trial_coordination` is declared with no route.
- Basis = `agentClientBasis` wrapping `agreementGrantsAccess` for a named agent; returns `agentUserId`. Not a basis: unconfirmed, disputed, outside `startAt`–`endAt`, a colleague's, or legacy. Unreadable values in security decisions (bad start/end dates, missing dob) mean refuse, never ignore. (P56F_AGENT_FINAL_DEFECT_REGISTER)
- `sharedFor` is always false: there is no agent-side share writer; only the player shares.

### Disclosure
- Three per-relationship booleans on `representationAgreements[].disclosure`: `clubPresence`, `contactRouting`, `trialVisibility`. All default off; confirming representation turns none on. Changed one at a time via `PATCH /player/agent/relationships/:id/sharing`; non-boolean values refuse the whole request. Only the player may change them; off always works, even on an ended relationship, and doesn't rewrite past records. The agent is notified that something changed, not which. (P56E_DISCLOSURE_MODEL)

### Contact routing
- Modes `player_only` and `both` only. No `agent_only`: a club approach can never reach the agent instead of the player. The mode is a request re-derived at send; a refused agent leg still delivers to the player with a reason code. A block by the family refuses the whole send. Minors go via guardian. The routing snapshot names the agent and is never edited. Pro and Grassroots behave identically. (P56E_CONTACT_ROUTING_CONTRACT)

### Opportunity share
- Agent may share only what is already on the client's board; anything else is a uniform 404 `OPPORTUNITY_NOT_AVAILABLE`. Sharing is never applying: no apply parameter, no Apply button on the player card. Only the representing licensed agent (admin 403; colleague/foreign 404). Shares live on the agreement (cap 200, note ≤300 chars), are withdrawn not deleted, vanish when the relationship ends; minors get none. Quota 60/hour per actor. (P56E_OPPORTUNITY_SHARE_CONTRACT, P56F_AGENT_FINAL_DEFECT_REGISTER)

### Trial projection
- Agent viewer gets trial id, club, state, session times, venue name and town, and whether a report is owed. Never venue address, joining instructions, evidence, assessment or report content. Needs `trialVisibility`. No agent route to confirm, reschedule, cancel or record attendance. (P56E_TRIAL_PROJECTION_CONTRACT)

### Transaction handoff (club → agency)
- A finalised `progress` decision creates nothing. A recruitment lead separately invites a workspace; the invitation lives on `recruitmentCases[].transactionHandoff` (invited/accepted/withdrawn/expired; expiry derived at 30 days). It records whether the client was represented, never who, nor any term/fee/decision reasoning. The agency, not the club, opens the workspace; creation citing a case is bound (invitation exists, still invited, this agency and agent, same player) before anything is stored. No withdrawal once accepted. `HANDOFF_NOT_PERMITTED` is reported alone; other blockers together. The case reference on a transaction is visible only to the representing agent and the owning engaging club. Quota 30/hour per org. (P56E_TRANSACTION_HANDOFF_CONTRACT)

### Agent and Offers (P6)
- An adult client shares a specific Offer with their agent (`POST /player/offers/:id/share-agent`); guardians cannot. The agent reads terms, state, responses; never documents, internal notes, decision or transaction refs. No agent route accepts, declines, issues or edits an Offer. Access ends when the mandate ends. (M23_P6_AGENT_TRANSACTION_INTEGRATION)
- A club Offer may cite a transaction only if the club is its engaging entity and it is linked to the same case (else a uniform 400). Readiness is re-evaluated at issue; blockers returned as codes. Recipient payloads never name a transaction.

### Legacy representation
- The M13 F10 lane (`/org/representation`, `/player/representation`, `/admin/representations`) was closed in P5.6E and removed in S11a with its screens (the player app's Representation section, the club and Grassroots Representation page, the admin tab): no record could exist. An agent relationship is only ever requested by a licensed agent and confirmed by the client.

### Idempotency
- `clientKey` goes in the body (1–64 chars); replay answers `idempotent: true`; same key, different payload is 409. (P56F_CONCURRENCY_IDEMPOTENCY)

## Open questions and deferred work

- **No live register integration** for FIFA, the FA or USSF. Production verification depends entirely on attributed review.
- **No minor pathway anywhere.** England is the only candidate.
- **England agency-party colleague performance** (`ENG-4.1b`, consent kind `agency_performance`) is encoded with `productionEnabled:false`, pending L-9.
- **Legal reviews that block production use:**
  - L-1: the status of FFAR 12(8)–(10) after the July 2026 CJEU judgment. FIFA-only outcomes stay under manual review.
  - L-2: the exclusive-agreement window. It is a review case, never a hard block.
  - L-4 / L-9: same-agency information barriers.
  - L-6: the non-England minors timing parameter.
  - L-8: the U.S. rules text.
  - L-18: domestic versus international scope.
- **Fees, signatures, retention.** Fees are recorded but never validated (L-5). E-signature sufficiency is open (L-17), as is tombstone retention (L-11).
- **Deferred:** the Trust projection for agent clients (DR-21) and per-agent blocks (DR-27).

- Fee/commission/payment workflows: deferred entirely.
- `renewal` transaction type: deferred.
- Minor pathway: disabled in every jurisdiction; guardian architecture kept ready.
- Long-term retention of regulated transaction records: flagged for legal review.
- Transfer/loan Offers (club-to-club terms) and auto-Offer from READY: not modelled.
- Agent trial coordination and `agent_only` contact: deliberately not built.
- A2 (naming an adult non-client in a draft) accepted rather than narrowed.

## Also worth knowing

- **[`../reference/agent-regulatory-snapshot-2026-09.md`](../reference/agent-regulatory-snapshot-2026-09.md)** (about 10,000 words, kept in the tree). This is a source-cited snapshot, dated 18 September 2026, of FIFA FFAR 2025, the FA 2026-27 rules and the U.S. rules. It includes:
  - each rule's status after the July 2026 CJEU judgment;
  - a minors table for each jurisdiction (§12);
  - the legal-review register (L-1..L-18) and the uncertainty register (U-1..U-19).

  Every encoded rule comes from it, and it took real research.

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

All ✓ unless noted (paths under `scoutbox-server/`):
- ✓ Minors excluded from lookup and client detail: `domains/agents/core/index.mjs:490`, `:577`.
- ✓ Minor pathway off everywhere: `domains/agents/compliance/policy.mjs:322`.
- ✓ Dual-control publication `domains/agents/compliance/index.mjs:237`; no review past ACTIVE prohibition `:875`; last reviewer admin `:176`.
- ✓ Two acknowledgements to grant `:776-777`; club signatory only `:814`; minor gets empty consents `:799`; revocation is a new row `:760`.
- ✓ `/ts` behind `reviewerAuth`: `server.mjs:4427`. Production provider `none` → manual review: `domains/agents/compliance/provider.mjs:31-32`.
- ≠ `FIFA-RSTP-2027` is a rule, not a version (§3).

- ✓ Actor transition map as documented: `scoutbox-server/m26/transaction.mjs:122`.
- ✓ Contact modes `player_only`/`both` only: `domains/recruitment/lifecycle/contact.mjs:96`; unknown mode flagged at `:447`.
- ✓ Disclosures default off: `domains/agents/core/shared.mjs:361`.
- ✓ Start-date check in the access predicate: `domains/agents/core/shared.mjs:291,311`.
- ✓ Handoff TTL 30 days: `m27/integration.mjs:366`; agent trial viewer `domains/recruitment/lifecycle/trial.mjs:476`.
- ✓ Minor pathway disabled (ENG, INT, USA): `domains/agents/compliance/policy.mjs:322`.
- ✓ `sharedFor` always false: `m27/index.mjs:170`.
- ✓ Duplicate rule: `domains/agents/transactions/index.mjs:592`; handoff binding before create: `domains/agents/transactions/index.mjs:610`.
- ✓ Offer readiness seam used by Offers: `domains/agents/transactions/index.mjs:1416`, `domains/recruitment/offers/index.mjs:323`; adult-only share-agent route `domains/recruitment/offers/index.mjs:793`.
- ✓ Missing dob fails closed: `domain.mjs:35`.
