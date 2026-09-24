# M23 P7 — Signing & Contract Completion: final report

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen tip
`1217e5b` (P6.1 R5, local = remote at Stage 0). Local commits R1–R6 only —
**no push, no PR, no deploy** — as the mandate requires (§109, §110).

The principle this milestone builds and proves:

    Offer accepted ≠ signing opened ≠ party confirmed ≠ signing completed

An accepted Offer creates no signing. A recruitment lead opens a signing
package over the exact accepted Offer revision by an explicit act, attaches
the exact document, presents it. The player confirms that exact document
as themselves; the club's recruitment lead signs for the club under their
own name; only the canonical completion — a further explicit act behind the
completion gate, in one unit of work with rollback — writes the
`db.signings` row, moves the case to `signed` through the ONE validator and
the ONE lifecycle writer, and marks the player `under_contract`. ScoutBox
records the workflow and the evidence; it claims no legal effect it cannot
prove.

## The 85 items (§106)

| # | Item | Answer |
| --- | --- | --- |
| 1 | starting tip | `1217e5b` (local = remote, 0/0, clean) |
| 2 | final local tip | R6 = the commit that contains this file (its hash is in the delivery message; a file cannot contain its own commit's hash). R5 = `ea071ce`, R4 (final functional tip) = `75dc6cb` |
| 3 | remote tip | `1217e5b` — unchanged; `origin/main` `b2eca8e` unchanged |
| 4 | starting schema | 2307, 17 migrations |
| 5 | final schema | 2308, 18 migrations |
| 6 | migration | `m280_001_signing_workflow`: creates `db.signingPackages = []`; nothing backfilled, no legacy row reinterpreted (persistence 1) |
| 7 | workflow store | `db.signingPackages` (migration-guaranteed, owner m29, in `storeContract`): one package per (Offer, attempt) with embedded revisions, parties, documents, keys, history, completion (M23_P7_SIGNING_MODEL.md) |
| 8 | `db.signings` semantics | the completed-signing record only: one row per completed package (`method: 'CANONICAL_COMPLETION'`) or per legacy recording (`LEGACY_RECORDED`); never for an in-progress, cancelled, voided, expired or superseded package; legacy-compatible fields kept (M23_P7_CONTRACT_STATUS_SEMANTICS.md) |
| 9 | signing statuses | package DRAFT, READY, IN_PROGRESS, COMPLETED, CANCELLED, VOIDED (stored) + EXPIRED (derived, never written); revision adds SUPERSEDED (M23_P7_SIGNING_STATE_MACHINE.md) |
| 10 | revision model | monotonic `revisionNumber`; DRAFT editable, presented immutable; a changed document is a new revision with every party pending; old revisions kept with pointers both ways |
| 11 | Offer precondition | `canStart`: Offer ACCEPTED and its revision ACCEPTED, case `offer_accepted`, recipient allowed, no live or completed package; `offerRevisionId` binds the exact revision; a stale binding is corruption (R4) |
| 12 | explicit initiation | `POST /org/offers/:id/signing` by a room/recruitment lead with a `clientKey`; the club tab offers the button only when readiness allows and says nothing is presented until presented (live A4–A5); acceptance creates nothing (B3, B4, live A3b) |
| 13 | Club auth | `roomCan(role,'offer_view')` to read, `'offer_issue'` to manage; `isLead` to sign for the club, complete and void; re-derived per request; demotion takes effect on the next request (C12) (M23_P7_SIGNING_AUTH_MATRIX.md) |
| 14 | Player auth | the addressed adult only, party `PLAYER` with `forEntityId` = their id, the exact current revision and digest, their own session; another player 404; twice refused |
| 15 | guardian/minor | pathway table closed in every jurisdiction; `canStart` refuses `SIGNING_PATHWAY_CLOSED`; guardian routes dormant and fail-closed (list `[]`, read 404, act 422); readiness names the pathway for a minor before any Offer (D-P7-2); no minor agent representation touched |
| 16 | Agent | read-only `signingAgentView` under `/org/agent/clients/:id/signings` over Offers the client shared, with own agreement + `client_private` decision + employment/transfer scope + current licence; no write route; same-agency 404; revoked → 403 and the app's deep link shows no access (live D, E) |
| 17 | required parties | derived from the accepted revision's recipient snapshot: `PLAYER` + `CLUB_SIGNATORY` (or `GUARDIAN` + `CLUB_SIGNATORY`, never reached); no optional, witness or agent party (M23_P7_SIGNING_PARTY_MODEL.md) |
| 18 | party completion | `canCompleteParty`: current revision named, party pending, actor kind allowed (`PARTY_ACTOR_KINDS`), digest equals the revision's, case at `offer_accepted`, not blocked; server instant; evidenceRef written; READY → IN_PROGRESS; never a signing by itself (#22) |
| 19 | signing evidence | `PLATFORM_ACKNOWLEDGMENT` (authenticated account holder confirms the exact digest) and `UPLOAD_EXECUTED_DOCUMENT` (club evidence, completes nothing); evidenceRef `{ kind, id, revisionId, documentSha256, at, actorKind, actorId, session }`; immutable; integrity-checked (M23_P7_SIGNING_EVIDENCE_MODEL.md) |
| 20 | document integrity | DRAFT-only attach; presented revision frozen; supersede for a change; completed package immutable; m14 `organisation_internal` evidence rows with `meta.signingPackageId` (M23_P7_DOCUMENT_INTEGRITY.md) |
| 21 | document hash | SHA-256 of the exact bytes (D-P7-1 fixed in m14) recomputed independently in m29 from the arriving bytes; the party confirms the digest; the completion gate re-checks every evidenceRef against it; the live suite computes it independently and matches four surfaces |
| 22 | completion gate | `completionGate` names every problem (state, revision, document, parties, evidence, digest, temporal order, contract days, Offer, Offer revision, references, case, lifecycle, conflicting completed signing, block); only an empty list completes |
| 23 | `db.signings` writer | `recordCompletedSigning` in `m29/index.mjs`, the only `db.signings.push` in the repository (Z1); idempotent per package; reached by the canonical completion and, for non-Offer recruitments only, the legacy route |
| 24 | `signed` lifecycle writer | m29 never assigns a status word (Z4); it asks `canTransitionRecruitmentCase(confirmSignedOutcome)` with the real evidence provider (which needs the row) and calls `applyLifecycleTransition`; by hand and the legacy status writer are 422 (L1, L2) |
| 25 | `under_contract` semantics | written in exactly one file (Z2) by the ONE writer; means a completed signing; never by acceptance, a confirmation, a terminal package, the lifecycle route or a migration (M23_P7_CONTRACT_STATUS_SEMANTICS.md) |
| 26 | contract start | DATE_ONLY, required to present, from the accepted terms, editable in DRAFT, frozen on presentation, on the completion and the row; a future start is allowed |
| 27 | contractUntil | `contract.endDate` DATE_ONLY optional, ≥ start, ≤ 10 years after; no automatic reversal at the end day (stated as a P7.1 question, §28) |
| 28 | affiliation integration | a grassroots club's squad gains the player through the legacy recording only; a Pro club's squad untouched; rolled back with the unit of work |
| 29 | invoice integration | success-fee invoice at most once per signing, only inside the attribution window, through the billing adapter, inside the unit of work (O1, P6b) |
| 30 | player level integration | `playerLevelAfterSigning(org.level)`, timeline lines, `availability = 'not_seeking'`, inside the unit of work (K6) |
| 31 | cancellation | DRAFT/READY/IN_PROGRESS → CANCELLED by manage, reason optional; Offer and case untouched; a new package may open (L9, L10, live G) |
| 32 | void | READY/IN_PROGRESS → VOIDED by a recruitment lead, or T&S with a named reviewer and a reason; confirmations invalidated, history kept; writes nothing, moves nothing (AD5–AD9, #28) |
| 33 | supersession | READY/IN_PROGRESS → new DRAFT revision n+1, same contract days, every party pending; the old revision SUPERSEDED; old confirmations refused `SIGNING_SUPERSEDED` (H2, H4, H5) |
| 34 | expiry | `expiresAt` ≥ 1 h ≤ 90 d (default 30 d); EXPIRED derived at read time, never stored; every act refused; 1 ms before lands, at or after refused (R group, #29, #33) |
| 35 | blocks | fail closed by name to the club (`SIGNING_BLOCKED`), by state to the recipient (never the word "blocked"); notifications suppressed; the club may still cancel (M23_P7_SIGNING_BLOCK_MATRIX.md) |
| 36 | auth loss | re-derived per request: demoted lead 403, stale session 401, terminated/lapsed/narrowed agent 403, old deep links dead (C12, U3, U5, F8, live E) |
| 37 | concurrency | single-threaded store, gate re-evaluated inside every act: completion vs cancel, vs void, final signature vs expiry, N concurrent completions — one winner each (P group, #31–#33) |
| 38 | idempotency | `clientKey` per act list (start, ready, party, cancel, void, supersede, complete); same fingerprint replays with `idempotent: true`, different fingerprint 409 (Q group, K7, #34, #35) |
| 39 | rev | `expectedRev` required as an integer on every club mutation; `SIGNING_REV_REQUIRED` / `SIGNING_REV_CONFLICT`; bumped on every change including recipient acts (Q3, #36) |
| 40 | privacy | audience-specific views; draft absent (not redacted); note/digest/name/bytes never to a recipient or agent as the matrix states; one concealment body (M23_P7_SIGNING_PRIVACY_MATRIX.md) |
| 41 | same-agency | Bea (same agency) and the agency admin get 404 `REPRESENTATION_NOT_FOUND` / 403 on the relationship; nothing says a signing exists (F5, live D4) |
| 42 | events | seven `signing_*` events, all `org_private`, ids plus the party type word only; registered, boot-asserted (V group) |
| 43 | notifications | one type `recruitment_signing` in category `signing_updates` (default on); player, club leads and the agent (while the basis holds); texts name acts only; suppressed under a block |
| 44 | Inbox | notifications land in the existing player/club/agent inboxes as the `recruitment_signing` type; no separate signing inbox was added |
| 45 | deep links | the club room deep link opens the Signing tab with authority re-derived; the agent's `#/clients/:rel/offers` deep link shows no access after revocation (live E); stale club links 401/403 (U group) |
| 46 | legacy signing | `POST /org/players/:id/signing` routed through the ONE writer with `method: 'LEGACY_RECORDED'`, refused `SIGNING_CANONICAL_REQUIRED` when an accepted Offer or a package exists (X0, live C7c); legacy rows reported honestly, never turned into packages (X4) (M23_P7_LEGACY_COMPATIBILITY.md) |
| 47 | direct writer audit | M23_P7_EXISTING_SIGNING_WRITER_AUDIT.md (R1): every pre-P7 writer of `db.signings`, `signed`, `under_contract`, level and invoice inventoried; the legacy route was the one direct writer and is now a caller; the drift regression Z1–Z4 sweeps the tree |
| 48 | partial failure | the completion is a unit of work with a snapshot rollback across the package, `db.signings`, the ledger, the invoices, the player, the squad, the case status and history; development fault seams prove it (AD10–AD14, #48); after-effects run under `safe()` and cannot undo an authoritative completion |
| 49 | temporal integrity | DATE_ONLY days via `parseStrictDateOnly`; instants via `readInstant`; body timestamps ignored; the test clock only under `SCOUTBOX_TEST_CLOCK=1`; ordering rules on the record (ready ≥ created, party ≥ ready, completed ≥ last party) are corruption when broken (Y group, A34–A36, #43–#46) |
| 50 | Trust Score isolation | the module never reads or writes the Trust Score (Z6); a signing leaves it unchanged (K13, #50) |
| 51 | Passport exposure | the timeline line and the level only; no package, digest or note on the Passport |
| 52 | analytics | `db.signings` rows counted as before; `method` distinguishes canonical from legacy; no term or note on a row |
| 53 | m23SigningE2E | 255 checks, 154 negative (60%), groups A–Z + AD, cases #1–#50 labelled; green at R4 (battery run 2, fresh clone) |
| 54 | m23SigningPersistence | 84 checks, sections 1–4 (migration, journey across SIGTERM, post-reboot views/keys/uniqueness, ten planted corrupt rows); green |
| 55 | m23SigningLive | 134 checks, 48 negative (36%), groups A–G + N, widths 1440/1280/1024/768/390/360, a11y, FR, sentinels, zero page errors; green (run 6, browser battery, fresh clone) |
| 56 | Offer hardening regression | m23OfferHardeningE2E 259 + m23OfferHardeningLive 53, green |
| 57 | Temporal regression | m23TemporalIntegrityE2E 493, green (T1 now asserts 2308) |
| 58 | Agent regression | m23AgentE2E 407, Compliance 346, Transaction 404 (+ persistence 63), Integration 535, FinalHardening 286, P56ERepairAudit 179, and the six agent live suites — green (schema/event truths updated test-side, T-P7-4) |
| 59 | server battery | 44 rows (43 suites + apiE2E; baseline 42): run 1 at R3 39 green + 4 superseded-truth rows fixed in R4; run 2 at R4 **44 / 44 green**, 0 flakes (M23_P7_TEST_REPORT.md §3) |
| 60 | apiE2E | 130 / 130 against a real server with matching `DATA_DIR`, both runs |
| 61 | browser battery | 17 suites (baseline 16), **17 / 17 green**, zero page errors, ports released |
| 62 | typechecks | 5 / 5 (agent, club, grassroots, admin, player) — working copy and fresh clone |
| 63 | builds | 5 / 5 (four vite builds, one expo web export) — working copy and fresh clone; `buildDemos` rc=0, `demoFreshness` 16 / 16 |
| 64 | EN/FR | club 136 keys ×2, player 22 top-level keys with FR typed `typeof en`, agent 13 ×2, grassroots 6 confirmation pairs; live N16/N16b render French with no English fallback; every `SIGNING_*` code maps to a sentence |
| 65 | accessibility | live N15 (tab semantics, every control labelled, `aria-required`, `aria-describedby`, polite live region, keyboard); status as text + glyph; the three states are distinct words on every surface; the player confirmation is an alert; the digest is on an accessibility label |
| 66 | perf/load | `m23SigningPerf`: views in fractions of a millisecond, linear in the store, one scan per surface, no N+1 for list / party states / document metadata / agent projection; no index or cache added; auth not weakened |
| 67 | clean boot | empty store → 2308, store files created, port released; re-run at R4 identical (`p7-coldboot2.out`) |
| 68 | replay | second boot 2308, record persisted, migration ledger applied nothing (0), 0 duplicate registrations; the one registry warning predates P7 |
| 69 | fresh clone | from R4 `75dc6cb`: install ×7, boot 2308, 5 typechecks, 5 builds, m23SigningE2E, m23SigningPersistence, Offer hardening, Temporal, Agent integration, m23SigningLive (both journeys) — all green; no surviving process |
| 70 | recovery bundles | R1 `4d30e6c` `p7-R1.bundle` sha256 `60338ef836149e901359e547814ce1eff5f5ee723117120071b5b51b32b0b196`; R2 `a0925a0` `p7-R2.bundle` `6fe2d098059a2aaae860a6b0495c5ccea553525ff4c60adafa6335d2cc2f9cdd`; R3 `4889e22` `p7-R3.bundle` `37a4ea652d2dc16474f6cec4db907a9823c277f288b14222d4a161e558917909`; R4 `75dc6cb` `p7-R4.bundle` `9a6b953b9107c6a22df08f7e4dde36681391f7fffff8fee00e63e41d48f0c436`; R5 `ea071ce` `p7-R5.bundle` `d871bd9ead930a45f4aa93f3770d2562bc59aba483817d13107b5cf4e7b9c345`; R6 bundle and sha256 in the delivery message. All in the session scratchpad. **DO NOT PUSH.** |
| 71 | Critical found/fixed | 0 / 0 |
| 72 | High found/fixed | 1 / 1 (D-P7-1 exact-bytes digest) |
| 73 | Medium found/fixed | 1 / 1 (D-P7-4 stale Offer revision binding as corruption) |
| 74 | Low found/fixed | 3 / 3 (D-P7-2 minor pathway named in readiness, D-P7-3 voided/cancelled completion code, D-P7-5 grassroots catalogue parity) |
| 75 | open Critical | 0 |
| 76 | open High | 0 |
| 77 | open Medium | 0 |
| 78 | open relevant Low | 0 |
| 79 | known flakes | 0 |
| 80 | tree | clean at R6 (this commit) |
| 81 | ahead/behind | 6 ahead of `origin/claude/desktop-project-migration-wyk3ec` (`1217e5b`), 0 behind |
| 82 | pushed? | **NO** |
| 83 | PR? | **NO** |
| 84 | deployed? | **NO** |
| 85 | ready for P7.1? | **YES** — every gate line holds (M23_P7_RELEASE_READINESS.md) |

## Truth block (§107)

    Starting tip: 1217e5b
    Remote starting tip: 1217e5b

    P7 Signing & Contract Completion complete: YES

    Accepted Offer automatically creates signing: NO
    Signing requires explicit initiation: YES
    Signing requires accepted exact Offer revision: YES

    Canonical signing workflow store: YES
    Completed db.signings remains distinct from in-progress package: YES

    Required signing parties explicit: YES
    Missing required party can still complete signing: NO
    Agent can sign as Player: NO
    Agency admin can sign as Player: NO
    Same-agency membership grants signing access: NO
    Minor Agent signing pathway newly opened: NO

    Issued signing document revision immutable after signature: YES
    Changed document requires new signing revision: YES
    Completed signing evidence immutable: YES

    Offer acceptance writes db.signings: NO
    Partial signing writes db.signings: NO
    Only canonical completion writes db.signings: YES

    Offer acceptance sets signed: NO
    Partial signing sets signed: NO
    Only canonical signing completion sets signed: YES

    Offer acceptance sets under_contract: NO
    under_contract written only according to canonical completed-contract semantics: YES

    Duplicate completion creates duplicate db.signings: NO
    Completion vs cancellation race has one winner: YES
    Completion vs void race has one winner: YES
    Final signature vs expiry race has one winner: YES

    Stale Club role can sign: NO
    Expired Agent authority preserves access: NO
    Old signing deep link bypasses current authorization: NO

    Foreign signing ID leaks metadata: NO
    Draft contract leaks: NO
    Internal signing notes leak: NO
    Full contract terms leak in generic events: NO

    Malformed temporal data widens signing authority: NO
    Impossible contract dates accepted: NO
    Client clock authoritative: NO

    Legacy signed lifecycle fabricates signing evidence: NO
    Trust Score changes because Player signs: NO

    m23SigningE2E passed: YES
    m23SigningPersistence passed: YES
    m23SigningLive passed: YES
    Offer hardening passed: YES
    Temporal suite passed: YES
    Agent regression passed: YES
    Full server battery passed: YES
    apiE2E passed: YES
    Browser battery passed: YES
    Five-app typecheck passed: YES
    Five-app build/export passed: YES
    EN/FR parity passed: YES
    Accessibility verified: YES
    Perf/load passed: YES
    Clean boot passed: YES
    Replay passed: YES
    Fresh clone passed: YES
    Recovery bundle created: YES

    Open Critical: 0
    Open High: 0
    Open reasonably-fixable Medium: 0
    Open security/privacy/authorization/data-integrity Low needing repair: 0
    Known P7 flakes: 0

    P7 pushed: NO
    PR created: NO
    Deployment performed: NO

## Conclusion (§108)

The evidence above supports every line:

    M23 P7 SIGNING & CONTRACT COMPLETION COMPLETE
    ACCEPTED OFFERS DO NOT AUTOMATICALLY BECOME SIGNINGS
    SIGNING STARTS THROUGH AN EXPLICIT AUTHORIZED ACTION
    REQUIRED SIGNING PARTIES ARE EXPLICIT AND RE-AUTHORIZED
    SIGNED DOCUMENT REVISIONS ARE IMMUTABLE
    CHANGED DOCUMENTS REQUIRE NEW SIGNING REVISIONS
    PARTIAL CANCELLED VOIDED EXPIRED AND SUPERSEDED SIGNING PACKAGES CANNOT CREATE A COMPLETED SIGNING
    ONLY CANONICAL SIGNING COMPLETION WRITES DB.SIGNINGS
    ONLY CANONICAL SIGNING COMPLETION WRITES SIGNED
    UNDER_CONTRACT IS WRITTEN ONLY THROUGH THE CANONICAL COMPLETED-CONTRACT PATH
    DUPLICATE COMPLETION CANNOT CREATE DUPLICATE SIGNINGS
    SIGNING RACES PRODUCE ONE AUTHORITATIVE RESULT
    STALE CLUB AGENT AND GUARDIAN AUTHORITY DOES NOT PRESERVE SIGNING POWER
    SAME-AGENCY MEMBERSHIP DOES NOT LEAK SIGNING DATA
    SIGNING DOCUMENTS AND TERMS REMAIN PRIVATE
    MALFORMED TEMPORAL DATA FAILS CLOSED
    LEGACY SIGNED STATES DO NOT FABRICATE SIGNING EVIDENCE
    SCOUTBOX RECORDS SIGNING WORKFLOW AND EVIDENCE WITHOUT CLAIMING LEGAL EFFECT IT CANNOT PROVE
    TRUST SCORE REMAINS INDEPENDENT OF SIGNING
    ZERO KNOWN CRITICAL DEFECTS
    ZERO KNOWN HIGH DEFECTS
    ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS
    ZERO KNOWN SECURITY PRIVACY AUTHORIZATION OR DATA-INTEGRITY LOW DEFECTS REQUIRING REPAIR
    P7 IS READY FOR P7.1 SIGNING HARDENING

Work stops here (§111). P7.1 has not been begun.
