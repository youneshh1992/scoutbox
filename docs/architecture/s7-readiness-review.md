# S7 readiness review: messaging, notifications, delivery and push — what the code does today, what can proceed, what waits

Written 14 October 2026 on branch `feat/sqlite-schema` at commit `2d7ddeb` (S6a independently
accepted), from reading the code as it is at that commit. **Documentation and read-only
inspection only:** no source, schema DDL, migration, test, runtime behaviour, deletion behaviour,
account data or user interface was changed by this review, no migration is registered, no
migration identifier is assigned, and nothing was run against real data. Paths are relative to
`scoutbox-server/`; `S:` is `server.mjs`, `DL:` is `m13/delivery.mjs`, `AD:` is `adapters.mjs`,
`NP:` is `m182/notificationPrefs.mjs`, `ST:` is `store.mjs`; `SQL03:` is
[`sql/03_messaging_safety_audit.sql`](./sql/03_messaging_safety_audit.sql) and `SQL02:` is
[`sql/02_recruitment.sql`](./sql/02_recruitment.sql) (both proposed, not accepted). Line numbers
are those of `2d7ddeb`. The plan is [`sqlite-migration-plan.md`](./sqlite-migration-plan.md)
§S7, whose assumptions this review corrects (§2, §6).

**Status: S7a implemented, pending independent acceptance** (one local commit on
`feat/sqlite-schema` on top of `812e13b`; what was built, the four compatibility corrections it
honours and the one deliberate reading it records are in §8.3). **S7b–S7d not started.** §§0–8.2
are the review as written at `2d7ddeb`, kept as the record of the reasoning; where the
implementation corrected a proposal (§3.2 coupled writes, §8.2 "transaction of its own"), the
correction is marked in place. The exact blockers of the remaining sub-steps are in §8. Nothing
here decides a retention period, a deletion policy, the country-code or child-status questions, or
the org-deletion question; those stay with the Founder.

Sections: 0 summary · 1 ownership and data mapping · 2 the dependency graph · 3 transaction and
delivery boundaries · 4 privacy, permissions and deletion · 5 preflight and cutover · 6 backup and
rollback · 7 tests, acceptance and the performance objective · 8 the dependency table and the
bounded recommendation.

---

## 0. Summary

The S7 domain is nine collections, every one of them a JSON blob today: `channels` (with the
nested `messages`, their attachments and the two read receipts), `notifications`,
`notificationPrefs`, `dispatches` (with nested `attempts`), `outbox`, `pushLog` and `pushTokens`,
plus the three identity-row preference fields that already live in tables. The survey found:

- **One writer per record kind, all in known places.** Channels are opened in one function
  (`openChannel`, S:897–917) from two acceptance routes; messages are written by one function
  (`postMessage`, S:940–971) from three routes; notifications are created by one function
  (`notify`, S:828–877) from ~168 call sites across 31 modules; dispatches by one sweep
  (DL:76–135); the outbox by **two** writers with **two shapes** (AD:90–95 and DL:33). No module
  inserts system, trial, offer or signing messages into a channel; m23/m28/m29 keep their own
  stores and call `notify`.
- **The plan's S7 premises are wrong in three places.** (a) "Depends on S4" — the target
  `channels.request_id` references `recruitment_requests(id)` (SQL03:71), a table that belongs to
  S8 (SQL02:509) and itself references S8's `recruitment_cases`, `trials` and `org_users`
  (SQL02:519, 539–540), while S8 lists S7 as a dependency (plan §S8 "contacts' outbox copies"): a
  cycle on paper. (b) "Rollback: pre-S7 backup + S6 commit (messages after S7 lost)" — a copy-only
  rollback that rewrites the rows into the blobs the old build reads loses nothing (§6). (c)
  "`postMessage` no longer triggers a whole-database write" — a send writes the `channels`,
  `ledger`, `notifications` and `pushLog` blobs through `persistNow()` and then a second debounced
  save (S:968–969, S:584, ST:177–183); moving messages alone cannot meet the objective (§7.3).
- **S4b decides more of S7 than the plan says.** `ledger.player_id … RESTRICT` (SQL03:696),
  `reports.target_player_id … RESTRICT` (SQL03:548) and `blocks.player_id … RESTRICT` (SQL03:497)
  all sit on the message-send path (S:949, S:1088, S:1734) and cannot ship before S4b (S6 review
  §4.1); `channels.player_id … CASCADE` (SQL03:72) matches today's hard delete but means nothing
  under a tombstone, so message retention after deletion is an undecided policy question
  ([`s4-deletion-decision.md`](./s4-deletion-decision.md) §4 "messages — *review*"), not a
  schema detail.
- **The bounded recommendation (§8.2):** the smallest independently testable sub-step under
  current decisions is **S7a — `notifications`, `notification_prefs` and
  `notification_pref_categories`**: one writer, no foreign key, no dependency on S4b, S6 or S8,
  a lossless copy-only rollback, and the largest unbounded blob the send path writes. Channels and
  messages wait for the request-reference decision (§2.3) and the retention answer (§4.4);
  dispatches follow S7a; the outbox needs the second writer's shape unified and the remaining
  plain-text codes decided (§1.6); push tokens need a decision on the audience-key defect (§1.8).

---

## 1. Ownership and data mapping

### 1.1 Identities behind every audience and sender key

| Key | What it names | Where it is built |
|---|---|---|
| `sender = { kind: 'player', id, name }` | a `players.id` (table since S4a) | S:3413 |
| `sender = { kind: 'guardian', id, name }` | a `guardians.id` (table since S4a) | S:1573 |
| `sender = { kind: 'org_user', id, name }` | a staff user `org_users.id` (table since S1); `name` is the composed string `"Name · Role · Org"` | S:2330 |
| `channel.playerId`, `orgId`, `guardianId` | `players.id`, `orgs.id`, `guardians.id` (all tables); `guardianId` null for adults | S:898–914 |
| `channel.counterparty` | `'player'` or `'guardian'` = `request.routedTo` — the human on the far side; the child is never a party | S:908, S:2182–2184 |
| `notification.audience = { kind, id }` | `player` / `guardian` / `org_user` with the matching table id; polymorphic, no foreign key | S:780, S:860–865 |
| `dispatch.audience`, `dispatch.to` | a copy of the notification's audience; `to` is an e-mail address, or `"kind:id"` for in-app rows | DL:40, DL:86–95 |
| `pushToken.kind / refId` | the **session's** kind and ref id: `player`, `guardian`, **`org`** (= `orgs.id`, not the staff id) or `ts_reviewer` | S:3979–3980, S:1803, S:1922 |
| `notificationPrefs.audienceKind / audienceId` | `player` / `guardian` / `org_user` | NP:261–265 |
| SSE identities | `{kind:'org', orgId, userId}`, `{kind:'player', playerId}`, `{kind:'guardian', guardianId}` | S:468–483 |
| `"<kind>:<id>"` strings | rate-limit keys only (`guardian:${id}` S:1507, `player:${id}` S:3355); never a stored identity | — |

### 1.2 Channels, messages, attachments, read receipts, typing

**Channel** (one writer, `openChannel`, S:897–917, pushed at S:915; called on guardian acceptance
S:1531 and adult-player acceptance S:3377; `request.contactChannel` set beside it, S:1532/S:3378):

| Field today | Set from | Proposed column (SQL03:69–84) | Notes for the mapping |
|---|---|---|---|
| `id` | `nextId('chan')` (S:643–646) | `id` | global counter, `chan-<n>` |
| `requestId` | request.id | `request_id` NOT NULL → `recruitment_requests` | **the S8 reference** (§2) |
| `playerId`, `playerName` | request | `player_id` CASCADE, `player_name` snapshot | |
| `orgId`, `orgName`, `orgVerified`, `scoutName`, `scoutRole` | request snapshots; `scoutRole` defaults `'Scout'` (S:2169) or `'Manager'` on the open-day path (S:2815) | `org_id` RESTRICT + snapshots | |
| `counterparty` | `request.routedTo` | `counterparty` CHECK | |
| `guardianId` | request; null for adults | `guardian_id` → `guardians` RESTRICT | |
| `createdAt` | `Date.now()` | `created_at` | |
| `messages: []` | — | child table | |
| `readBy: { org: null, counterparty: null }` | S:913 | `read_by_org_at`, `read_by_counterparty_at` | the only read state; a thread-open time, not a last-message id |
| `orgUserIdForNotify` | **never written**, read at S:954 | dead field (SQL03:63) | not migrated |
| *(no `status`, `closed`, `lastMessageAt`, `kind`)* | — | — | `closed` is derived on every read (S:976–990) and must stay derived |

Unknown fields pass through to clients (`channelViewFor` spreads the record, S:993–996; the admin
view `{...c}`, S:4466), so a preflight must decide what to do with any key outside this list
(§5.2). The test fixture `scripts/m23Persistence.mjs:83` (`{id, playerId, orgId, messages: []}`,
no `readBy`, `requestId`, `counterparty`, `playerName`) is an accepted legacy shape in that suite
and would violate `NOT NULL` at SQL03:71, 73, 79.

**Message** (one writer, `postMessage`, S:940–971; literal at S:947):
`{ id: nextId('msg'), ts, sender, text, attachment, ...(clientMsgId ? { clientMsgId } : {}) }`.

| Field | Notes | Proposed (SQL03:112–126) |
|---|---|---|
| `id` | `msg-<n>` | `id` |
| `ts` | `Date.now()`; two messages may share a value | `created_at` |
| `sender.kind/id/name` | §1.1; `name` is a snapshot | `sender_kind` CHECK, `sender_id` (no FK), `sender_name` |
| `text` | required, trimmed (S:1569, 2324, 3407); **no length limit**; moderated before write (S:1081–1104), a hit is never stored | `text` NOT NULL |
| `attachment` | always present, `null` or one object (§ below) | `message_attachments` 0..1 row |
| `clientMsgId` | **absent** when not given (not `null`); ≤ 64 chars (S:1572, 2329, 3412); dedupe on `(clientMsgId, sender.kind, sender.id)` within the channel (S:943–946), the duplicate returns the stored message with 201 even if its text differs | `client_msg_id` + partial UNIQUE (SQL03:124–126) |
| *(no per-message read flag, moderation flag or type)* | | |

Ordering is array insertion order, oldest first, never sorted on the server (S:948); every client
treats the last element as the latest (`scoutbox-player/src/components/Threads.tsx:27`,
`scoutbox-club/src/screens.tsx:706`). Unread is computed client-side as `m.ts > readBy.<side>`
(`scoutbox-club/src/App.tsx:467`, `scoutbox-player/src/state.tsx:241`,
`scoutbox-grassroots/src/App.tsx:514`), so `created_at` and the two `read_by_*_at` columns must
come from the same clock and keep their millisecond values exactly. The proposed index
`(channel_id, created_at)` is not an ordering guarantee for equal timestamps: the table must also
carry a per-channel sequence (or rely on `rowid` order of insertion) so the oldest-first contract
survives ties — an addition to SQL03, not in it today.

**Attachment** (`buildAttachment`, S:920–938; at most one):
`{kind:'clip', mediaId, title, url, verifiedClip}` (S:927; `url` is `/media/<id>` or null, signed
copy-on-write at read time S:419–452; no `contentType`, no `dataUrl`) or
`{kind:'trial_report', reportId, orgName, summary}` (S:933–935; an org may attach only its own
report, S:929). Maps to SQL03:146–158; `media_id` and `report_id` keep no foreign key because the
clip or report may be deleted later while the message keeps the reference (SQL03:136–141; S5's
`player_media` rows go with the player, the message does not).

**Read receipts**: three routes set `readBy.<side> = Date.now()` then `persistNow()` then
`broadcast('messages')` (S:1576–1583, 2334–2341, 3416–3424); none checks whether the channel is
closed. **Typing**: broadcast only, nothing stored (S:1585–1590, 2343–2349, 3426–3432; skipped by
`persist` and the replay buffer, S:584–590). **Moderation**: `moderateOrRefuse` writes a
`moderationLog` row with a 140-character excerpt and, on a grooming hit, an urgent `reports` row
(S:1081–1104); those two collections are S6, not S7.

**Readers**: list routes by owner (S:1558–1560, 2310–2315, 3396–3399 — `[]` for minors),
find-by-id-and-owner in nine routes, the player export (S:4079), `/admin/channels` (S:4466),
SSE delivery by channel id (S:507–514), and m26 agent transactions, which store **references**
`{id, channelId, linkedBy, linkedAt}` (m26/index.mjs:1211–1226) and never copy a message. No
collection copies message text; the ledger row carries ids and names only (S:949). No
server-side unread count or search exists.

### 1.3 Notifications

One creator, `notify(audience, type, text, refId)` (S:828–877; pushed at S:866). Fields:
`id` (`ntf-`), `ts`, `audience`, `type`, `text`, `refId` (default null), `read: false`,
`repeatCount: 1`, `groupKey` (`type:refId` or null), `category` (null when the type is unclassified
or the gate is not wired yet, S:823–824, 863), `deferredPush` (S:790–815), optional
`actionRequired {deadline, ackedAt, ackedBy}` (DL:142). Mutations: coalescing refreshes `ts` and
`repeatCount++` on an identical unread row within 6 h (S:843–854); `markNotificationsRead`
(S:887–891, no persist of its own); `notifyAction` (DL:142, `persist()`); ack (DL:155–156,
`persistNow()`); migration `m182_005` backfills `repeatCount` (m182/migrations.mjs:129). Deleted
only for a deleted player's own audience (S:4219). `target` is derived at read time (S:880–884),
never stored. Maps to SQL03:194–220; the `category` CHECK list must equal `CATEGORIES` in
NP:28–79, and unknown `type` values are delivered by design (NP:229) so `type` carries no CHECK.
Readers: the three feeds newest-first and unbounded (S:879–885; S:3434, 1655, 2351), the agent
inbox's last 100 (m24/index.mjs:696), the unread count (m24/index.mjs:208), the delivery sweep
by id set (DL:79–81) and by id (DL:151, 157), the awaiting-ack scan (DL:236), SSE `notify`
(S:515–520).

### 1.4 The four preference stores

| Store | Where today | Fields, defaults | Readers |
|---|---|---|---|
| player `notificationPrefs` | **table columns** `prefs_*` since S4a (repositories/identityMapping.mjs:112; `sql/01_identity.sql:187–190`); default null | `quietStart`, `quietEnd`, `schoolHoursMute`, `timezone` (S:4053–4058); written by `POST /player/prefs` (S:4066–4067, no minor gate) | `pushDeferred` (S:790–815): school-hours mute defaults **on** for minors (S:803), Mon–Fri 08:30–15:30 (S:805), quiet hours may wrap midnight (S:811), zone defaults `Europe/London` (S:789, 800) |
| guardian `notificationPrefs` | table columns (identityMapping.mjs:135; `01_identity.sql:123–126`) | same; `POST /guardian/prefs` (S:4068–4069); no route for a guardian to set a child's | `pushDeferred` (S:797–798) |
| org-user `deliveryPrefs` | `delivery_prefs_json` on `org_users` (repositories/users.mjs:23, 38, 52) | `{quietStart, quietEnd, channels:{email}}` (DL:220–223) | only `channels.email` (DL:58); **the quiet hours have no reader** |
| category prefs `db.notificationPrefs` | **blob**, written only by NP:261–265 | `{audienceKind, audienceId, categories{}, emailIntent, updatedAt}`; defaults from `CATEGORIES` (NP:28–79; `discovery_nudges` off by default, NP:42); mandatory `compliance` and `security_account` forced on (NP:216, 230) and refused when set false (`PREF_CATEGORY_MANDATORY`, NP:256–259); unknown names refused | the `allows` gate inside `notify` (S:832; wired at S:4586, after `registerM13` at S:4542 — until then every type passes and `category` is null); **`emailIntent` has no reader** outside the view |

Only the fourth store is S7's to move (SQL03:239–272); the other three are already rows. Its
natural key `(audienceKind, audienceId)` is unique by find-then-push today (NP:261–262) and
becomes the primary key; a stored `false` on a mandatory category is impossible today and
becomes a CHECK (SQL03:271).

### 1.5 Dispatches and attempts (the F11 delivery centre)

Created only by `dispatchSweep` (DL:86–95), at boot (DL:260) and every 60 s (400 ms under
`M13_FAST_RETRY`, DL:261): one `in_app` row (created `delivered`) plus one external row per
destination rule (DL:38–59), `queued`, `held_quiet_hours` or `skipped` (`guardian_routed` for an
under-18 player, DL:43–47 — **no guardian dispatch is created there**; guardian routing happens
at each `notify` call site, e.g. m13/transitions.mjs:221–223). Status ladder `RANK` (DL:11) is
forward-only for `queued/held → accepted → delivered → opened → actioned`; `retrying`,
`skipped`, `failed` are outside `RANK`, so every `RANK[d.status] < X` comparison is false for
them (DL:130, 159, 191, 195) — a migration must preserve that exact semantics, not "improve" it.
Attempts are `{at, ok, error}` send rows and at most one `{at, note:'quiet hours re-check'}`
row (DL:106, 110); note rows are excluded from the retry count (DL:114, 122). Retry schedule
`[0, 2 m, 15 m, 1 h]`, four attempts (DL:70–73); final failure writes an `opsEvents` row and a
`delivery.failed` webhook (DL:115–119); the sweep ends with `persistNow()` (DL:133). Callbacks:
`POST /callbacks/delivery` (DL:173–206), HMAC with a 5-minute window (DL:177–178; default secret
`'local-fake-callback-secret'`, DL:26), ≤ 100 events, duplicates skipped by `callbackId` kept in
`db.deliveryCallbacksSeen` (capped at 5 000 by splicing 1 000, DL:184–186), forward-only
transitions (DL:189–201). Never pruned; orphan rows remain after a notification is deleted
(SQL03:282–283). Maps to SQL03:312–370; `dispatch_attempts` needs minted ids and a `seq` (SQL03:348–350).
Related m13 bookkeeping (`deliveryCallbacksSeen`, `deliveryCentreSince`, `deliveryFailInject`,
`webhookDeliveries`, `opsEvents`) is not in S7's table list and stays in blobs; `storeContract.mjs:76–77`
says the first two are "created by migrateM13", but they are created in `registerDelivery` (DL:20–21).

### 1.6 The mail outbox — two writers, two shapes, and the S6a masking

| Writer | Shape | Persisted how |
|---|---|---|
| (a) `createMailer.send` (AD:87–114; record at AD:90, pushed at AD:95) | `{id:'mail-…', ts, to, subject, text, transport:'sendgrid'\|'dev-outbox', delivered}` — `text` has every string in `secrets` replaced by `OUTBOX_SECRET_PLACEHOLDER` (AD:72, 88–89); on the dev transport the full text is kept in process memory only, bounded to 500, served by `/admin/outbox` (AD:84, 91–93, 116; S:4365) | debounced `persist()` through `nextId` (S:644); the challenge route also calls `persist()` (S:3123) |
| (b) `fakeSend` in the delivery centre (DL:27–35; pushed at DL:33) | `{id:'mail-…', at, channel, to, text (first 300 chars of the notification text), providerMessageId:'fm_<16hex>', provider:'local-fake'}` — no `subject`, no `delivered`, `at` instead of `ts` | the sweep's `persistNow()` (DL:133) |

Nine mail call sites: S:1287 (guardian sign-up code), S:3117 (club challenge — **the only one
passing `secrets`**, S:3121), S:3868, m14/organisations.mjs:236, 533, 717, 918,
m23/contactRoutes.mjs:521, m13/enterprise.mjs:88. Six of them still put a one-time code or token
into `text` in clear (S:1290; m14/organisations.mjs:239, 533, 717, 918; m13/enterprise.mjs:88) —
recorded in OPERATIONS.md "One-time codes" and as a "KNOWN DEFECT" in SQL03:393–397, whose note
predates the S6a correction and should be rewritten when the DDL is next touched. **S7 must
preserve the S6a contract exactly:** the persisted row carries the withheld text; delivery to the
provider carries the full text; the development-only full text lives in process memory and is
never a column. Never pruned; never deleted on player deletion (SQL03:382); read by
`/admin/outbox` (S:4365) and counted in `/admin/overview` (S:4348). The DDL (SQL03:400–412)
unifies the two shapes; the migration must map `at → created_at`, `provider → transport
('local-fake')`, `delivered` absent → 0, and keep `providerMessageId` for (b) rows only.

### 1.7 Push log

Written only by `createPushSender.send` (AD:126–127), called only from `notify` through
`store.afterCommit` when `deferredPush` is false (S:874): `{id:'push-…', ts, audience, title
('ScoutBox', S:874), body, transport:'expo'|'dev-log'}`, written whether or not any token
matched. Persisted by the debounced save through `nextId`. Never pruned (`slice(-200)` is applied
at read time only, S:4366); never deleted on player deletion. Maps to SQL03:433–443.

### 1.8 Push tokens

Written only by `POST /push/register` (S:3979–3980): filter-then-push upsert of the triple
`{kind: session.kind, refId: session.refId, token, ts}`, persisted by `persist()` (S:3981). No
expiry, no revocation, not removed on logout or player deletion (SQL03:451). **Defect, confirmed:**
org sessions are `('org', org.id)` (S:1803, S:1922), so tokens are stored under the organisation,
while the sender filters by the notification audience `('org_user', org_users.id)` (AD:131) —
staff pushes never match a token. The plan's S7 objective "push tokens registered by
`(audience_kind, audience_id)` so staff pushes work" is a **behaviour change** on top of the
storage move: it needs the registration route to resolve the staff user from the org session and
a decision on what to do with existing `org`-kind rows (re-key, keep, or drop). Maps to
SQL03:466–472, whose `ref_kind` CHECK keeps `org` and `ts_reviewer` for the rows as they are.
The `deliveryFailInject.push` counter (DL:248–250) has no reader in the sender (AD:121–145).

### 1.9 Persistence, backup, restore, export — the paths that move with S7

- **Every S7 collection is a blob**: `TABLE_BACKED` is `orgs, players, guardians, users,
  sessions, mediaDeletions, emailChallenges, pairingCodes` only (repositories/index.mjs:64);
  each save upserts every non-table-backed collection as one JSON row (ST:177–183, 180–183).
  `persist()` is debounced 2 s (S:159–169); `persistNow()` saves at once and **catches and logs a
  failed save** (S:171–178) — a send answers 201 even if its save failed.
- **Store contract** (storeContract.mjs): `channels` migration/core (:69), `notifications`
  migration/core (:109), `notificationPrefs` migration (:108), `dispatches` module/m13 (:84),
  `outbox` (:116), `pushLog` (:131), `pushTokens` (:132) module/core; containers created by
  `m230_001` (m182/migrations.mjs:253) and `m182_002`/`m182_004` (m182/migrations.mjs:97–106,
  117–119) or at composition (S:278–280, m13/shared.mjs:28). When a collection becomes a table its
  contract entry is removed, as S6a did (readiness review §10.5, `m23BootContract`).
- **Backup** (`POST /admin/backup`, m13/enterprise.mjs:470) writes `db.json` as
  `{...db, sessions, mediaDeletions, emailChallenges, pairingCodes}`: every S7 collection is
  included today as a blob; only `notifications` is counted in the manifest (:491). After S7 the
  table-backed collections are exported through `readTableBacked` / the repository's export, as
  S4a–S6a do, in their **stored** form.
- **Restore** is a boot of a fresh `DATA_DIR` holding `db.json` (enterprise.mjs:498): the legacy
  import writes every collection it finds, table-backed ones through their migration's import
  from the file (ST:356–380; S4a/S5/S6a precedent). The import validates only the table-backed
  shapes; "other collections may hold any JSON value" (ST:76–82).
- **Data export**: `exportPlayer` (S:4073–4084) returns `threads` (every channel with the
  player's id, through `channelViewFor(c, 'player')`, which strips `orgId` and `guardianId`) and
  `notifications`; the guardian export returns the children's exports and not the guardian's own
  notifications (S:4238–4244); the org audit export includes none of these collections
  (m13/enterprise.mjs:327–341). A repository must keep these projections byte-for-byte.
- **Dependents that embed or copy delivery records**: m23 Contact stores the mail outcome as
  `contact.emailCopy = { state, to, outboxId, at }` (m23/contactRoutes.mjs:516–551), written
  asynchronously after the mail promise settles and followed by `persistNow()` — a reference by
  `outboxId`, the "contacts' outbox copies" the plan's §S8 means. m26 transactions keep
  `linkedThreads[].channelId` references (m26/index.mjs:1222) and do not clear them on player
  deletion (m26/index.mjs:1359–1381).

---

## 2. The dependency graph, resolved on paper

### 2.1 The live-table registry today

`DATA_MIGRATIONS` = `0001_org_users`, `0002_core_identity_shadow`, `0003_sessions_live`,
`0004_orgs_live`, `0005_core_identity_live`, `0006_media_deletions`, `0007_player_subrecords`,
`0008_one_time_codes` (repositories/index.mjs:34–45; files in `repositories/migrations/`). Tables
that exist and that S7 rows may reference: `orgs`, `org_users`, `players` (+ twelve `player_*`),
`guardians`, `guardian_children`, `sessions`, `media_deletions`, `email_challenges`,
`pairing_codes`. **Not** tables: `requests`, `trials`, `recruitmentCases`, `recruitmentContacts`,
`ledger`, `blocks`, `reports`, `moderationLog` and every S7 collection. The next unused identifier
is `0009`; it is **not assigned** by this review (plan §B numbering rule).

### 2.2 The cycle: `channels.request_id` → `recruitment_requests` (S8) while S8 depends on S7

- SQL03:71: `request_id TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT`,
  with a unique index (SQL03:86, "1:1, enforced by code today").
- SQL02:509–546: `recruitment_requests` is an S8 table, and it references
  `org_users(id)` (:519), `recruitment_cases(id)` (:539) and `trials(id)` (:540) — the heart of
  S8a/S8b. Its `player_id` has no FK pending S4b (SQL02:511; plan §S8).
- Plan §S8 "Depends on … S7 (contacts' outbox copies)": that dependency is the `emailCopy.outboxId`
  reference (§1.9), i.e. S8c (contacts) wants the outbox row to exist as a row it can reference.
- Today `request.contactChannel` points the other way (SQL02:499, "channels(id), file 03, no FK").

So, as written, S7 cannot create `channels` with its FK before S8a+S8b exist, and S8 says it
wants S7 first. The DDL encodes a 1:1 pair of references between two steps. Neither "create an
empty placeholder `recruitment_requests` table" nor "drop the `NOT NULL`/FK quietly" is
acceptable (the task's boundary, and §A of the plan: no silent integrity waiver).

### 2.3 A safe sequence — **proposal, not approval**

1. **S7a first, with no channels** (§8.2): `notifications`, `notification_prefs`,
   `notification_pref_categories`. None references a request, a channel, a case or a trial;
   `audience_id` is polymorphic by design (SQL03:174). Nothing in the cycle is touched.
2. **S7b, dispatches + attempts**, after S7a: `dispatches.notification_id → notifications` is the
   only FK and it becomes satisfiable the moment S7a is live. Orphan dispatches (whose
   notification was deleted with a player, §1.5) are a preflight finding to resolve (§5.3), not
   something to drop silently.
3. **S7c, outbox / push_log / push_tokens**: no FKs. The outbox needs the two-shape unification
   (§1.6) and the push-token audience key needs a decision (§1.8). S8c's `emailCopy.outboxId`
   then references a row; whether S8 adds a FK to it is S8's decision.
4. **S7d, channels / messages / attachments — with a transitional request reference**, proposed
   as follows and requiring explicit approval before it is built:
   - `request_id TEXT NOT NULL` **without** a foreign key, plus the unique index, in S7d's DDL.
   - **Validation at every write against the authoritative source today**: `openChannel` runs
     inside the acceptance unit of work and the repository refuses a channel whose `requestId`
     is not the id of a request present in `db.requests` (the blob, still authoritative until S8a)
     with `status === 'accepted'`-to-be and `contactChannel` null — the same existence check the
     route performs by construction today (the request *is* the argument, S:897). Snapshot
     writes (restore, persistence suites) validate every channel row's `requestId` against the
     `requests` collection in the same snapshot and refuse the whole write on a miss (the S6a
     `PAIRING_CODE_PLAYER_MISSING` precedent, oneTimeCodes.mjs).
   - **Every writer preserves it**: the only channel writer is `openChannel`; the tombstone path
     keeps the request row and nulls `contactChannel` (S:4167), never the channel's `requestId`;
     player deletion removes the channel (S:4218) rather than the reference. No writer updates
     `requestId` after creation, and the repository exposes no method to do so.
   - **Preflight** (§5.3): a channel whose `requestId` names no request in the file, or two
     channels naming one request, refuses the cutover with the ids and leaves the file unchanged.
   - **The later FK**: when S8a creates `recruitment_requests`, its migration rebuilds `channels`
     with `REFERENCES recruitment_requests(id) ON DELETE RESTRICT` (SQLite cannot add a FK in
     place; the S4a/S5 rebuild pattern) after its own preflight proves every `request_id`
     resolves — which S7d's validation has kept true in the meantime.
   This keeps referential integrity enforced in code and at every snapshot boundary until the
   database can enforce it, and says so in the DDL comment rather than pretending.
   The alternative order — S8a before S7d — is also coherent (requests become a table first,
   channels then reference it directly) but S8a carries the O1/O2 decisions (plan §S8) and the
   largest aggregate in the system; it is not the smaller step.

### 2.4 What needs S4b (the retained player record), and what needs the S6 audit tables

The old plan's "Depends on S4" does not establish that S4a is sufficient; it is not:

| S7 element | Needs | Why |
|---|---|---|
| `channels.player_id … ON DELETE CASCADE` (SQL03:72) | a **retention decision**, and S4b to make it meaningful | today the channel is filter-deleted with the player (S:4218), which the CASCADE mirrors; under S4b's tombstone the row is never deleted so the CASCADE never fires, and whether a deleted player's messages are kept (the six-year agent-communications duty, `s4-deletion-decision.md` §4 "messages — *review*") or erased is **open**. S7d must not pre-empt it: the proposal is to keep today's behaviour (the repository deletes the channels inside the deletion unit, explicitly, as S6a revokes codes) and leave the CASCADE out of the DDL until the policy is decided |
| `ledger` rows per message (S:949) | the S6 `ledger` table, which waits for S4b (S6 review §4.1: `ledger.player_id RESTRICT` would refuse today's `players.remove`) | until then the ledger stays a blob and every send still writes it (§7.3) |
| grooming escalation → `reports` (S:1088), urgent-report blocks (S:1734) | S6 tables (`reports.target_player_id RESTRICT`, `blocks.player_id RESTRICT`), hence S4b | not S7's rows, but on S7's send path; they stay blobs |
| `moderation_log.context_channel_id` (SQL03:577, 600) | S6 | no FK proposed; nothing to resolve for S7 |
| `channels.guardian_id … RESTRICT` (SQL03:80), `org_id … RESTRICT` (:74) | nothing new | no guardian or org deletion route exists (CLAUDE.md "no org deletion route … before O2"; `s4-deletion-decision.md` §48–51); a RESTRICT on tables that are never deleted from today does not change behaviour, but S4b's planned guardian-deletion route ("only with no live child", plan §S4) would meet it — to be designed with S4b, not here |
| `push_tokens` cleanup on deletion | S4b's proposal deletes them for the subject (`s4-deletion-decision.md` §217); today nothing does | a policy change bundled with S4b, not with S7 |

Nothing in S7a–S7c touches a `players(id)` reference; S7d is the only sub-step with one, and it
is deferred for the reason above. **Do not mark S4b complete, and do not add a RESTRICT on
`players(id)` anywhere in S7** (S6 review §4.1 shows it would make nearly every account
deletion fail with `FOREIGN KEY constraint failed`).

---

## 3. Transaction and delivery boundaries

### 3.1 A message send today, in order (`POST /org/channels/:id/messages`, S:2317–2332)

Outside any unit of work. The guardian (S:1562–1574) and player (S:3401–3414) routes are the
same from step 3.

| # | Where | What happens |
|---|---|---|
| 0 | S:717–721, 1933–1947 | bearer session → `orgAuth`: session kind `org`, the org exists, the staff user belongs to it and is not removed (`USER_REMOVED`), the org is not suspended (`ORG_SUSPENDED`) |
| 0 | S:2318–2324 | the channel is the org's (`c.orgId === req.org.id`; any active staff member may post); `channelClosedForOrg` (S:976–982: player exists, `isBlocked` S:667–669, `visibleToOrg` domain.mjs:110–121 — agencies never see minors, unverified clubs never see minors, grassroots limited to 50 km); `TEXT_REQUIRED` |
| 1 | S:2325 → S:1081–1104 | moderation. On a hit only: `nextId('mod')` (which calls `persist()`), `moderationLog.push`, on grooming an urgent `reports.push`, `persist()`, `400 MODERATION_BLOCKED`. The channel contexts carry no `orgId` (S:2325, 1569, 3409) so the grooming report has `targetKind 'player'`, `targetOrgId null` even when a club sent the text (S:1090; the request-message context does carry it, S:2098) — an observation for the safeguarding owners, not changed here |
| 2 | S:2326, 920–938 | attachment resolved (reads only) |
| 3 | S:943–946 | duplicate `clientMsgId` → the stored message, 201, no writes |
| 4 | S:947–948 | `nextId('msg')` (debounced `persist()`), `channel.messages.push` |
| 5 | S:949 → S:658–665 | `ledgerAppend({type:'message', …})`: `nextId('led')`, `db.ledger.push`, `broadcast('ledger')` — which outside a unit calls `persist()` (S:584) and **writes the SSE frame at once** (S:585–594), before anything is durable |
| 6 | S:950–965 → S:828–877 | notifications: org sender → one `notify` to the guardian or adult player (S:951–953, 964); counterparty sender → one per org user who has posted plus `request.userId` (S:955–962; no `removedAt` filter; `orgUserIdForNotify` never set). Inside `notify`: the preference gate (S:832), coalescing (S:843–854, `broadcast('notify')`) or a new row (S:860–866), `store.afterCommit(pushSender.send)` (S:874 — **outside a unit this runs immediately**, ST:435–438: `pushLog.push` then, when live, one Expo `fetch` per matching token, AD:131–139), `broadcast('notify')` (S:875) |
| 7 | S:968 → S:171–178 | `persistNow()`: one save transaction writing **every** blob collection (ST:177–183); a failure is logged, not returned |
| 8 | S:969 → S:584 | `broadcast('messages')` → a **second** whole-database save 2 s later |
| 9 | S:2331 | 201 |
| later | DL:76–135 | the sweep creates the dispatch rows, `fakeSend` writes outbox rows, `persistNow()` |

SSE audiences: `messages` to the org's streams, the player's when `counterparty === 'player'`,
the guardian's by `guardianId` (S:507–514); `notify` to the named audience's streams (S:515–520);
`ledger` to every org that can see the player (S:529–535). Channel creation on acceptance follows
the same pattern (`openChannel`, ledger, trial, `notify`, `persistNow`, `broadcast`;
S:3377–3391, S:1531–1552). Read receipts: one field write + `persistNow` + broadcast.

### 3.2 The proposed boundaries (for the sub-step that moves each collection)

- **One unit of work per request, joined by every repository it touches.** A send becomes:
  `unit(() => { messages.insert(channel, msg); channels.markActivity?; ledgerAppend (blob until
  S6); notifications.create(...) (table after S7a) })`, with `pushSender.send` and
  `broadcast(...)` registered through `store.afterCommit` so **nothing observable leaves before
  COMMIT** — today the ledger SSE frame and the push leave first (steps 5–6). **Correction (S7a
  review, accepted):** the coupled blob writes — the `channels`, `ledger` and every other blob
  the request edits — belong INSIDE the same unit-of-work commit as the new table writes (the
  unit's commit already writes every blob, ST:329); only external side effects (the push, the SSE
  frame, a provider call) belong after COMMIT. The earlier wording that put `persist()` of the
  remaining blobs after COMMIT would have let a notification commit ahead of the message it
  announces, and is withdrawn. The store contract requires it: inside a unit a repository mutation runs through
  `unit.join` so a failure after a statement poisons the unit even when caught (S6a review
  correction, oneTimeCodes.mjs `operation`); a real COMMIT failure (`failCommitOfOpenTransaction`,
  ST:401–406) rolls back every row and restores memory; an explicit retry runs the whole
  operation again. `store.save` inside the unit is absorbed into its commit (ST:408), so the
  `persistNow()` at step 7 becomes the unit's own commit and step 8's second save disappears for
  the table-backed part.
- **Moderation refusal** keeps writing `moderationLog`/`reports` (S6 blobs) in its own ordinary
  save as today; it happens before the unit opens and nothing of the message exists yet.
- **Idempotency** stays a read-then-insert of the client key inside the unit; after S7d the partial
  unique index (SQL03:124–126) is the backstop, and an `INSERT` conflict is answered by returning
  the existing row, never by a 500. Two concurrent sends with one key cannot both insert (the
  write transaction serialises them; the second sees the first's row).
- **Read receipts** are a single `UPDATE channels SET read_by_<side>_at = ?` — joined when a unit
  is open, a transaction of its own otherwise; the value stays a thread-open time, not a message
  id, because every client computes unread from `m.ts > readBy`. **Coalescing** becomes
  `UPDATE notifications SET occurred_at = ?, repeat_count = repeat_count + 1 WHERE audience… AND
  read = 0 AND group/text match AND occurred_at > now − 6 h` with the 6-hour window kept
  (`NOTIFY_COALESCE_MS`, S:818); `markNotificationsRead` becomes one `UPDATE … SET read = 1`
  inside whatever unit the route opens (today it persists with the next save of any kind, S:887–891).
  **Correction (S7a review, accepted; implemented):** the coalescing `UPDATE … WHERE occurred_at >
  now − 6 h` sketched here is NOT the existing behaviour and was not implemented. The existing
  scan (S:843–854) walks the array newest-first by *position*, stops at the first row older than
  the cutoff (a matching row behind it is never examined, even when its own clock was refreshed),
  coalesces only the row it selects, and includes a row exactly six hours old. S7a keeps that scan
  verbatim over the in-memory mirror (§8.3), and the single `UPDATE` it produces targets the
  selected row by id.
- **Network calls never inside a SQLite transaction.** Today none is (the push runs after COMMIT
  inside a unit and `testUnitOfWork.mjs:126–133` asserts `isTransaction === false` in the
  callback; the store refuses async work inside a unit, ST:236–245, 315–316; the mailer's `fetch`
  is started synchronously but never inside `unit()` — none of the nine call sites is in one).
  S7 keeps that invariant and adds a test for every new path (§7.1).
- **Durable intent versus provider response.** A notification row (S7a) and a dispatch row
  (S7b) are *intent*; `accepted` / `delivered` / `opened` are *provider or client facts* written
  only from a provider response or a signed callback (DL:111–123, 189–201; m13E2E "provider
  accepted is never reported as delivered", scripts/m13E2E.mjs:398–409). An outbox row (S7c) is
  the record that a mail was handed to a transport, with `delivered` the provider's synchronous
  answer (AD:108–110) — not proof of receipt. **Crash recovery between them**: a notification
  committed but no dispatch yet → the boot sweep creates it (DL:260); a dispatch `queued`/`retrying`
  with no provider answer → the sweep retries on schedule (m13E2E:834–852, SIGKILL mid-queue);
  a provider answered but the process died before writing `accepted` → the next attempt resends
  (an at-least-once contract; the provider's own idempotency, if any, is outside ScoutBox). A mail
  whose `fetch` was in flight at the crash leaves an outbox row with `delivered: false`, as today.
- **The S6a masking and the development-only delivery are preserved unchanged**: the row stores
  the withheld text, the provider gets the full text, the dev full text stays in `devDeliveries`
  memory (AD:84) and is merged into `/admin/outbox` at read time (S:4365). Moving the outbox to a
  table changes where the withheld row lives, nothing else.

---

## 4. Privacy, permissions and deletion — current behaviour, and what stays open

### 4.1 Current behaviour that S7 must preserve byte-for-byte (not a proposal)

- **Guardian-only contact for minors**: minor players are refused by `guardianManagedOnly`
  (S:1245–1254, S:3402), `GET /player/channels` returns `[]` for them (S:3397), and a channel's
  `counterparty` is `guardian` for a minor (S:908, 2182–2184). Contact recipients are resolved
  fail-closed to exactly one verified, disclaimer-accepted guardian (`m23/contact.mjs:250–281`,
  `CONTACT_GUARDIAN_REQUIRED` :278).
- **Verified clubs, the under-18 wall, blocks and suspension**: re-checked on **every** org
  send through `channelClosedForOrg` (S:976–982) and `visibleToOrg` (domain.mjs:110–121); on the
  counterparty side `channelClosedForCounterparty` checks org existence, suspension and block
  (S:984–990). An urgent report naming an org adds `blocks` rows and suspends pending requests
  (S:1727–1739). SSE re-authorises per event (S:488–501, 507–514).
- **Tenant isolation**: the org route finds channels by `orgId` (S:2318); the guardian by the
  captured `guardianId` (S:1563); the player by `playerId` + `counterparty` (S:3403).
  `connectedE2E.mjs:174–176` proves another org cannot write or list.
- **Sender and attachment ownership**: the sender is the authenticated identity (S:1573, 2330,
  3413), never a body field; an org may attach only its own trial report (S:929); media URLs are
  signed per session at read time (S:419–452) and re-authorised on fetch (S:4476–4508).
- **Mandatory notification categories**: `compliance` and `security_account` cannot be muted
  (NP:216, 230, 256–259; m182E2E:559).
- **Public payloads**: `channelViewFor` strips `orgId`/`guardianId` for the player view and
  `playerId`/`guardianId` for the org view (S:993–996); `/admin/channels` returns full records
  (S:4466); notifications carry `refId` and a fixed text, never message text (S:961, 964). The
  m23 suites sweep channels, notifications, the outbox and the push log for leaks
  (m23ContactE2E:542–558; m23TrialE2E ≈1026–1046; m23DecisionE2E:815).

Observations the survey made that are **not** S7's to change but that the owners should know
(each is current behaviour, cited, undecided): `GET /player/export` has no minor gate, so a
minor's export includes the guardian–club threads `/player/channels` hides from them (S:4230 vs
S:3397); the grooming report from a channel message names no club (S:1090, §3.1); removed staff
still receive new message notifications (S:957–962, no `removedAt` filter) and remain an e-mail
destination (DL:56–59); the push-token audience defect (§1.8).

### 4.2 What each deletion does to these records today

| Path | Where | Channels / messages | Notifications | Dispatches, outbox, push log, push tokens, category prefs | Ledger |
|---|---|---|---|---|---|
| **Player deletion** (`DELETE /player/account` adults only, S:4232–4236; `DELETE /guardian/children/:id`, S:4246–4250) → `deletePlayerData`, one unit (S:4172–4228) | hard delete of the player row with cascading links (S:4188, identity.mjs:767–779); requests and trials tombstoned (S:4195–4196); m24–m29 hooks (S:4209–4217) | **hard-deleted with every message, attachment and receipt**, by `playerId` — guardian–club threads included (S:4218); m26 `linkedThreads[].channelId` left dangling (m26/index.mjs:1359–1381) | only the **player-audience** rows deleted (S:4219); guardian and staff rows naming the player stay | **all untouched** (nothing in S:4172–4228 refers to them): dispatches of deleted notifications become orphans; outbox rows with the guardian's address stay; push log stays; push tokens stay; `notificationPrefs` rows stay (SQL03:228) | rows stay, "carry only ids" (S:4222) — but `message` rows carry `scoutName = sender.name` (S:949) |
| **Guardian deletion** | **no route** (`s4-deletion-decision.md` §48–51) | — | — | — | — |
| **Guardian–child link removal** — only aging up (`POST /player/aging-up/complete`, S:3243–3259 → `players.ageUp` → `unlink`, identity.mjs:757–765, 549–566) | the link row goes; notify, ledger `account_transitioned`, timeline | **untouched**: `counterparty:'guardian'` channels stay readable and writable by the guardian (S:1559, 1563) and invisible to the now-adult player (S:3398) | untouched | untouched | row appended |
| **Staff removal** (`POST /org/staff/:userId/remove`, m12/scouting.mjs:630–640; agency `…/team/:userId/end`, m24/index.mjs:405–425) | soft: `removedAt`, sessions revoked, SSE ended (S:4516–4528), ledger `staff_removed` | untouched; messages keep `sender.id`/`name` | untouched; **new** notifications can still be created for the removed user (S:957–962) | untouched; still an e-mail destination (DL:56–59) | row appended |
| **Organisation removal** | **no route**; suspension only (S:987, 1941–1943, 488–501) | paused for the counterparty | — | — | — |

### 4.3 What S7 proposes to change in behaviour (needs approval) versus what it keeps

Keeps: everything in §4.1 and §4.2 — a storage move is not a policy change. The repository
methods reproduce today's deletion effects explicitly inside the deletion unit (delete the
player's channels; delete the player-audience notifications), as S6a's `revokePairingCodesFor`
does, so the outcome does not depend on a CASCADE that S4b would later make inert.

Proposes, each a separate decision for the owners and **not implemented by S7 unless approved**:
(a) remove dispatch rows with their notification (the DDL's CASCADE, SQL03:314) instead of
leaving orphans; (b) stop notifying removed staff; (c) the push-token re-keying (§1.8).

### 4.4 Unresolved retention and deletion questions S7 must not decide

- Whether a deleted player's **messages** are retained (and in what form) or erased: open
  (`s4-deletion-decision.md` §4, §219, §309–313).
- Retention of `notifications`, `dispatches`, `outbox`, `push_log` and `push_tokens` rows after
  a deletion, and any retention period at all for these append-only logs: open; nothing prunes
  them today and S7 adds no pruning.
- The remaining plain-text codes in six outbox call sites (§1.6): a correction outside S7's
  scope, listed for the owners; S7 carries the rows as they are and does not cleanse history.
- Country code and child-status stamp (S4b, O1): open; untouched. Org deletion (O2): open.

---

## 5. Preflight and cutover design (per sub-step; nothing registered)

### 5.1 Markers and the authoritative source

As for 0005–0008: a step's cutover is decided by its record in `data_migrations`
(`migrationApplied`, repositories/database.mjs), never by a table existing; until the record
exists the blob is authoritative and the new build refuses to boot on a file whose record is
missing while the tables exist (`UNEXPECTED_SCHEMA`); a file with the record but without the
tables is refused the same way. The migration imports the blob **from the file** inside one
transaction, records the cutover and its counts in `meta.<step>Cutover` (counts only, never
content), and deletes the blob row only after the rows are written — the 0008 pattern
(oneTimeCodes.mjs `importCodeBlobs`). An in-memory array a caller still holds is never imported
(the S6a/0006 rule); a stale blob row found after cutover is reported, dropped and its row deleted
so no save can resurrect it (repositories/index.mjs:242–250 precedent). Pending initialisation
(`meta.*Init = pending`) is not needed for S7: these collections have no seed import — the seed
creates empty containers (seed.mjs:485–491), and a "genuinely new" database simply has no rows.

### 5.2 Accepted legacy shapes

The migration accepts exactly what every build since the containers were created has written,
and nothing it would have to reinterpret:

| Collection | Accepted entry | Absent collection | Empty collection |
|---|---|---|---|
| `notifications` | the `notify` literal (§1.3) with `repeatCount` present (backfilled by `m182_005`) or absent (→ 1), `groupKey`/`category`/`refId` null or absent (→ null), optional `actionRequired` with its three fields, `read` boolean | imports nothing, records the cutover | same |
| `notificationPrefs` | `{audienceKind, audienceId, categories{name:boolean}, emailIntent, updatedAt}` with `updatedAt` null on an initial row (NP:197, SQL03:234) | same | same |
| `dispatches` | the sweep literal (§1.5) with `attempts[]` of the two row kinds; every status in the nine-value set | same | same |
| `outbox` | shape (a) or shape (b) (§1.6), told apart by the presence of `ts`+`subject`+`transport` versus `at`+`channel`+`provider` | same | same |
| `pushLog` | the sender literal (§1.7) | same | same |
| `pushTokens` | `{kind, refId, token, ts}` with `kind` in the four session kinds | same | same |
| `channels` (S7d) | the `openChannel` literal (§1.2) with `readBy` present; `messages[]` of the `postMessage` literal with `clientMsgId` present or absent, `attachment` null or one of the two shapes | same | same |

### 5.3 Concrete refusal conditions (whole write refused, file unchanged, ids and reasons listed, never a code, token or message text)

- **Duplicate identifiers**: two entries with one `id` in any collection; two `channels` with one
  `requestId`; two `pushTokens` with one `(kind, refId, token)`; two `notificationPrefs` rows for
  one `(audienceKind, audienceId)`; two messages in one channel with one
  `(clientMsgId, sender.kind, sender.id)`; two dispatches with one `providerMessageId`.
- **Orphan references**: a `dispatch.notificationId` naming no notification (orphans exist
  today, §1.5 — the dry run lists them; the resolution is a data fix with a written record, or an
  approved rule to drop them, decided before the cutover, not by the migration); a channel
  whose `requestId` names no request in the file (S7d), whose `playerId` names no player row, or
  whose `guardianId` names no guardian row while `counterparty === 'guardian'`.
- **Invalid audiences / identities**: an `audience.kind` or `sender.kind` outside
  `player | guardian | org_user`; a `pushToken.kind` outside the four session kinds; a
  `counterparty` outside `player | guardian`; `routedTo`/`counterparty` mismatch with `guardianId`.
- **Malformed arrays, attachments, preferences**: `messages`, `attempts` or `categories` that are
  not an array/object; an attachment with neither or both of `mediaId`/`reportId`
  (SQL03:156–157); a category name outside `CATEGORIES`; a mandatory category stored `false`;
  a dispatch status outside the nine values; an attempt row with both `note` and `ok`.
- **Ambiguous field mappings**: an outbox entry that matches neither shape or both (e.g. `ts`
  and `at`), a message with `clientMsgId` longer than 64 characters, a `ts`/`at`/`createdAt`
  that is not a safe integer, a `read` or `delivered` that is not a boolean, an unknown field on a
  channel or message (today passed through to clients, §1.2 — the migration must not drop it
  silently, so an unknown key is a refusal until an `extra_json` column or an explicit allowlist
  is approved, the S5 `extra_json` precedent).
- **The S4a rule stands**: a preflight that finds an under-18 player without a valid guardian link
  stops the migration until it is resolved (0005's preflight; nothing in S7 imports, omits, ages
  up or fabricates a link).

A refusal leaves the blob and the file exactly as they were and the previous build still boots
it; the next boot refuses the same way until the data is fixed. Nothing is coerced.

### 5.4 Whole-snapshot final-state validation and restart

Every snapshot write (restore, persistence suites, a tool) validates the collection entry by
entry in the accepted shapes, then checks the **final state** of the write (S6a precedent): every
`dispatch.notification_id` resolves, every S7d `channel.request_id` resolves to a request in the
same snapshot, every `message.channel_id` resolves. A failure rolls the whole save back with
`saveSeq` unchanged. Boot after a crash mid-migration finds either the pre-cutover file (no
record, blobs intact) or the post-cutover file (record, tables, blob rows gone) — never a mixture,
because the import is one transaction; the restart-safety tests of 0007/0008 (SIGKILL between
steps) are reused.

---

## 6. Backup and rollback design

### 6.1 Backup

`POST /admin/backup` keeps writing `db.json` with every collection: table-backed S7 collections
are exported in their **stored** form through the repository (rows, not views), as 0005–0008 do
(`readTableBacked`, repositories/index.mjs:76–). The outbox rows carry the withheld text exactly
as stored — the backup never regains a secret. A restore into a fresh directory imports the
exported rows through the same migration (both the legacy blob shape and the stored shape are
accepted, §5.2), so a backup taken after cutover restores and a backup taken before it restores
too.

### 6.2 Copy-only rollback that **loses nothing** (replaces the plan's assumption)

The plan says "Pre-S7 backup + S6 commit (messages after S7 lost)". That is unnecessary: every S7
row maps back to the blob entry the old build reads without loss (the mapping tables in §1 are
one-to-one; the only minted values — `dispatch_attempts.id`, `seq` — are dropped on the way
back, and `outbox` rows return to the shape their `transport` says). The proposal, per sub-step,
mirrors `oneTimeCodesRollback.mjs`:

- **Source immutability**: open read-only, `VACUUM INTO` a copy, work on the copy only, remove
  the copy on any failure (`OUTPUT_NOT_EMPTY`, `NO_SOURCE` refusals).
- **Later-schema refusal**: a copy carrying a `data_migrations` id the tool does not know
  (`LATER_SCHEMA`), one without the step's record (`NOT_CUT_OVER`), one whose record exists but
  whose tables are missing (`UNEXPECTED_SCHEMA`).
- **The rewrite, one transaction**: for every newly owned collection, `SELECT` the rows, rebuild
  the blob entries in the **old build's exact shape** (channel with nested `messages[]` and
  `readBy`; notification with `actionRequired` re-nested; dispatch with `attempts[]` re-nested in
  `seq` order and note rows restored as `{at, note}`; outbox rows split back into shape (a) or
  (b) by `transport`), `INSERT … ON CONFLICT DO UPDATE` into `collections`, drop the tables,
  delete the record and the meta key, advance `saveSeq`, `foreign_key_check`, COMMIT, `VACUUM`.
- **Revalidation** before reporting: integrity, the tables gone, the record gone, the blobs
  present with the same counts as the tables held, and the untouched tables (orgs, players,
  guardians, sessions, codes) byte-identical to the source.
- **Secrets**: the rollback moves the withheld outbox text as it is; it never reconstructs a
  code, and the dev in-memory full text is process state the tool never sees.
- **Fresh-directory restore**: the output boots on the previous build (the S6a build at
  `2d7ddeb`), which reads the blobs — proven the way `s6a/old-build-proof.mjs` proved S6a's.
- **The unavoidable incompatibility, stated precisely**: none for the data. The one thing the
  old build cannot do with the rolled-back copy is *enforce* what the tables enforced (the unique
  client key, the one-row-per-audience preference) — it never did. If S7c re-keys push tokens
  (§1.8), the rollback must map them back to the session-kind rows the old sender reads, or the
  old build's pushes change behaviour; that is a reason to keep the re-keying out of the storage
  move. No data loss is accepted on the user's behalf by this design.

---

## 7. Tests, measurable acceptance, and the performance objective

### 7.1 Proposed tests (failing-first where a behaviour changes; per sub-step)

- **Migration**: legacy blob in every accepted shape (§5.2) imports with the right counts and
  `meta.<step>Cutover`; each refusal condition in §5.3 refuses whole and leaves the file
  unchanged (`saveSeq`, blob bytes); rerun is a no-op; a crash (SIGKILL) between the record and
  the blob deletion leaves a file the next boot handles; an absent collection versus an empty one.
- **Repository and unit of work**: joined success (one revision), caught failure inside a unit
  (the `b2a237e` regression pattern: trigger-injected statement failure, independent read
  connection, memory restored, `saveSeq` unchanged, retry lands), real COMMIT failure
  (`failCommitOfOpenTransaction`), raw transaction honoured without a nested BEGIN, construction
  refusal of a malformed participant API.
- **Send semantics** (S7d): duplicate `clientMsgId` returns the existing row across a restart;
  two concurrent sends with one key through two connections insert once; ordering with equal
  `ts` stays insertion order; read receipt is one row write and the client's `m.ts > readBy`
  contract holds; a send to a closed channel refuses before any write; moderation refusal writes
  nothing to the channel.
- **Notifications** (S7a): coalescing within 6 h and not after; mandatory categories; a muted
  category creates no row; `markNotificationsRead`; `notifyAction` and ack; the player-deletion
  removal of the player-audience rows inside the deletion unit (two-connection read).
- **Delivery** (S7b/S7c): the sweep's forward-only ladder and the out-of-RANK statuses; retry
  schedule; SIGKILL mid-queue (reuse m13E2E:834–852); callback idempotency; outbox two-shape
  import and the S6a withholding (reuse `testOneTimeCodesServer.mjs` finding-1 case against the
  table); push log written whether or not a token matched; `/admin/outbox` dev merge.
- **Permissions**: the §4.1 list, re-run through the real routes (reuse `connectedE2E`,
  `m23ContactE2E` section I, `m23P4AClosureE2E` C2–C3/D1–D8, `apiE2E` grooming and export).
- **Backup/restore/rollback**: backup after cutover, restore into a fresh directory, outstanding
  rows intact; a pre-S7 backup restored; the copy-only rollback booted on the `2d7ddeb` build
  with every message, notification and dispatch present; refusals (`LATER_SCHEMA`,
  `NOT_CUT_OVER`, `OUTPUT_NOT_EMPTY`).

### 7.2 Existing suites mapped to these cases

| Case | Covered today by | Gap |
|---|---|---|
| idempotent send by client key, tenant isolation, block/suspension closing, SIGKILL durability of messages and read state | `connectedE2E.mjs:159–238` | no two-connection concurrency case; no equal-`ts` ordering case |
| grooming blocked and escalated; exports; minor cannot self-delete | `apiE2E.mjs:143–180` | none for the report's missing org |
| delivery centre: in-app delivered, accepted ≠ delivered, signed/idempotent/out-of-order callbacks, retries exhausted, ack loop, SIGKILL mid-queue | `m13E2E.mjs:378–428, 514, 834–852` | the plan names `m13Delivery*` suites — **they do not exist**; delivery lives in `m13E2E.mjs` |
| preference defaults, muted category creates no row, mandatory cannot be muted, every type classified, `repeatCount`/prefs migration | `m182E2E.mjs:183–195, 239–241, 538–559` | none |
| muting "Messages and requests", deletion flows D1–D8 | `m23P4AClosureE2E.mjs:325–348, 413–484` | none |
| privacy sweeps over channels, notifications, outbox, push log | `m23ContactE2E.mjs:542–558`, `m23TrialE2E.mjs`, `m23DecisionE2E.mjs:815` | none |
| transaction ↔ channel link ownership | `m23AgentTransactionE2E.mjs:643–660` | none |
| unit of work with a `channels` blob fixture | `testUnitOfWork.mjs:58–99` | fixture only; no repository case |
| writer atomicity | `testWriterAtomicity.mjs` | **no channel, message or notification case** |
| player deletion | `testCoreIdentityServer.mjs:314` | asserts row, media, sessions, shortlist — **not** channels or notifications |
| browser, live server: Pro↔adult, Grassroots↔adult, Pro↔guardian messaging, unread, read receipts over SSE | `e2e/liveIntegration.test.mjs`, `e2e/m24f3InboxLive.test.mjs` | **client/browser suites**: not run by `npm test`, need built apps and Chromium; `e2e/crosstab.test.mjs` uses demo bundles, not the API |

### 7.3 The performance objective, assessed honestly

The plan's measurable goal is "`postMessage` no longer triggers a whole-database write". Today
one send performs **two** whole-blob saves (§3.1 steps 7–8), each writing every non-table-backed
collection as JSON (ST:177–183) — `channels`, `ledger`, `notifications`, `pushLog`, `requests`,
`recruitmentCases`, … — regardless of which changed. Moving `channels`/`messages` alone does not
meet the goal: the same send still appends a `ledger` row (S6, blocked on S4b) and a
`notifications` row (S7a) and a `pushLog` row (S7c), and `persistNow()` still rewrites every
remaining blob. The goal is met only when **every collection the send path writes is a table**
(S7a, S7c, S7d and the S6 `ledger`) *or* the store's ordinary save writes only the blobs that
changed (a store change — dirty-collection tracking — that is outside S7 and would need its own
review against the S3 save contract, ST:195–203).

**Phased, measurable acceptance** (proposal): count, per send, (i) the number of `collections`
rows upserted and (ii) the total JSON bytes written, from a synthetic benchmark. Phase 0 (now):
the baseline — N upserts × 2 saves. Phase S7a: `notifications` leaves the count. Phase S7c:
`pushLog`/`outbox` leave it. Phase S7d: `channels` leaves it; the send's own writes are rows.
Phase S6-ledger (after S4b) or the dirty-save change: the count reaches the blobs the send does
not touch, which is the point at which "no whole-database write" is true. Each phase states its
number; none claims the objective early.

**The benchmark, reproducible and synthetic** (described, not built): extend
`scripts/dataLayerPerf.mjs` (synthetic snapshot in the server's own shapes, throwaway database,
nothing touches `DATA_DIR`) with K channels × M messages and a notification history, then run
the real send routes against a server booted on that directory (`PORT` free, `DATA_DIR`
temporary) and measure, per send: `SELECT total_changes()` before and after (rows changed by the
request's saves), the number of `collections` rows whose `value` changed (compare
`length(value)` and a hash per row across the request), the bytes those rows hold, and wall time
of the route — reported as medians over 100 sends at K = 1 000, M = 50 and K = 10 000, M = 20,
with the ledger and notification sizes stated. The harness is not changed by this review.

---

## 8. The dependency table and the bounded recommendation

### 8.1 Dependency table

| Work | Class | Blocker or need |
|---|---|---|
| **S7a** `notifications` + `notification_prefs` + `notification_pref_categories` | **ready technical work** | none under current decisions (no FK, one writer, no S4b/S6/S8 dependency); the `category` CHECK must equal `CATEGORIES`; orphan-dispatch findings are listed, not resolved, by S7a |
| **S7b** `dispatches` + `dispatch_attempts` | ready after S7a | `notification_id → notifications`; orphan rows need a resolution record before cutover (§5.3); whether dispatches cascade with notifications is a policy question (§4.3 a) |
| **S7c** `outbox`, `push_log` | ready technical work | the two-shape unification (§1.6); the six plain-text code call sites are an **owner decision** (cleanse, mask like S6a, or carry as is) — S7c carries rows as they are unless told otherwise |
| **S7c** `push_tokens` storage move | ready technical work | — |
| **S7c** push-token audience re-keying (staff pushes) | needs a **product/behaviour decision** | which identity a staff push targets; what to do with existing `org`-kind rows; keep it out of the storage move (§6.2) |
| **S7d** `channels` + `messages` + `message_attachments` | needs **another storage stage or an approved transitional design** | `request_id` → S8's `recruitment_requests` (§2.2); the transitional reference (§2.3 step 4) is a proposal awaiting approval; an ordering column for equal timestamps (§1.2) to add to SQL03 |
| S7d `channels.player_id` deletion behaviour | needs a **product-policy answer** | message retention after deletion (`s4-deletion-decision.md` §4 "review"); until then the repository deletes explicitly inside the deletion unit, no CASCADE in the DDL |
| the `ledger` rows every send writes | needs **another storage stage** (S6 ledger) which needs **S4b** | `ledger.player_id RESTRICT` (S6 review §4.1) |
| "no whole-database write on send" | needs S7a + S7c + S7d + the S6 ledger (or a store dirty-save change) | §7.3 phases |
| retention periods, pruning, deletion cleanup of delivery records, removed-staff notifications, the minor export gate, the grooming report's org | **product-policy answers** | listed in §4.1/§4.4; not decided here |
| guardian deletion, org deletion | S4b (O1) and O2 | out of S7 |

### 8.2 Recommendation: the smallest coherent, independently testable sub-step — **S7a**

**Scope**: `notifications`, `notification_prefs`, `notification_pref_categories` become tables;
`db.notifications` and `db.notificationPrefs` become read-only views (the S6a view pattern);
nothing else moves. **Not started by this review.** It needs the Founder's go-ahead and takes the
next unused migration identifier only then.

- **Files**: new `repositories/notifications.mjs` (repository: create with the preference gate and
  coalescing, mark read, action/ack, delete-for-audience, feeds, counts, export, snapshot
  read/replace, blob import, final-state checks) and
  `repositories/migrations/<next-id>_notifications.mjs`; `repositories/index.mjs` (register,
  `TABLE_BACKED`, views, `unit: store.unit`); `server.mjs` `notify` (S:828–877),
  `markNotificationsRead` (S:887–891), `notificationsFor` (S:879–885), the player-deletion unit
  (S:4219 → repository call); `m13/delivery.mjs` `notifyAction`/ack and the sweep's reads
  (DL:79–81, 141–160, 236); `m182/notificationPrefs.mjs` `update`/`view`/`effective`/`allows`
  (NP:197–275) and its migration `m182_004`/`m182_005` entries (import path); `m24/index.mjs:208,
  696` reads; `storeContract.mjs` (remove the two entries); `m13/enterprise.mjs` backup export;
  `sql/03_messaging_safety_audit.sql` (status lines; the `category` CHECK reconciled to
  `CATEGORIES`); `OPERATIONS.md`; a copy-only `repositories/notificationsRollback.mjs` +
  `scripts/notificationsRollback.mjs`.
- **Tables**: SQL03:194–220 (`notifications`), 239–245 (`notification_prefs`), 259–272
  (`notification_pref_categories`), with `occurred_at` keeping the refreshed-on-coalesce
  semantics and `action_*` nullable as today.
- **Transaction boundaries**: every mutation through one `operation` boundary joining
  `store.unit` (S6a pattern); `notify` creates the row inside the caller's unit when one is open
  (every m23/m24/m29 caller already runs in one) and in a transaction of its own otherwise, with
  the push and the SSE `notify` broadcast registered through `store.afterCommit` so they never
  precede COMMIT; coalescing is one `UPDATE`; `markNotificationsRead` one `UPDATE`; the player
  deletion deletes the audience's rows inside its unit.
- **Tests**: `scripts/testNotifications.mjs` (migration shapes and refusals, repository, joined
  and caught failures, COMMIT failure, coalescing window, mandatory categories, snapshot
  replace/final-state, rollback) and `scripts/testNotificationsServer.mjs` (real routes: feeds,
  mark read, ack, muted category, deletion through two connections, backup/restore, SIGKILL);
  `m182E2E`, `m13E2E`, `m23P4AClosureE2E`, `apiE2E`, `connectedE2E` unchanged and green; the
  phase-S7a benchmark number recorded (§7.3).
- **Rollback**: copy-only (§6.2) rewriting the rows into the `notifications`/`notificationPrefs`
  blobs the `2d7ddeb` build reads, losing nothing; proven by booting the copy on `2d7ddeb`.
- **Why it is independent**: no foreign key, one creator, polymorphic audiences by design, no
  dependency on S4b, the S6 tables or S8, and the old build reads the rolled-back blobs
  unchanged.
- **What it does not do**: it does not meet the whole-database-write objective on its own
  (§7.3), does not touch dispatches, the outbox, push or channels, and decides no retention.

If S7a is not wanted first, there is **no** channel/message sub-step that is independent under
current decisions: S7d is blocked by the `recruitment_requests` reference until the §2.3
transitional design is approved or S8a ships, and by the message-retention question.

### 8.3 S7a as implemented — **implemented, pending independent acceptance**

Built on `812e13b` after the S7a review accepted the §8.2 recommendation subject to four
compatibility corrections, which an unchanged probe script (`s7a-compatibility-probes.mjs`, exit
0 on the starting server) had established. Migration **`0009_notifications`** (the next unused
identifier). Files: `repositories/notifications.mjs`, `repositories/migrations/0009_notifications.mjs`,
`repositories/notificationsRollback.mjs`, `scripts/notificationsRollback.mjs`,
`scripts/testNotifications.mjs`, `scripts/testNotificationsServer.mjs`,
`scripts/notificationsPersistenceBench.mjs`; converted callers in `server.mjs` (`notify`,
`notificationsFor`, `markNotificationsRead`, the deletion unit, the module contexts),
`m13/delivery.mjs` (sweep reads, `notifyAction`, `ackHandler`, the admin count),
`m182/notificationPrefs.mjs` (stored preferences through the repository; vocabulary, validation,
effective view and gate unchanged), `m24/index.mjs` (inbox and unread count), `m13/enterprise.mjs`
(explicit backup export), `repositories/index.mjs`, `storeContract.mjs`, `sql/03` and
`scripts/testSchemaDdl.mjs`; the Player app untouched.

**The four corrections, as honoured.**

1. *Ordering.* `notifications.seq INTEGER PRIMARY KEY` is the durable insertion-order key: the
   migration assigns it from the array position, a backup exports the rows in `seq` order and a
   restore or snapshot write reassigns it from the array position, the rollback writes the blob
   in `seq` order. The feed is `ORDER BY seq DESC` (in practice the mirror walked backwards);
   `occurred_at` is never an ordering key, so a coalesce refreshes the clock without moving the
   row, and tied clocks keep their positions. Tested at repository level (ties, refreshed clocks,
   a reopen), through the real routes (a later notification stays above a refreshed one, across a
   SIGKILL) and across backup → restore → rollback → re-upgrade.
2. *Coalescing.* `findCoalescible` is the pre-S7a reverse scan over the in-memory mirror,
   statement for statement; a differential test runs 300 random feeds against the verbatim
   `812e13b` loop, and focused tests cover the single selected row, the read-row skip, audience /
   type / text / refId isolation, exactly six hours included, one millisecond older excluded, and
   the stop at the first older row hiding a matching row behind it — at repository level and
   through the real routes with planted rows.
3. *Mandatory category stored false.* The proposed storage `CHECK` forbidding it is removed from
   `sql/03` and the migration (as is the `category` list `CHECK` on both tables and the
   `audience_kind` list `CHECK`: the vocabulary lives in `CATEGORIES`, must not need a schema
   change to grow, and the reports path writes a `system` audience that a stored row must keep
   importing). The route still refuses a literal `false` on a mandatory category and an unknown
   category, still coerces with `!!v` (numeric zero is stored false), the repository stores what
   it is given (booleans and known categories only, refusing the rest without coercion), and the
   effective view and the gate force a mandatory category on. A legacy stored false is imported
   as it is and never rewritten. Tested at repository, module and route level, and on the pre-S7a
   build over a rollback copy.
4. *Coupled writes.* §3.2 corrected above. The acknowledgment updates the notification row and
   the still-blob-backed dispatch statuses in one unit of work (a real COMMIT failure leaves both
   unchanged; the retry lands both; a SIGKILL right after keeps both). `notifyAction` creates or
   coalesces the row and its contract in ONE repository operation and returns null for a muted
   notification instead of crashing. The deletion unit removes the person's rows with the player
   row and keeps their preferences.

**One deliberate reading, recorded because the instruction said both "own transaction when
standalone" and "a new durable notification must not commit ahead of the action it announces".**
~170 `notify()` call sites edit blob collections that are saved later (a message pushed into its
channel, a request, a case), and wrapping each in a unit of work would be the cross-project
refactor the instruction forbids — and would multiply whole-snapshot writes. The repository
therefore has two write modes. *Immediate* (tools, tests, the migration): one boundary, joined
inside an open unit through `unit.join` (a caught failure still poisons the unit), part of a raw
transaction a tool opened (no `BEGIN` of its own; after the tool's own `ROLLBACK` the tool calls
`reload()`), a transaction of its own otherwise — the S6a contract. *Staged* (the running
server): a mutation updates the mirror at once and queues its SQL; the queue runs inside the
next snapshot save transaction — an ordinary debounced save, a `persistNow()`, or a unit of
work's commit — before the blob rows, so a notification is durable together with the blob edits
made alongside it and never ahead of them; inside an open unit the mutation still joins the unit
(a refused argument poisons it) and its SQL runs in the unit's commit; on a rollback the mirror
and the queue return to the unit's start, writes queued before the unit stay queued; a failed
save keeps the queue for the retry; the queue is FIFO and drained whole, so the file's order is
memory's order; a foreign transaction is refused in this mode. In other words the "own
transaction" of a standalone server write is the save that carries the blobs it belongs to —
exactly the durability window the blob had before S7a (the next save, at most the 2 s debounce),
with the coupled state landing in the same transaction. SSE and push outside a unit are unchanged
(immediate, as every other broadcast after a blob edit); inside a unit both wait for COMMIT.

**What else was decided.** Normalisations on import are the ones the pre-S7a snapshot
migrations applied or the literal always set (`repeatCount` absent → 1 as `m182_005`; `read`
absent → false; `groupKey`/`category` absent → null; `deferredPush` absent → false), each counted
in `meta.notificationsCutover`; unknown notification fields are kept in `extra_json` and spread
back on read; a preference record with an unknown field, an unknown or prototype-named category,
a non-boolean value or a duplicate audience is refused; the audience kind is open. `notify()`
gained an optional fifth argument `{ actionRequired }` for the M13 contract; no other public
payload changed (`refId`, `groupKey`, `category` absent on a pre-M18.2 row now read `null`;
`deferredPush` reads `false`). `storeContract.mjs` keeps the two entries because the snapshot
migrations `m182_002/004/005` still name the containers; the data layer replaces each container
with its read-only view at attach and no production reader or writer touches `db.notifications`
or `db.notificationPrefs` directly. `scripts/m182E2E.mjs` §9 now constructs a real repository on a
temporary in-memory database instead of an array. Benchmark (§7.3, phase S7a, synthetic, 3000
notifications, 100 notify-then-save rounds, 14 October 2026): the blob bytes rewritten by each
save fell from 1,511,974 (four blob rows, the notifications blob 866,961 of them) to 645,013
(three rows), mean save time from 14.1 ms to 6.0 ms. Every other blob is still rewritten by every
save: the whole-database-write objective is narrowed, not met.

**Rollback.** `scripts/notificationsRollback.mjs` (copy-only, `VACUUM INTO`, refusals
`LATER_SCHEMA` 4 / `NOT_CUT_OVER` 5 / `UNEXPECTED_SCHEMA` 10 / `OUTPUT_NOT_EMPTY` 1, revalidated
before it is reported) writes every row back into the `notifications` / `notificationPrefs`
blobs in `seq` order; nothing after the cutover is lost. Proven by booting the copy on the actual
`812e13b` server (`SCOUTBOX_PRE_S7A_SERVER` in `testNotificationsServer.mjs`): same feeds, same
preferences (the stored mandatory false forced on there too), and that build still writes to it;
the S6a tool refuses a 0009 file; the real migration re-upgrades the copy to the same rows.

---

## Appendix — survey corrections to the proposed DDL comments (for the next DDL revision, not applied)

- SQL03 header line numbers for `server.mjs` are stale throughout (e.g. `openChannel` 841–861 →
  897–917; `postMessage` 884–915 → 940–971; deletion 4014 → 4218; `notify` 809–815 → 828–877).
- SQL03:393–397 "KNOWN DEFECT" on the outbox predates the S6a correction: the club challenge
  code is withheld since `b2a237e`; six other call sites still write codes in clear (§1.6).
- SQL03 `messages` needs an ordering column for equal `created_at` (§1.2).
- SQL03:72 `channels.player_id … CASCADE` encodes a retention decision that is open (§2.4).
- `storeContract.mjs:76–77` attributes `deliveryCentreSince`/`deliveryFailInject` to
  `migrateM13`; they are created in `registerDelivery` (DL:20–21).
- The plan's S7 battery names `m13Delivery*`; the suite is `m13E2E.mjs`.
