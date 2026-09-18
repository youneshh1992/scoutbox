# M23 P5.6B — ScoutBox Agent Core App: Final Report

Branch `claude/desktop-project-migration-wyk3ec`. Stage 1 of this mandate
pushed exactly `fe4b18e` (the frozen P5.6A tip) to
`origin/claude/desktop-project-migration-wyk3ec`; that authorisation was
consumed there. **Nothing of P5.6B was pushed, no PR was opened, nothing was
deployed, no P5.6A commit was amended or rebased, `origin/main` (`b2eca8e`)
was not touched.**

Documents of record: `M23_P56B_AGENT_IMPLEMENTATION.md`,
`M23_P56B_AGENT_AUTH_MATRIX.md`, `M23_P56B_AGENT_PRIVACY_VERIFICATION.md`,
`M23_P56B_AGENT_TEST_REPORT.md`, `M23_P56B_AGENT_DEFECT_REGISTER.md`, this
report. The frozen P5.6A set is unchanged.

## §104 — the 75 items

1. **Starting tip** — `fe4b18e` (P5.6A closure pass 2), pushed as Stage 1 with all seven pre-checks matching (branch, HEAD, clean tree, origin at `669d060`, ahead 4 / behind 0, `origin/main` untouched). After the push local == origin == `fe4b18e`.
2. **Final local tip** — the closure commit that carries this report; its hash is printed in the chat reply and by `git rev-parse HEAD`. P5.6B commits: `c98034b` (server), `e6518a8` (clients + registration), `6fbf675` (browser suites, D-P56B-9/-11, four documents), then the closure commit (test report, final report). Four P5.6B commits on top of `fe4b18e`; `origin/claude/desktop-project-migration-wyk3ec` remains at `fe4b18e`.
3. **Schema** — 2304 → **2305**, exactly one step (`m240_001_agent_core_stores`), idempotent, non-destructive. Clean boot works (three empty stores; `/healthz` reports 2305); upgrade from 2304 works (P §2–§3); a pre-M23 snapshot upgrades 2200 → 2305 (`m23Persistence` §47).
4. **New stores** — `agentProfiles`, `agencyAffiliations`, `representationAgreements`, all `migration`-guaranteed in `storeContract.mjs`, owner `m24`, production-required (`m23BootContract`: 127 production-read stores, 0 missing).
5. **No agent-specific auth database** — sessions, tokens and `db.users` are the existing ones; an agency user logs in on `platform: 'agent'` with the same `/auth/org/login` (E T1, E1–E9).
6. **Agent identity model** — User → Agent Profile → Agency Affiliation(s). The profile is personal (`userId`); the affiliation is a dated membership with `tiers[]`; the agency (`org.type === 'agency'`) holds no licence and no claim, and every screen says so.
7. **Agency is not the licence holder** — `GET /org/agent/agency` states it; `verificationGap` reads only the natural person's facets; the migration bootstraps nobody as `licensed_agent` (P §2, E F2, live A4b).
8. **Verification states** — `UNVERIFIED`, `PENDING`, `VERIFIED`, `STALE`, `INACTIVE`, `MANUAL_REVIEW_REQUIRED`; STALE is derived from `recheckAt` (30 d); an unknown stored state reads MANUAL_REVIEW_REQUIRED; `storedState` is shown beside the effective state (E A1–A10, P §5).
9. **No fake regulator API** — production submissions end `MANUAL_REVIEW_REQUIRED` with provenance `{ provider: 'none' }` and a note naming G-C0 (E A11, G12); the client says "No FIFA, FA or U.S. Soccer register integration exists in this build" (live B8/B10b).
10. **Synthetic test provider** — `AGENT_VERIFICATION_TEST_PROVIDER=1`, `TEST-VERIFIED-*`/`TEST-INACTIVE-*` only, provenance `local-synthetic-test-provider`, note "never exists in production"; reported by `/org/agent/me` and shown on the verification page (E A12–A15, H1; live B8, B11).
11. **Separate facets** — `fifa_licence`, `national_registration{ma}`, `minors_authorisation{ma}`; a FIFA facet closes no ENG gap (E A22, H2–H3; live B12–B13).
12. **Declared ≠ verified** — a typed licence number lives under `declared` and changes no facet; changing it after verification resets the FIFA facet (E A20, G5–G6, H12; live B7).
13. **Regulated gate** — request requires the required facets VERIFIED now; consequence: no production request until attributed review exists, stated in code comments, docs and the UI (E G13, H13, K1).
14. **Roles** — `licensed_agent`, `agency_admin`, `analyst`, `assistant`, `finance`; several per affiliation; the matrix in `M23_P56B_AGENT_AUTH_MATRIX.md` §2 (16 capabilities, E B1–B13).
15. **Server-side permission matrix** — `PERMISSIONS` (null-prototype) and `can()` enforced by `requireCap` on every route; the client only mirrors `capabilities` (live N3, N3b: typing a hidden route hits the same refusal).
16. **No verify / approve / resolve / override capability exists** for any tier (E B11).
17. **Membership bootstrap** — the first person into an agency with no active affiliation becomes `agency_admin` (M14's first-root-admin rule); everyone after is `AGENCY_MEMBERSHIP_REQUIRED` until added (E F6–F7).
18. **Role-change invariants** — no self-promotion to admin; last admin can be neither demoted nor ended; ended admins do not count (E C4–C9, I13–I16).
19. **Time-aware affiliations** — `startedAt`/`endedAt`; ending revokes sessions and SSE at once, sets `user.removedAt`, keeps profile and attributions (E I23–I26, W7). Documented limitation: identity is per-organisation, so "remove from agency" and "remove from organisation" coincide in this build.
20. **Clients foundation** — prospect ≠ client: the list is empty until a request exists and a request is listed under "Awaiting the client's answer"; a CRM row is not representation (no CRM notes, tags or pipeline were built — "Do NOT overbuild CRM").
21. **Representation statuses** — the P5.6A names: `proposed`, `active`, `declined`, `expired` (derived), `terminated_by_client`, `terminated_by_agent`, `disputed` (E D1–D2).
22. **Client confirmation root** — only `POST /player/agent/relationships/:id/confirm` by the subject makes a relationship active; it stamps `confirmedAt`, `confirmedBy`, `startAt`, `endAt` (E L11; live C6).
23. **Agent claim ≠ private access** — a proposal grants nothing; the detail says `access: false`; the board is 409 (E D14, K18–K20; live B19–B20).
24. **Access predicate** — `agreementGrantsAccess` ∧ `orgCanSee`, re-derived per read; nine negative cells (E D11–D19).
25. **Transitions** — client: proposed → active | declined | disputed; active → terminated_by_client | disputed. Agent: proposed | active → terminated_by_agent. Terminal states are terminal for both sides (E D20–D25).
26. **Dispute** — suspends access, blocks re-request, cannot be ended or re-confirmed by either side, reason private to the client, both apps say attributed review is not yet available (E M18–M27; live E1–E6).
27. **Expiry** — derived from `endAt`; Home alerts and notifies once (`representation_expiring`) within 30 days; an expired relationship needs a new confirmation (E D8–D9, Home).
28. **Cooldown** — 30 days after a decline or an end before the same agent may ask the same player again, with `retryAt` (E D29–D31, M30, M41).
29. **Term cap** — 24 months (FFAR 12(3) / FA 4.3), default 12; 25, 0, fractions, text refused (E D5–D6, K3).
30. **Scope** — `employment | transfer | commercial | other_services`; unknown scope refused (D-P56B-4; E K4).
31. **Jurisdiction on the request** — `INT | ENG | USA`; the gate widens for ENG (E H3–H4).
32. **Player "My Agent"** — `MyAgentSection` on You › Clubs: confirm / decline / end / dispute (private reason) / share-with-staff toggle; the agent's licence state with an honest caveat; nothing for a minor; EN/FR (live C2–C7, E1, N9, N10; demo spotcheck).
33. **Legacy Representation section kept** — the M13 F10 lane is untouched and its demo spotcheck still passes; legacy rows appear read-only in My Agent with no verification claim (P §3).
34. **Opportunities projection** — reuses the ONE engine (`opportunityBoardFor` extracted from `m12/journeys.mjs`); the agent reads exactly the board the player sees; applying stays the player's act; no route lets an agent apply (E M2–M4, S14; live D3–D4).
35. **Club-private cases never appear** — the board carries open trials, campaigns, open days etc. from the player's engine; no `case-`/`room-` id; the aggregate board says so (E M3; live D6).
36. **Inbox** — reuses canonical `notify` and `/org/notifications`; the Agent inbox merges own notifications and own pending requests; the bell deep-links a `rep-*` refId to the client (E K17, L17).
37. **Agency workspace** — Overview (counts, roles, honest line), Team (add, roles, end), Compliance (informational only, states not numbers), Settings (jurisdictions, moderated description) + Audit (admin only, cursor-paginated) (E I1–I32, H16–H18, T2; live A5–A7, N2).
38. **Verification UI** — one card per facet with state pill, provenance, submitted and re-check dates, the facet note, a submit box; the provider note; the regulated-actions table; history without references (live B6–B13, N6g).
39. **Events** — nine `org_private`/`org_internal` events, ids and state words only, never replayed, never analytics; literal broadcast call sites; the M18.2 audit is green (E T1, L12–L13).
40. **Notifications** — new `representation` category (on by default, mutable), `agent_verification`/`agency_membership` as security/account (mandatory); every text is honest about what is and is not active (E L4, M27, M42).
41. **Audit** — content-free rows in three domains merged into `/org/audit` and served on `/org/agent/agency/audit`; a dispute row says `hadReason: true` only (E T2, L18–L20).
42. **Rate limiting** — five policies; the request quota counts only attempts that reach a subject (D-P56B-7); the lookup limit fires per actor (E Q1–Q3).
43. **Idempotency** — fingerprinted `clientKey` on member add, request, terminate and every client action; replay / collision / restart (E I7–I8, K13–K14, L14, M37–M38, W4–W5).
44. **Rev** — `expectedRev` on every rev-guarded mutation with the M18.1 conflict body and the shared conflict notice in the client (E I17–I18, H11, L9).
45. **Concurrency** — five parallel confirmations → one wins; three parallel requests → one created (E P1–P5).
46. **Tenant isolation** — every read scoped to `agencyOrgId`; foreign and colleague records 404, never 403 (E M5–M7, N8–N10; live N3).
47. **Blocks** — vanish from lookup, uniform 404 on request, confirmation through a block refused and explained, unavailable identity afterwards (E O1–O6).
48. **Tombstones** — id-only record after player deletion; reason and attributions nulled; survives restart (E U1–U5, W8).
49. **Minors** — never in the lookup, uniform 404 on request, empty My Agent with `minor: true`, cannot act; the minors facet is recorded and activates nothing; **no non-England minor path exists**; guardian controls untouched (E H5–H7, J5, N6–N7; live B15, N10).
50. **General agency minor discovery remains blocked** — `visibleToOrg` returns false for every minor and every agency; unchanged (E J5).
51. **Agent never logs in as Player** — org sessions and player sessions are distinct; a player token is 401 on `/org/agent/*`, an agent token 401 on `/player/agent/*` (E E8, L7).
52. **Agent does not own Passport, Trust, Box Cam** — no route exists; the Trust projection has no agent term (E S9–S11, N12).
53. **No offer / signed / signings writes** — asserted on the store after the whole suite (E S1–S3); no offer, sign, transactions or fees route (E S7–S8, S13); ten screens swept for offer/negotiation/commission/fee/transaction wording after removing the sentences that say there is none (live N5).
54. **Never pay to be seen** — no ranking, no paid placement, no score; the Opportunities board is the player's own engine output in deadline order.
55. **M16.2 semantics unchanged** — `m162E2E` green including the a3ebc7a regression; the club's player view carries no agent data (E N11).
56. **Agent is not a Club Contact actor** — no contact route for agents (E S12); documented as R7.
57. **Agency login to the club app unchanged** — P5.6E retires that lane (R8).
58. **Platform gating** — `/orgs?platform=agent` lists agencies only; a club or grassroots login on the agent platform is `403 PLATFORM_MISMATCH`; the login page shows one card (E E2–E5; live N1).
59. **T&S — read-only, no adjudication route** — two GET routes; seventeen conceivable adjudication routes answer 404 with the shared key; the disputed relationship and the profile are byte-identical afterwards; agent facets are not M14 claims (E R1–R10; live E6). **No route exists by which the shared key can verify or reject a licence, resolve a dispute, approve a minor pathway or override a regulatory state.** Not a blocker: the route does not exist.
60. **Error contract** — 31 `AGENT_*`/`REPRESENTATION_*`/`AFFILIATION_*`/`MEMBER_*`/`LAST_ADMIN`/`SELF_PROMOTION_BLOCKED`/`PLAYER_NOT_FOUND` codes, null-prototype table, whitelisted public fields; every refusal in the suite carried a code and no stack (E D38–D40, E2).
61. **The fifth app** — `scoutbox-agent` (Vite + React, :5176, shared `node_modules` symlink), copied shell from Pro, four sections + Inbox, strict hashes, EN/FR, demo mode, dev logins; typecheck and both builds green.
62. **Navigation** — `navConfig` 339 checks (agent block: integrity, EN/FR labels incl. the 11 shell keys, resolver, tier filtering that fails closed before `/me`, palette never reveals Opportunities to a non-agent, strict deep links, shortcuts); `navLive` 64 checks unchanged for Pro/Grassroots/T&S.
63. **Responsive** — 1440 (all journeys), 390 and 360 with no horizontal scroll on login, Home, Clients, a client detail with tabs and the verification page; the drawer opens from the hamburger; the player app at 390 shows My Agent (live N6a–g, N9).
64. **Accessibility** — `role=tablist/tab/tabpanel` with `aria-selected`/`aria-controls`; every request-form control labelled; the lookup names its hint; live regions on loading and toasts; the browser-native confirm for destructive acts (live N7a–c).
65. **EN/FR** — 250 keys in the agent app, every navigation and shell key in both dictionaries; the sidebar and a disputed client render in French with no English fallback; 22 `m24*` keys in the player app (live N8a–b; navConfig).
66. **Demo mode** — `VITE_DEMO=1` with three personas (Ana licensed + verified, Tomás admin, Ben analyst), a pre-seeded active/pending/disputed/declined set, a simulated counterparty (Kwame Osei confirms); the player demo's My Agent lists two requests with honest states; `scoutbox-agent-demo.html` (342 kB) built, inlined, badged, fingerprinted; `demoFreshness` 16 green; `m23AgentDemoSpotcheck` 12 green with zero page errors.
67. **Dev login** — any seeded agency user on the Agent platform; Tomás Rivera (Director) is migrated as `agency_admin` and must grant `licensed_agent` explicitly (live A1–A7).
68. **Registration** — `setup.mjs` (symlink), `dev-all.mjs` (:5176), `Dockerfile` (`/agent`), CI job, README, `buildDemos`, `sourceFingerprint`, `demoHost`, `serve`, `launcher.html`.
69. **`m23AgentE2E`** — 407 checks, 250 negative (61 %), groups A–W as mapped in the test report, including the T&S anonymous-review block (R) and the subsystem sweep (S).
70. **`m23AgentPersistence`** — 68 checks, 24 negative: one step, upgrade from 2304 with legacy mirroring, real boot over the snapshot, clean-boot round trip, corruption contained.
71. **`m23AgentLive`** — 82 checks, 25 negative, zero page errors: admin → agent → client confirmation → access → dispute, plus ten negative groups.
72. **§95 regressions** — all green on the final tree (test report §2): m162E2E 136, m17E2E 515, m18E2E 287, m181E2E 196, m182E2E 365, m22Blocker 60, m23E2E 382, m23ContactE2E 418, m23TrialE2E 535, m23DecisionE2E 435, m23P4AClosureE2E 337, m23BootContract 61, m23Persistence 67, m23ContactPersistence 61, m23TrialPersistence 36, m23DecisionPersistence 48, navConfig 339, navLive 64, demoFreshness 16. Three suites had their `=== 2304` pins updated to the truth (step 2304, schema 2305).
73. **Typechecks / builds** — five apps typecheck; four Vite builds and the Expo web export succeed; every demo bundle rebuilt.
74. **Defects** — 11 found and fixed in P5.6B (3 Medium: D-P56B-1 prototype capability crash, D-P56B-2 null-agent legacy access in the pure predicate, D-P56B-4 silent scope default; 8 Low), one pre-existing Low observation recorded (D-P56B-12), D-P56A-9 (shared T&S identity) **open and not downgraded** as the P5.6C gate G-C0. Zero Critical, zero High.
75. **Commit / push discipline** — four local commits with attribution lines; no amend, no rebase, no force-push, no PR, no deploy, no P5.6B push; the tree is clean at the final tip (`git status --short` empty).

## §105 — truth block

```
Fifth app (scoutbox-agent) exists and builds: YES
Agent identity = User → Agent Profile → Agency Affiliation(s): YES
Agency → licence modelled anywhere: NO
Verification states honest (UNVERIFIED/PENDING/VERIFIED/STALE/INACTIVE/MANUAL_REVIEW_REQUIRED): YES
Fake regulator API introduced: NO
Synthetic provider clearly local, flag-gated, self-naming, absent in production: YES
Self-typed licence number treated as verified: NO
Regulated request possible in production without attributed review: NO
Facets kept separate (FIFA / national / minors): YES
Server-side permission matrix enforced on every route: YES
Client filtering treated as authorization: NO
Prospect ≠ client, CRM entry ≠ representation: YES
Agent claim = private access: NO
Client confirmation is the root of private access: YES
Access re-derived from record + clock on every read: YES
Dispute suspends access and is terminal in P5.6B: YES
Any P5.6B surface resolves a dispute: NO
Opportunities reuse the existing board engine: YES
Club-private recruitment cases reachable by an agent: NO
Agent can apply on the client's behalf: NO
Inbox reuses canonical notifications: YES
Events registered, org_private, ids only: YES
Audit content-free: YES
Rate limiting, idempotency, rev, tenant isolation, blocks, tombstones: YES
EN/FR complete for the Agent app and the player card: YES
Responsive at 1440/1280/390/360 (390/360 asserted live): YES
Demo mode + dev login: YES
One idempotent migration, 2304 → 2305: YES
Clean boot works: YES
Upgrade from 2304 works: YES
Agent-specific auth database introduced: NO

Conflict Engine adjudication implemented: NO
Multiple-representation approval implemented: NO
Regulatory override implemented: NO
Manual regulatory-review resolution implemented: NO
Representation dispute adjudication implemented: NO
Minor compliance approval implemented: NO
Transaction representation / regulated negotiation / Agent Transaction Room: NO
Service-fee enforcement / Offer workflow: NO
offer_made / offer_accepted / offer_declined / signed writes, db.signings writes: NO
Never pay to be seen honoured: YES

Route by which the shared T&S key can verify/reject a licence: NO (17 probes → 404)
Route by which the shared T&S key can resolve a dispute: NO
Route by which the shared T&S key can approve a minor pathway: NO
Route by which the shared T&S key can override regulatory state: NO
T&S per-reviewer identity issue hidden or downgraded: NO (D-P56A-9 open, G-C0)

General agency minor discovery remains blocked: YES
Non-England minor representation activated: NO
Minor architecture preserved, production activation deferred: YES
Guardian controls preserved: YES

Agent logs in as Player: NO
Agent owns Player profile / Passport: NO
Agent can edit Trust Score: NO
Box Cam backdoor: NO
M16.2 semantics changed: NO (a3ebc7a regression green)
Agent made a Club Contact actor: NO

Frozen P5.6A commits amended or rebased: NO
P5.6B pushed: NO
Force-pushed: NO
PR opened: NO
Deployed: NO
Tree clean at final tip: YES

Open Critical: 0
Open High: 0
Open reasonably-fixable Medium: 0
Open Medium prerequisite before P5.6C: 1 (D-P56A-9 / G-C0)
```

## §106 — success and NOT READY

**P5.6B succeeded** as the foundation the mandate scoped: identity,
membership, verification state, relationship records, the Clients
workspace, the Agent inbox, the Opportunities shell, navigation, and the
player/club integration foundations, each proven by a dedicated suite and
a live journey, with every existing regression green and nothing pushed.

**NOT READY for production, and says so in every surface:**

- No regulated action is possible in production. Verification cannot reach
  `VERIFIED` without a provider or attributed review; both are absent by
  design. A production agent's request is refused with
  `AGENT_VERIFICATION_REQUIRED` and the honest reason. This is correct, not
  a gap: the alternative was a fake register.
- Disputes cannot be resolved. They suspend access and stop. Resolution is
  P5.6C, gated on **G-C0** (per-reviewer Trust & Safety identity,
  D-P56A-9, open).
- No conflict engine, no multiple-representation policy, no transaction
  room, no offer, no fee. The Agent workspace states what it is not.
- The minor pathway is recorded and inert. Minors are unreachable from the
  Agent platform in every direction.
- The legacy F10 representation lane still exists beside the new store
  (mirrored read-only) until P5.6E retires it; the club app's Representation
  screen and the player's earlier Representation section are unchanged.
- Identity is per-organisation, so ending an agency membership ends the
  person's access to that organisation; a person's profile survives, but a
  cross-organisation identity is not modelled in this build.
- One pre-existing Low boot warning (D-P56B-12, P5's decision events not
  listed in `EMITTED_EVENTS`) is recorded, not fixed here.

## §107 — commit / push discipline, as executed

Stage 1: `git push -u origin claude/desktop-project-migration-wyk3ec`
carried `669d060..fe4b18e` after the seven checks; verified local == origin
== `fe4b18e`. Stage 2: four local commits, none pushed. `origin/main`
`b2eca8e`, untouched. No amend, no rebase, no force, no PR, no deploy.

## §108 — stop

P5.6B stops here. P5.6C (attributed T&S identity G-C0, dispute and conflict
adjudication, compliance decisions) is not begun.
