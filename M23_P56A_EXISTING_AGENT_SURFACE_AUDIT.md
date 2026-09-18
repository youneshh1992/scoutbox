# M23 P5.6A — Existing Agent / Agency Surface Audit

Every place in the ScoutBox tree where "agent", "agency" or "representation"
already means something, with a disposition for each. Classes are the six
from the mandate (§7): **KEEP** (correct as is, the Agent product builds on
it), **EXTEND** (correct but incomplete for the Agent product), **RENAME**
(the name misleads and should change when it is next touched), **DEPRECATE**
(stays functional; the Agent product must not build on it; retired in a
named later phase), **REMOVE LATER** (dead or wrong; scheduled removal), and
**NOT AGENT PRODUCT** (the word appears but the thing is not part of the
Agent product and must not be mistaken for it).

Nothing in this audit was changed in production during P5.6A except the
Trust Score relationship defect recorded in
`M23_P56A_AGENT_DEFECT_REGISTER.md` (D-P56A-1). Every line reference is to
the tree at the P5.6A starting tip `669d060`; where the defect fix moved a
line, the register says so.

Method: `rg -n "agent|agency|representation" --ignore-case` across
`scoutbox-server`, the four clients and the test suites, then each hit read
in context. The Explore pass that produced the raw inventory is summarised;
this document is the judgement.

---

## 1. Server — domain and visibility

| # | Surface | Where | What it does today | Class | Disposition |
|---|---|---|---|---|---|
| S1 | `org.type === 'agency'` | `scoutbox-server/seed.mjs:44-56` (seeded `org-northstar`), `server.mjs:1523-1552` (org shape), `catalogue.mjs:63-70` | A first-class org type beside `club`, with `level: 'agency'`, `plan: 'Agency'`. **Unvalidated**: nothing checks the value set on creation; only T&S provisions agencies (`server.mjs:3887`). | **EXTEND** | Keep the discriminator; it is the tenant of the future Agent product. P5.6B adds validation of the value set and a stored `platform` discriminator (see `M23_P56A_AGENT_FINAL_ARCHITECTURE.md` §6). Do not rename: `agency` is the FFAR word (R-F2). |
| S2 | `visibleToOrg()` agency ∧ minor → `false` | `domain.mjs:65-82` (the rule at `:73`) | The safeguarding invariant: an agency org never sees a non-adult player, verified or not, through any read path. | **KEEP** | Unchanged in P5.6A and stays global (mandate §48). The future minors pathway is a *separate*, narrower predicate layered beside this one, never a relaxation of it (`M23_P56A_AGENT_AUTHORIZATION_CONTRACT.md` §7). |
| S3 | `orgCanSee = visibleToOrg && !isBlocked` | `m13/shared.mjs:224`; duplicated inline in ~8 read paths (`server.mjs:548-550` `isBlocked`, `:911-955` `playerViewForOrg`, `m17/rooms.mjs:126-160`, `m23/contact.mjs:241-297`, `m16/combine.mjs:581-586`, `m21/permissions.mjs:71-82`, `m12/journeys.mjs:70+`, `m182/audit.mjs:212-229`) | The one read gate; re-evaluated on every read, never cached. | **KEEP** | The Agent product reuses it verbatim for adult clients. The duplication is a maintenance hazard, not a defect; noted in the reuse audit as the reason the Agent authorization layer must call one exported predicate. |
| S4 | `isAdult` / `ADULT_AGE` (`{DEFAULT:18, KR:19, TH:20, EG:21, SG:21, NZ:18}`) | `domain.mjs:5-40` | Age of majority by player country, evaluated from DOB at request time. | **KEEP** (with a note) | The regulations use **under 18** for "Minor" (FFAR Def.; FA reg. 5.1), not the age of majority. The Agent product needs a second predicate, `isRegulatoryMinor(player) = age < 18`, distinct from `isAdult`. A 19-year-old Korean is an adult for ScoutBox visibility and *not* a Minor for FFAR purposes; a 17-year-old anywhere is both a ScoutBox minor and a FFAR Minor. Recorded in the decision register (DR-14). |
| S5 | `req.playerIsMinor` | `server.mjs:1052-1061` (`playerAuth`) | Convenience flag derived from `isAdult`. | **KEEP** | Same note as S4. |
| S6 | `UNDER_18_WALL` refusal copy, agency-specific | `server.mjs:1780-1800` (legacy request route, "Agency accounts cannot contact minors."), `m13/transitions.mjs:244, 274` | The wall as a named refusal. | **KEEP** | The copy stays truthful for the general product. The minors pathway, when built, will refuse with the new families (`MINOR_APPROACH_NOT_PERMITTED`, `GUARDIAN_CONSENT_REQUIRED`) *before* reaching this wall, so the wall never becomes reachable-but-wrong. |
| S7 | `AGENCY_ONLY` refusal | `m13/transitions.mjs:240, 264` | Clubs are refused the representation lane. | **KEEP** | Correct direction; the Agent product inherits "clubs cannot propose representation". |
| S8 | Platform separation (`GRASSROOTS_PLATFORM_ONLY`, `PLATFORM_MISMATCH`) | `server.mjs:1513-1520` (org list), `:1566-1578` (login) | Derived from `org.level === 'grassroots'`; anything else is "main". An agency user can log into the Pro club app today. | **EXTEND** | P5.6B adds a third platform value (`agent`) so the club app refuses agency orgs and the Agent app refuses clubs, symmetric with grassroots. Not changed in P5.6A (would be a production behaviour change). |
| S9 | `role` free text on login (`'Agent'` is just a string) | `server.mjs:1621-1624` (role written from the request body on *every* login), `m13/shared.mjs:211` (`isLead` regex; `'Agent'` does not match) | Self-asserted role; authority is a regex. | **NOT AGENT PRODUCT** (the string) + **EXTEND** (the model) | The `'Agent'` role string in seeds and tests is cosmetic and grants nothing regulated — correctly so. The Agent product must not read it. Agency staff tiers come from `agencyAffiliations` (store proposal §3), modelled on the one real RBAC in the tree, `db.verAdmins` (`m14/organisations.mjs:569-651`). |

## 2. Server — the existing representation lane (M13 F10)

| # | Surface | Where | What it does today | Class | Disposition |
|---|---|---|---|---|---|
| S10 | `db.representations` | `m13/transitions.mjs:230-339`; store guaranteed by `storeContract.mjs:131` | Agency **organisation** proposes; adult player confirms / withdraws / disputes; optional uploaded credential note reviewed by T&S with an honesty string that says it is a document review, not a register check. Record: `{ id, playerId, playerName, agencyOrgId, agencyName, representativeName (free text), scope ∈ full\|contracts_only\|commercial_only, startAt, endAt (≤ 36 months), credential, status ∈ proposed\|active\|withdrawn\|disputed (+ derived expired), confirmedAt, withdrawnAt, disputedAt, history[] }`. | **DEPRECATE** (as the regulated agreement) / **KEEP** (as a player-facing "my agency" relationship until P5.6B replaces it) | It is agency-level, not individual-level (R-F1 requires the licensed natural person); `representativeName` is free text bound to nobody; the 36-month cap exceeds the two-year maximum for players (R-F9, R-E3); there is no jurisdiction, no legal-advice acknowledgement (R-F10), no guardian path, no policy version. **It cannot be the Representation Agreement.** It stays functional for existing data and its player-confirmation/withdrawal semantics (which are *stricter* than the regulations and correct) are carried into the new model. P5.6B introduces `representationAgreements`; a migration maps each `db.representations` row to a `legacy_agency_level` agreement with `agentUserId: null` and `regulatoryStatus: 'not_regulated_record'`, never to a compliant agreement. Retirement of the write routes: P5.6E. |
| S11 | `POST /org/representation/propose`, `GET /org/representation` | `m13/transitions.mjs:239-268` | Agency writes. | **DEPRECATE** | Same as S10. Left untouched in P5.6A. |
| S12 | `GET/POST /player/representation[...]` confirm / withdraw / dispute | `m13/transitions.mjs:272-323` | Player controls; adult-gated live on every route. | **EXTEND** | The player-side semantics (confirm before anything is active; withdraw ends current access instantly; dispute routes to T&S; history retained) are exactly the mandated client-authority model (§27, §138–§139) and are reused as the shape of the new agreement's client lane. |
| S13 | `POST /admin/representations/:id/review-credential` | `m13/transitions.mjs:325-339` | T&S marks an uploaded credential note valid/invalid; `honest` string states no register integration exists. | **KEEP** (honesty) / **DEPRECATE** (mechanism) | The honesty posture is the model for A-2 (fail-honest licence states). The mechanism (a note, not a document, reviewed against nothing) is replaced by M14 `LICENCE` claims plus the agent verification abstraction. |
| S14 | Notification kind `'representation'` | `m13/transitions.mjs:257, 305`; category map `m182/notificationPrefs.mjs:105` (`activity`) | Player notified on propose; *first non-removed agency user* notified on withdraw. | **EXTEND** | The withdraw notification goes to whichever user happens to be first in the agency, not the representative: an artefact of the agency-level model. The new model notifies the named agent. Not a defect today (nothing leaks; the agency is the counterparty). |
| S15 | Trust Score relationship keying reads `rep.orgId` | `m162/trust.mjs:84-87` | Meant to count a confirmed agency relationship as one distinct verified relationship for an adult. `rep.orgId` does not exist on the record (`agencyOrgId` does), and `confirmedAt` survives withdrawal/dispute/expiry, so the key collapses to `rel:agency:undefined` and a withdrawn or disputed relationship keeps counting. | **DEFECT** → fixed | D-P56A-1 in the defect register: Medium, existing production, Trust Score integrity. Fixed in P5.6A with a live regression check. |

## 3. Server — verification, claims, trust, passport, rooms

| # | Surface | Where | What it does today | Class | Disposition |
|---|---|---|---|---|---|
| S16 | M14 claim types `LICENCE`, `AGENCY_AFFILIATION`, `AGENCY_ROLE` | `m14/shared.mjs:19-31`; evidence rules `:274-294` (affiliation/role need `official_email`); licence routes `m14/review.mjs:79-140` | A licence claim is born `collecting_evidence`, and with no configured register goes to `requires_human_review` with `NO_AUTHORITATIVE_SOURCE`; `document_submitted` is never authoritative. | **EXTEND** | This is the correct spine for FIFA-licence and national-registration verification: claims, not booleans; effective status recomputed at read time (`:115-144`); expiry. P5.6B adds claim subtypes / metadata (`FIFA_AGENT_LICENCE`, `NATIONAL_AGENT_REGISTRATION{ma}`, `MINORS_AUTHORISATION{ma}`, `CPD_STATUS`) and the `recheckAt` clock. No register integration exists and none is pretended (mandate §148, §170). |
| S17 | `AGENCY_AFFILIATION` semantics | `m14/shared.mjs:26-27, 276-282` | "This person works at this agency" via official e-mail. | **EXTEND** | Becomes the evidence behind an `agencyAffiliations` row; the affiliation row (tier, from/to) is a separate store because a claim has no tier and no membership window. |
| S18 | Conflict-of-interest declarations, kind `'agent_relationship'` | `m14/organisations.mjs:652-674` | Org staff declare a personal relationship with an agent. | **KEEP** + **EXTEND** | Directly reusable as an *Interest* input to the Conflict Engine (R-F18): a club user's declared agent relationship is a `MANUAL_REGULATORY_REVIEW_REQUIRED` signal when that agent appears on the other side of a Transaction. |
| S19 | `safeTrustProjection` has no `'agency'` case → `null` | `m162/shared.mjs:431-457`; `m17/rooms.mjs:131` computes `viewerKind 'agency'` | An agency Room sees `trust: null`. | **KEEP** (fail-closed) | Correct default. The privacy matrix (row "Trust Score") gives a licensed agent with an *active confirmed agreement* the `pro_club` level view (level + weight + safe signal codes), never components. That is a P5.6B decision, not a P5.6A change (DR-21). |
| S20 | Passport viewer kind `'agency'` = club view | `m15/shared.mjs:62, 64-76, 716` | Agency sees `public` + `recruitment` visibility, minor location stripped. | **KEEP** | Adults only by S2. The Agent product's *client* view (agreement active, client confirmed) may be wider than `recruitment` only by the player's explicit share (M15 shares never widen access, `m15/sharing.mjs`). No new visibility level; DR-22. |
| S21 | Room `viewerKind 'agency'` | `m17/rooms.mjs:131` | Agencies can open Recruitment Rooms today (adults only). | **NOT AGENT PRODUCT** | A Recruitment Room is a *club* workflow object. The Agent product does not open Rooms; an agency org's ability to open one is a pre-existing generic-org capability and is out of scope here. Whether to withdraw it when the platform discriminator lands is DR-23 (recommend: refuse for `platform: 'agent'` orgs in P5.6B). |
| S22 | Development Hub excludes agencies | `m21/permissions.mjs:16-31` (documented "§75") | Agencies get nothing. | **KEEP** | Development plans are player/club material. The privacy matrix keeps this. |
| S23 | Legacy `computeTrustScore` and `TRUST` constants | `domain.mjs:118-131` | Older score. | **NOT AGENT PRODUCT** | Not read by anything agent-shaped. |

## 4. Server — contact, requests, inbox, journey

| # | Surface | Where | What it does today | Class | Disposition |
|---|---|---|---|---|---|
| S24 | `contact.channel === 'agent'` | `m23/contact.mjs:78-85` (channel enum), client copy key `ct.ch.agent` | A *club* records that its contact with a player went "via the player's agent". A provenance label, nothing more. | **NOT AGENT PRODUCT** / **RENAME** consideration | Keep the value (it is a truthful record of how a club reached someone). When next touched, rename the label to "via representative" in copy only; the stored value stays for data continuity (DR-24). No identity is bound to it and none should be until the club can select a *verified* agreement counterparty (P5.6E integration, §40 of the mandate). |
| S25 | `player.agentName` (free text) | `server.mjs` player shape; shown in club views | A player-typed name. | **DEPRECATE** | Unverifiable free text that reads like a fact. Kept for existing data; the client UI will label it "self-reported" until P5.6E replaces it with the confirmed-agreement counterparty (`My Agent`, §36). No change in P5.6A. |
| S26 | `issueRecruitmentRequest` `orgType` on the request row | `server.mjs:1849-1895` | Requests carry `orgType` so the recipient sees "agency" vs "club". | **KEEP** | Truthful. A regulated Approach by an agent is *not* this object (it is a `CLIENT_ACTION`/`REGULATED_AGENT_ACTION` on a `representationAgreements` proposal); see the action classification. |
| S27 | `resolveContactRecipient` `CONTACT_GUARDIAN_REQUIRED` unreachable for agencies | `m23/contact.mjs:241-272` (`visibleToOrg` refuses at `:248` first) | Fails closed. | **KEEP** | Exactly the intended ordering (conceal before route). |
| S28 | `m23/journey.mjs` agency branches | `m23/journey.mjs:49-51` | Journey projection notes org type. | **KEEP** | Cosmetic. |
| S29 | Event registry, `representation` / agency events | `m182/eventRegistry.mjs:37, 248, 432`; `EMITTED_EVENTS` `server.mjs:4285` | No agent-domain events exist; audiences are `player_private, guardian_private, org_private, org_member, public_safe, trust_safety_only`. | **EXTEND** | P5.6B registers the seven mandated events (§135) with `org_private` + `payload.orgId` (there is no `agency_private` audience and none is needed). |
| S30 | `notificationPrefs` categories | `m182/notificationPrefs.mjs:28-54, 58-120` | `representation` → `activity`; nothing else agent-shaped. | **EXTEND** | New types mapped in P5.6B; unknown types are delivered and counted, so the gap is loud, not silent. |

## 5. Clients

| # | Surface | Where | What it does today | Class | Disposition |
|---|---|---|---|---|---|
| C1 | Pro club nav item `representation` | `scoutbox-club/src/nav.ts:142`; i18n `nav.representation` | Shows the M13 F10 lane to agency orgs in the *club* app. | **DEPRECATE** | Lives in the wrong app. Removed from the club app when the `agent` platform discriminator refuses agency logins there (P5.6B B7); until then it stays because it is the only UI for existing data. `navConfig` pins the item count (5 Pro), so removal is a counted nav change with its own test update. |
| C2 | Pro club `m13screens.tsx` representation screen | `scoutbox-club/src/m13screens.tsx:526-554`; keys `m13.rep.*` | Propose / list. | **DEPRECATE** | Same as C1. |
| C3 | `AgencyWall` | `scoutbox-club/src/screens.tsx:96-107`; key `fp.wallAgency` | Copy shown to an agency that hits the minor wall. | **KEEP** | Truthful; the grassroots copy of it (`scoutbox-grassroots`) is unreachable because grassroots orgs are never agencies — Low, documented, not a defect. |
| C4 | `ROLES` list includes `'Agent'` | `scoutbox-club/src/App.tsx:34` | Login role picker. | **NOT AGENT PRODUCT** | Cosmetic (S9). Stays until the club app refuses agencies. |
| C5 | Player app `M13Sections.tsx` representation section | `scoutbox-player/src/.../M13Sections.tsx:211-231`; `m13client.ts` | Confirm / withdraw / dispute. | **EXTEND** | The player-side controls are the right UX; P5.6B B8 re-points them at `representationAgreements` (and adds the guardian twin). |
| C6 | Player discover copy mentioning agencies | `scoutbox-player/.../discover.tsx:34` | Copy. | **KEEP** | |
| C7 | Admin `m13tabs.tsx` representations tab | `scoutbox-admin/src/m13tabs.tsx` | Lists representations; credential review. | **EXTEND** | Becomes the Compliance view over agreements in P5.6B; the credential-review button is replaced by M14 licence review. |
| C8 | `OrgType = 'club' \| 'agency'`, `plan: 'Agency'` in the club API types | `scoutbox-club/src/api.ts:12-38` | Types already model agencies. | **KEEP** | Shared into the Agent app's client. |

## 6. Tests that pin the current behaviour (must stay green through P5.6B–E)

| Suite | Lines | What it pins |
|---|---|---|
| `scripts/testTrust.mjs` | 84-93 | `visibleToOrg(minor, agency)` is `false` even when verified. |
| `scripts/m13E2E.mjs` | 536-543 | F10 propose/confirm/withdraw, adult-only. |
| `scripts/m162E2E.mjs` | 205-215, 455-461 | Agency relationship neither helps nor hurts a minor; agency refused a minor's Trust Profile (`NOT_VISIBLE`) and Passport (`UNDER_18_WALL`). |
| `scripts/m15E2E.mjs` | (agency viewer cases) | Agency Passport view equals club view; minor location stripped. |
| `scripts/m17E2E.mjs` | 447-457 | Agency Room behaviour. |
| `scripts/m21E2E.mjs` | 544 | Agencies excluded from Development Hub. |
| `scripts/m23ContactE2E.mjs` | 720-723 | Agency contact refused for a minor before guardian routing. |
| `scripts/m23TrialE2E.mjs` | 627-632 | Agency trial invitation refused for a minor. |
| `scripts/m23E2E.mjs` | 169 | Agency journey/lifecycle check. |
| `e2e/navConfig.test.mjs` | 41, 77 | Nav item inventory incl. `representation`; section counts. |
| `e2e/navLive.test.mjs` | 408-410 | Representation destination reachable for an agency login. |

`M23_P56A_AGENT_TEST_PLAN.md` group Q lists which of these change when C1/C2 move.

## 7. Summary counts

| Class | Count | Items |
|---|---|---|
| KEEP | 17 | S2, S3, S4, S5, S6, S7, S18, S19, S20, S22, S26, S27, S28, C3, C6, C8, S13 (honesty) |
| EXTEND | 12 | S1, S8, S9 (model), S12, S14, S16, S17, S29, S30, C5, C7, S18 |
| RENAME | 1 (copy only) | S24 |
| DEPRECATE | 6 | S10, S11, S13 (mechanism), S25, C1, C2 |
| REMOVE LATER | 0 | — |
| NOT AGENT PRODUCT | 6 | S9 (string), S21, S23, S24 (value), C4, C6 |
| DEFECT | 1 | S15 → D-P56A-1 |

Nothing existing is removed in P5.6A. The one production change is the
D-P56A-1 fix.
