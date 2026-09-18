# M23 P5.6B — Agent Authorization Matrix (as implemented)

The server-side permission matrix ScoutBox Agent enforces, route by route,
as it exists in the tree after P5.6B. This is the implemented counterpart of
the frozen P5.6A contract (`M23_P56A_AGENT_AUTHORIZATION_CONTRACT.md`);
where the two differ the difference is named in §6 and recorded as a
P5.6A refinement in `M23_P56B_AGENT_IMPLEMENTATION.md` §12.

Source of truth in code: `scoutbox-server/m24/shared.mjs` (`PERMISSIONS`,
`can`, `affiliationChangeProblem`, `agreementGrantsAccess`,
`verificationGap`) and the route order in `scoutbox-server/m24/index.mjs`.
The client (`scoutbox-agent/src/nav.ts`, `screens.tsx`) mirrors
`capabilities` from `/org/agent/me` for convenience only; typing a hidden
route still hits the same server rules (live N3, N3b).

---

## 1. The authorization order (every mutation, P5.6A §132)

```
1 authenticate (bearer session → req.orgUser, req.org)          401 ORG_AUTH_REQUIRED
2 platform (org.type === 'agency')                               403 AGENT_ACTION_NOT_PERMITTED
3 membership (active agencyAffiliations row, or bootstrap)       403 AGENCY_MEMBERSHIP_REQUIRED
4 conceal foreign resource (other agency / other agent's row)    404 REPRESENTATION_NOT_FOUND
5 role (PERMISSIONS[capability] ∩ tiers)                         403 AGENT_ACTION_NOT_PERMITTED
6 relationship state / access basis                              409 REPRESENTATION_NOT_ACTIVE | REPRESENTATION_DISPUTED
7 block / safeguarding (isBlocked, isAdult, visibleToOrg)        404 PLAYER_NOT_FOUND (uniform)
8 objective verification (regulated only: verificationGap)       403 AGENT_PROFILE_REQUIRED | AGENT_VERIFICATION_REQUIRED
9 rev / idempotency (guardRev, clientKey fingerprint)            409 *_VERSION_CONFLICT | *_IDEMPOTENCY_CONFLICT
10 mutate → history → event → notification
```

One deliberate re-ordering against the contract's literal list: on
`POST /org/agent/clients/request` the **verification gap (8) is checked
before the subject lookup (7)**, so an unverified agent is refused on their
own state and learns nothing about whether a player exists, is a minor, is
invisible or has blocked the agency — the subject answers alike with a
uniform `404 PLAYER_NOT_FOUND` (m23AgentE2E K1, K6–K8, H7, O2). The
representation-request quota is consumed only by attempts that reach the
subject (D-P56B-7).

## 2. Roles (tiers) and capabilities

`PERMISSIONS` is a null-prototype table; `can()` answers only own keys
(D-P56B-1). A member's `tiers` is the array on their active affiliation;
several may be held.

| Capability | licensed_agent | agency_admin | analyst | assistant | finance |
|---|:-:|:-:|:-:|:-:|:-:|
| `me.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `profile.write.own` | ✓ | – | – | – | – |
| `verification.submit` | ✓ | – | – | – | – |
| `clients.read.own` | ✓ | – | – | – | – |
| `clients.read.shared_summary` | – | ✓ | ✓ | ✓ | ✓ |
| `clients.request` | ✓ | – | – | – | – |
| `clients.terminate` | ✓ | – | – | – | – |
| `clients.opportunities.read` | ✓ | – | – | – | – |
| `players.lookup` | ✓ | – | – | – | – |
| `inbox.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agency.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agency.team.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agency.team.write` | – | ✓ | – | – | – |
| `agency.settings.write` | – | ✓ | – | – | – |
| `agency.audit.read` | – | ✓ | – | – | – |
| `agency.compliance.read` | ✓ | ✓ | – | – | – |

There is **no** capability named verify, approve, resolve, override or
adjudicate for any tier (m23AgentE2E B11). An administrator is not an agent:
every regulated or client capability is `licensed_agent` only (B4), and the
tier itself grants nothing regulated until the agent's own facets are
VERIFIED (§4).

Role-change invariants (`affiliationChangeProblem`, C4–C10, I13–I21):
nobody grants themselves `agency_admin` (`SELF_PROMOTION_BLOCKED`); the
last active administrator can be neither demoted nor ended (`LAST_ADMIN`);
an ended affiliation does not count; an administrator may add
`licensed_agent` to their own roles because the tier is agency governance,
not a licence.

## 3. Routes

| Route | Step 5 capability | Further gates | Refusals it can answer |
|---|---|---|---|
| `GET /org/agent/me` | membership only | — | 401, 403 |
| `GET /org/agent/home` | membership only | — | 401, 403 |
| `GET /org/agent/profile` | membership only | own profile only | 401, 403 |
| `POST /org/agent/profile` | `profile.write.own` | rev on update; rate `agent_profile_write` | 400 AGENT_INPUT_INVALID / AGENT_JURISDICTION_INVALID, 409 REPRESENTATION_VERSION_CONFLICT, 429 |
| `POST /org/agent/profile/facets/:facet/submit` | `verification.submit` | profile required; facet ∈ FACETS; national facet needs ENG/USA (D-P56B-5) | 400 AGENT_FACET_INVALID / AGENT_INPUT_INVALID / AGENT_JURISDICTION_INVALID, 403 AGENT_PROFILE_REQUIRED, 429 |
| `GET /org/agent/agency` | membership only | — | 401, 403 |
| `GET /org/agent/agency/team` | `agency.team.read` | — | 403 |
| `POST /org/agent/agency/team` | `agency.team.write` | clientKey idempotency; removed user refused; rate `agent_affiliation_write` (org) | 400, 403, 409 MEMBER_ALREADY_AFFILIATED / AFFILIATION_IDEMPOTENCY_CONFLICT, 429 |
| `PATCH /org/agent/agency/team/:userId` | `agency.team.write` | SELF_PROMOTION_BLOCKED, LAST_ADMIN, rev | 400 AGENT_TIERS_INVALID / EXPECTED_REV_INVALID, 403, 404 MEMBER_NOT_FOUND, 409 LAST_ADMIN / AFFILIATION_VERSION_CONFLICT |
| `POST /org/agent/agency/team/:userId/end` | `agency.team.write` | LAST_ADMIN, rev; ends sessions (`revokeOrgUserAccess`), sets `user.removedAt` | 404, 409 |
| `PATCH /org/agent/agency/settings` | `agency.settings.write` | jurisdictions ⊆ JURISDICTIONS; description moderated | 400, 403 |
| `GET /org/agent/agency/compliance` | `agency.compliance.read` | informational: states only | 403 |
| `GET /org/agent/agency/audit` | `agency.audit.read` | cursor pagination ≤ 50 | 400 AUDIT_CURSOR_INVALID, 403 |
| `GET /org/agent/players?q=` | `players.lookup` | adults only; `visibleToOrg`; not blocked; ≥ 2 chars; ≤ 20; rate `agent_player_lookup` | 403, 429 |
| `GET /org/agent/clients` | membership | own rows need `clients.read.own`; summary rows need `clients.read.shared_summary` AND the client's `shareWithAgencyStaff` (or a legacy row) | 403 |
| `POST /org/agent/clients/request` | `clients.request` | input; idempotency replay; **verification gap**; rate `agent_representation_request`; uniform 404 subject; conflict/cooldown | 400 AGENT_SCOPE_INVALID / AGENT_TERM_INVALID / AGENT_JURISDICTION_INVALID / AGENT_CLIENT_KEY_INVALID, 403 AGENT_PROFILE_REQUIRED / AGENT_VERIFICATION_REQUIRED, 404 PLAYER_NOT_FOUND, 409 REPRESENTATION_ALREADY_EXISTS / REPRESENTATION_IDEMPOTENCY_CONFLICT, 429 REPRESENTATION_COOLDOWN / RATE_LIMITED |
| `GET /org/agent/clients/:id` | membership | own → full; shared/legacy → summary; else **404** | 404 REPRESENTATION_NOT_FOUND |
| `POST /org/agent/clients/:id/terminate` | `clients.terminate` | own only; legacy read-only; AGENT_TRANSITIONS (proposed/active only); rev; idempotency | 403, 404, 409 REPRESENTATION_NOT_ACTIVE / REPRESENTATION_VERSION_CONFLICT / REPRESENTATION_IDEMPOTENCY_CONFLICT |
| `GET /org/agent/clients/:id/opportunities` | `clients.opportunities.read` | own; **`agreementGrantsAccess` AND `orgCanSee`** | 403, 404, 409 REPRESENTATION_NOT_ACTIVE |
| `GET /org/agent/opportunities` | `clients.opportunities.read` | per agreement: `agreementGrantsAccess` AND `orgCanSee` | 403 |
| `GET /org/agent/inbox` | `inbox.read` | own notifications + own pending | 403 |
| `GET /player/agent/relationships` | player session | minor → empty list with `minor: true` | 401 |
| `POST /player/agent/relationships/:id/{confirm,decline,terminate,dispute}` | player session | not a minor; own record; not legacy; clientKey; CLIENT_TRANSITIONS; block on confirm; rev; rate `agent_client_response` | 400, 403 AGENT_ACTION_NOT_PERMITTED, 404, 409 REPRESENTATION_NOT_ACTIVE / REPRESENTATION_DISPUTED / REPRESENTATION_VERSION_CONFLICT / REPRESENTATION_IDEMPOTENCY_CONFLICT, 429 |
| `PATCH /player/agent/relationships/:id/sharing` | player session | not a minor; own record; rev | 403, 404, 409 |
| `GET /admin/agent/relationships` | shared T&S key | **read-only**; dispute reasons withheld | 401 ADMIN_KEY_REQUIRED |
| `GET /admin/agent/profiles` | shared T&S key | **read-only**; states + provenance only; references and licence numbers withheld (D-P56B-6) | 401 |

**No admin mutation exists.** Seventeen conceivable adjudication routes
(`/resolve`, `/approve`, `/override`, `/verify`, `/reject`, `/minors/approve`,
`/manual-review`, `/regulatory/override`, `/conflicts/adjudicate`,
`/multiple-representation/approve`, PATCH/PUT/DELETE on a relationship…)
answer 404 with the shared key, and the disputed relationship and the
profile are byte-identical afterwards (m23AgentE2E R5–R7). Agent facets are
not M14 claims, so the shared-key claim review cannot reach them (R8).

## 4. The regulated gate (step 8)

`verificationGap(profile, jurisdiction, now)`:

| Jurisdiction of the act | Facets that must be `VERIFIED` now |
|---|---|
| `INT` | `fifa_licence` |
| `ENG` | `fifa_licence` + `national_registration.ENG` |
| `USA` | `fifa_licence` (no national facet is required in P5.6B) |

`minors_authorisation` is required by no act. Effective state derives from
the record and the clock: a `VERIFIED` facet whose `recheckAt` has passed
reads `STALE`; an unknown stored state reads `MANUAL_REVIEW_REQUIRED`; a
missing facet reads `UNVERIFIED`. Only `VERIFIED` closes the gap (A20–A27).

In production no provider exists and no attributed reviewer exists, so a
submission ends `MANUAL_REVIEW_REQUIRED` and the regulated act stays
refused — the honest state of the build (A11, G12–G13). The synthetic
provider (`AGENT_VERIFICATION_TEST_PROVIDER=1`) is the only path to
`VERIFIED` and names itself in the provenance.

## 5. The access predicate (step 6)

```
agreementGrantsAccess(a, agentUserId, now) :=
  a.agentUserId is a non-empty string
  ∧ a.agentUserId === agentUserId
  ∧ a.confirmedAt != null
  ∧ effectiveAgreementStatus(a, now) === 'active'
```

then, at the route, `∧ orgCanSee(agency, player)` (block + visibility).
A proposal, a dispute, a termination, an expiry, a colleague's agreement, a
legacy agency-level row and agency membership itself all grant nothing
(D11–D19; live B19, E2, N2c, N3). The client's confirmation is the root.

## 6. Differences from the P5.6A contract, named

| Contract said | P5.6B implements | Why |
|---|---|---|
| Verification as M14 claims with T&S review outcomes | Facets as own records on `agentProfiles`; no claim, no shared-key review lane | The M14 review is shared-key adjudication, which the mandate forbids for licences (G-C0); facets are re-read on every act (DR-6) |
| Status 422 for policy outcomes needing a further act | Not used in P5.6B | No consent/guardian act exists in P5.6B (minors excluded) |
| Status 503 for provider failure | Not used in P5.6B | No provider exists to fail; the honest outcome is `MANUAL_REVIEW_REQUIRED` |
| Player answer via `db.requests` type | Dedicated `/player/agent/relationships/*` routes | Legacy request semantics (accept = channel) do not fit a confirmation whose root is the client (DR-39 deviation) |
| Single `tier` | `tiers[]` | One person may be both administrator and agent |
| Same-agency colleague sees nothing | Colleague sees a **summary** (id, status, dates, client name) only where the client toggled `shareWithAgencyStaff` | Privacy matrix "Other Agent at Same Agency": client-controlled, never client data (M10–M15) |
