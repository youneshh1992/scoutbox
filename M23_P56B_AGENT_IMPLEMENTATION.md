# M23 P5.6B — ScoutBox Agent Core: Implementation

What P5.6B built, where it lives, and how it maps to the frozen P5.6A
architecture. The companion documents are `M23_P56B_AGENT_AUTH_MATRIX.md`
(the implemented permission matrix), `M23_P56B_AGENT_PRIVACY_VERIFICATION.md`,
`M23_P56B_AGENT_TEST_REPORT.md`, `M23_P56B_AGENT_DEFECT_REGISTER.md` and
`M23_P56B_AGENT_FINAL_REPORT.md`.

The governing sentence, carried from P5.6A: **a licensed natural person is
not an agency; agency membership is not a licence; a self-typed licence
number is not a verified licence; a CRM entry is not representation; an
agent's claim is not private access; the client's confirmation — and only
that — is the root of a relationship. ScoutBox adjudicates nothing, and the
shared Trust & Safety key can adjudicate nothing either.**

---

## 1. Schema — 2304 → 2305, one step

`scoutbox-server/m182/migrations.mjs`: `SCHEMA_VERSION = 2305`; step
`m240_001_agent_core_stores` (the only step above 2304). It is idempotent
and non-destructive:

| Store | Guarantee (`storeContract.mjs`) | Owner | Content |
|---|---|---|---|
| `agentProfiles` | migration | m24 | the licensed natural person's profile: `displayName`, `declared { fifaLicenceNumber, jurisdictions }`, `facets { fifa_licence, national_registration{ma}, minors_authorisation{ma} }`, `rev`, `history`, `keys` |
| `agencyAffiliations` | migration | m24 | time-aware membership: `agencyOrgId`, `userId`, `tiers[]`, `startedAt`, `endedAt`, `endedReason`, `rev`, `history`, `keys` |
| `representationAgreements` | migration | m24 | the client-confirmed relationship record (P5.6A store proposal §3 statuses) with `agentUserId`, `agencyOrgId`, `clientKind/clientId`, `scope[]`, `exclusive`, `jurisdiction`, `termMonths`, `startAt/endAt`, `status`, timestamps per transition, `disputeReason`, `shareWithAgencyStaff`, `legacy`, `subjectRemovedAt`, `keys`, `rev`, `history` |

Two bootstraps on upgrade, both idempotent (P §2): every existing agency
staff row gains an affiliation (lead-role heuristic → `agency_admin`,
others → `assistant`, **nobody → `licensed_agent`**; an agency with no lead
gets its earliest member as admin; a removed user gets nothing; `startedAt`
is clamped to *now* — D-P56B-8); every M13 F10 `db.representations` row is
mirrored **once** as a legacy agency-level record (`agentUserId: null`,
`legacy: { fromRepresentationId, regulatoryStatus: 'not_regulated_record',
representativeName }`). The source rows are untouched: the F10 lane and the
M16.2 relationship source keep reading them until P5.6E.

Clean boot: three empty stores (P §1). Boot contract: 127 production-read
stores, 0 missing (`m23BootContract`, 46 migration-guaranteed).

## 2. Server module — `scoutbox-server/m24/`

| File | Role |
|---|---|
| `shared.mjs` | the pure layer: `VERIFICATION_STATES`, `FACETS`, `RECHECK_MS` (30 d), `JURISDICTIONS` (INT/ENG/USA), `newFacets`, `effectiveFacetState` (VERIFIED decays to STALE past `recheckAt`; unknown → MANUAL_REVIEW_REQUIRED), `evaluateSubmission` (the provider abstraction), `requiredFacetsFor`, `verificationGap`; `TIERS`, `PERMISSIONS` (null-prototype), `can`, `capabilitiesOf`, `affiliationActive`, `affiliationChangeProblem`; `AGREEMENT_STATUSES`, `SCOPES`, `MAX_TERM_MONTHS` 24, `REQUEST_COOLDOWN_MS` 30 d, `effectiveAgreementStatus` (active past `endAt` reads `expired`, never written), `agreementGrantsAccess`, `requestConflict`, `AGENT_TRANSITIONS`/`CLIENT_TRANSITIONS` (null-prototype), the three projections |
| `errors.mjs` | `M24_ERROR_HTTP` (31 codes, bands 400/403/404/409/429/500, null-prototype), `PUBLIC_ERROR_FIELDS`, `sendAgentError` |
| `audit.mjs` | `agentAuditRows` — content-free rows for the organisation audit (`m182/audit.mjs` merges them for agency orgs) |
| `index.mjs` | `registerAgent(ctx)`: the routes in §3, `onPlayerDeleted` (tombstones), the synthetic-provider flag |

Wiring in `server.mjs`: `registerAgent({ ...m19Ctx, isAdult })` after the
M23 block; nine names in `EMITTED_EVENTS`; `/orgs?platform=agent` lists
agencies only; `POST /auth/org/login` refuses `platform: 'agent'` for a
non-agency (`403 PLATFORM_MISMATCH`); a static mount at `/agent`;
`deletePlayerData` calls the tombstone hook. `m12/journeys.mjs` exports
`opportunityBoardFor(db, player, deps)` — the ONE opportunity engine — so
the agent reads exactly the board the player sees.

## 3. Routes

Org (`/org/agent/*`, agency sessions only): `me`, `home`, `profile`
(GET/POST), `profile/facets/:facet/submit`, `agency`, `agency/team`
(GET/POST), `agency/team/:userId` (PATCH), `agency/team/:userId/end`,
`agency/settings` (PATCH), `agency/compliance`, `agency/audit`,
`players?q=`, `clients`, `clients/request`, `clients/:id`,
`clients/:id/terminate`, `clients/:id/opportunities`, `opportunities`,
`inbox`. Player (`/player/agent/*`): `relationships`,
`relationships/:id/{confirm,decline,terminate,dispute}`,
`relationships/:id/sharing` (PATCH). Admin (`/admin/agent/*`, shared key):
`relationships`, `profiles` — **read-only, and nothing else**.

The authorization order, the capability per route and every refusal are in
`M23_P56B_AGENT_AUTH_MATRIX.md` §1–§3.

## 4. Verification — facets, states, the provider that does not exist

Three facets, kept separate (`fifa_licence`; `national_registration` and
`minors_authorisation` keyed by member association). Six honest states:
`UNVERIFIED`, `PENDING`, `VERIFIED`, `STALE`, `INACTIVE`,
`MANUAL_REVIEW_REQUIRED`. A typed licence number is stored under
`declared` and changes no facet; changing it after verification resets the
FIFA facet to `UNVERIFIED` (E H12).

`evaluateSubmission` is the provider seam. **Production has no provider**:
a submission ends `MANUAL_REVIEW_REQUIRED` with provenance
`{ provider: 'none' }` and a note naming G-C0. The **local synthetic test
provider** exists only behind `AGENT_VERIFICATION_TEST_PROVIDER=1`
(development and tests): `TEST-VERIFIED-*` → `VERIFIED` with provenance
`local-synthetic-test-provider` and a 30-day `recheckAt`; `TEST-INACTIVE-*`
→ `INACTIVE`; any other reference is still manual review. `/org/agent/me`
reports `platform.testVerificationProvider` so the client says so on the
verification page. No route pretends to be FIFA, the FA or U.S. Soccer.

The regulated gate: a request in `INT` needs `fifa_licence` VERIFIED; in
`ENG` also `national_registration.ENG`; `minors_authorisation` is required
by nothing (recorded, never activated — DR-49). Consequence: **in
production no regulated request is possible until attributed review
exists** — the honest state of the build, not a gap papered over.

## 5. Membership and roles

Five tiers on one affiliation (`tiers[]`). The first person into an agency
with no active affiliation is bootstrapped as `agency_admin` (M14's
first-root-admin rule); everyone after must be added by an administrator
(E F6–F7). Ending a membership sets `endedAt`, sets `user.removedAt`,
revokes sessions and SSE at once; the profile and every attribution stay
(E I23–I26). Self-promotion and last-admin are refused (E I15–I16, C4–C9).
A job title typed at login grants nothing (E F2; live A4b).

## 6. Relationships

`proposed → active` only by the client's confirmation (`confirm`), which
stamps `confirmedAt`, `confirmedBy`, `startAt` and `endAt = startAt +
termMonths`. The client may `decline` or `dispute` a proposal and
`terminate` or `dispute` an active relationship; the agent may only
withdraw or end (`terminated_by_agent`). `expired` is derived from the
clock. `declined`, `expired`, `terminated_*` and `disputed` are terminal
for both sides in P5.6B; a decline or an end starts a 30-day cooldown
before the same agent may ask the same player again; a dispute blocks a new
request indefinitely (E D26–D32, M25).

Private access = `agreementGrantsAccess` ∧ `orgCanSee`. It is re-derived on
every read. The client controls `shareWithAgencyStaff`, which exposes a
summary (never data) to the agency's support roles.

## 7. Events, notifications, audit, rate limits, idempotency, rev

- **Events** (`m182/eventRegistry.mjs`): `agent_profile_created`,
  `agent_verification_state_changed`, `agency_affiliation_created`,
  `agency_affiliation_ended`, `representation_requested / confirmed /
  rejected / terminated / disputed` — all `org_private` / `org_internal`,
  ids and state words only, never replayed, notification-eligible, never
  analytics. Broadcast call sites are literal (D-P56B-9).
- **Notifications** (`m182/notificationPrefs.mjs`): new category
  `representation` (on by default, may be muted) for
  `representation_request / confirmed / rejected / terminated / disputed /
  expiring`; `agent_verification` and `agency_membership` are
  `security_account` (mandatory). The player is told "Nothing is active
  until YOU confirm it"; the agent is told a dispute needs attributed review
  that is not yet available.
- **Audit**: `agentAuditRows` (domains `agent`, `agency`,
  `representation`) merged into `GET /org/audit` for agency organisations
  and served alone on `GET /org/agent/agency/audit`; a dispute row records
  `hadReason: true`, never the reason; no reference or licence number.
- **Rate limits** (`m181/rateLimit.mjs`): `agent_representation_request`
  40/day per actor (counted only for attempts that reach the subject),
  `agent_player_lookup` 120/h, `agent_profile_write` 60/h,
  `agent_affiliation_write` 60/h per org, `agent_client_response` 30/h per
  player.
- **Idempotency**: payload-fingerprinted `clientKey` on member add, request,
  terminate, and each client action; replay returns `idempotent: true`;
  a different payload under the same key is a 409 collision; keys survive
  restarts (E W4–W5).
- **Rev**: `expectedRev` (M18.1 `guardRev`) on profile update, affiliation
  patch/end, terminate, every client action and sharing; conflicts name
  the current rev.

## 8. Tombstones

`onPlayerDeleted(playerId)` keeps every relationship naming the player as
an id-only record: `subjectRemovedAt` set, `disputeReason` nulled, a legacy
`representativeName` nulled, a pending proposal becomes `declined`, player
attributions in history become `{ kind: 'player', userId: null, name: null }`
(E U1–U5).

## 9. The Agent client — `scoutbox-agent/`

A fifth Vite + React app on port 5176, sharing `scoutbox-club`'s
dependency set through a `node_modules` symlink (the Grassroots pattern;
`scripts/setup.mjs` restores it). Copied verbatim from Pro: `navui.tsx`
(only the Home action centre replaced), `icons.tsx`, `httpState.ts`,
`conflict.tsx`, `dirtyGuard.ts`, `styles.css`, `main.tsx`. Its own:
`api.ts` (session on `platform: 'agent'`, `/orgs?platform=agent`,
notifications, SSE, report), `agentApi.ts` (typed projections + the
`AgentApi` client), `agentDemo.ts` (`VITE_DEMO=1`), `nav.ts` (four sections
+ Inbox utility; strict hashes `#/clients/:id[/tab]`, `#/agency/:tab`),
`i18n.ts` (EN + machine-translated FR, every shell key present),
`confirmAction.ts` (three destructive actions), `screens.tsx`, `App.tsx`.

Screens: **Home** (counts, alerts, tiers, the regulatory notice, "what this
workspace is"); **My profile & verification** (declaration form; one card
per facet with state, provenance, re-check date, note and a submit box; the
provider note; the regulated-actions table; history); **Clients** (lookup
of adult players, request form with scope/term/jurisdiction/exclusive,
lists by state, detail with Overview / Representation / Opportunities /
Activity tabs, access line, withdraw/end behind an explicit confirmation);
**Opportunities** (aggregate board with the honest scope line);
**Inbox** (pending requests + notices); **Agency** (Overview / Team /
Compliance / Settings + Audit). Every list reads a server projection;
refusals use the shared HTTP reading; conflicts the shared notice; the
sidebar filters on the tiers `/me` reported (fail closed until it answers).

Dev logins: any seeded agency user on the Agent platform (Tomás Rivera,
Director, migrated as `agency_admin`). Demo personas: Ana Costa (licensed
agent, verified), Tomás Rivera (admin), Ben Okoro (analyst).

## 10. The player app — "My Agent"

`scoutbox-player/src/components/MyAgentSection.tsx` on **You › Clubs**,
above the legacy Representation section (kept: `m13DemoSpotcheck` and the
F10 lane depend on it). `src/data/m24client.ts` (live) and `m24mock.ts`
(demo). The card lists each relationship with the agent's display name,
agency, scope, term, end date and the licence **state** with an honest
caveat; offers Confirm / Decline (proposal), End / Dispute (active) with a
private reason box, and the share-with-agency-staff toggle; renders nothing
for a minor. EN/FR keys `m24*`.

## 11. Registration in the monorepo

`scripts/setup.mjs`, `scripts/dev-all.mjs` (:5176), `Dockerfile`
(`/agent`), `.github/workflows/ci.yml` (agent job), `README.md`,
`e2e/buildDemos.mjs`, `e2e/sourceFingerprint.mjs`, `e2e/demoHost.mjs`,
`e2e/serve.mjs` (`/agent/`), `e2e/launcher.html` (card),
`e2e/navConfig.test.mjs` (agent block).

## 12. P5.6A refinements and deviations (each named, each reasoned)

| # | P5.6A said | P5.6B did | Reason |
|---|---|---|---|
| R1 | Verification claims in M14 with T&S review | Facets as own records; no M14 claim; no shared-key review | The mandate forbids a shared-key route that verifies a licence; M14 review is exactly that (G-C0). Facets are re-read on every act, which is what DR-6 wanted. |
| R2 | 422 / 503 error bands | Not used in P5.6B | No consent act and no provider exist yet. |
| R3 | Player answer through `db.requests` (DR-39) | Dedicated `/player/agent/relationships/*` routes + canonical `notify` | Legacy request `accept` opens a channel; a confirmation has different semantics and a different root. |
| R4 | `tier` (one) | `tiers[]` | An administrator may also be an agent; the admin bootstrap needs it. |
| R5 | Colleague sees nothing | Colleague sees a client-controlled summary | Privacy matrix "Other Agent at Same Agency" allowed a status summary at the client's choice; data never. |
| R6 | Trust projection `agency` case (DR-21) | Deferred | A feature with its own privacy decision; M16.2 semantics unchanged (E N12). |
| R7 | Agent as a Club Contact actor | Not done | Semantics are not compatible in P5.6B (no Transaction Room); no contact route exists for agents (E S12). |
| R8 | Agency login to the club app | Unchanged | The F10 lane and its suites still live there until P5.6E. |
| R9 | Lead heuristic on `user.role` | Used **only** by migration 2305 to seed `agency_admin`; never for a licence | S9: a self-typed role is not a licence. |

## 13. What P5.6B deliberately does not do

No Conflict Engine adjudication, no multiple-representation approval, no
regulatory override, no manual-review resolution, no dispute adjudication,
no minor compliance approval, no minor pathway (non-England or otherwise),
no transaction representation, no regulated negotiation, no Agent
Transaction Room, no service-fee enforcement, no Offer workflow, no writes
to `offer_*`/`signed`/`db.signings`, no Passport/Trust/Box Cam route for
agents, no email transport, no external register integration, no
agent-specific auth database. Every one is asserted absent by a test
(E B11, D2, D22, R5, S1–S14; L N4–N5).
