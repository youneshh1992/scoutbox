# S8c readiness review — recruitment contacts and offers as tables

**Status: IMPLEMENTED, PENDING INDEPENDENT ACCEPTANCE (24 October 2026, one commit on top of `19f5ca8`; CORRECTED on
24 October 2026 after the independent review of `535e247` — three P2 implementation findings F1, F2, F3, §14.1 the
correction record; the design, the earlier F1/F2/R1 pointer corrections, the S8b acceptance and the two Founder answers
unchanged).** The design
below was written on `feat/sqlite-schema` at `7072dd9`, the commit at which S8b was independently accepted
(`sqlite-migration-plan.md` §D.9; `s8b-readiness-review.md` §12), corrected on 24 October 2026 after the independent
review of `854d035` (F1 the offer-pointer contract, F2 the model's order and guard) and again after the independent
review of `a5a7ed9` (R1 the final offer COLLECTION decides, never the omitted row) — §13 and §13.1 are the correction
records, §6 the single pointer rule, the collection semantics and the order as corrected — and **independently
accepted for implementation at `19f5ca8` on 24 October 2026**: "R1 CLOSED. No remaining actionable finding … The
corrected S8c design is accepted for implementation subject to the Founder's explicit Q8c-a and Q8c-b decisions. This
accepts the design, not an implemented S8c repository." That review also confirmed the one engineering statement §9
put forward — the narrow refusal of a string pointer whose target exists only under ANOTHER offer of the FINAL
collection — as the reviewed ownership protection (not a product decision; access, retention and deletion unchanged).
**The Founder then answered the two product questions on 24 October 2026**, recorded verbatim in §9 and §14 and not to
be asked again: **Q8c-a "Approve tolerant (Recommended)"** (the player references on the nine tables carry no key;
live, retained and historically missing ids resolve, are counted and never refused, fabricated or deleted) and
**Q8c-b "Approve strict checks (Recommended)"** (the guardian references are checked in code against the FINAL
guardians table, ids only, no key; no account is created, unlinked or deleted to satisfy a refusal). The
implementation landed in one commit on top of `19f5ca8`: migration **`0017_recruitment_contacts_offers`**
(REGISTERED — `repositories/index.mjs` ends at `m0017`, `repositories/migrations/` holds `0001`–`0017`),
`repositories/recruitmentContactsOffers.mjs`, the copy-only rollback tool, the two failing-first suites and the
adaptations the chain and registry tests needed. **§14 is the implementation record**: what landed, every departure
from the proposed sections, the MEASURED behaviour of the actual `7072dd9` build on a `0017` file (§8 predicted it;
§14 states what happened), the adjustments outside the new modules, the batteries on the final tree and on the
untouched `7072dd9` checkout, and the gates. S8d (signing packages, signings, follow-ups, outcome reports) is not
started; the next free migration identifier is `0018` (not reserved). This implementation awaits its own independent
review. Nothing here is production, release, security, legal-compliance, merge or deployment approval, and nothing
here authorises a change to a route, a permission, the recipient selection, safeguarding, the lifecycle or retention.

What this document is for: the survey the acceptance of S8b asked for ("establish the exact bounded collection/table
list from current producers and consumers before proposing implementation"), the field-by-field record of the two
collections from their writers' literals, the drafted constraints judged against what the current code accepts and
keeps, a concrete migration / write / rollback design with two synthetic design probes, the ordered checklist and the
acceptance tests — so that the implementation milestone could start from a reviewed brief, as S8b did from the design
accepted at `4d2c74b`. It did: §1–§13 are kept as the accepted design (the text the review of `19f5ca8` accepted,
unchanged except where a sentence stated a prediction or an open question that §14 now closes, each marked in place);
§14 is the record of the implementation against them.

Standing rules that bind this design: the Founder's recorded decisions Q7a/Q7b/Q7c (the S8a tables) and Q8a (the S8b
tables) apply to those tables and are **not extended** to the S8c tables (§9 asks the questions they do not cover);
the S8a mapping as corrected at `7a7efc6` and the S8b implementation as accepted at `7072dd9` are the required precedent
(own prototype-named fields, absent / null / empty / off-type / unknown values kept distinct, list order and duplicate
entries kept, the one shared `idempotency_keys` table with the owning row's key, the persisted key-format marker left
exactly as it is); no public route, role, safeguarding or deletion/retention rule changes to make storage simpler;
nothing is dropped, fabricated, repaired, renamed or deduplicated by a migration; no player or guardian database key
before the identity rewrite plan (plan §D.2a, Q3) permits one; the unmarked-file boundary of S8b stands (a `0016` file
without `meta.recruitmentCasesKeyFormat` is refused; it is never stamped; its route back is the rollback tool of the
build that wrote it).

Design probes (synthetic, labelled design models — they import the real S8a engine and the real `0016` rebuild helper
READ-ONLY and change nothing in the repository): `s8c-probe-1-mapping.mjs` (32 checks: the proposed shapes through the
real encoder/decoder) and `s8c-probe-2-constraints-order.mjs` (as corrected after the reviews of `854d035` and
`a5a7ed9`: 103 checks — the constraints against real inputs, the write order of §6 in both input orders and as partial
saves, the request/contact transitions, the pointer rule for all five offer pointers over the FINAL COLLECTION, the
drafted-constraint controls, exact rollback at every phase, the shared key table's rollback model; the 75-check model
the review of `a5a7ed9` received is kept beside it as `probes/baseline/` and is what the reviewer's
`review-a5a7ed9-final-graph.mjs` reproduces R1 against; the ORIGINAL 31-check model as `probes/baseline-854d035/`, the
subject of `review-854d035-design-reproductions.mjs`). Both exit 0 on Node v22.22.0 and v24.19.0; source and results
travel with the handoff (§11). A design model
proves the design's own consistency; it is not evidence about an implemented S8c repository or the real server — that
evidence is the implementation's own suites (§14), to which the R1 and F1/F2 cases of the two reviewer scripts were
ported against the REAL repository and store.

## 1. The bounded scope — two blob collections, nine tables, one shared table broadened

The roadmap (plan §S8, line 1573) names S8c "contacts + offers" and S8d "packages + signings + follow-ups". The
producers and consumers of this build confirm two collections and nothing else:

| Collection | Created by | Written by | Read by |
|---|---|---|---|
| `db.recruitmentContacts` | the M23 migration registry `m230_004_recruitment_contacts` (`m182/migrations.mjs:315-335`, `??= []`; store contract `storeContract.mjs:158`, guarantee `migration`) | `m23/contactRoutes.mjs` only — draft (`:273-345`), edit (`:347-379`), cancel (`:381-401`), send (`:405-558`), external record (`:562-619`), the response hook `ctx.onRequestResponded` (`:628-653`) called by the two respond routes (`server.mjs:1602`, `:3451`), the asynchronous e-mail-copy update after the send's save (`:544-552`); the deletion unit's in-place edit of the reply (`server.mjs:4293-4295`) | the club's contact routes (`contactRoutes.mjs:238-269`), the cooldown (`contact.mjs:323-332`), the lifecycle evidence `contact_delivered` (`m23/evidence.mjs:118-132`), the journey projection (`m23/journey.mjs:133`, `:303-308`, `:349`, `:536`, `:620`, `:647`, `:666`), the deep-link resolver (`m23/journeyRoutes.mjs:160-169`), the agent's own list (`m27/index.mjs:283-321`), the audit feed (`m182/audit.mjs:170-183`), the event registry (`m182/eventRegistry.mjs:328-350`, audience `org_private`), the M20 dashboard/funnel/metrics (`m20/dashboard.mjs:182`, `m20/funnels.mjs:356`, `m20/metrics.mjs:157`) |
| `db.recruitmentOffers` | `registerOffers` at registration (`m28/index.mjs:63`, `??= []`; store contract `:164`, guarantee `module`) | `m28/index.mjs` only — create (`:296-347`), edit draft (`:361-398`), issue (`:408-491`), withdraw (`:493-536`), revise (`:539-588`), read receipts (`:649-658`, `:669-670`, `:683`), accept/decline (`:696-784`), share/un-share with an agent (`:788-816`), `onPlayerDeleted` (`:891-898`, called from the deletion unit `server.mjs:4308`) | the club's offer routes, the recipient routes (`:660-686`, `:818-844`), the agent's list (`:855-888`), the lifecycle evidence (`m23/evidence.mjs:199-202` → `m28/offer.mjs:447-463`), the journey (`m23/journey.mjs:321-326`, `:338-341`, `:481-494`, `:536`, `:650`), the deep-link resolver (`journeyRoutes.mjs:170-183`, `:193`), the signing module (`m29/index.mjs:103`, `:331-333`, `:348-356`, `:382-393`; `m29/signing.mjs:245`, `:267`), the event registry (`eventRegistry.mjs:361-386`), M20 (`dashboard.mjs:184`, `funnels.mjs:356`, `metrics.mjs:157`); the Player app reads the recipient routes only (`scoutbox-player/src/components/M23Offer.tsx`) |

Neither collection is ever removed from by code: there is no `splice`, no filtered reassignment and no delete route for
a contact or an offer (the only removals are snapshot writes that no longer list a record). Nothing else writes either
array; the Player app and the Agent workspace never see the records themselves, only the views of §2.

**Proposed tables (nine; the structural form of the drafts in `docs/architecture/sql/02_recruitment.sql:1197-1530`,
amended as §3 states; the DDL is generated from the shapes by the S8b engine at implementation and amended into file 02
then, exactly as S8b did):**

- `recruitment_contacts` (parent), `contact_attempts` (CASCADE child, position-keyed), `contact_history` (RESTRICT
  child, position-keyed, removed explicitly before its owner);
- `recruitment_offers` (parent), `offer_revisions` (CASCADE child, position-keyed, its own `id` indexed),
  `offer_revision_documents` (CASCADE grandchild keyed `(offer_id, revision_position, position)`), `offer_responses`,
  `offer_read_receipts` (CASCADE children, position-keyed), `offer_history` (RESTRICT child);
- the ONE shared `idempotency_keys` table **rebuilt** with its owner CHECK broadened to `'recruitment_contacts'` and
  `'recruitment_offers'` (the `0016` precedent, `repositories/migrations/0016_recruitment_cases.mjs:59`; probe 2 S5).

**No other live table is rebuilt.** `recruitment_requests.contact_id` (S8a, `repositories/recruitment.mjs:163`,
`contactId → contact_id`) stays a plain indexed column (§4); the request–contact relationship is carried by the NEW
real key `recruitment_contacts.request_id → recruitment_requests(id) RESTRICT` plus the pair guard of §6, so the S8a
parent is not touched. `recruitment_cases` (S8b) is referenced by both parents with real RESTRICT keys and is not
rebuilt. The S8a and S8b child tables, the threads, the identity tables and the S8b key-format marker are untouched.

**What stays as it is (later stages, named so nothing is migrated early):** `signingPackages`, `signings`, `followUps`,
`outcomeReports` (S8d) — they name offers and revisions by plain ids (`m29/index.mjs:420`, `m29/signing.mjs:267`) and
keep doing so until S8d creates its tables; `representationAgreements` / `agentTransactions` (file 06: the routing and
share agreement ids, the offer's `transactionId`, the readiness snapshot's `transactionId`); `verEvidence` (file 05:
the offer documents' `evidenceId`); the `outbox` rows (S7c, live) a contact's e-mail copy names by id. All of these
stay plain columns (§3).

### 1.1 Two naming corrections the survey establishes from source

- **`recruitment_requests.contact_channel_id` is NOT a contact reference.** It is the writer's `contactChannel`
  (`repositories/recruitment.mjs:163`): `null` at issue (`server.mjs:2264`) and the id of the message **thread**
  `openChannel` creates when the recipient accepts (`server.mjs:1608-1609`, `:3456-3457`) — the S7d `channels` row,
  whose own `request_id` is already a real key back to the request. The plan's notes at lines 2694 and 2776 ("contacts
  are S8c") describe `contact_channel_id` as waiting for S8c; it waits for nothing — it is the request→thread
  back-reference of a pair whose other direction is already keyed, and S8c creates no key for it (a key would make
  `channels` and `recruitment_requests` reference each other both ways, the trial-pair device for no reader's benefit).
  Corrected in the plan with this milestone.
- **`recruitment_requests.contact_id` IS the contact reference** (`contactId`, `server.mjs:2257`): written once, at the
  send, by `issueRecruitmentRequest({... contactId: c.id ...}, { persist: false })` (`contactRoutes.mjs:475-479`),
  stripped from every recipient view (`server.mjs:2355`), kept on the player tombstone (`server.mjs:4242`), and read by
  the two respond routes to find the contact (`contactRoutes.mjs:630-631`: BOTH ids must agree — `request.contactId`
  names the contact and `c.requestId` names the request) and by the rate limiter (`server.mjs:1584`, `:3437`).

## 2. The records, field by field (exact stored shapes from the writers' literals)

Conventions: *writer* = the line that sets the field; *audience* = who may read it through a view (club = the room's
staff by role; recipient = the player or guardian the record was addressed to; agent = an authorised representative;
nobody = never served, storage only); *semantics* = what omitted / `null` / empty / off-type / unknown mean to the
readers of this build; *storage* = the proposed column(s) or child table (the engine keeps every absent key in
`absent_keys_json`, every off-type value in `offtype_json`, every unknown key in `extra_json`, a `null` object in
`offtype_json` as the S8a/S8b engine does today — probe 1 shows each). References are keyed or plain as §3 decides.

### 2.1 `recruitmentContacts[]` → `recruitment_contacts`

Two literals create a contact: the in-app draft (`contactRoutes.mjs:319-335`) and the attested external record
(`:598-611`). Both carry the SAME thirty-six keys in the same order; every later writer edits in place. A contact
written before P5.6E carries no `contactMode` and no `routingSnapshot` key at all (absent, read as `player_only`,
`contactRoutes.mjs:363`, `contact.mjs:447`).

| Field | Writer(s) | Readers / audience | Stored shape and semantics | Storage |
|---|---|---|---|---|
| `id` | `nextId('rct')` | everyone by id; the deep-link resolver by prefix (`journeyRoutes.mjs:160`) | `rct-<n>`; a non-string id is corruption on read (`contactIntegrity`, `contact.mjs:438`), kept | `id TEXT NOT NULL UNIQUE` (+ `seq` insertion order) |
| `orgId`, `caseId`, `playerId` | the create literals | every reader filters by `(caseId, orgId)` or `(orgId, playerId)`; the journey reports a row naming the case but another org or player as `CLUB_MISMATCH` / `PLAYER_MISMATCH` (`journey.mjs:527-539`) and never uses it | strings; `playerId` missing → `player_missing` corruption, kept | `org_id` (key), `case_id` (key), `player_id` (plain, counted — §9) |
| `status` | create (`draft` / `recorded`), send (`failed` `:462`, `delivered` `:481`), cancel (`cancelled` `:391`), response (`responded` `:634`) | club view; cooldown (`delivered` only); evidence (`delivered` / `responded` / `recorded`, `contact.mjs:69`); journey milestones (`delivered` / `responded` for the recipient and the agent) | one of `CONTACT_STATUSES` (`contact.mjs:47`); unknown → `status_unknown`, kept and omitted from projections | `status TEXT` (no CHECK — §3) |
| `channel` | create: `in_app`; external: the attested channel (`phone`, `in_person`, `email_external`, `agent`, `other`) | views, cooldown (`in_app`), audit | `CONTACT_CHANNELS` keys (`contact.mjs:78`); unknown → `channel_unknown`, kept | `channel TEXT` |
| `recipient` | draft: `null`; send: the resolved route (`:482`); external: the derived route (`:600`) | club view (type and minor flag only, `contact.mjs:372`); the recipient journey filters by `recipient.type` (`journey.mjs:620`) | `null` or `{type:'player'\|'guardian', playerId, guardianId:string\|null, minor:boolean}`; a delivered/responded/recorded row without `recipient.type` is `recipient_missing` corruption, kept | `recipient_type`, `recipient_player_id` (stored, not derived: a mismatch with `player_id` is data), `recipient_guardian_id` (plain — §9), `recipient_minor` |
| `contactMode` | draft (`:325`, the club's request), edit (`:373`), external: `player_only` | club view (`contact.mjs:377`); the send re-derives the route from it (`:439`) | `player_only` \| `both`; ABSENT on pre-P5.6E rows (read as `player_only`); unknown → `contact_mode_unknown`, kept | `contact_mode TEXT` (nullable; absence recorded) |
| `routingSnapshot` | `null` on create/external; the send: `agentIntegration.contactTargetSnapshot(route, at)` (`m27/integration.mjs:302-312`, frozen: `{at, mode, player, guardian, agent:null\|{agentUserId, agreementId}, honest}`) or the no-agent literal (`:497`) | club view: `routedToAgent`, `routedAt` only; the agent's list and journey filter by `routingSnapshot.agent.agentUserId` (`m27/index.mjs:297`, `journey.mjs:647`, `journeyRoutes.mjs:166`) | `null` or the object; malformed → `routing_snapshot_malformed`; an agent on an unsent row → `routing_snapshot_unsent`; kept | `routing_at`, `routing_mode`, `routing_player`, `routing_guardian`, `routing_agent_user_id` (key, §3), `routing_agent_agreement_id` (plain), `routing_honest` (stored as written — the draft's "derived, not stored" is withdrawn: the engine keeps every field a writer wrote, the S8b rule) |
| `subject`, `body`, `summary` | draft/edit (`:326`, `:371-372`); external: `summary` only | club view and the routed agent (`m27/index.mjs:304-308`: subject and body); never the journey, the audit feed or the recipient (the recipient reads the REQUEST row, not the contact) | strings or `null`; off-type kept | `subject`, `body`, `summary TEXT` (no length CHECK — §3) |
| `createdBy`, `sentBy`, `recordedBy`, `cancelledBy` | `actorOf(req)` = `{kind:'org', userId, name}` (`:55`) | views show `name` only (`contact.mjs:383`, `:386`, `:393`) | the object or `null` | `<prefix>_kind`, `<prefix>_user_id` (key, §3), `<prefix>_name` (snapshot) |
| `createdAt`, `updatedAt`, `sentAt`, `deliveredAt`, `failedAt`, `occurredAt`, `recordedAt`, `respondedAt`, `cancelledAt` | the respective writers | views; `deliveredAt` drives the cooldown and must be a finite instant (`contact.mjs:327`, `:457`); `occurredAt` the external record's day/instant (`:583`, `:606`) | ms numbers or `null`; a non-finite value is kept and read as corruption | `INTEGER` columns (off-type → `offtype_json`) |
| `failureCode` | send on refusal: `'TRANSPORT_REFUSED'` (`:464`), cleared to `null` on success (`:488`) | club view | string or `null` | `failure_code TEXT` |
| `attempts[]` | send: `{at, ok:false, code:'TRANSPORT_REFUSED'}` (`:465`) / `{at, ok:true, code:null}` (`:489`), append-only | club view reads the COUNT only (`contact.mjs:391`); history details carry `attempt: attempts.length` | list in send order; empty on create; an off-type value (not a list) is kept as data | `contact_attempts (contact_id, position, at, ok, code, raw_json, …)` CASCADE |
| `requestId` | send: the new request's id (`:483`); `null` otherwise | the response hook matches `c.requestId === request.id` (`:631`) | string or `null`; one request per sent contact by construction (each send mints its own request, `:475`) | `request_id TEXT REFERENCES recruitment_requests(id) ON DELETE RESTRICT` (§3, §6) |
| `emailCopy` | send: `null`, then `{state:'queued', to:'guardian', outboxId:null, at}` (`:520`) or `not_available` (`:527`); the mailer's promise: `local_outbox` / `accepted_by_provider` / `failed` with `outboxId: rec.id` (an `outbox` row id, `adapters.mjs:102`) in a LATER save (`:545-551`) | club view verbatim (`contact.mjs:397`) | `null` or `{state, to:'guardian', outboxId:string\|null, at}` | `email_copy_state`, `email_copy_to`, `email_copy_outbox_id` (plain, §3), `email_copy_at` |
| `lifecycle` | `advanceCase` (`:217-234`): `{applied:true, from, to, at}` or `{applied:false, reason, at}`; `null` on drafts | club view verbatim | the two literals or `null` | `lifecycle_applied`, `lifecycle_from`, `lifecycle_to`, `lifecycle_at`, `lifecycle_reason` |
| `response` | the response hook: `{kind, message:string\|null, by:'player'\|'guardian', at}` (`:636`); the deletion unit nulls `message` in place (`server.mjs:4294`) | club view (the one thing the recipient authored, `contact.mjs:396`); the agent reads `kind` only (`m27/index.mjs:315`) | the object or `null` | `response_kind`, `response_message`, `response_by`, `response_at` |
| `keys` | draft: `{create:{key,fp}\|null, send:null, record:null}` (`:332`); send: `send = {key:string\|null, fp}` (`:453` — `key.key ?? null`); external: `record:{key,fp}\|null` (`:608`) | the three replay searches scan ALL contacts of the case (`:302`, `:417`, `:588`) by act and key, then compare `fp` (create: today's fingerprint or the pre-P5.6E legacy fingerprint plus the stored mode, `:297-298`) | three acts always present; each `null` or `{key, fp}`; a `send` with `key: null` is NOT replayable | `idempotency_keys` rows owned by the contact's own id (`owner_table 'recruitment_contacts'`): a keyed act is a `value` row; a null act, a null-key send and any unknown act stay on the row under `extra_json.keys` exactly as written (the S8a rule, probe 1 rct-3 / rct-8). Act ORDER inside the map is not preserved when held and row acts interleave (probe 1, OBSERVED — an engine property since S8a; every reader looks acts up by name) |
| `history[]` | `record()` (`:61-64`): `{id:'aud-<n>', at, action, by, detail\|null}`; `by` is `actorOf(req)` or the response's `{kind, name:'Guardian'\|'Player'}` (`:638`, no `userId`) | club view (sorted by `at` then id, `contact.mjs:349-355`); the audit feed for the actions in `CONTACT_ACTIONS` (`m182/audit.mjs:174-182`) | append-only, insertion order | `contact_history (contact_id, position, id, at, action, by_kind, by_user_id, by_name, detail_json, …)` RESTRICT, index `(contact_id, at)` and `(id)` |
| `rev`, `revAt`, `revBy` | `0`/`at`/`null` on create, then `bumpRev` (`m181/concurrency.mjs:84-87`: `revBy = {userId, name}` or `null` for the recipient's response) | the rev gate (`contactRoutes.mjs:204-208`); view `revBy.name` | integers / `{userId, name}` / `null`; an off-type `rev` is kept | `rev`, `rev_at`, `rev_by_user_id` (plain), `rev_by_name` |
| `policyVersion` | `CONTACT_POLICY_VERSION` (1) | view | integer | `policy_version` |

Derived at read, never stored: `statusLabel`, `channelLabel`, `external`, `attempts` (the count), `routedToAgent`,
`routedAt`, `transportNote`, the cooldown's `retryAt`, the milestone's `initiatedAt` (`contact.mjs:419`) and the
evidence verdicts. Nothing is derived AWAY: `recipient.playerId`, `routingSnapshot.honest` and `emailCopy.to` are
stored as written although every writer today agrees on them.

### 2.2 `recruitmentOffers[]` → `recruitment_offers` (+ five child tables)

One literal creates an offer (`m28/index.mjs:334-340`) with revision 1 (`:326-333`); `revise` appends a revision
(`:569-579`); every other writer edits in place. `offer.type` is rewritten from the current draft's terms on edit
(`:391`). `subjectRemovedAt` is SET only by the deletion unit (`:896`) — absent until then (not `null`).

| Field | Writer(s) | Readers / audience | Stored shape and semantics | Storage |
|---|---|---|---|---|
| `id`, `orgId`, `caseId`, `playerId`, `type` | create; `type` mirrors `terms.offerType` (`:335`, `:391`) | every reader filters by `(caseId, orgId)` (`offersOfCase`, `:147`), by `playerId` for recipients (`:622-635`), by org for the signing module (`m29/index.mjs:103`, `:382`); `type` must be in `OFFER_TYPES` (`offer.mjs:355`) | strings; a missing player id or unknown type is `offerIntegrity` corruption, kept and omitted | `id TEXT NOT NULL UNIQUE` (+ `seq`), `org_id` (key), `case_id` (key), `player_id` (plain, counted — §9), `type TEXT` |
| `decisionId` | create: `dp.sourceId ?? null` (`:336`), the FINALIZED progress decision the evidence provider named | club view only (`offer.mjs:505`); never the recipient | string or `null`; a decision row can leave only through the finalize route's transport-failure splice (`decisionRoutes.mjs:392`, uncommitted) — no writer removes a committed decision | `decision_id TEXT` plain, indexed, dangling COUNTED at the cutover and in `/capabilities` (the drafted `SET NULL` key is withdrawn — §3, probe 2 S3e) |
| `transactionId` | create: the verified workspace id or `null` (`:315-321`) | club view; the issue re-evaluates readiness from it (`:448-453`); the signing package copies it (`m29/index.mjs:420`) | string or `null` | `transaction_id TEXT` plain (file 06 is not live) |
| `status` | create `DRAFT`; issue `ISSUED` (`:466`); withdraw `WITHDRAWN` (`:517`); revise `DRAFT` (`:579`); response `ACCEPTED`/`DECLINED` (`:754`) — the CURRENT revision's STORED status | the journey's canonical status derives from the revisions (`canonicalOfferStatus`); the signing module reads `offer.status === 'ACCEPTED'` directly (`m29/signing.mjs:245`) | one of five stored words; `EXPIRED` and `SUPERSEDED` are never stored on the container | `status TEXT` (no CHECK) |
| `currentRevisionId` | create (`:336`), revise (`:578`), response discarding a draft (`:753`) | `currentRevision()` (`offer.mjs:260`); integrity requires it to name a revision of this offer AND the latest non-discarded one (`offer.mjs:388-396`) | string; a pointer to no revision is `current_revision` corruption — KEPT by the current store (the review of `854d035` proved it on the actual migrated store: saved and reloaded unchanged; `offerIntegrity` reports `current_revision` and nothing else) and omitted from projections on read | `current_revision_id TEXT` plain, stored as written; under the ONE pointer rule of §6: a target that resolves within this offer is valid; a target that names NO known revision anywhere (an unresolved historical pointer) is kept verbatim, counted, never refused — the read-time report stays the judge; a target that exists ONLY under another offer OF THE FINAL COLLECTION is refused (§6 G, probe 2 S8, S10 — an offer a supplied collection no longer lists departs and owns nothing). The drafted key to `offer_revisions(id)` is withdrawn (§3) |
| `revisions[]` | create, revise; in-place edits of the current draft (`:384-393`), the freeze (`:460-466`), supersession (`:465`), withdrawal (`:516`), response (`:751-753`) | club view all; recipient view the issued ones (`offer.mjs:521-542`); agent view without documents (`:545-556`); the signing module finds the ACCEPTED revision (`m29/index.mjs:351`, `:392`) | list in revision order; ≤ 20 by rule (`OFFER_LIMITS.revisions`) — kept as data; duplicate ids or numbers are corruption, kept | `offer_revisions (offer_id, position, …)` CASCADE, `id` INDEXED (not unique — §3) — see 2.3 |
| `responses[]` | the respond handler appends `{id:'rofa-<n>', revisionId, responseType, actorType, actorId, actorName, forPlayerId, occurredAt, reason, clientKey}` (`:742`, `:750`); the deletion unit nulls `actorName` and `reason` on player rows (`:894`) | club view (`offer.mjs:502`), recipient view (`:537`), the evidence (`responderMatches`, `:331-337`), replay by `clientKey` within the offer (`:709`) | append-only; one per revision by the gate; a duplicate is `duplicate_response` corruption, kept | `offer_responses (offer_id, position, …)` CASCADE, index `(offer_id, client_key)` |
| `readReceipts[]` | `markViewed` (`:649-658`): `{revisionId, viewerKind, viewerId, firstViewedAt}`, write-once per (revision, viewer) by the code check (`:653`) | club view `firstViewedAt = MIN` (`offer.mjs:503`) | append-only; `readReceipts` ABSENT on rows created before the receipt code ran (`:652` `??=`) | `offer_read_receipts (offer_id, position, …)` CASCADE (the drafted deduplicating primary key is withdrawn — position-keyed, §3) |
| `agentShare` | share: `{agentUserId, agreementId, at, by:{kind:'player', id}}` (`:807`); un-share: `null` (`:796`); no rev bump | club view `agentShared`; the agent's list and journey filter by `agentShare.agentUserId` (`:878`, `journey.mjs:650`, `journeyRoutes.mjs:175`, `:194`) | the object or `null` | `agent_share_user_id` (key, §3), `agent_share_agreement_id` (plain), `agent_share_at`, `agent_share_by_kind` (stored as written — the draft's "always player: derived" is withdrawn), `agent_share_by_id` |
| `keys` | create: `{create:{key,fp}\|null, issue:[], withdraw:[], revise:[]}` (`:338`); issue/withdraw/revise push `{key, revisionId}` (`:474`, `:523`, `:580`); `keyList` COERCES a non-array act to `[x]` on read (`:84`) | replay: create scans the case's offers by key and compares `fp` (`:300-303`); issue/withdraw/revise find the key in the list and compare `revisionId` (`:416-420`, `:501-505`, `:546-547`); the recipient's `clientKey` lives on the response, not here | the map or ABSENT on an older literal; list acts without `fp`/`at` | `idempotency_keys` rows owned by the offer's own id: list entries as `list` rows (`fp` NULL, `entry_json` verbatim), a keyed `create` as a `value` row, empty lists / null / unknown acts held under `extra_json.keys`; a LEGACY non-array `issue` object is stored as the `value` row it is and comes back as the object (probe 1 rof-3) |
| `lifecycle` | the LAST `advanceCase` result (`:473`, `:522`, `:767`): `{applied, action, from, to, at}` or a refusal with `reason`, `message`, `allowed[]` | club view verbatim | the object or `null` | `lifecycle_applied`, `lifecycle_action`, `lifecycle_reason`, `lifecycle_message`, `lifecycle_allowed_json` (retained JSON, display only), `lifecycle_from`, `lifecycle_to`, `lifecycle_at` |
| `history[]` | `hist()` (`:78-81`): `{id:'aud-<n>', at, action, by:{kind, id, name}, detail\|null}`; the deletion unit nulls `by.name` on player entries (`:895`) | club history paged at 200 (`:355-359`); the recipient's history filtered of `/draft\|internal/` (`offer.mjs:565-569`) | append-only, insertion order | `offer_history (offer_id, position, id, at, action, by_kind, by_id, by_name, detail_json, …)` RESTRICT |
| `createdAt`, `createdBy`, `updatedAt` | create (`byOrg(req)` = `{kind:'org', id, name, role}`, `:77`); `updatedAt` on every write incl. share and receipts | club view | — | `created_at`, `created_by_kind`, `created_by_user_id` (key), `created_by_name`, `created_by_role`, `updated_at` |
| `rev`, `revAt`, `revBy`, `policyVersion`, `subjectRemovedAt` | `bumpRev` on every club mutation and recipient answer (`:476-477`, `:769-770`), never on a share or a receipt; `subjectRemovedAt` by the deletion unit only | the rev gate (`:165-171`, `:730-733`); `subjectRemoved()` reads the CASE's flag, not the offer's (`:149`) | integers / `{userId, name}` / `null`; `subjectRemovedAt` ABSENT until set | `rev`, `rev_at`, `rev_by_user_id`, `rev_by_name`, `policy_version`, `subject_removed_at` |

### 2.3 `revisions[]` → `offer_revisions` (+ `offer_revision_documents`)

| Field | Writer(s) | Semantics | Storage |
|---|---|---|---|
| `id`, `revisionNumber`, `status` | create/revise (`rofr-<n>`, `nextRevisionNumber`, `DRAFT`); issue → `ISSUED`, the previous issued → `SUPERSEDED` (`:465`); withdraw → `WITHDRAWN`; response → `ACCEPTED`/`DECLINED`; a draft discarded by a response → `WITHDRAWN` with `withdrawnBy: null` (`:753`) | **`EXPIRED` is NEVER stored** — `effectiveRevisionStatus` reads an ISSUED revision past `expiresAt` as EXPIRED at read (`offer.mjs:254-258`); the stored word stays `ISSUED`. The migration imports the stored word; nothing is "expired" by the cutover | `id TEXT` (indexed), `revision_number INTEGER`, `status TEXT` |
| `terms` | `{offerType, role, squad, startDate, endDate, conditions}` from `validateTerms` (`offer.mjs:196`); frozen at issue (`:461`) | all six keys always present (`null` where empty); dates are `YYYY-MM-DD` strings | `term_offer_type`, `term_role`, `term_squad`, `term_start_date`, `term_end_date`, `term_conditions` (no length/order CHECKs — §3) |
| `recipientMessage`, `internalNote` | create/edit/revise | `internalNote` is club-private: never the recipient or agent view (`offer.mjs:521`, `:545`) | `recipient_message`, `internal_note` |
| `documents[]` | `resolveDocuments` (`:174-182`): `{id:'rofd-<n>', evidenceId, label, mime, bytes}`; replaced wholesale on edit (`:388`); copied with NEW ids on revise (`:565`) | the recipient document route re-reads the vault row by `evidenceId` and the offer's org (`:828`); no bytes here | `offer_revision_documents (offer_id, revision_position, position, id, evidence_id (plain), label, mime, bytes, raw_json, …)` |
| `expiresAt` | validated instant in ms or `null` on a draft (`:329`, `:387`) | required at issue; read-time expiry (above) | `expires_at INTEGER` |
| `createdAt/By`, `updatedAt/By`, `issuedAt/By`, `withdrawnAt/By`, `withdrawReason`, `respondedAt`, `response:{id}\|null`, `supersedesRevisionId`, `supersededByRevisionId`, `supersededAt`, `discardedByResponseId` | the respective writers; `discardedByResponseId` is set by assignment (`:753`) and DELETED on the route's in-memory rollback (`:755`) — absent on every other revision | `by` objects are `byOrg(req)` or `null`; `response` is `{id}` or `null` | columns as drafted (`response_id`, `supersedes_revision_id`, `superseded_by_revision_id`, `discarded_by_response_id` all PLAIN, stored as written — a string in its column, `null` as NULL, an absent key in `absent_keys_json`, an off-type value in `offtype_json`; the drafted self-keys and response keys are withdrawn in favour of the ONE pointer rule of §6: own target valid, unresolved historical target kept and counted, known foreign-owner target refused — probe 2 S8 covers each of the four together with `current_revision_id`) |
| `recipientSnapshot` | issue: `{type, playerId, guardianId, minor, at}` (`:463`); `null` on drafts | the recipient and agent reads filter by it (`:629-631`, `journey.mjs:488-490`, `journeyRoutes.mjs:177-181`); `responderMatches` re-checks the answerer against it | `recipient_type`, `recipient_player_id` (stored), `recipient_guardian_id` (plain — §9), `recipient_minor`, `recipient_at` |
| `readinessSnapshot` | issue: `{transactionId, evaluatedAt, status, blockers:[]}` or `null` (`:452`, `:464`) | club view only | `readiness_transaction_id`, `readiness_evaluated_at`, `readiness_status`, `readiness_blockers_json` |
| `rev`, `revAt`, `revBy` | the revision's own `bumpRev` (`:390`, `:476`, `:525`, `:769`) | the view's `rev` | `rev`, `rev_at`, `rev_by_user_id`, `rev_by_name` |

### 2.4 What the deletion unit does to both (reproduced, not redesigned)

`server.mjs:4293-4295` rewrites a deleted player's contact replies to `{...response, message: null}` in place;
`m28Ctx.onPlayerDeleted` (`:891-898`) nulls `actorName` and `reason` on player responses, `by.name` on player history
entries, and sets `subjectRemovedAt`. Under S8c these are ordinary in-place edits of records the repository publishes:
they land in the deletion unit's commit through the same change tracking as the S8b case tombstones (`server.mjs:4289-
4291`), and the unit's failure restores the mirrors from the graph memento (§5). No deletion of a contact or an offer
exists today and none is introduced (probe 2 S6).

## 3. The drafted constraints against the producers — what was found

Draft SQL is not evidence that a constraint is safe. Each drafted NOT NULL, key, CHECK and index was judged against
the inputs the current writers produce and the records the current readers KEEP (report, omit, never repair). The
S8a/S8b rule applies: a constraint that merely restates a vocabulary, a length or a rule a route already enforces is
dropped (the route stays the rule); a uniqueness the writers never violate but a kept-corrupt record could is dropped;
a real key is kept only where the referenced table is live and the referenced row can never leave under its dependant
without a named refusal.

| Drafted (file 02) | Verdict | Evidence |
|---|---|---|
| `recruitment_contacts.org_id NOT NULL REFERENCES orgs RESTRICT`; `recruitment_offers.org_id` likewise | **kept** — reproduces: no org deletion route exists (O2), every writer sets it, every reader filters by it; a snapshot that removes an organisation under a contact or offer is refused with the table (the S8b precedent) | S8b `CONSTRAINTS` (`recruitmentCases.mjs:221`); probe 2 S1/S2 |
| `case_id NOT NULL REFERENCES recruitment_cases RESTRICT` on both parents | **kept** — reproduces: every writer takes `room.id`/`kase.id` from the concealing room lookup; `recruitment_cases` is live since `0016`; a case pruned under a retained contact or offer is refused by the key, named by the S8b preflight's retained-dependants check extended to the two new tables (§6 P) | probe 2 S1 (`CONTACT_OFFER_CASE_MISSING`), S2 (the key under a retained dependant) |
| `player_id NOT NULL` (no key) | **kept as NOT NULL, no key** — every writer sets it; strictness of the reference is the Founder's (§9, Q8c-a), as Q7a/Q8a were | probe 2 S6 (counted, commits) |
| staff references `created_by_user_id`, `sent_by_user_id`, `recorded_by_user_id`, `cancelled_by_user_id`, `routing_agent_user_id`, `agent_share_user_id` → `org_users RESTRICT` | **kept as keys, NULLABLE** (the draft's `created_by_user_id NOT NULL` is relaxed): staff are never deleted (`recruitmentCases.mjs:51`), so RESTRICT reproduces; a record whose `createdBy` is missing is NOT refused by the readers today (`contactIntegrity` does not require it), so NOT NULL would be a new refusal. A historically missing staff id refuses the cutover with ids (`RECRUITMENT_CASES_USER_MISSING`'s S8c twin) — the S8b precedent, an engineering choice stated in §9, not a product rule. The agent user id IS an `org_users` row (the Agent workspace is an organisation) | `recruitmentCases.mjs:474`; probe 2 S1 |
| `recipient_guardian_id REFERENCES guardians(id) ON DELETE SET NULL` (contacts and revisions) | **withdrawn** — no guardian key before the identity plan permits one (Q3), and `SET NULL` would rewrite a recipient snapshot silently; plain column; the check mode is §9 Q8c-b | probe 2 S3d (control: the key nulls the snapshot when the row goes) |
| `request_id REFERENCES recruitment_requests ON DELETE RESTRICT` | **kept** — the one NEW real key of S8c: the request table is live, each send mints its own request, no code path removes a request; a snapshot that drops a request under a retained contact is refused by name (`CONTACT_STILL_REFERENCED`, the table named) before the key fires | probe 2 S1 (both orders, partial saves, the dangling and still-referenced refusals, the bare-key control) |
| `CREATE UNIQUE INDEX recruitment_contacts_request ON (request_id) WHERE request_id IS NOT NULL` | **withdrawn** — no writer can violate it (one request per send); a disagreeing pair from a corrupt snapshot is refused by the pair guard WITH IDS (`CONTACT_REQUEST_MISMATCH`, the S8a `PAIR_MISMATCH` rule, `recruitment.mjs:570-572`), where the index would give a bare constraint error | probe 2 S3f |
| `email_copy_outbox_id` → `outbox` (drafted "no FK") | **plain, as drafted** — the outbox rows are rewritten wholesale by a snapshot (`outboxPush.mjs:409`) and their retention is open (O4); the id is a courtesy pointer the club view shows | — |
| contact `CHECK (channel = 'in_app' OR status = 'recorded')`, every status/channel/mode/state vocabulary CHECK, every `length(...)` CHECK, `recipient_minor IN (0,1)`-style CHECKs, `contact_mode NOT NULL DEFAULT 'player_only'` | **withdrawn** — the S8a/S8b rule: the routes validate and the readers report; a kept-corrupt record (an unknown status, an over-long body from an older limit) must import. `contact_mode` is nullable with absence recorded (a pre-P5.6E row stays distinguishable from an explicit `player_only`) | `recruitmentCases.mjs:220-230` (no vocabulary CHECKs); probe 1 rct-5/rct-8 |
| `recruitment_offers.decision_id REFERENCES room_decisions ON DELETE SET NULL` | **withdrawn** — `SET NULL` erases provenance silently; plain indexed id, dangling counted at the cutover and in `/capabilities` (the only decision removal is an uncommitted splice) | probe 2 S3e |
| `current_revision_id NOT NULL REFERENCES offer_revisions(id) RESTRICT` | **withdrawn as a key, and nullable** — a parent→child key is a cycle with the child's CASCADE key back (insert order impossible without parking or deferral; S8a's rule is IMMEDIATE constraints), and NOT NULL would refuse a record the store keeps. Plain column under the ONE pointer rule (§6): an unresolved historical target is KEPT and counted (the compatibility promise of §2.2 — a corrupt-but-kept offer never blocks the cutover); a target that exists ONLY under another offer is refused (`OFFER_CHAIN_BROKEN`, ids and the owning offer named) — the S8b same-room lesson (F1 of `b7c0dd0`). **The foreign-owner refusal is the ONE compatibility statement of this design that goes beyond today's storage** (the blob store would save such a pointer; no writer can produce it — every pointer is set within one offer in one tick; `offerIntegrity` would report it as unresolved and omit the offer): it is put forward for the review's confirmation, not assumed (§9, §13) | probe 2 S8 (every pointer kind × own / unresolved / foreign / null / off-type / duplicate), S4; the reviewer's `review-854d035-design-reproductions.mjs --expect-corrected` (F1 kept verbatim, F2b refused) |
| `offer_revisions.id PRIMARY KEY`, `UNIQUE (offer_id, revision_number)`; `offer_responses.revision_id UNIQUE`; `offer_revision_documents UNIQUE (revision_id, evidence_id)`; `offer_read_receipts PRIMARY KEY (revision_id, viewer_kind, viewer_id)` | **withdrawn** — each would REFUSE a record `offerIntegrity` reports and KEEPS today (`revision_id`, `revision_number`, `duplicate_response`; a repeated document; a repeated receipt). Position-keyed children, duplicates kept and counted at the cutover; `offer_revisions.id` INDEXED. **S8d dependency:** `signing_packages.offer_revision_id → offer_revisions(id)` (file 02 drafts it as a key) needs a UNIQUE revision id; S8d must either add the unique index after a cutover preflight proves no duplicates exist in that file, or key by `(offer_id, position)`. Recorded here so S8d does not inherit an unexamined assumption | probe 2 S3b/S3c |
| `offer_revisions.response_id`, `supersedes_revision_id`, `superseded_by_revision_id`, `discarded_by_response_id` as keys (RESTRICT) | **withdrawn as keys** — within-aggregate pointers written in one tick with their targets; kept as plain columns under the SAME pointer rule as `current_revision_id` (§6 G: own valid, unresolved kept and counted, known foreign owner refused) — the review of `854d035` found the model's guard omitted `discarded_by_response_id`; the rule now names all five pointers and the model checks all five | probe 2 S8 (all five), S4 |
| `CREATE UNIQUE INDEX recruitment_offers_one_live_per_case ON (case_id) WHERE status IN ('DRAFT','ISSUED')` (drafted as "NEW") | **withdrawn** — it refuses a state the routes PRODUCE: `canRevise` (`offer.mjs:289-296`) consults the offer's own status only, so an offer withdrawn, a second offer created and issued (`liveOfferOf` saw none live, `:312`), and the first revised into a DRAFT gives two live offers on one case. `OFFER_LIVE` stays the create route's code check | probe 2 S3a |
| `CHECK ((agent_share_user_id IS NULL) = (agent_share_at IS NULL))`, `type … CHECK (… IN ('direct_recruitment'))`, `term_start_date < term_end_date` | **withdrawn** — route rules | — |
| `contact_history` / `offer_history` `ON DELETE RESTRICT` | **kept** — the owned history never disappears under its owner; a departing owner's history is removed explicitly before the parent (S8b R1 of `86342b8`) | probe 1 (the rewrite), probe 2 S2 (departure and the control) |
| `transaction_id`, `agent_share_agreement_id`, `routing_agent_agreement_id`, `readiness_transaction_id`, `evidence_id` (file 05/06, not live) | **plain, as drafted** | — |

NOT NULL inventory as proposed: `id`, `org_id`, `case_id`, `player_id` on both parents (every writer sets all four;
every reader requires them; the S8b precedent); nothing else. Every other drafted NOT NULL (`status`, `channel`,
`created_at`, `updated_at`, `created_by_user_id`, `revision_number`, `occurred_at` on responses, …) is relaxed to
nullable so that a record the blob store holds and the readers report-and-keep imports as it is.

## 4. References in both directions (from source, not from names)

| Direction | Meaning | Proposed treatment |
|---|---|---|
| contact → request (`requestId`) | the request row the send created as the recipient's mailbox object | real RESTRICT key; the contact row is written AFTER the S8a request create/update and BEFORE the S8a request prune (§6: no parking, no deferral); a surviving contact that changes request has its old pointer released at R before any prune can reach it; a departing contact goes at F0 before its request departs at F2 |
| request → contact (`contactId` = `contact_id`) | which contact created the request (internal link, stripped from recipient views) | plain indexed column (S8a, unchanged, no rebuild); pair guard: a request a contact names must name that contact back or none (`CONTACT_REQUEST_MISMATCH`); a request naming a contact that is not in the final graph is COUNTED, not refused (today `onRequestResponded` returns `null` for it, `contactRoutes.mjs:630-632`) |
| request → channel (`contactChannel` = `contact_channel_id`) | the thread opened at acceptance (NOT a contact) | unchanged, plain; the plan's two notes corrected (§1.1) |
| contact → case, offer → case | the room | real RESTRICT keys; the S8b preflight's retained-dependants check extended to `recruitment_contacts` and `recruitment_offers` so a case pruned under one is named (`CASE_STILL_REFERENCED` with the table) before the key fires |
| contact → outbox (`emailCopy.outboxId`) | the courtesy e-mail's outbox row | plain |
| contact → agent (`routingSnapshot.agent.agentUserId`, `agreementId`) | who was validly routed at the send | user id: RESTRICT key to `org_users`; agreement id: plain (file 06) |
| offer → decision (`decisionId`) | provenance of the progress decision | plain, indexed, counted |
| offer → transaction (`transactionId`) | the agent-workspace link | plain (file 06) |
| offer → current revision; revision → response; revision ↔ revision (supersedes / superseded by); draft → discarding response | within one offer, written in one tick | plain columns, stored as written; the ONE pointer rule at P and G (§6): own target valid; unresolved historical target kept verbatim and counted; a target that exists only under another offer refused with the owner named |
| revision document → evidence (`evidenceId`) | the vault row | plain (file 05) |
| response / receipt → player or guardian (`actorId`, `viewerId`, `forPlayerId`) | the person | plain; mode per §9 |
| signing package → offer, → accepted revision (S8d) | the later stage | plain ids today; S8d's keys need `offer_revisions.id` unique (§3) |
| the evidence provider, the journey, M20, the audit feed, the event registry | read-only consumers of the published arrays | unchanged: they keep reading `db.recruitmentContacts` / `db.recruitmentOffers`, which become the repository's read-only array views (the S8b rule; `Array.isArray` holds, `JOURNEY_REQUIRED_STORES` is satisfied, `m182`'s `??= []` and `m28`'s `??= []` are no-ops on a present view) |

## 5. Repository, views, save timing and the graph memento (proposed)

One module, `repositories/recruitmentContactsOffers.mjs`, built on the S8b engine (the `COLL` descriptor, `writeRecord`
/ `readRecords`, the preflight / stage / prune / assert split, `createRecruitmentCasesRepository`'s mirror-and-view
pattern — `recruitmentCases.mjs:206-211`, `:326-363`, `:638-740`), with two collections (`CONTACTS`, `OFFERS`), the
shapes of §2 (probe 1 is their first draft), the constraints of §3, and:

- **Entry points.** `addContact(record)` for the two create literals (`contactRoutes.mjs:338`, `:614`) and
  `addOffer(record)` for the one (`m28/index.mjs:342`): the record itself is kept (validated like an import: a plain
  object with a string id; a case the cases view holds — `CONTACT_OFFER_CASE_MISSING`, ids only), appended to the
  mirror. No removal entry point: no writer removes either today. Every other write stays an in-place edit of the
  record and lands in the next save — including the asynchronous e-mail-copy update, which already triggers its own
  `persistNow()` (`contactRoutes.mjs:547`, `:550`) and keeps doing so.
- **Views.** `db.recruitmentContacts` and `db.recruitmentOffers` become read-only array views of the mirrors (push /
  splice / assignment refused with the entry point named), published by `attachDataLayer` under the same names; the
  store's `tableBacked` skip list gains the two names (`TABLE_BACKED`, `repositories/index.mjs:106`) so no save writes
  their blobs. The store-contract entries stay as they are (S8b changed none).
- **Change tracking.** Committed fingerprints per record (the S8b rule): a save writes the changed or new records as
  their own rows (parent upsert by `id`, `seq` kept; every owned child table deleted and reinserted in list order; the
  owner's key rows deleted and reinserted) and prunes the records no longer in the mirror; an unchanged save writes
  nothing; a failed save leaves memory as it is (pending intent kept for the next attempt — "ordinary failed-save
  pending intent"), a failed UNIT restores the mirrors from the graph memento ("failed-unit in-memory rollback").
- **Unit of work.** `snapshotState()` / `restoreState()` over the two mirrors with `captureGraph` / `restoreGraph`
  (`memento.mjs:29`, `:55`), joined through the store's participant API exactly as S8b (`recruitmentCases.mjs:732-733`).
  The deletion unit's edits (§2.4) are captured this way.
- **Hooks (staged mode).** Two, registered around the existing six (S8b core → recruitment → S8b links → S8b rooms →
  channels → S8b prune). The reference point is the ACCEPTED S8a flush: the recruitment hook performs the request
  create/update (phases 1–3) AND the request prune (phase 5) inside its own `flush` (`repositories/recruitment.mjs`,
  the staged `flush()` calling `prune(...)` for the requests no longer in its mirror), so in staged mode the request
  prune falls BETWEEN the two S8c hooks. **α** `contactsOffersPreHook`, BEFORE the S8b core hook: the preflight P over
  the final graph (the mirrors, the cases view, the requests view); F0, the prune of departed contacts/offers (history
  and key rows explicitly, then the parent); R, the release — a surviving contact whose stored `request_id` this save
  changes has its table row's `request_id` set to NULL now, so the recruitment hook's prune can never hit it. **β**
  `contactsOffersHook`, AFTER the recruitment hook: A′/D′ (the changed contacts and offers — the requests exist, so
  the contact row carries its final `request_id`; nothing is parked) and G. In staged mode the writers produce none of
  the departures or retargets (no code path removes a contact, an offer or a request; a contact's `requestId` is
  written once, at the send — §2.1); α's F0 and R are therefore no-ops on the live server and exist so that the ONE
  algorithm is correct wherever the request prune runs. Registration order is the data layer's responsibility, as for
  S8b (`hookRefusal`, `recruitmentCases.mjs:662`).
- **Snapshot mode** (`writeTableBacked`, `readTableBacked`): `CONTACTS_OFFERS_SNAPSHOT.begin` (P, F0, R) immediately
  before `RECRUITMENT_CASES_SNAPSHOT.begin` (`index.mjs:210`); `.write` (A′, D′) after `RECRUITMENT_SNAPSHOT.replace`
  (`:222`, the S8a phases 1–3 — the request create/update) and before the channels; the S8a request prune stays where
  it is (`RECRUITMENT_SNAPSHOT.prune`, `:241`, after the room prunes) — after every contact that named a pruned request
  has departed at F0 or been rewritten at A′; `.assert` (G) with the other final assertions (`:306`). `readTableBacked`
  adds the two collections after the cases (`:138-139`). The export for the admin backup is the published views
  themselves (`m13/enterprise.mjs:484` spreads `db`), as for every table-backed collection.
- **`/capabilities`** gains `domains.recruitmentContactsOffers` (counts, pending writes, the unresolved and retained
  player references, the counted guardian / decision / request-contact references, the key format of the S8b marker
  unchanged) beside `recruitmentCases` (`index.mjs:696`).
- **Audience.** Nothing changes in any view: the recipient still never receives `internalNote`, `decisionId`,
  `transactionId`, the readiness blockers or a draft (`offer.mjs:515-542`); the agent never receives documents or the
  internal note; the club never receives the agent's name from the snapshot; the journey never carries a body or a
  reply. Storage changes where the bytes live, not who reads them.

## 6. The write — one algorithm for the import, a restore, a flush and a snapshot (proposed)

Inputs: any subset of `{ recruitmentContacts, recruitmentOffers }` supplied (the rest retained), beside whatever the
save supplies for the S8a and S8b collections. Constraints IMMEDIATE; one transaction; every refusal before any row of
this save changes, ids only.

**Collection semantics (corrected after the review of `a5a7ed9`, R1) — "retained" is by COLLECTION, never by omitted
row.** A collection that is OMITTED from the save is retained whole: every stored row of it, pointer bytes included, is
part of the final graph. A collection that is SUPPLIED as an array is the ENTIRE final collection of that kind: a stored
record not listed in it departs at F0, and nothing of its former row — not its revisions, not its responses, not its
ownership of any id — belongs to the final graph that P classifies; `recruitmentOffers: []` therefore means the final
offer collection is empty and every stored offer departs. An explicit `null` or any non-array value is NOT an omission:
it is refused before any write (`TypeError` in a save, `CONTACTS_OFFERS_IMPORT_BLOCKED` at the cutover), the same shape
refusal the data layer applies to every table-backed collection. A staged dirty subset is NOT a snapshot collection: in
staged mode the mirror is complete and P classifies over the complete mirror (every offer the store holds), so no
staged save can mistake an unchanged offer for a departed one; only a snapshot write, a restore and the cutover supply
a collection as such, and there the supplied array IS the collection.

```
P   preflight over the FINAL combined graph (each collection supplied — the array IS the collection — or omitted —
      the whole stored collection retained; an explicit null / non-array collection refused):
      every supplied record a plain object with a string id (else CONTACTS_OFFERS_IMPORT_BLOCKED at the cutover,
        TypeError in a save) — duplicates of an id within a supplied list refused with the id;
      case_id of every supplied contact/offer in the final cases graph        → CONTACT_OFFER_CASE_MISSING
      request_id of every SUPPLIED contact in the final requests graph        → CONTACT_REQUEST_DANGLING
      a RETAINED contact whose request this save removes (requests supplied)  → CONTACT_STILL_REFERENCED
                                                                                 (table named)
      a RETAINED contact/offer whose case this save removes                   → CASE_STILL_REFERENCED (table named;
                                                                                 the S8b check extended)
      contact/request pair agreement over the final graph                     → CONTACT_REQUEST_MISMATCH
      org_id and the staff ids against the final orgs / org_users             → CONTACTS_OFFERS_ORG_MISSING /
                                                                                 _USER_MISSING
      the five offer pointers over the FINAL offer collection (THE POINTER RULE,   → OFFER_CHAIN_BROKEN for a
        below): the supplied array alone when offers are supplied, the whole       known foreign-owner target only
        stored collection when they are omitted — a departing offer owns nothing
      counted, never refused: player ids (per §9), guardian ids (per §9), decision ids, request→contact ids,
        outbox ids, UNRESOLVED offer pointers, duplicate revision / response / document / receipt entries
F0  prune: each contact/offer no longer listed in a SUPPLIED collection — its history rows and its key rows
      explicitly, then the parent (the CASCADE children follow) — BEFORE any request work
R   release: a surviving contact whose stored request_id this save changes → its table row's request_id set to
      NULL now (a later request prune can never hit it; the final value arrives at A′)
    ── the S8b core (P A R), the S8a phases 1–3 = B1 the request CREATE/UPDATE (no prune), the S8b links and rooms
       (C D), the channels (E) ──
A′  the supplied contacts: owned history and key rows deleted, parent upserted (seq kept) with its FINAL request_id
      (the request exists: nothing is parked, nothing is deferred), children reinserted in list order
D′  the supplied offers likewise (history and keys explicit; revisions, documents, responses, receipts reinserted;
      every pointer stored as written)
    ── the S8b room prune F1, then F2 = the S8a request PRUNE (phase 5: after every contact that named a pruned
       request has departed at F0 or been rewritten at A′), then F3 the cases, the staff and organisations ──
G   guard: contact/request pairs agree in the tables; THE POINTER RULE over the tables (foreign → refused,
      unresolved → counted); PRAGMA foreign_key_check empty
```

**THE POINTER RULE — one rule for `currentRevisionId`, `response.id`, `supersedesRevisionId`, `supersededByRevisionId`
and `discardedByResponseId` (corrected after the review of `854d035`, F1).** Every pointer is stored exactly as
written: a string in its column; `null` as NULL; an absent key recorded in `absent_keys_json`; an off-type value (a
number, an object, a list) with the column NULL and the value in `offtype_json`; duplicates (two revisions naming one
target; two rows sharing an id) kept as rows. Only a STRING value is a pointer, and it is classified at P over the
FINAL offer collection — when `recruitmentOffers` is supplied, the supplied array and nothing else (a stored offer the
array no longer lists departs at F0 and owns no row of the final graph; corrected after the review of `a5a7ed9`, R1);
when it is omitted, every stored offer's rows — and again at G (over the tables, which by then ARE the final
collection) by where its target exists — a revision pointer against the revision ids, a response pointer against the
response ids:

| The target … | Classification | What happens | Example |
|---|---|---|---|
| resolves to a row of the SAME offer | valid | stored | `rof-1.currentRevisionId = 'rof-1-r2'`, a revision of `rof-1` |
| names NO known row of that kind under ANY offer OF THE FINAL COLLECTION (tables at G) | **unresolved historical pointer** | stored verbatim; COUNTED in the cutover record and `/capabilities`; never refused; the read-time integrity report stays the judge (`offerIntegrity` → `current_revision`, `response`, …; the offer omitted from projections, as today) | `rof-1.currentRevisionId = 'revision-missing'` (the review's F1 case: the actual store keeps it); `rof-1` pointing at a row of `rof-2` in a save whose supplied `recruitmentOffers` no longer lists `rof-2` (R1 of `a5a7ed9`: `rof-2` departs, the pointer is unresolved, the save commits) |
| exists ONLY under ANOTHER offer OF THE FINAL COLLECTION | **known foreign-owner pointer** | refused — `OFFER_CHAIN_BROKEN`, ids only (the offer, the row, the pointer, the target, the owning offer), nothing written, the tables unchanged; equally when the whole offer collection is retained because the save omitted it (the owner is then in the final collection by retention) | `rof-1-r2.supersedesRevisionId = 'rof-2-r1'` while `rof-2` owns `rof-2-r1` and both are in the final collection; the review's F2b case (`discarded_by_response_id` naming `rof-2`'s response) |
| exists under the own offer AND another (ids repeated across offers) | valid | stored (ownership satisfied by the own row; the repetition is reported on read) | two offers each carrying a revision `shared-id` and pointing at it |
| is `null`, absent or off-type | not a pointer | stored as data, never refused | `discardedByResponseId` absent on every revision but the discarded one; a legacy `42` |

Why the asymmetry is the compatibility promise and not a new refusal in disguise: the current fully migrated store
saves and reloads an offer whose `currentRevisionId` names no revision (the review of `854d035` proved it on the actual
store, migrations and `offerIntegrity`), and §2.2 promised to keep such a record — the unresolved class is that promise,
byte for byte, with the existing read-time refusal/reporting untouched (no pointer cleared, no revision fabricated,
no offer deleted, no audience widened). The foreign-owner class is a pointer the writers cannot produce (every pointer
is set within one offer in one tick) and the S8b ownership lesson (a decision chain crossing rooms, F1 of `b7c0dd0`);
refusing it IS a statement beyond today's storage, stated as such in §3 and §9 and put forward for confirmation — it
is not a blanket legacy-data refusal: a legacy file whose pointers are merely unresolved imports whole.

Placement of F0 and R before any request work, and of A′/D′ after the request create/update and before the request
prune, is what lets (a) a departing contact and its departing request leave in one save, (b) a surviving contact move
to a new request while its old request departs, and (c) a new pair arrive, all under the RESTRICT key with IMMEDIATE
constraints and no parking. Probe 2 (corrected) proves on the design model, executing exactly this order: the same
valid final graph commits identically in both input orders and a partial save equals the full save (S1); the four P
refusals fire before any write with the tables byte-identical (S1); an owner departure removes its RESTRICT history
explicitly and the control (parent first) is refused (S2); the joint contact/request departure, the retarget with the
old request departing (in one save and as three partial saves), a new pair across two partial saves, and the
retained-dependant refusals with unchanged rows (S7); the pointer rule for each of the five pointers × own / unresolved
/ foreign (both owners in the final collection) / the owner no longer listed in the supplied collection (departs; the
pointer unresolved; the save commits) / the whole collection retained by omission / null / off-type / duplicate, the
review's F1 and F2b cases included (S8); a failure injected after F0/R, after B1, after the writes and at G, each
rolling back to byte-identical tables, and the unchanged retry landing the whole transition once (S9); the final
COLLECTION deciding ownership for each of the five pointers in both directions — the target's owner departing while
the pointer arrives, and the pointer's owner departing while a new offer arrives owning the target id — with a true
foreign-owner refusal (both owners in the supplied collection) leaving every row unchanged and the unchanged retry
landing, `[]` versus omitted, and an explicit `null` collection refused (S10). There is no retained unique predicate in
S8c to release before an arrival (every drafted partial unique index is withdrawn, §3; probe 2 S3 asserts none is
installed). The reviewers' own scripts, unchanged, run with `--expect-corrected` against the corrected model exit 0
(`854d035`: F1 kept verbatim, F2a the joint departure commits, F2b refused; `a5a7ed9`: the ten R1 cases commit, the
twelve controls pass), and against the models they reviewed still reproduce their findings (§13).

**The cutover (migration `0017`, when approved; one transaction, `foreignKeysOff` like `0016`):** refuse if any of the
nine tables exists without the record; require `0015` and `0016` recorded and `assertKeyFormat` to pass (the S8b
marker is read, never written); create the nine tables; rebuild `idempotency_keys` with the broadened CHECK (every
existing row copied back, probe 2 S5); import the two blobs through P and A′/D′ against the file's own tables (the
S8b import pattern, `recruitmentCases.mjs:615-630`: an absent blob imports nothing, a present `null` or non-array blob
refuses the step; a known foreign-owner pointer refuses the step with ids; an unresolved pointer imports and is
counted); retire the two blob rows; record `meta.recruitmentContactsOffersCutover` (counts only: per collection,
children, key rows, the counted references including the unresolved pointers per kind, the duplicates). No new format marker: the S8c key rows are
owned by the record's own id — the S8a representation, never the child-owned ambiguity R1 was about; should a later
build change that representation, the R1 rule applies to it (a persisted discriminator, fail-closed).

## 7. Durability boundaries — each side effect mapped to its save (today's behaviour, preserved)

| Action | What changes in memory | The save that carries it | Side effects and their timing | Failure classes |
|---|---|---|---|---|
| contact draft (`:273-345`), edit (`:347-379`), cancel (`:381-401`) | the contact record (+ history, rev) | the route's `persistNow()` (`:342`, `:377`, `:399`) — the S8c β hook writes the row in that save | `broadcast` after the save (`:343`) | staged save failure → pending intent, the client sees the error and retries by `clientKey` (create) or `expectedRev` (edit/cancel); replay answers from the record |
| contact send (`:405-558`) | the contact (status, recipient, requestId, attempts, routingSnapshot, emailCopy queued, lifecycle, history, send key), the NEW request row (S8a, `persist: false`), the case's status and history (S8b, `advanceCase`), the agent's notification row (S7a, staged into the same save) | ONE `persistNow()` (`:542`): the S8b core hook (the case), the recruitment hook (the request), the S8c β hook (the contact) in one transaction | `broadcast('contact_sent')` after the save (`:543`); the `delivered: true` answer after the save (`:553`); the guardian's courtesy e-mail is sent BEFORE the save (`:521`: today's behaviour — the mailer record is an outbox row of the same save) and its outcome lands in a LATER save (`:545-551`) | a failed save leaves the whole send pending in memory (contact, request, case together); a retry with the same send key replays from the record (`:422`); the failed-attempt path (`:459-473`) is its own save |
| contact response (`server.mjs:1568-1609`, `:3424-3457`) | the request's answer, the contact's response (via the hook `:628-653`), the thread opened on acceptance, the trial on a trial request, the owner/lead notification rows | the respond route's one save (P4A-D15) | the broadcast inside the hook (`:651`) runs when called — before the save, as today | the request's `ALREADY_RESPONDED` guard (`:1573`, `:3428`) is the replay protection |
| external record (`:562-619`) | the contact, the case move | ONE `persistNow()` (`:616`) | broadcast after | replay by `record` key (`:588-590`) |
| e-mail copy outcome (`:545-551`) | `emailCopy` in place | its own `persistNow()` | none | a failure leaves `queued` until the next save of anything (pending intent) |
| offer create (`:296-347`), edit (`:361-398`), revise (`:539-588`) | the offer (+ revision, history, keys), the case's audit entry (`audit(kase, …)`, S8b) | ONE `persistNow()` | broadcast after (`safe`) | replay by `create` key + fp, `revise` key + revisionId; `expectedRev` |
| offer issue (`:408-491`) | the frozen revision, the superseded one, the offer status, the case move (`advanceCase`), the key | ONE `persistNow()` (`:481`) | broadcasts, the recipient's / agent's / club's notifications AFTER the save (`:482-489`) | a refused case move rolls the in-memory freeze back before any save (`:467-471`); a failed save keeps the issue pending; replay by `issue` key + revisionId |
| offer withdraw (`:493-536`) | the revision, the offer, the case move back | ONE `persistNow()` (`:529`) | after | replay by `withdraw` key |
| offer accept / decline (`:696-784`) | the response row, the revision, the discarded draft, the offer, the case move, the case audit | ONE `persistNow()` (`:774`) | the development fault seam AFTER the save (`:779`): the client sees a failure, the store holds the answer, the retry with the same `clientKey` replays (`:709-713`) without a second move or notification; broadcasts and notifications after | the in-memory rollback on a refused case move (`:755`, `:763`) happens before any save |
| read receipts (`:669-670`, `:683`) | the receipt and a history entry | `persistNow()` once per list / read | none | write-once by the code check |
| share / un-share (`:788-816`) | `agentShare`, history | `persistNow()` | the agent's notification BEFORE the save (`:809`, staged into the same save) | no rev bump by design |
| the deletion unit (`server.mjs:4293`, `:4308`) | in-place edits of contacts and offers | the unit's one commit | — | a failed unit restores both mirrors from the memento |

Nothing above changes: the S8c hooks write the rows in the SAME save the route's `persistNow()` triggers today, so no
success is published before the required persistence and no notification is sent twice. "Duplicate delivery" risks
that exist today (the courtesy e-mail before the save; the agent notification before the save) are today's behaviour,
recorded here and not redesigned — a change there is a product/engineering decision outside a storage step.

## 8. Copy-only rollback to the accepted pre-S8c build (`7072dd9`) — proposed; implemented as written (§14)

`scripts/recruitmentContactsOffersRollback.mjs` (`rollback:recruitment-contacts-offers`), the S8b tool's contract
(`repositories/recruitmentCasesRollback.mjs:1-36`) applied: the source file opened read-only and copied with `VACUUM
INTO`; on the copy only — refuse `LATER_SCHEMA` (a recorded step this tool does not know), `NOT_CUT_OVER` (no `0017`),
`OUTPUT_NOT_EMPTY`, `UNEXPECTED_SCHEMA` (the record without the tables), and `FORMAT_UNSUPPORTED` for the S8b marker
exactly as the S8b tool does (the S8c tool reads S8b rows? It does not — but it must not touch a file the S8b tool
would refuse, so it checks the marker first and leaves it alone); then, in one transaction: read every contact and
offer back through the S8c readers (every record in its writer's literal, children nested in list order, the keys
reassembled — absent / null / off-type / unknown exactly as recorded, every pointer including an unresolved historical
one byte for byte) and write the two blobs; delete the S8c owners'
rows from `idempotency_keys` and rebuild it with the S8b owner CHECK (`idempotencyKeysDdl(S8B_KEY_OWNERS)`, probe 2
S5: the S8a and S8b rows byte-identical, the S8b marker untouched); drop the nine tables; delete the `0017` record and
`meta.recruitmentContactsOffersCutover`; advance `meta.saveSeq`. Nothing else: the S8a/S8b tables, threads, identity
and audit tables are exactly those of the source. Revalidate before reporting (integrity, foreign keys, the tables and
record gone, the two blobs with the tables' counts, the key table's S8b rows row for row, the marker present). The
re-upgrade (migration `0017` on the copy) imports the blobs back as the same rows; the admin backup/restore carries
the two collections through `readTableBacked` / `writeTableBacked` and a restore into a new directory imports them
through `0017`.

**The old build on a `0017` file — predicted here, MEASURED by the implementation (§14).** The prediction as written
at design time: `7072dd9` booted directly on a cut-over file would find no `recruitmentContacts` blob and no
`recruitmentOffers` blob; its migration registry (`m230_004`, `m182/migrations.mjs:333`) and `registerOffers`
(`m28/index.mjs:63`) would CREATE both as empty arrays, the server would listen, serve no contact and no offer, and
write two empty blobs beside the untouched tables. **What the actual build did** (`SCOUTBOX_PRE_S8C_SERVER = 7072dd9`,
`scripts/testRecruitmentContactsOffersServer.mjs`, the MEASURED line printed on every run): it LISTENED; its boot log
reads `INTEGRITY STORE_MISSING recruitmentContacts — required collection(s) absent after migration; nothing was
repaired.`; `GET /org/rooms/:id/contacts/:cid` answered **500** (the contact routes find no container — the legacy
`m230_004` step is already recorded in the file's schema version, so that build does NOT re-create
`recruitmentContacts`), `GET /org/rooms/:id/offers` answered 200 with **0 offers** (`registerOffers`'s `??= []` gives
it an empty container); the nine tables were untouched; the save revision advanced 16 → 18; **ONE blob was written,
`recruitmentOffers []`** — not two as predicted; this build, started on that copy, drops the stale empty blob at attach
and serves the contact and the offer from the tables again. The DANGER line in `OPERATIONS.md` states the measured
behaviour; the rollback chain is S8c tool → S8b tool → S8a tool.

## 9. Decisions — what is the Founder's and what is engineering

**Answered (24 October 2026).** The independent review of `19f5ca8` cleared this brief to ask ("the brief in readiness
review §9 is now cleared to ask"); the Founder answered both questions on 24 October 2026, explicitly for these
tables, recorded verbatim and not to be asked again: **Q8c-a "Approve tolerant (Recommended)"** — option (1) below;
**Q8c-b "Approve strict checks (Recommended)"** — option (1) below. Both are implemented as the options describe (§14;
`repositories/recruitmentContactsOffers.mjs` header; `/capabilities` → `dataLayer.domains.recruitmentContactsOffers
.references`). No database key to a player or guardian account is implied by either answer. The brief as it was put,
kept as the record: it reuses no earlier approval beyond its recorded scope — Q7a/Q7c covered the S8a tables, Q8a the
S8b tables.

**Q8c-a — the player references on the S8c tables (product policy).** Affected: `recruitment_contacts.player_id` and
`recipient_player_id`; `recruitment_offers.player_id`; `offer_revisions.recipient_player_id`;
`offer_responses.for_player_id` and `actor_id` when the actor is the player; `offer_read_receipts.viewer_id` when the
viewer is the player. What they are: the contact history and the offers made to a player, which the club keeps after
the player leaves (today: the record stays; the reply, the response names and the history names go; `subjectRemovedAt`
is set). Options: **(1) tolerant and counted (recommended)** — no database key; a live, retained (S4b-R) or
historically missing player id resolves, is counted in the cutover record and `/capabilities`, and is never refused,
fabricated or deleted — the Q7a/Q8a pattern, consistent across the recruitment domain; **(2) strict in code** — a
contact or offer naming a player id absent from the final `players` table refuses the cutover and every snapshot
write (ids only; a refusal stops the migration and authorises no deletion — the Q8a strict-option wording). What
depends on the answer: the preflight's treatment of those columns; the implementation can proceed on everything else.

**Q8c-b — the guardian references on the S8c tables (product policy).** Affected:
`recruitment_contacts.recipient_guardian_id`; `offer_revisions.recipient_guardian_id`; `offer_responses.actor_id` when
the actor is a guardian; `offer_read_receipts.viewer_id` when the viewer is a guardian. What they are: which guardian
was the valid route at the moment of a send or an issue, and who answered. No guardian deletion route exists today
(`guardianRouter.delete('/children/:id')`, `server.mjs:4342`, unlinks a child; the guardian row stays). Options: **(1)
strict in code (recommended for consistency with Q7c, which chose it for the S8a guardian columns)** — a snapshot or
cutover naming a guardian absent from the final `guardians` table is refused with ids (no key: the identity plan
decides keys); **(2) tolerant and counted** — like Q8c-a option 1. What depends on the answer: the preflight only.

**Engineering choices, recorded with their evidence (not permission questions):** the nine tables and the one shared
table (§1); the lossless mapping and the held key acts (§2, probe 1); every constraint verdict of §3 (probe 2 S3);
the one new real key and the pair guard (§4, probe 2 S1); the staff ids as RESTRICT keys with a cutover refusal on a
historically missing staff id (the S8b precedent — if the review prefers tolerance here, it is a one-line change in
`CONSTRAINTS` and the preflight, not a product question); the write order (§6); the rollback (§8); one module and one
migration for both collections (§10); the `contact_channel_id` naming correction (§1.1); the S8d note on the revision
id uniqueness (§3). **Put forward for the review's explicit confirmation (an engineering statement that goes beyond
today's storage, not a product question and not assumed authorised):** the refusal of a KNOWN FOREIGN-OWNER offer
pointer (§6, the pointer rule) — the blob store would save it, no writer can produce it, and the accepted S8b applies
the same ownership protection to decision chains; every other pointer state, the unresolved historical one included,
imports and is kept exactly as today. **Confirmed by the independent review of `19f5ca8` (24 October 2026)** as the
reviewed ownership protection: "a target unresolved everywhere is retained verbatim and counted, while existing
read-time corruption handling remains in place; an own target remains valid even if another offer uses the same target
id"; implemented so (§14).

## 10. Implementation checklist (ordered; each item with its acceptance criterion) and the test plan

**Carried out on 24 October 2026 in this order (§14 the record):** one migration and one module for both collections
(the recommended slice); items 1–3 tests-first on the unchanged `19f5ca8` tree (the suites fail there on concrete
assertions — the imports of the absent modules and the `0017` registration; the logs travel with the handoff), items
4–10 as listed; the existing suites named below were run on the final tree and on the untouched `7072dd9` checkout
and classified (§14).

**Slices.** One migration (`0017`, when approved) and one repository module for both collections are recommended: the
two collections are independent of each other (no reference either way), each depends only on tables already live
(cases, requests, orgs, staff), and one tool keeps the rollback chain at three links. If the review prefers smaller
reviewable surfaces, the natural split is **S8c-i contacts** (the request key, the pair guard, the e-mail-copy state)
and **S8c-ii offers** (the two-level nested model, the same-offer guard) — each then needs its own migration number,
its own rollback tool and its own old-build boot measurement, and S8c-ii's cutover must require S8c-i's record. Either
way the development is tests-first per collection on the unchanged `7072dd9` tree.

1. **Fixtures** (`scripts/recruitmentContactsOffersTestFixtures.mjs`): every literal of §2 incl. the pre-P5.6E contact,
   the external record, the null-key send, the discarded draft, the legacy non-array `keys.issue`, the missing
   `readReceipts`, prototype-named own keys, off-type values, duplicate revision ids. *Criterion:* probe 1's cases are a
   subset.
2. **Failing-first unit suite** (`scripts/testRecruitmentContactsOffers.mjs`, chained in `npm test` after
   `testRecruitmentCases.mjs`): `[cutover]` the `0017` record, the nine tables, the broadened CHECK, the two blobs
   retired, the counts, every refusal with ids; `[mapping]` the round trip of every fixture, presence/absence/null/
   off-type/unknown/list order, the held acts; `[write]` both input orders, partial snapshots with omitted collections
   retained, F0 departures with RESTRICT history, the joint contact/request departure, the retarget with the old
   request departing, the four P refusals and G, the pointer rule for each of the five pointers (own / unresolved kept
   and counted / known foreign owner refused / null / off-type / duplicate), an injected statement failure at each
   phase and a real COMMIT failure (`failCommitOfOpenTransaction`) with byte-identical tables and the retry landing
   once; `[repo]`
   in-place edits landing in the next save, an unchanged save writing nothing, the unit memento restoring both mirrors,
   the entry points refusing a direct push; `[rollback]` the copy-only tool, the refusals, the re-upgrade, a restore
   through `0017`, the S8b marker untouched. *Criterion:* fails on the unchanged `7072dd9` tree on concrete assertions.
3. **Failing-first real-server suite** (`scripts/testRecruitmentContactsOffersServer.mjs`): draft → send (with
   `deliveryFailInject` once) → guardian response through the real respond route; external record; offer create →
   edit → issue → revise → recipient accept with a draft beside; withdraw; share-agent; read receipts; `/capabilities`
   counts; the recipient's and the agent's surfaces unchanged (no internal note, no decision id, no body in the
   journey); another club's 404; the deletion unit with a real COMMIT failure and the retry; the admin backup and a
   restore into a new directory; the actual `7072dd9` build booted on the rollback copy (`SCOUTBOX_PRE_S8C_SERVER`)
   reading the same contacts and offers and writing one of each, re-upgraded by this build; the old build booted
   DIRECTLY on a `0017` copy (measured, whichever way it goes); a rollback copy whose blob is a present JSON null
   refused at boot. *Criterion:* fails on `7072dd9` on the `[cutover]` assertions; the `[compat]` checks hold on both.
4. **The module** `repositories/recruitmentContactsOffers.mjs` (shapes of §2, constraints of §3, preflight / stage /
   prune / assert of §6, the repository with two hooks and the memento of §5, the import, the readers, `exportAll`).
5. **Migration `0017`** (§6 cutover) registered in `DATA_MIGRATIONS`; `TABLE_BACKED` extended; `attachDataLayer` wiring
   (the two hooks around the six, the views published, the accessor to the cases view and the requests view);
   `writeTableBacked` / `readTableBacked` positions of §5; the `/capabilities` domain.
6. **Caller conversion** (storage only): `contactRoutes.mjs:338`, `:614` → `addContact`; `m28/index.mjs:342` →
   `addOffer`; nothing else in the two modules changes (every other write is an in-place edit); `m23/index.mjs:203-209`
   and `m182/migrations.mjs:331-334` keep their comments truthful (a note that the data layer publishes the view since
   `0017`).
7. **Rollback tool** `repositories/recruitmentContactsOffersRollback.mjs` + `scripts/recruitmentContactsOffersRollback.mjs`
   (§8), chained ahead of the S8b tool in the existing chain tests (`testRecruitmentServer.mjs` pattern).
8. **DDL file 02** amended to the implemented definitions with "draft versus implemented" notes (the §3 verdicts);
   `testSchemaDdl.mjs` extended; `testCoreSchema.mjs` / `testIdentityRepositories.mjs` migration-slice regexes and
   `TABLE_BACKED` lists updated (the S8b experience, two gate rounds).
9. **Docs**: `OPERATIONS.md` (cutover, rollback, the DANGER line as measured, the exit codes), `sqlite-schema.md`
   (two rows LIVE, the counts), plan §D.10 implementation record, this review's §12 implementation record, `CLAUDE.md`.
10. **Gates and handoff** as standing: backend `npm test` on Node 22 and 24 with the NINE historical builds (`7072dd9`
    added as `SCOUTBOX_PRE_S8C_SERVER`), the Player suite, the batteries below, the two design probes and the reviewer
    scripts; the handoff ZIP with a fresh extraction; stop for independent review.

**Existing suites to run (named from `scoutbox-server/scripts/`; adapt only where they inspect storage directly):**
`m23ContactE2E`, `m23ContactPersistence` (reads the snapshot through `openStore().load()`, which returns the
table-backed collections — the byte-identical blob comparisons become record comparisons, as `m23DecisionPersistence`
was adapted for S8b), `m23ContactPerf`, `m23OfferE2E`, `m23OfferHardeningE2E`, `m23OfferPersistence` (its checks 1.2
and 1.5–1.8 assert the module guarantee and an empty `recruitmentOffers` blob in a snapshot — the guarantee stays, the
blob becomes the view), `m23OfferPerf`, `m23E2E`, `m23Persistence`, `m23BootContract`, `m23RecruitmentJourneyE2E`,
`m23RecruitmentJourneyHardeningE2E`, `m23RecruitmentJourneyPersistence`, `m23JourneyPerf`, `m23TrialE2E` /
`m23TrialPersistence` (the request/contact pair through the respond routes), the downstream signing checks that read
offers `m23SigningE2E`, `m23SigningHardeningE2E`, `m23SigningPersistence`, the agent checks that read shared offers and
routed contacts `m23AgentIntegrationE2E`, `m23AgentTransactionE2E`, `m23AgentTransactionPersistence`,
`m23AgentFinalHardeningE2E`, and `m23DecisionPersistence` (already table-aware). Each run on the final tree and on the
untouched `7072dd9` checkout, classified (the S8b battery record is the template).

## 11. Evidence in the handoff

- `probes/s8c-probe-1-mapping.mjs` (32 checks, unchanged) and `probes/s8c-probe-2-constraints-order.mjs` (103 checks,
  corrected after the reviews of `854d035` and `a5a7ed9`) with their results on Node 22 and Node 24
  (`probes/results/`), exit 0; probe 1's OBSERVED line (the act order inside a `keys` map);
  `probes/baseline/s8c-probe-2-constraints-order.mjs`, the 75-check model the review of `a5a7ed9` received, unchanged,
  with the reviewer's `review-a5a7ed9-final-graph.mjs` against it (exit 1: ten R1 reproductions across the five pointer
  kinds; twelve controls pass) and against the corrected model with `--expect-corrected` (exit 0, ten corrected cases
  and twelve controls, Node 22 and 24); `probes/baseline-854d035/`, the ORIGINAL 31-check model, with
  `review-854d035-design-reproductions.mjs` against it (exit 1: F1, F2a, F2b reproduced; the two controls pass) and
  that script against the corrected model with `--expect-corrected` (exit 0); the corrected probe's regressions run
  against the `a5a7ed9` baseline through its `S8C_PROBE_MODEL` adapter (failing-first: 21 of 103 checks fail there —
  the five S8 "supplied collection removes the owner" cases, the ten S10 direction cases, the explicit-`null` refusal,
  and five S8 retained-collection controls that fail as a consequence of the preceding refusal, labelled as such in
  the output) and against the original `854d035` model (54 of 103 fail — the F1/F2 and R1 cases together with the
  labelled set-up artefacts).
- The reviewer's unchanged bundle for `7072dd9` re-run on the accepted tree (recovery with the genuine `b7c0dd0` and
  `2fe05df` creators, the two format-boundary runs, the reproductions, the two matrices, the key transitions, the
  old-format probe and the boot refusal), Node 22 and 24, all exit 0 (`logs/reviewer/`).
- The gates after the final edits of the design milestones: backend `npm test` on Node 22 and 24 with the eight
  historical builds booted for real, the Player suite (`logs/gates/` of those handoffs).
- The line-level references of §1–§7 were verified against `7072dd9` on 23 October 2026.
- **The implementation milestone (§14; its handoff):** the independent review of `19f5ca8` verbatim (the verdict, its
  run record and logs; its manifest re-verified); the two Founder answers as given; the failing-first logs of the two
  new suites on the unchanged `19f5ca8` tree (the implementation files moved aside; `logs/failing-first/`); the final
  runs of the two suites with the genuine `7072dd9` build wired (the MEASURED line); the reviewer's unchanged
  `review-a5a7ed9-final-graph.mjs` and `review-854d035-design-reproductions.mjs` with `--expect-corrected` against the
  corrected model, both probes and the baselines unchanged; the battery record (every §10 battery on the final tree and
  on the untouched `7072dd9` checkout, classified); the gates after the final edits — backend `npm test` on Node 22 and
  Node 24 with the NINE historical builds booted for real (`7072dd9` added as `SCOUTBOX_PRE_S8C_SERVER`), the Player
  suite — with versions, SQLite versions, counts, exits captured immediately, skips and `EADDRINUSE` counts; the
  fresh-extraction record on both runtimes.

## 12. Limitations and what remains open

- The whole-snapshot-write objective is NOT met by S8c: packages, signings, follow-ups, outcome reports (S8d) and every
  later collection are still blobs rewritten by each save; no performance gain is claimed or measured.
- The old build's behaviour on a `0017` file was predicted (§8) and is now MEASURED (§8, §14): it listens, serves no
  contact (500) and no offer (an empty list), writes ONE empty blob (`recruitmentOffers`), touches no table row; the
  prediction of two blobs was wrong by one, the conclusion (the rollback tool on a copy is the only way back) stands.
- The `keys` act order inside a map is not the writer's after a round trip when held and row acts interleave (probe 1,
  OBSERVED): an engine property shared with S8a/S8b, harmless to every reader, recorded so a reviewer comparing raw
  JSON byte for byte is not surprised; a canonical (key-order-insensitive) comparison is the right test, as
  `m23DecisionPersistence` already uses and as the new suites use (`canon`, `recCanon`).
- `offer_revisions.id` is indexed, not unique (§3); S8d's drafted key to it needs a decision then (§3, S8d note).
- The two product questions of §9 are ANSWERED (24 October 2026, after the independent acceptance of the design at
  `19f5ca8`): Q8c-a tolerant, Q8c-b strict; implemented (§14).
- The refusal of a known foreign-owner offer pointer (§6) is the one statement of this design that goes beyond today's
  storage; it was put forward for confirmation (§9) and CONFIRMED by the review of `19f5ca8`. After the review of
  `a5a7ed9` it is narrower than the first correction stated: "known" means owned by an offer OF THE FINAL COLLECTION;
  an offer the supplied collection no longer lists owns nothing, and a partial snapshot that drops it imports (§6, §13).
- Today's pre-save side effects (the courtesy e-mail, the agent notifications) are recorded in §7 and unchanged.
- Not measured, not claimed: a faster save or a smaller file (the change-tracking fingerprint still serialises every
  record per flush; the bench of item 10 was not run); the whole-snapshot-write objective is still not met (S8d and
  the later collections are blobs).

## 13. Correction record — after the independent reviews of `854d035` and `a5a7ed9` (24 October 2026)

The review of `854d035` accepted the S8b acceptance record and did not accept this design: two P2 findings
demonstrated by three reproducible cases (`review-854d035-design-reproductions.mjs`, run unchanged against the
ORIGINAL design model: exit 1; its two controls — the actual migrated store keeping the F1 offer unchanged, and the
documented F0-first order succeeding with immediate keys — pass). Both findings are design/evidence findings about a
prepared design; neither is a defect in an implemented S8c repository, and nothing in the S8b acceptance is touched.

**F1 — the offer-pointer contract contradicted itself.** §2.2 said a `currentRevisionId` naming no revision is
corruption KEPT by storage; §6 G refused every pointer that did not resolve within the offer, so one such legacy
offer — which the actual store saves and reloads unchanged, `offerIntegrity` reporting only `current_revision` — would
have blocked the cutover. Corrected by ONE pointer rule for all five pointers (§6): own target valid; unresolved
historical target kept verbatim, counted, never refused, the read-time report unchanged; a target that exists only
under another offer refused with the owner named. §2.2, §2.3, §3 (the two pointer rows, `current_revision_id` now
nullable), §4, §6 P/G, the cutover and rollback paragraphs, §9, §10, §11, §12 and plan §D.10 are reconciled with it.
The foreign-owner refusal is stated as the one compatibility statement beyond today's storage and put forward for
confirmation (§3, §9); it is not assumed authorised and no blanket legacy refusal is introduced.

**F2 — the model executed another order than the document, and its guard omitted a pointer.** The original model wrote
contacts before requests with a parked back-reference, combined the request upsert and prune at one step, and pruned
departed contacts last, so a valid joint contact/request departure failed on the key; its guard's UNION omitted
`discarded_by_response_id`, so a pointer to another offer's response was admitted. Corrected by (a) fixing the ONE
order against the accepted S8a/S8b boundaries — the S8a request create/update (phases 1–3) and the S8a request prune
(phase 5) are separate steps, and in staged mode both run inside the recruitment hook between the two S8c hooks (the
accepted `recruitment.mjs` flush prunes internally) — as P → F0 → R → B1 → A′ → D′ → F2 → G (§6), with the obsolete
parking / B′ / C′ descriptions removed from §4, §5 and §6 and the hook/snapshot placements restated (§5); (b) the model
rewritten to execute exactly that order and to check all five pointers (probe 2, 75 checks), with the failing-first
regressions the review asked for — joint departure, retarget with the old request departing, new pairs and partial
saves with either collection retained, retained-dependant refusals with unchanged rows, every pointer kind under the
rule, failures at each intermediate phase and at G with byte-identical rollback and the unchanged retry — run first
against the ORIGINAL model through a transparent adapter (`S8C_PROBE_MODEL`: the baseline's functions imported from its
own prefix, the reviewer's technique; 30 failures, 27 of them the F1/F2 cases) and then green on the corrected model;
(c) the reviewer's unchanged script run with `--expect-corrected` against the corrected model: exit 0 on Node 22 and
24 (F1 preserved verbatim; F2a the joint departure succeeds; F2b refused atomically). The original model is kept as
`probes/baseline/` beside the corrected one; the S1 section boundary and the `openModel / write / dump / CON / REQ /
OFF` interface are unchanged, so the reviewer's script runs against either without modification. What is a model and
what is not: probe 2 is a design model of the proposed tables and the documented order; the only actual-store
evidence in this milestone is the reviewer's own F1 control (the candidate's migrations, store and `offerIntegrity` on
a synthetic file); no real-server or implemented-repository evidence for S8c exists, because S8c is not implemented.

**Status after the correction:** S8c is a CORRECTED DESIGN, PENDING INDEPENDENT ACCEPTANCE — not implemented, not
accepted; `0017` not reserved; S8d not started; Q8c-a and Q8c-b unanswered and the brief not cleared. The gates of the
milestone (the backend chain on Node 22 and Node 24 with the eight historical builds booted for real, the Player
suite, the unchanged `7072dd9` reviewer scripts, the `854d035` script and both probes) are recorded in the handoff.

### 13.1 Second correction — after the independent review of `a5a7ed9` (24 October 2026)

The review of `a5a7ed9` found ONE further P2 design-model finding, R1, demonstrated by ten reproducible cases across
the five pointer kinds (`review-a5a7ed9-final-graph.mjs`, run unchanged against the 75-check model of `a5a7ed9`: exit 1,
ten reproductions, twelve controls passing; with `--expect-corrected` against the same model: exit 1 at the first case).
It is a design-model finding about a prepared design; nothing in the S8b acceptance is touched and no source file
changes.

**R1 — the model's final-collection preflight merged omitted rows.** The model's P classified the pointers over "the
supplied offers' literals PLUS the rows of every stored offer the supplied array did not list", while its F0 then
deleted exactly those offers. A valid partial snapshot — `recruitmentOffers` supplied without offer B, offer A's
pointer naming a row that B used to own — was therefore refused as a known foreign-owner pointer although B was
departing and owns nothing in the final graph; the five S8 checks of the `a5a7ed9` model at the "other offer retained
rather than supplied" block encoded that wrong merge as the expectation. Corrected by stating the collection semantics
once (§6, before the algorithm) and making the model follow them: a collection OMITTED from the save is retained WHOLE
(its rows, pointer bytes included, are in the final graph); a collection SUPPLIED as an array IS the entire final
collection (an unlisted stored record departs at F0 and owns nothing; `[]` empties the collection); an explicit `null`
or non-array collection is refused, not treated as an omission; a staged dirty subset is not a snapshot collection —
the staged mirror is complete and P classifies over the complete mirror. "Retained" is by COLLECTION for a partial
snapshot, never by omitted row. The model's `graphOfFinal` now derives the final offer graph from the supplied array
alone when one is supplied and from the tables only when the collection is omitted; its `write` refuses a non-array
collection before any write. The five wrong S8 expectations are replaced by the full-collection result (the save
commits, the unlisted owner departs, the pointer is kept verbatim and counted as unresolved) and each is followed by a
real retained-collection control (a contacts-only save leaves the whole offer collection and its pointer bytes
byte-identical); a new S10 section adds, for each of the five pointer kinds, both directions (the target's owner
departing while the pointer arrives; the pointer's owner departing while a new offer arrives owning the target id), a
TRUE foreign-owner refusal with both owners in the supplied collection (rows and counts unchanged, the unchanged retry
landing), `[]` versus omitted, and the explicit-`null` refusal. The earlier F1/F2 cases (S7–S9) and the 32-check
mapping probe are retained unchanged. Evidence: the regressions were run FIRST against the `a5a7ed9` model through the
transparent `S8C_PROBE_MODEL` adapter (21 of 103 fail there — the fifteen R1 cases, the `null` refusal and five
consequence-labelled controls; the adapter clears the variable while the baseline's prefix evaluates, because that
model carries the same adapter) and are green on the corrected model (103 checks, Node 22 and 24); the reviewer's
unchanged script with `--expect-corrected` against the corrected model exits 0 on Node 22 and 24 (ten corrected cases,
twelve controls); the `854d035` script with `--expect-corrected` still exits 0 against it; the model's `openModel /
write / dump / CON / REQ / OFF` interface and the S1 section boundary are unchanged. §6 (the inputs, P, the pointer-rule
paragraph and table), the probe summary in the header, §11 and §12 are reconciled; plan §D.10, `sqlite-schema.md`,
`CLAUDE.md` and `OPERATIONS.md` name the second correction. Probe 2 remains a design model; no real-server or
implemented-repository evidence for S8c exists, because S8c is not implemented.

**Status after the second correction:** unchanged in kind — S8c is a CORRECTED DESIGN, PENDING INDEPENDENT ACCEPTANCE,
not implemented, not accepted; `0017` not reserved and no stub; S8d not started; Q8c-a and Q8c-b unanswered and the
brief not cleared; the foreign-owner refusal (now explicitly over the final collection) still put forward for
confirmation, not assumed.

**Status after the independent review of `19f5ca8` (24 October 2026):** R1 CLOSED; "the corrected S8c design is
accepted for implementation subject to the Founder's explicit Q8c-a and Q8c-b decisions" (the design, not an
implemented repository); the foreign-owner refusal confirmed as the reviewed ownership protection; the brief cleared
and then answered (Q8c-a tolerant, Q8c-b strict — §9). Implemented on top of `19f5ca8` — §14.

## 14. Implementation record (24 October 2026, one commit on top of `19f5ca8`)

**Preconditions, recorded.** The design acceptance: the independent review of `19f5ca8` (its verdict, run record and
logs travel verbatim in the handoff) — R1 CLOSED, the design accepted for implementation subject to Q8c-a/Q8c-b; the
reviewer's unchanged scripts exit 0 with `--expect-corrected` against the corrected model and reproduce their
findings against the baselines; the backend gate of that review passed independently on Node 24 after a sandbox
permission (35 suites / 421 checks, eight historical builds). The Founder's explicit answers of 24 October 2026, given
for these tables (no earlier answer and no recommendation was treated as consent): **Q8c-a "Approve tolerant
(Recommended)"**; **Q8c-b "Approve strict checks (Recommended)"**. The starting tree: `19f5ca8` (parent `a5a7ed9`),
clean; `0017` verified free (`repositories/index.mjs` ended at `m0016`, `repositories/migrations/` at `0016`) before
it was registered. The S8b acceptance at `7072dd9` is untouched: no S8b file's behaviour changed; the S8b key-format
marker is read, never written, by anything of S8c.

**What landed.** `repositories/recruitmentContactsOffers.mjs` (the shapes of §2 as specs over the S8a engine, which
`recruitment.mjs` exports — `encode`, `decodeLevel`, the DDL helpers, `idempotencyKeysDdl`; the two collection
descriptors `CONTACTS` / `OFFERS` with the nine tables, the indexes and the §3 constraints — `org_id` and `case_id`
RESTRICT on both parents, `request_id → recruitment_requests` RESTRICT, the staff ids RESTRICT and nullable, NOT NULL
only on `id`, `org_id`, `case_id`, `player_id`, the history tables RESTRICT and every other child CASCADE; the generic
writer / reader / deleter; `validateEntry` (the table dispatcher's contract: a present collection must be an array of
records with the identifying strings); `classifyPointers` — the pointer rule of §6 over the FINAL offer collection for
`POINTER_KINDS` (`current_revision_id`, `response_id`, `supersedes_revision_id`, `superseded_by_revision_id`,
`discarded_by_response_id`); `preflight` (P, ids only, over the final combined graph: cases, requests, departing
requests and cases, organisations, staff, guardians, the retained rows); `stageDepartures` (F0), `releaseRequests` (R),
`stageRecords` (A′/D′); `assertContactsOffersConsistent` (G: the pair agreement, the five pointers by SQL over the
tables, `foreign_key_check` empty); the counters `unresolvedPlayerReferences`, `retainedPlayerReferences`,
`unresolvedPointerReferences` (per kind, plus the dangling decision ids); `CONTACTS_OFFERS_SNAPSHOT` (`read`, `begin`,
`write`, `assert` — the positions of §5 inside `writeTableBacked`); `importRecruitmentContactsOffersBlobs`;
`createRecruitmentContactsOffersRepository` — the two read-only ARRAY views of plain mutable records (`markView`,
mutation refused), `addContact` / `addOffer`, the committed fingerprints and the staged flush, the graph memento
(`snapshotState` / `restoreState`) the store's unit of work takes and restores, the two save hooks `preHook` (α: P,
F0, R) and `writeHook` (β: A′, D′, G), the hook-registration check (a staged mutation before both hooks are taken is
refused), `exportContacts` / `exportOffers` / `exportAll`). `repositories/migrations/0017_recruitment_contacts_offers.mjs`
(registered; requires `0016` and the S8b key-format marker first — `assertKeyFormat`, the marker read and left as it
is; refuses pre-existing tables; creates the nine tables; rebuilds `idempotency_keys` with the owner CHECK broadened to
the two parents — `rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8C_KEY_OWNERS))`, the `0016` helper,
every S8a/S8b row byte for byte; imports the two blobs through the same preflight as a snapshot write, in array order;
retires the two blob rows; records counts only in `meta.recruitmentContactsOffersCutover`, the rebuild named). Any
refusal aborts the whole migration with `CONTACTS_OFFERS_IMPORT_BLOCKED` naming the specific refusal —
`CONTACT_OFFER_CASE_MISSING`, `CONTACT_REQUEST_DANGLING`, `CONTACT_REQUEST_MISMATCH`, `CONTACTS_OFFERS_ORG_MISSING`,
`CONTACTS_OFFERS_USER_MISSING`, `CONTACTS_OFFERS_GUARDIAN_MISSING` (Q8c-b), `OFFER_CHAIN_BROKEN`,
`CONTACTS_OFFERS_KEY_VIOLATION`, and at a snapshot write `CASE_STILL_REFERENCED` / `CONTACT_STILL_REFERENCED` — with
collections, positions, tables and ids, never a subject, a body, a note, a message or a name; a present `null` or
non-array blob is refused like a malformed entry, only an absent blob imports nothing.
`repositories/recruitmentContactsOffersRollback.mjs` and `scripts/recruitmentContactsOffersRollback.mjs`
(`npm run rollback:recruitment-contacts-offers -- <data-dir> <fresh-empty-dir>`; §8 as designed: `VACUUM INTO` a copy,
the refusals `LATER_SCHEMA` (exit 4), `NOT_CUT_OVER` (5), `FORMAT_UNSUPPORTED` for the S8b marker checked FIRST and
left alone (6, the message `RECRUITMENT_CASES_FORMAT_UNSUPPORTED` as the S8b tool's), `UNEXPECTED_SCHEMA` (10),
`OUTPUT_NOT_EMPTY` / `NO_SOURCE` (1); in one transaction the two blobs written back in insertion order in the
writers' literals, the S8c owners' key rows removed and the key table rebuilt with the S8b owner CHECK, the nine tables
dropped, the `0017` record and meta key removed, `saveSeq` advanced; revalidated before reporting, the untouched
tables compared to the source). `repositories/index.mjs` (`DATA_MIGRATIONS` + `m0017`; `TABLE_BACKED` + the two
collections; `readTableBacked` reads the S8c snapshot; `writeTableBacked`: `CONTACTS_OFFERS_SNAPSHOT.begin` BEFORE the
S8b snapshot's begin — P, F0, R —, `.write` after `RECRUITMENT_SNAPSHOT.replace` — A′, D′ —, `.assert` after the S8b G;
`attachDataLayer`: the repository created with accessors to the recruitment repository and the cases view, `preHook`
registered before `recruitmentCases.coreHook()`, `writeHook` after `recruitment.saveHook()`, the cutover log line
`recruitment contacts/offers: cutover imported …`, the stale in-memory arrays dropped at attach with a warning, the two
views published, the boot entry; the `/capabilities` domain `recruitmentContactsOffers` — `mode`, `rows`,
`pendingWrites`, `unresolvedPlayerReferences`, `retainedPlayerReferences`, `unresolvedPointerReferences`, `writeMode`,
`references` naming Q8c-a and Q8c-b). The caller conversions, storage only: `m23/contactRoutes.mjs` (the two `push`
sites — the create route and the external record — → `recruitmentContactsOffers.addContact`), `m28/index.mjs` (the
`push` → `addOffer`), `server.mjs` (the repository passed into the M23 and M28 contexts); `m23/index.mjs` and
`m182/migrations.mjs` keep their comments truthful (the data layer publishes the view since `0017`). The admin backup is
unchanged (`m13/enterprise.mjs` serialises the two views — the mirrors — as it serialised the arrays; the writers'
literals, insertion order, keys reassembled); a restore into a new directory imports them through `0017`. File 02
amended (the drafted contact and offer sections replaced by the generated definitions with "draft versus implemented"
notes — the §3 verdicts —, the key table's CHECK shown as `0017` leaves it, a two-line status block); `package.json`
(the two suites chained — `testRecruitmentContactsOffers` after `testRecruitmentCases`,
`testRecruitmentContactsOffersServer` at the end — and the rollback script). The fixtures
`scripts/recruitmentContactsOffersTestFixtures.mjs` (every literal of §2: the draft, the sent and answered contact, the
null-key send, the external record, the pre-P5.6E contact, the off-type contact, the draft / issued-and-accepted /
declined / legacy offers with the legacy non-array `keys.issue`, the missing `readReceipts`, the unresolved
`currentRevisionId` and `decisionId`, prototype-named own keys, the request literals of the pair) and the two suites
`scripts/testRecruitmentContactsOffers.mjs` (9 checks) and `scripts/testRecruitmentContactsOffersServer.mjs` (3
checks). Every public route, permission, audience, lifecycle, safeguarding and retention rule is unchanged; the route
payloads are unchanged; nothing is deduplicated, repaired, fabricated or dropped.

**Departures from the proposed sections, each recorded here.**
- §5 proposed two hooks (α before the S8b core hook, β after the recruitment hook): implemented exactly so; the
  snapshot positions of §5 likewise (begin before the S8b begin, write after the S8a replace, assert after the S8b G).
- Q8c-b is applied to the FINAL graph, not only to supplied records: when a snapshot write supplies the guardians (the
  identity pair rewritten), a RETAINED contact or revision snapshot naming a guardian that leaves the final guardians
  table is refused too (`CONTACTS_OFFERS_GUARDIAN_MISSING`, ids), so no committed graph names a missing guardian; §6
  P spoke of the supplied records' guardian ids only. No account is created, unlinked or deleted to satisfy it.
- The cutover record's `withAbsentKeys` and `withOfftypeValues` follow the S8a/S8b rule — absence is recorded at EVERY
  level and a null nested object is an off-type value — so the fixture's four contacts and four offers count 4 / 4 and
  6 off-type; nothing is backfilled.
- The refusal names are as listed above; §6 named them generically.
- The reviewer scripts' R1 and F1/F2 cases were ported to the REAL repository and store rather than re-run against a
  model only: for each of the five pointer kinds both R1 directions, the true foreign-owner refusal with both owners
  present (rows and counts unchanged, the unchanged retry landing), `[]` versus omitted, and the explicit-`null`
  refusal; the model probes and their baselines are unchanged and still run.
- Item 10's bench was not run: no boot, file-size or save-time figure is measured or claimed.

**Measured, not assumed (the actual `7072dd9` build, `SCOUTBOX_PRE_S8C_SERVER`).** Booted DIRECTLY on a copy of a
`0017` file it LISTENS: the migration runner skips the record it does not know; the boot-contract check logs
`INTEGRITY STORE_MISSING recruitmentContacts — required collection(s) absent after migration; nothing was repaired.`
(the legacy `m230_004` step is recorded in the schema version, so that build does NOT re-create the contacts
container — §8 predicted it would); `GET /org/rooms/:id/contacts/:cid` answers 500 and `GET /org/rooms/:id/offers`
200 with no offer (`registerOffers`'s `??= []` gives it an empty container); the save revision advances 16 → 18; ONE
blob is written back — `recruitmentOffers []` — beside the untouched tables; no table row changes; this build, started
on that copy, drops the stale blob at attach and serves the contact and the offer from the tables. The §8 prediction
("two empty blobs") was wrong by one blob; its conclusion stands — a club using that server sees no contact and no
offer, and the rollback tool on a copy is the only way back. On the rollback copy the old build serves the same
contact and offer from its blobs, writes a contact (into a second player's planned room — the first room is at
`offer_made`, where `planContact` is required first) and a revision into them, and this build re-upgrades the copy with
those writes exactly.

**Adjustments outside the new modules (each stated in its file).** Every suite that walks the rollback chain runs the
S8c tool before the S8b tool (a live file carries `0017`): the module chains in `testRecruitment.mjs`,
`testSafetyAudit.mjs`, `testNotifications.mjs`, `testPlayerSubrecords.mjs`, `testOneTimeCodes.mjs`,
`testCoreIdentityRollback.mjs`, `testMediaDeletions.mjs`, `testOrgs.mjs`, `testOutboxPush.mjs`, `testSessions.mjs`; the
CLI chains in `testChannelsServer.mjs`, `testCoreIdentityServer.mjs`, `testDispatchesServer.mjs`,
`testNotificationsServer.mjs`, `testOutboxPushServer.mjs`, `testSafetyAuditServer.mjs`, `testPlayerErasureServer.mjs`,
`testRecruitmentServer.mjs`, `testRecruitmentCasesServer.mjs`; `testRecruitmentCases.mjs` exercises the S8b tool
through the S8c tool (the S8b tool refuses a `0017` file with `LATER_SCHEMA`) and its owner-CHECK regex accepts the
two S8c owners (0017 runs on the same boot). The registry lists, the "last recorded migration" positions and the
`TABLE_BACKED` lists allow for `0017` and the two collections (`testCoreSchema.mjs`, `testIdentityRepositories.mjs`,
`testDataLayer.mjs`, `testCoreIdentityMigration.mjs`, fourteen list tails, the two server-suite slices); the
untouched-table dumps exclude the nine tables as they exclude the fifteen and the twenty-five; the chained revision
counts gained one; `testSchemaDdl.mjs` covers the nine definitions, the `0017` header and the broadened CHECK. The S8c
server suite's restore check compares the tables by CONTENT (a rewrite reinserts a record's children; rowid order is
not a property of the data) and boots the live server twice before the backup: M13's boot-time normaliser
(`m13/shared.mjs`, a case without a budget gets `budget: null`) is an in-place change the S8b staged flush lands in the
next save, and the restore's import boot applies it to the imported cases too — an S8b property observed here, not an
S8c one, recorded so that a reviewer comparing a single-boot live file to a restore is not surprised.

**The §10 batteries (every one named there), each run on the final tree and on the untouched genuine `7072dd9`
checkout, one attempt, classified (`logs/battery/` in the handoff).** Twenty of the twenty-four pass on both trees with
the same counts (`m23ContactE2E` 428, `m23OfferE2E` 447, `m23OfferHardeningE2E` 259, `m23E2E` 382,
`m23RecruitmentJourneyE2E` 168, `m23RecruitmentJourneyHardeningE2E` 248, `m23RecruitmentJourneyPersistence` 139,
`m23TrialE2E` 535, `m23TrialPersistence` 41, `m23SigningE2E` 260, `m23SigningHardeningE2E` 212,
`m23AgentIntegrationE2E` 535, `m23AgentTransactionE2E` 404, `m23AgentFinalHardeningE2E` 286, `m23DecisionPersistence`
52, the three perf batteries exit 0 on both). Four fail IDENTICALLY on both trees — pre-existing, not of this
milestone, each with the same failing lines on `7072dd9`: `m23Persistence` (5 of 50: the required-store count of the
legacy store contract), `m23BootContract` (7 of 58: the contract's store count against the scan), `m23SigningPersistence`
(exit 1 on both: its fixture seeds a case without `ownerUserId`, refused at `0016` with the id —
`RECRUITMENT_CASES_IMPORT_BLOCKED`, the S8b precedent) and `m23AgentTransactionPersistence` (1 of 57: a 2306-derived
snapshot boot). Two DIFFERED before adaptation, exactly the two §10 named as storage-inspecting: `m23ContactPersistence`
— its byte-faithful-restore fixture gave TWO contacts the same request (`rct-1` and `rct-4` → `req-1`), a state no
production writer produces (the send creates the request for that contact) and the cutover refuses with the ids
(`CONTACT_REQUEST_MISMATCH: contact rct-4 → request req-1 → contact rct-1`); its corruption fixture planted a `null`
entry, a second record with an id already present and sent rows naming one shared request — the blob store tolerated
them, the table cannot hold them. Adapted along the S8b precedent, reason stated in the file: the responded contact
carries its own request; each sent row of the corruption file its own request (the pair, as the writer produces; the
foreign row's organisation present, since `org_id` is a real key); the null entry, the duplicated id and a dangling
request became an explicit refusal contract asserted on three copies (the cutover refuses at boot naming the entry or
the ids, the two collections exactly as they were in every key and value, the next boot refusing the same way); every
row defect the tables CARRY losslessly (the unknown status word, the missing recipient, the off-type history and
timestamp, the prototype-named channel, the impossible state, the unknown history event) is still planted and still
omitted-and-counted on read as before; the byte-identity comparisons became key-order-insensitive (every key and value
still compared — the documented table-read property). 70 checks on the final tree; the adapted battery on `7072dd9`
fails ONLY the six refusal checks (that build's blob store accepts those files). `m23OfferPersistence` — its check 5.22
compared the nine planted rows byte for byte across two boots and two stops; the rows read back from the tables with
every key and value identical in the stored shape's key order; the comparison is key-order-insensitive now (the ids,
values, presence and list order still compared). 94 checks on the final tree and on `7072dd9` alike. No product
behaviour was changed for a constraint; the pre-adaptation runs are kept beside the final ones in the handoff.

**The earlier reviewers' scripts on the final tree, unchanged (Node 22 and Node 24).** The two S8c design scripts:
`review-a5a7ed9-final-graph.mjs` exits 1 against the `a5a7ed9` model (ten reproductions, twelve controls) and 0 with
`--expect-corrected` against the corrected model (ten corrected cases, twelve controls); `review-854d035-design-
reproductions.mjs` exits 1 against the original model (three cases) and 0 against the corrected one; probe 2 (103),
probe 1 (32) and the two baselines (75, 31) unchanged; the failing-first adapter run still fails 21 of 103 on the
`a5a7ed9` model. The `7072dd9` S8b bundle: `review-b7c0dd0-reproductions.mjs` (21 checks), the two mapping matrices
(2,764 round trips / 8 refusals / 0 mismatches; 3,150 / 0 / 0), `review-7a7efc6-key-transitions.mjs` (294), the
old-format probe and `review-7072dd9-boot-refusal.mjs` (the server never listened; format refusal) all exit 0.
**Two of that bundle's scripts now exit 1 on the final tree for ONE reason, recorded here and not worked around:**
`review-7072dd9-recovery.mjs` (after its CONTROL passed) and the single "new-format rollback" check of
`review-2fe05df-format-boundary.mjs` (its eight genuine `b7c0dd0` / `2fe05df` compatibility checks — staged, snapshot
and rollback refusals with `RECRUITMENT_CASES_FORMAT_UNSUPPORTED`, the new-format staged and snapshot reads — all
CORRECT on both creators and both runtimes) call the S8b rollback tool DIRECTLY on a file the candidate build has just
cut over. That file now carries `0017`, which the S8b tool refuses by design — `LATER_SCHEMA: the database carries
schema step(s) this tool does not know (0017_recruitment_contacts_offers); a partial downgrade is not attempted` — the
same contract every earlier tool of the chain has for a later step; the scripts were written when `0016` was the last
step and assume the S8b tool is the first link. The reviewer's scripts were not edited. The round trip they intended —
the candidate's cutover, a staged export and save, a rollback and a re-upgrade — runs through the chain (the S8c tool
first, the S8b tool on its output) in `testRecruitmentCases.mjs`, `testRecruitmentCasesServer.mjs` and
`testRecruitmentContactsOffersServer.mjs`, and the format-boundary refusals those scripts exist for are unchanged
(above). Nothing of the S8b key-format boundary or of S8b's acceptance is affected: a `0016` file of the superseded
builds is still refused before `0017` runs, on every path.

**Gates (after the final edits; one attempt each, no retries, exits captured immediately; `logs/gates/gates-run.txt`
in the handoff, with versions, elapsed times and the per-build boot counts).** Backend `cd scoutbox-server && npm
test` on Node v22.22.0 (SQLite 3.50.4, npm 10.9.4): exit 0, 37 suites, 433 checks, 0 assertion failures, 0 `EADDRINUSE`
lines, 0 skipped old-build boots — the nine historical builds booted for real (`812e13b`, `0641b2c`, `6ca66ba`,
`b67bce5`, `4f954ad`, `f0abd34`, `9b109dc`, `7a7efc6`, `7072dd9`), the S4b-R, S8a, S8b and S8c danger boots and the
MEASURED line among them. The same on Node v24.19.0 (SQLite 3.53.3): exit 0, 37 suites, 433 checks, 0 / 0 / 0, the
same boots. Player `cd scoutbox-player && npm test -- --runInBand` on Node v22.22.0: exit 0, 4 suites, 41 tests.
Skipped inside the backend gate, by design and reported as such: the real older-Node runtime checks
(`SCOUTBOX_TEST_NODE_BINS` unset, simulated only). Not run: the browser suites, the demo rebuild, the Player E2E,
the bench.

### 14.1 Correction — after the independent review of `535e247` (24 October 2026, one commit on top of `535e247`)

The independent review of `535e247` (its verdict, run record, logs, the unchanged reproduction script
`review-535e247-reproductions.mjs` and its frozen harness travel verbatim in the handoff) found S8c **IMPLEMENTED, NOT
ACCEPTED**: three P2 findings, four reproduced cases, each against the REAL store and repository through a frozen copy of
this suite's fixture prefix. The design accepted at `19f5ca8`, the F1/F2/R1 offer-pointer corrections, the S8b
acceptance at `7072dd9` and the Founder's answers (Q8c-a tolerant and counted; Q8c-b strict) stand; nothing of the
audiences, the deletion policy, the routes' side-effect timing or the idempotency contracts changes; no player or
guardian database key is introduced; no new migration number. The reviewer's script run unchanged against `535e247`:
exit 1, four reproductions (both runtimes); `--expect-corrected`: exit 2 at the first F1 assertion. The regressions
below were written first and fail on the unchanged `535e247` tree on the behavioural assertions (the one-save guardian
departure refused; a request-only save NOT refused; the live counts 0/0 against a cutover count of 6), then the source
was corrected; the reviewer's unchanged script then exits 0 in both modes on Node 22 and Node 24.

- **F1 — the final guardian references exclude departing owners.** `CONTACTS_OFFERS_SNAPSHOT.begin` built the
  retained guardian references for a snapshot that rewrites the guardians from the stored rows of a collection that
  was OMITTED **or** whose owner id a SUPPLIED array no longer listed. The latter rows depart at F0 and own nothing in
  the final graph — the collection-versus-row mistake of R1 repeated in the guardian path. One save that removed a
  guardian (`gd-signup`, no children) together with every contact/offer naming it was refused before F0 with
  `CONTACTS_OFFERS_GUARDIAN_MISSING`; the same final state in two saves succeeded. Corrected: only an omitted
  collection contributes stored references; a supplied array contributes its final supplied rows, which the preflight
  already checks. Strict checks on genuinely surviving references are untouched. The regression (`[review 535e247 F1]`)
  covers a contact recipient, an offer revision recipient, a guardian response actor and receipt viewer; each collection
  supplied or omitted independently (the omitted one still refused with the retained row named, the departing one never
  named); `[]` versus a replacement; same-id rows that still name the guardian (refused) and same-id rows with the
  reference moved (landing); every refusal atomic with the revision unchanged and the corrected retry landing; the
  reviewer's two-save control and the one-save path compared table for table.
- **F2 — a request-only staged change cannot bypass the pair guard.** `flushPre` returned `plan: null` when no contact
  or offer was dirty and no request departed, and `flushWrite` then skipped G; a request whose `contactId` changed in
  the staged S8a mirror committed a disagreeing pair that `assertContactsOffersConsistent` itself rejects. Corrected
  within the accepted hook boundaries, without rewriting unchanged S8c rows: at α the repository asks the recruitment
  repository whether any request is pending or departing; if so it applies the pair guard at P over the COMPLETE
  contact mirror against the final requests (`assertPairsAgree`, ids only, before any write) and marks the save for the
  final guard; at β, G (`assertContactsOffersConsistent`) runs after the S8a request create/update whether or not an
  S8c row was written. The regression (`[review 535e247 F2]`, through `attachDataLayer` and the real store hooks): the
  request-only mismatch refused with the ids, every table and the revision unchanged, a separate connection seeing the
  committed pair, the intended value kept in memory and a plain retry refused again, the correction landing, a valid
  request-only edit landing without rewriting an S8c row, a unit of work retargeting the request alone refused at its
  commit with the request memory restored, and the contact and request moved TOGETHER landing. The contact
  send/response coupling, the joint departure and retarget cases and every existing hook and COMMIT test are unchanged
  and still pass. No public route retargets a request's `contactId` today; this is the staged record contract.
- **F3 — the live counts cover every player-reference occurrence of Q8c-a.** `unresolvedPlayerReferences` and
  `retainedPlayerReferences` inspected the two parents' `player_id` only, while the cutover's `playerIdsOf` counted the
  contact recipient, the revision recipients, the responses' for-player and player actor ids and the player receipt
  viewers. Corrected: one SQL per collection (`PLAYER_REFS_SQL`) lists the same occurrences from the tables; the two
  counters count those naming no player / a retained record; the per-collection, count-only report shape is unchanged
  (`/capabilities` → `dataLayer.domains.recruitmentContactsOffers`); `playerIdsOf` counts a nested id only when it is a
  non-empty string, so the cutover record and the live report count alike. The reviewer's fixture (live parents, five
  missing nested references) now reports `{ recruitmentContacts: 1, recruitmentOffers: 4 }`. The regression (`[review
  535e247 F3]`): field by field for missing, live and retained accounts, a duplicate occurrence counted twice, a
  guardian-typed actor or viewer never counted as a player reference, the counts equal to the cutover's, updated after
  a staged save, a restore and a restart, no id in the aggregate report; `retainedPlayerReferences` the same fields.
  Three existing expectations written against the parent-only counter were raised to the per-occurrence counts with
  the occurrences named in each (the tolerant import fixture 1 / 3 — equal to the cutover's 4 missing —, the behaviour
  test 1 / 2, the server suite's retained person 2 / 4). Nothing is dropped, fabricated or repaired; no name or id
  enters the aggregate report.

**Preserved and re-run.** The real-store five-pointer cases, the mapping and shape tests, the exact rollback and
retry, the read-only views, the unit mementos, the strict-guardian and tolerant-player fixtures, backup and restore,
and the genuine `7072dd9` boot on the rollback copy, the re-upgrade and the MEASURED direct boot (the S8c unit suite
now 12 checks, the server suite 3). The earlier reviewers' scripts as in §14, with the same two S8b-bundle exits
(`LATER_SCHEMA` on a `0017` file: the S8c tool is the first link) stated as before and not relabelled; no chained
wrapper was added in this milestone. The twenty-four §10 batteries, each on the corrected tree and on the untouched
`7072dd9` checkout: the same result as at `535e247` — twenty pass alike with the same counts, the four pre-existing
failures identical on both trees (`m23Persistence`, `m23BootContract`, `m23SigningPersistence`,
`m23AgentTransactionPersistence`), the two adapted persistence batteries 70 and 94 checks. The gates after the final
edits of this correction (backend `npm test` on Node 22 and Node 24 with the nine historical builds booted for real,
the Player suite, the reviewer scripts on both runtimes) are recorded with versions, counts and exits in the handoff
(`logs/gates/gates-run.txt`, `REVIEW-START-HERE.md`) and in the draft pull request.
