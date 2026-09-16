# M23 P3 — Contact Workflow Reuse Audit

Written before any Contact production code, because §3–§5 of the P3 mandate
make it the gate. The question is not "what shall we build" but **"what is
already here, and why is that not enough"** — asked once per Contact
requirement and answered with file paths.

The governing principle the audit is read against:

> ScoutBox must never confuse internal interest with real contact, a drafted
> message with a sent communication, or access to a player with permission to
> contact them.

---

## Part A — What already exists (inventory)

| # | System | Where | What it already does |
|---|---|---|---|
| A1 | **`db.requests`** | `server.mjs:1766-1836` (`POST /org/players/:id/request`), `:1252-1312` (guardian inbox + respond), `:2752-2821` (player inbox + respond) | The platform's existing **shared** club→player/guardian object. Created by an org user, immediately visible to the recipient, `routedTo: 'guardian'` for a minor, `status: pending → accepted \| declined`, opens a moderated channel on accept. Every one of its ~15 readers assumes a row is recipient-visible. |
| A2 | **Inbox** | `playerRouter.get('/inbox')`, `guardianRouter.get('/inbox')`; player app `(tabs)/inbox.tsx`, `guardian.tsx` | Reads `db.requests`. Minors get a sanitised status note only; guardians get the club-first view. Accept/Decline already exist in both UIs. |
| A3 | **Messages / channels** | `openChannel`, `postMessage`, `channelClosedForOrg`, `channelClosedForCounterparty` (`server.mjs:693-786`) | The ONLY conversation surface; exists solely because a request was accepted. Moderated, logged, block/suspension re-checked on every send. |
| A4 | **Notifications** | `notify()` (`server.mjs:633-677`), `m182/notificationPrefs.mjs` | One in-app feed, per-category preferences, coalescing, `groupKey`, push deferral for minors' school hours. Types `request`, `accepted`, `declined`, `recruitment_room` already exist and are classified. |
| A5 | **Outbox / email** | `adapters.mjs:71-98` (`createMailer` → `db.outbox`, `dev-outbox` vs `sendgrid`), `m13/delivery.mjs` (delivery centre, `queued → accepted → delivered`, `deliveryFailInject`) | Honest transport vocabulary already exists: `dev-outbox` is a local record, never delivery. The delivery centre derives per-channel dispatches from notifications after the fact. |
| A6 | **SSE / events** | `broadcast()` + `shouldDeliver()` (`server.mjs:376-470`), `m182/eventRegistry.mjs`, `EMITTED_EVENTS` | Every emitted event is registered with audience + payload allowlist; unknown names fail closed to `org_private`. `inbox` (player_private, playerId) and `notify` (directed) already exist for the recipient side. |
| A7 | **Audit / history** | `buildShared().audit()` (`m12/shared.mjs:67-70`), `case.history`, `m182/audit.mjs` | Append-only `history` on important records; the org audit view projects them content-free. |
| A8 | **Blocks** | `db.blocks`, `isBlocked()` (`server.mjs:541`), `orgCanSee` (`m12/shared.mjs:57`) | One block relation, checked inside every visibility gate and on every channel send. |
| A9 | **Guardian ownership** | `db.guardians[].childIds`, `player.guardianId`, `guardianAuth`, `guardianOwnsChild` | Parents own every under-18 account; ID + disclaimer gates before a child exists; co-guardians share `childIds`. |
| A10 | **Age / country rules** | `domain.mjs` `ADULT_AGE`, `adultAgeFor`, `ageOn`, `isAdult` | GB 18, KR 19, TH 20, EG/SG 21, default 18. Computed in UTC. |
| A11 | **Player / club visibility** | `visibleToOrg` (`domain.mjs:71`), `playerViewForOrg` (`server.mjs:904`) | Agencies never see minors; unverified clubs never see minors; grassroots radius fails closed on missing location. |
| A12 | **Recruitment cases + lifecycle** | `db.recruitmentCases`, `m17/shared.mjs` (`ROOM_TRANSITIONS`, `STATUS_EVIDENCE_REQUIRED`), `m23/lifecycle.mjs`, `m17/rooms.mjs` `applyStatus` / `ctx.applyLifecycleTransition` | `contact_planned → contacted` is the only inbound edge to `contacted`; `contacted` requires evidence kind `contact_delivered`; one status writer. |
| A13 | **Recruitment Rooms** | `m17/rooms.mjs`, `roomRole`, `roomCan`, `findRoom` (404 concealment), comments (`db.roomComments`), decisions (`db.roomDecisions`) | The club's private layer. Internal notes = comments + decision notes. `findRoom` conceals foreign cases. |
| A14 | **Role resolution** | `roomRole()` (`m17/shared.mjs:572-586`), `isLead` regex (`m12/shared.mjs:49`), `orgAuth` per request | `viewer < contributor < room_lead < recruitment_admin`, resolved from the database on every request; removal → 401. |
| A15 | **Idempotency** | lifecycle `clientKey` in `case.history` (`m23/index.mjs:42-47`), decisions `clientKey` (`m17/rooms.mjs:1094-1099`), messages `clientMsgId` | Keys stored **on the record**, so they survive restart and cannot collide across cases or tenants. |
| A16 | **Revision conflicts** | `m181/concurrency.mjs` (`expectedRevOf`, `guardRev`, `bumpRev`, `revMeta`) | `expectedRev` accepted as integer only; `NaN` → 400 `EXPECTED_REV_INVALID`; mismatch → 409 with the M18.1 conflict body. |
| A17 | **Rate limiting** | `m181/rateLimit.mjs` `RATE_LIMIT_POLICY`, `createRateLimiter`, `rateLimitedBody` | One provider, one policy table, scope per action; `429 RATE_LIMITED` with `Retry-After` from the policy window. |
| A18 | **Moderation / reporting** | `moderateOrRefuse` (`server.mjs:877`), `handleReport`, `db.moderationLog`, `db.reports` | Contact-detail and grooming patterns refused with `MODERATION_BLOCKED`; grooming hits auto-escalate. Player/guardian report + block buttons already exist in the app. |
| A19 | **Deep links** | club `#/recruitment/rooms/:roomId` (P2.5 IA); player `?tab=`; notification `refId` | Notification bells open a Room by `refId`. |
| A20 | **Localisation** | club/grassroots `i18n.ts` (`t()`, EN + FR dictionaries), player `i18n.ts` (`pt()`) | Every visible string has an EN and FR entry; `navLive` and the club L7b check assert parity for lifecycle labels. |
| A21 | **Evidence provider** | `m23/evidence.mjs` `createEvidenceProvider` | `contact_delivered` currently answers `not_implemented`, which is exactly the gate P3 supplies evidence to. |
| A22 | **Journey projection** | `m23/journey.mjs` | Already lists `db.requests` rows under `contact.records` for the club and `sharedRecordsFor` for the player/guardian. |
| A23 | **Store contract + migrations** | `storeContract.mjs`, `m182/migrations.mjs` (schema 2302), `scripts/m23BootContract.mjs`, `scripts/m23Persistence.mjs` | A new durable store must be declared once and guaranteed by a numbered migration step. |
| A24 | **Fault / failure injection** | `m182/faults.mjs` (HTTP layer), `db.deliveryFailInject` + `POST /admin/delivery/inject-failure` (`m13/delivery.mjs:236`) | A deterministic way to make a transport fail without editing server code. |

---

## Part B — Requirement by requirement

Legend: **reuse** = unchanged · **extend** = existing system, additive change ·
**new** = new durable model, justified · **not needed**.

| Requirement | Existing system | Decision | Reason | Risk |
|---|---|---|---|---|
| Draft Contact object (internal, invisible, editable, cancellable) | `db.requests` (A1) | **new — `db.recruitmentContacts`** | Every reader of `db.requests` (inbox ×2, digest `newRequests`, insights, funnel, journey `sharedRecordsFor`, M13 insight, export) treats a row as recipient-visible. A `draft` status there would have to be filtered out at ~15 read sites, and one missed filter is exactly the hidden-interest leak §83 forbids. The internal object needs states (`draft`, `failed`, `cancelled`, `recorded`) that have no meaning to a recipient. | A second contact-shaped store. Mitigated: it never becomes recipient-visible on its own — the **shared** object stays `db.requests` (next row). |
| Shared communication the recipient sees | `db.requests` + Inbox (A1, A2) | **extend** | On send, the Contact creates one canonical `db.requests` row of `type: 'contact'` through the same writer the legacy request route uses (extracted to `ctx.issueRecruitmentRequest`), carrying `contactId` and an optional `subject`. Everything downstream — Inbox, guardian routing, notification, `inbox` SSE ping, ledger, channel-on-accept — is unchanged. | Adds two fields to a request row. Both stripped from nothing the recipient already sees (`contactId` is not exposed; `subject` is shared content). |
| Recipient response (accept / decline / short reply) | `POST /player/requests/:id/respond`, `POST /guardian/requests/:id/respond` (A1) | **extend** | The buttons, the guardian-only rule for minors, the channel-open-on-accept and the club notification all exist. P3 adds an optional plain-text `message` for contact-type requests and a hook (`ctx.onRequestResponded`) that records the response on the linked Contact. One response path, one channel-open path. | Core route touched. Covered by `apiE2E`, `m23ContactE2E` and the live suite. |
| Inbox surface for the recipient | Player Inbox / guardian dashboard (A2) | **reuse** | The contact lands in the same Inbox as every other approach. No "Recruitment Messages" surface. | None. |
| Conversation after acceptance | channels (A3) | **reuse** | Already moderated, logged, block-checked, not full chat. | None. |
| Notify recipient on real send | `notify()` type `request` (A4) | **reuse** | Same type/category the existing request already uses; preferences and school-hours deferral apply. Draft creation notifies nobody. | None. |
| Notify authorised club users on response | `notify()` types `accepted`/`declined` (to the sender) + `recruitment_room` (to room owner/lead) (A4) | **reuse** | The respond route already notifies `request.userId` (the sender). The hook additionally notifies the room owner and lead scout if different — never the whole organisation. | None. |
| Email / outbox leg | `mailer` (`dev-outbox`) (A5) | **extend (record only)** | A guardian has an email; a player record does not. On send to a guardian, one notification copy is written through the existing mailer and its honest state (`local_outbox` / `accepted_by_provider` / `failed` / `not_available`) is recorded on the Contact as `emailCopy`. It is a courtesy copy, **never the transport of record** and never called delivered. | A reviewer reads `emailCopy.state = local_outbox` as delivery. Mitigated by naming and by the UI label. |
| Transport of record | Inbox row durability (A1, A2) | **reuse** | The in-app Inbox IS the transport. A persisted `db.requests` row is in the recipient's mailbox on the next read, which is what "the recipient could have received it" means. Status `delivered`, `transport: 'in_app'`, one clock for `sentAt`/`deliveredAt`. `read` is deliberately not tracked (§42). | None beyond naming. |
| Transport failure (honest) | `db.deliveryFailInject` (A24) | **extend** | The existing admin inject route gains a `contact` channel. An injected failure makes the in-app deliver step fail *before* the request row is written: the Contact becomes `failed` with a `failureCode`, the attempt is appended to history, no recipient object exists, the case does not move. Resend = a new attempt on the same Contact. | None — test-only surface, refused in production like the rest of the inject route. |
| Recipient resolution (adult → player, minor → guardian) | `isAdult`, `visibleToOrg`, `isBlocked`, `guardians[].childIds` (A8–A11) | **reuse** (composed) | Derived server-side at draft time (preview) and **re-derived at send / record time**. Client-supplied `recipientType`, `recipientUserId`, `guardianId` are ignored if present. A minor whose guardian record is missing, does not list the child, or is ambiguous (two records claim the child and `player.guardianId` is neither) fails closed with `CONTACT_GUARDIAN_REQUIRED`. | None. |
| Verified-club and agency walls | `visibleToOrg` (A11) | **reuse** | A room cannot exist for a player the org cannot see, and send re-checks `orgCanSee`. No Contact-specific exception. | None. |
| Block enforcement | `isBlocked` via `orgCanSee` (A8) | **reuse** | Checked at draft creation, edit, send, external record. A block after delivery leaves history in place; the existing channel rules stop replies. | None. |
| Role matrix | `roomRole` / `roomCan` (A14) | **extend** (new `roomCan` actions) | `contact_view` = viewer+, `contact_write` (draft/edit/cancel/send/record/close) = room_lead+. The contract §6 fixes `recordContact` at room_lead+; a contributor proposes through tasks/comments. | None. |
| Case lifecycle coupling | `canTransitionRecruitmentCase` + `ctx.applyLifecycleTransition` (A12) | **reuse** | On delivered or recorded, the Contact module asks the same validator (`recordContact`, with the real evidence provider) and writes through the same single writer. No `case.status = 'contacted'` anywhere. `LIFECYCLE_NO_CHANGE` (already contacted) is recorded on the Contact and not treated as an error. | None. |
| Evidence kind `contact_delivered` | `createEvidenceProvider` (A21) | **extend** | Answers from `db.recruitmentContacts`: a record for this org + player, not cancelled, in `delivered`, `responded` or `recorded`. A missing store answers `contacts_store_unavailable`, never "no contact". | None. |
| Idempotent create / send / record / respond | key-on-record pattern (A15) | **reuse** (pattern) | `clientKey` stored on the Contact (`keys.create`, `keys.send`, `keys.record`) and on the response. Same key + different payload → `409 CONTACT_IDEMPOTENCY_CONFLICT` (payload fingerprint stored beside the key). Persisted with the record → survives restart; scoped to the case → cannot collide across tenants. | None. |
| Optimistic concurrency | `guardRev` / `bumpRev` (A16) | **reuse** | `contact.rev`; `expectedRev` **required** on edit, send, cancel and record-on-existing (`400 CONTACT_REV_REQUIRED` when absent); malformed values refused by the shared guard. | None. |
| Rate limiting | `RATE_LIMIT_POLICY` (A17) | **extend** | Four named policies: `contact_draft` (60/h/org), `contact_send` (30/h/org), `contact_external_record` (60/h/org), `contact_response` (30/h/actor). Plus a deterministic per-recipient cooldown (one delivered in-app contact per org+player per 72 h unless the previous one was responded to) → `429 CONTACT_COOLDOWN`. | None. |
| Content validation / XSS | `plainText` strip pattern (`m17/rooms.mjs:52`), `moderateOrRefuse` (A18) | **reuse** | Subject ≤ 120, body 1–2000 chars after markup strip; control characters removed; moderation refuses contact details / off-platform / grooming. Rendered as text, never HTML. | None. |
| Report / block from the recipient | `handleReport`, `/player/block`, `/guardian/block` (A18) | **reuse** | Already in the app beside the Inbox. | None. |
| Events | event registry (A6) | **extend** | Five org-private, id-only events: `contact_created`, `contact_sent`, `contact_failed`, `contact_external_recorded`, `contact_responded`. The recipient side reuses the existing `inbox` ping and `notify`. | None — the registry throws in development on any unregistered key. |
| Audit / history | `history` array pattern (A7) | **reuse** (pattern) | Append-only `contact.history`, one timestamp per logical event, ordered by time then id. The org audit view gains the four Contact actions content-free. | None. |
| Deep links | room hash + `refId` (A19) | **reuse** | Club notifications carry `refId = room id`; the Contact tab is a page-local tab inside the Room. Player notifications carry `refId = request id` as today. | None. |
| Localisation | `i18n.ts` ×3 (A20) | **extend** | New `ct.*` keys in EN and FR in both club apps; new `ct*` keys in the player catalogue. | None. |
| Journey projection | `buildRecruitmentJourney` (A22) | **extend** | `contact.contacts` (id, status, channel, timestamps, response kind — never a body) and two timeline milestones. `recruitmentContacts` joins `JOURNEY_REQUIRED_STORES` because it is migration-guaranteed. | None. |
| Persistence guarantee | store contract + migrations (A23) | **extend** | `m230_004_recruitment_contacts`, schema 2302 → 2303, `recruitmentContacts: { guarantee: 'migration', owner: 'm23' }`. | None. |
| Analytics | M20 (`funnels.mjs` already counts `contacted`) | **not needed** | The funnel moves because the lifecycle moves. No Contact metric is added in P3 (§90). | None. |
| Trust, Passport, Development, Second Look, Matching, Box Cam | — | **not needed** | Nothing in Contact reads or writes them; asserted by the S-group pattern in the suite. | None. |
| A second Inbox, notification system, audit framework, block system, guardian system or lifecycle | — | **not created** | See the rows above. | — |

---

## Part C — The one new store, justified

`db.recruitmentContacts` holds the club's **internal record of a communication
process**. It is not a second recruitment lifecycle (the case owns that), not a
second Inbox (the recipient sees a `db.requests` row), and not a message store
(channels own conversation). It exists because three things the product needs
have no honest home anywhere else:

1. **A draft is not contact.** The only place a draft can live without being
   recipient-visible is a store no recipient route reads.
2. **Delivery truth belongs to the communication, not to the case.** `failed`,
   `delivered`, `responded` and `recorded` are facts about an attempt, and the
   contract (§2) forbids them from becoming case states.
3. **An attested external contact has no recipient object at all.** A phone
   call recorded after the fact creates nothing in anyone's Inbox; it is a
   club's dated attestation and must be auditable as one.

Every other concept in the workflow is reused from the systems above.
