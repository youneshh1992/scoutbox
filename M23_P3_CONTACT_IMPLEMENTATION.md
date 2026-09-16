# M23 P3 — Contact Workflow: Implementation

What was built to let a verified football organisation move from internal
recruitment interest to a real, safeguarding-compliant, auditable contact with
an adult player or the appropriate guardian for a minor — while keeping
internal club discussion and shared communication strictly apart.

> ScoutBox must never confuse internal interest with real contact, a drafted
> message with a sent communication, or access to a player with permission to
> contact them.

Companion documents: `M23_P3_CONTACT_REUSE_AUDIT.md` (what was reused and
why one store is new), `M23_P3_CONTACT_CONTRACT.md` (the semantics, with the
chronology from the P2 freeze), `M23_P3_DEFECT_REGISTER.md`.

---

## 1. Shape of the change

| layer | new | modified |
|---|---|---|
| server engine | `m23/contact.mjs` — pure: statuses, transitions, role table, validation, recipient derivation, cooldown, views, integrity | — |
| server routes | `m23/contactRoutes.mjs` — seven org routes + the response hook | `m23/index.mjs` (registers Contact, returns the context), `server.mjs` (extracted request writer, recipient view, respond routes, event allowlist) |
| lifecycle | — | `m23/evidence.mjs` (`contact_delivered` answered from the store), `m23/journey.mjs` (contact milestones in the club projection), `m23/errors.mjs` (22 Contact codes + `sendDomainError`) |
| platform | — | `m182/migrations.mjs` (2303), `storeContract.mjs`, `m182/eventRegistry.mjs` (5 events), `m182/audit.mjs` (domain `recruitment_contact`), `m181/rateLimit.mjs` (4 policies), `m181/concurrency.mjs` (D1), `m17/shared.mjs` (`contact_view`, `contact_write`), `m13/delivery.mjs` (failure injection channel `contact`) |
| clients | `ContactPanel` + `ContactRow` in `roomsScreens.tsx` (Pro and Grassroots, identical) | `roomsApi.ts`, `roomsDemo.ts`, `i18n.ts` (EN + FR) in both; player `inbox.tsx`, `guardian.tsx`, `httpClient.ts`, `mockClient.ts`, `data/types.ts`, `domain/types.ts`, `i18n.ts` |
| tests | `scripts/m23ContactE2E.mjs`, `scripts/m23ContactPersistence.mjs`, `scripts/m23ContactPerf.mjs`, `e2e/m23ContactLive.test.mjs` | `scripts/m23E2E.mjs` (fixtures, drift sweep, route probes), `m23Perf.mjs`, `m23Persistence.mjs` (fixtures) |

Nothing was added to the top-level navigation, no second inbox, no second
notification path, no second audit log, no second block or guardian rule, and
no second lifecycle writer. The one new store is justified in the reuse audit
Part C.

## 2. The Contact object

Store `db.recruitmentContacts`, guaranteed by migration
`m230_004_recruitment_contacts` (schema 2303) and declared in the store
contract (`guarantee: 'migration'`, owner `m23`). Ids are the canonical
sequential form (`rct-N`).

```
id, orgId, caseId, playerId
status            draft | delivered | failed | responded | recorded | cancelled
channel           in_app | phone | in_person | email_external | agent | other
recipient         null until sent/recorded; then { type: player|guardian, playerId, guardianId, minor }
subject, body     the shared text (in_app)      summary   the attestation (external)
createdBy/At, updatedAt, sentBy/At, deliveredAt, failedAt, failureCode, attempts[]
requestId         the db.requests row the recipient sees (in_app, once delivered)
emailCopy         { state, to, outboxId, at } — guardian courtesy copy, states only
lifecycle         { applied, from, to, historyId } | { applied:false, reason } — what the send did to the case
occurredAt, recordedBy/At          (external)
respondedAt, response { kind, message, by, at }
cancelledAt, cancelledBy
keys              { create, send, record } — clientKey + payload fingerprint each
history[]         append-only; contact_created / edited / sent / send_failed / external_recorded / responded / cancelled
rev, revAt, revBy, policyVersion
```

Transitions (`CONTACT_TRANSITIONS`): `draft → delivered | failed | cancelled`;
`failed → delivered | failed | cancelled`; `delivered → responded`;
`responded`, `recorded`, `cancelled` are final. There is no `queued`, `sent`
or `read`: the in-app Inbox is the transport of record and the request row is
written in the same transaction as the Contact, so **delivered** is the first
true state after a send, and ScoutBox does not track reading.

Evidence statuses (`CONTACT_EVIDENCE_STATUSES`): `delivered`, `responded`,
`recorded`. A `draft`, `failed` or `cancelled` Contact is never evidence.

## 3. Routes (all under the existing org router, room-scoped)

| route | role | what it does |
|---|---|---|
| `GET /org/rooms/:id/contacts` | `contact_view` (viewer +) | items (sorted, integrity-filtered, `omitted` count), server-derived `routing`, `case { status, acceptsContact, planAction }`, `canWrite`, `cooldown`, channels, limits, policy version |
| `GET /org/rooms/:id/contacts/:cid` | `contact_view` | one contact; a corrupt row answers 500 `CONTACT_STATE_UNKNOWN`, a foreign row 404 |
| `POST /org/rooms/:id/contacts` | `contact_write` (room lead +) | a **draft**. Case gate, rate limit, recipient rule, moderation. Writes the record and nothing else: no history entry on the case, no notification, no request row, no outbox entry |
| `PATCH …/:cid` | `contact_write` | edit a draft/failed contact; `expectedRev` required |
| `POST …/:cid/cancel` | `contact_write` | cancel a draft/failed contact; `expectedRev` required |
| `POST …/:cid/send` | `contact_write` | re-derives the recipient, re-checks block/visibility/case gate/cooldown, moderates again, then in ONE transaction: `issueRecruitmentRequest` (the existing request writer, `persist:false`), contact → `delivered` with one clock, case advance through the canonical validator + writer, guardian email copy state, `persistNow()`, then `contact_sent` |
| `POST …/contacts/external` | `contact_write` | record a legitimate contact made outside ScoutBox: channel, `occurredAt` (≤ 15 min future, ≤ 180 days past), summary, `recipientType` that must match the derived route; → `recorded`, case advance |
| `GET /org/recruitment/contact-policy` | any org user | statuses, transitions, channels, limits, role table, policy version — the vocabulary clients render from |

The recipient answers through the **existing** `POST /player/requests/:id/respond`
and `POST /guardian/requests/:id/respond`, extended with an optional
`message` (≤ 500 chars, only on a contact request, moderated). The route calls
the registered `onRequestResponded` hook before persisting, which moves the
Contact to `responded`, records the reply as the recipient's own words,
notifies the room owner and lead scout (existing `recruitment_room`
notification, request-id deep link) and broadcasts `contact_responded`.

## 4. Rules, and where each one lives

| rule | where enforced | refusal |
|---|---|---|
| case must be at `contact_planned` or `contacted` | `caseAcceptsContact` on create, send, record | 409 `CONTACT_CASE_STATE` (`allowed` lists the states) |
| server derives the recipient; the client never names one | `resolveContactRecipient` on create, send, record | — |
| adult → the player; canonical `isAdult` (GB 18, KR 19) | same | — |
| minor → exactly one verified guardian (`idVerified`, `disclaimerAccepted`, `childIds` includes, not removed); several → `player.guardianId` decides; else fail closed | same | 422 `CONTACT_GUARDIAN_REQUIRED` |
| blocked (player or guardian) | `isBlocked` in the resolver; re-checked on send; accept refused on the respond routes | 403 `CONTACT_BLOCKED`; 403 `BLOCKED` on accept (decline allowed) |
| not visible under the standing rules (`visibleToOrg`: agencies never see minors, grassroots radius, verification) | resolver | 422 `CONTACT_RECIPIENT_UNAVAILABLE` |
| player removed / deleted | resolver | 422 `CONTACT_RECIPIENT_UNAVAILABLE` |
| role: viewer reads, room lead and above writes; read per request, never from the token | `roomCan` `contact_view: 0`, `contact_write: 2` | 403 `CONTACT_NOT_PERMITTED` |
| `expectedRev` required on edit / send / cancel; no coercion (`"2"`, `2.5`, `-1`, `{}` all refused) | `expectedRevOf` + `guardRev` | 400 `CONTACT_REV_REQUIRED`, 409 `CONTACT_VERSION_CONFLICT` |
| idempotent create / send / record by `clientKey`; same key + different payload is a conflict | `keys.*` with payload fingerprint, on the record, so it survives a restart | 409 `CONTACT_IDEMPOTENCY_CONFLICT`; same key + same payload replays the stored result |
| one delivered, unanswered in-app contact per org + player per 72 h | `cooldownFor` (deterministic; `retryAt` in the body) | 429 `CONTACT_COOLDOWN` |
| rate limits: `contact_draft` 60/h/org, `contact_send` 30/h/org, `contact_external_record` 60/h/org, `contact_response` 30/h/actor | existing limiter | 429 `RATE_LIMITED` |
| shared text: NFC, tags stripped, `<>` removed, control characters and lone surrogates removed, limits (subject 120, body 2000, summary 500, reply 500); then the platform moderator | `plainShared`, `validateContactContent`, `moderateOrRefuse` | 400 `CONTACT_CONTENT_INVALID` / `CONTACT_CONTENT_TOO_LONG`; 400 `MODERATION_BLOCKED` |
| external record: channel ∈ external set, `recipientType` = derived type, `occurredAt` window | `validateExternalRecord` | 400 `CONTACT_CHANNEL_INVALID` / `CONTACT_RECIPIENT_MISMATCH` / `CONTACT_OCCURRED_AT_INVALID` |
| lifecycle only via the canonical validator + single writer; `LIFECYCLE_NO_CHANGE` is recorded on the contact, not an error | `advanceCase` → `ctx.applyLifecycleTransition` | — |
| a transport failure keeps the draft, records the attempt, moves nothing | failure injection `channel:'contact'` → `failed`, `TRANSPORT_REFUSED`; resend = new attempt on the same Contact | `delivered:false` in the 200 body |
| tenant isolation and no enumeration | the room's own concealing lookup first | 404 identical to a case that never existed, for list, one-by-id, write and send |
| corrupt rows | `contactIntegrity` | omitted from lists + counted + logged; single GET → 500 `CONTACT_STATE_UNKNOWN` |

Every code is in the one M23 error table with its band; there is no default
branch, and the m23E2E drift sweep (Y1–Y6) fails on a producible code the
table has not heard of. Internal (500) bodies carry the code and a fixed
sentence only.

## 5. What the recipient sees, and does not

The recipient sees a **request row** (`db.requests`) in the existing Inbox:
organisation, named scout and role, optional subject, body, the reply field,
Accept / Decline. `requestForRecipient` strips `orgId`, `userId` and
`contactId` from every recipient-facing view (inbox, respond answers, the
data export). No case id, no contact id, no case status, no internal note,
and no hint that a draft exists: a draft writes nothing outside the store.

A minor sees only the existing guardian-managed item ("… contacted your
parent/guardian …") with the outcome — never the subject, body or a reply
field. The guardian's screen says why it reached them and not the child.

The sentinel proof (`PRIVATE_ROOM_SENTINEL_123` in an unsent draft and in an
internal Discussion note) is asserted on: player inbox, notifications,
insights, feed, export; guardian inbox, notifications, log; the outbox and
push log; and the foreign organisation's journey and contact list — in the
server suite (I group) and again through the real player app in the live
suite (N5).

## 6. Delivery truth

| channel | what ScoutBox knows | what it says |
|---|---|---|
| in-app Inbox | the request row is durable in the same transaction | `delivered` — "In the recipient's ScoutBox Inbox. ScoutBox does not track whether it was read." |
| guardian courtesy email | what the existing mailer returned | `emailCopy.state`: `local_outbox` (dev-outbox transport), `accepted_by_provider` ("not confirmed delivered"), `failed` ("the in-app message is unaffected"), `not_available` (no email on record). Never "delivered". |
| transport refused (injected) | nothing reached anyone | `failed`, `failureCode: TRANSPORT_REFUSED`, draft kept, case unmoved |

## 7. Lifecycle integration

`STATUS_EVIDENCE_REQUIRED.contacted = contact_delivered` was already the gate.
P3 makes the evidence provider answer it: a Contact for this org and player
in an evidence status, not cancelled, integrity-sound →
`{ satisfied: true, sourceType: 'recruitment_contact', sourceId }`; otherwise
`no_contact_delivered`; a missing store `contacts_store_unavailable` (fails
closed, as every other kind does).

A send or an external record from `contact_planned` advances the case with the
`recordContact` action through the validator and the single writer, so the
case history gains exactly one `room_status_changed` entry with the
`contact_made` reason. From `contacted`, the validator answers
`LIFECYCLE_NO_CHANGE`, which is recorded on the contact
(`lifecycle.applied:false`) and is not an error: the second delivered contact
is a fact about contacts, not about the case. A response, a decline, a failure
after delivery and a block after delivery move the case nowhere.

The club journey projection gains `contact { records, contacts[], omitted }`
(milestones only: id, status, channel, recipient type, timestamps — never the
text) and timeline entries `contact_initiated` / `contact_response_received`.
The player and guardian projections gain nothing.

## 8. Events, notifications, audit

Five registry events — `contact_created`, `contact_sent`, `contact_failed`,
`contact_external_recorded`, `contact_responded` — audience `org_private`,
class `org_internal`, payload allowlist `orgId, roomId, contactId` (ids only).
The recipient side receives the platform's **existing** `request` event and
`request` notification from the request writer, deep-linked to the request
id. The response notifies the room owner and lead scout through the existing
`recruitment_room` notification with the room id. The audit log lists
`contact_sent`, `contact_send_failed`, `contact_external_recorded`,
`contact_responded`, `contact_cancelled` under domain `recruitment_contact`
with `channel`, `recipientType` and `code` as the only allowed detail keys.

## 9. Clients

**Pro and Grassroots** (same code): a page-local **Contact** tab on the
Recruitment Room, after Discussion and before Activity — a function of the
case, not a destination (no sidebar item, no route, no palette entry). The
panel renders the server's routing pill ("Will be delivered to the player
(adult)" / "… to the parent or guardian — under-18, never the child" / "This
player cannot be contacted right now — <reason>"), the case-gate notice with
the current status, the cooldown notice with the retry time, the read-only
note for viewers and contributors, the shared conflict notice, a compose form
(subject, message, "This text is shared with the recipient…", Save draft,
Send), an "outside ScoutBox" disclosure (channel, date and time, summary, an
"I spoke to <the player / the guardian>" confirmation, Record contact), a
polite live region for outcomes, and the history: status pill, channel,
recipient type, the text as sent, delivery note, email-copy state, "Case moved
to Contacted." when it did, the response with the recipient's own words, per-
row Send / Edit / Cancel draft for drafts and failed sends, and an append-only
timeline. 390px: no horizontal scroll, the tab strip scrolls within itself.
Demo mode mirrors the rules in `roomsDemo.ts` (case gate, rev checks,
cooldown, case advance logged as `room_status_changed`).

**Player app**: the Inbox request card shows the subject, the message, a
labelled reply field (500 chars) with the note that the reply is recorded
against the contact and must carry no phone numbers, emails or links; Accept
contact / Decline; afterwards "You accepted…" / "You declined…". The guardian
screen adds "This contact was routed to you because the player is under age."
The child's Updates are unchanged. `respond` / `guardianRespond` carry the
optional `message`; the mock client validates and moderates it the same way.

EN and FR carry the same key set (`rm.tab.contact` and `ct.*` in both club
apps; `ct*` in the player app).

## 10. Tests

| suite | checks | negative | what it proves |
|---|---|---|---|
| `scripts/m23ContactE2E.mjs` | 418 | 240 (57%) | U pure engine · V validation/XSS · J adult journey · D draft-is-not-contact · I sentinel isolation · M minor/guardian/fail-closed · B block · R roles/downgrade/removal/foreign/agency/unverified · K expectedRev/idempotency/collision/restart · F transport failure · X external record · S cooldown · C rate limits · E error contract · Z routes/events |
| `scripts/m23ContactPersistence.mjs` | 61 | 33 | store guarantee on clean boot and upgrade; byte-faithful restore; replay from disk; six corruption shapes omitted/counted/logged; foreign row concealed |
| `scripts/m23ContactPerf.mjs` | measured | — | list/journey at 0/25/100/500 contacts; cost scales with the store, not per contact of the case; no collection read more than 4× per journey; no index added (§166) |
| `e2e/m23ContactLive.test.mjs` | 82 | 33 (40%) | adult journey (club → draft → player sees nothing → send → Contacted → Inbox at 390px → reply/accept → response on the Contact, case unmoved); minor journey (guardian route, courtesy email state, guardian replies/declines at 390px, child sees the outcome only); negatives (no guardian route fails closed in UI and API, block after delivery, contributor read-only, foreign org 404, sentinel, 390px Contact tab) |
| `scripts/m23E2E.mjs` (frozen P2) | 382 | — | unchanged semantics; fixtures and drift sweep extended |

## 11. What P3 deliberately does not do

- No Trial workflow, no `recruitmentOffers`, no offer/outcome/closure changes
  (§158–§159).
- No voice, video, rich chat, attachments, read receipts, typing indicators,
  AI drafting or bulk campaigns (§160). The existing on-platform thread that
  opens on acceptance is untouched.
- No analytics, Trust, Passport, Development or Second Look changes.
- No index on the contacts store: measured, not needed (§165–§166).
- The login screens (Pro, Grassroots, T&S) were fixed to fit 360px in the
  P3 closure pass (defect register D4, closed; navLive N17 guards it). That
  is the only change outside the Contact surfaces.

## 12. Closing checks

- Four typechecks (Pro, Grassroots, Admin, Player) and three Vite builds pass.
- Server battery: 29 suites green, `apiE2E` against an owned server on :4000.
- Browser battery: see the final report for the run on this tip.
- No raw control byte in any `.mjs/.ts/.tsx/.md` outside `node_modules`.
- Demo artifacts rebuilt; `demoFreshness` compares the source fingerprint.
