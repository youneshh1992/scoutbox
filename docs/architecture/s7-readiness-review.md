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

**Status: S7a independently ACCEPTED for the bounded migration milestone at commit
`0641b2c600cd1f082436b4b24dbb052b98ee00d7`** (15 October 2026; the acceptance record, its validation
and its limits are in §8.6; it is not production or deployment approval and not acceptance of any
later stage). Three local commits on `feat/sqlite-schema` on top of `812e13b` make up S7a: the
implementation `ba6956d`, the correction `7655bae` of the four findings its first independent review
raised (§8.4), and `0641b2c`, the correction of the two participant-contract defects and the
replay-coverage gap the second review raised (§8.5); §8.4 and §8.5 are kept as the dated history of
those rounds, not as current status. What was built, the four compatibility corrections it honours
and the one deliberate reading it records are in §8.3. **S7b: independently ACCEPTED for the bounded dispatch/attempt
storage milestone and its three corrections at `ac50b60257b89387aa1dec44bad7f571e61aa74e`** (16 October
2026; §9.9 holds the acceptance record and its limits — not production or deployment approval, not
acceptance of the whole migration; §9.7 is what was built, §9.8 the correction round as dated history).
**The notification-extras follow-up the `ac50b60` review confirmed is corrected in `6ca66ba` and
independently ACCEPTED there for its bounded scope (§9.10, §10.9). S7c (`outbox`, `push_log`,
`push_tokens`): independently ACCEPTED for its bounded storage-migration scope at
`911918749687a3acdca430fe011d6c868ee640df`** (17 October 2026; §10.12 holds the acceptance record, the
reviewer's results and its limits — not production, security, legal-compliance or deployment approval, and
not acceptance of S7d, S4b, the remaining S6 tables or S8). Its history, kept as dated history: the prepared
plan (§10) was corrected by the review of `6ca66ba` (D1, D2, the null destination — §10.3, §10.4, §10.7) and
implemented on top of `6ca66ba` (`40aa05c`, §10.8); the review of `40aa05c` found two compatibility defects
(an array mail destination refused and crashing the process; raw JSON overflow tokens refused), corrected in
`78c14b9` (§10.10); the review of `78c14b9` found one remaining boundary (a non-finite number INSIDE an
accepted array destination dropped its mail record), corrected in `9119187` (§10.11), the accepted commit;
migration `0011_outbox_push` is registered with its DDL amended in place before acceptance. **S7d (`channels`,
`messages`, `message_attachments`): independently ACCEPTED for its bounded backend storage-migration scope at
`4f954ad92cda6ca5178cc6c3d5485265684e0c03`** (18 October 2026; §11.11 holds the acceptance record, the reviewer's
results and its limits — not production, security, legal-compliance or deployment approval, and not acceptance of
S4b, the remaining S6 tables or S8). Its history, kept as dated history: implemented on top of `b67bce5` (§11.9, the
Founder's two approvals D-A and D-B recorded verbatim), corrected once after the review of `62e9c1a` (§11.10, the
held nested view restored by identity); migration `0012_channels` is registered; `repositories/channels.mjs`;
`scripts/channelsRollback.mjs`. **All four S7 sub-steps are accepted. That closes the communications storage stage
and nothing more**: the `ledger` and every other remaining blob are still rewritten by every save (§7.3), and the
next stage's findings and decisions are in `sqlite-migration-plan.md` §D. The nested-restore observation of §11.10
about the accepted S7a–S7c repositories is classified in §11.12 as a separately scoped follow-up (no caller-visible
stale value established; not fixed; not a blocker). The preparation §11.1–§11.6 and its two correction rounds §11.7 (review of
`46e5afe`) and §11.8 (review of `8330f08`) are kept as the dated history the implementation followed; the "PREPARED
/ NOT IMPLEMENTED" wording inside them is the status at the time, not the status now. §§0–8.2 are the review as written at `2d7ddeb`, kept as the record of the reasoning; where
the implementation corrected a proposal (§3.2 coupled writes, §8.2 "transaction of its own"), the
correction is marked in place, and the dependency table §8.1 carries the current status of each row. Nothing
here decides a retention period, a deletion policy, the country-code or child-status questions, or
the org-deletion question; those stay with the Founder.

Sections: 0 summary · 1 ownership and data mapping · 2 the dependency graph · 3 transaction and
delivery boundaries · 4 privacy, permissions and deletion · 5 preflight and cutover · 6 backup and
rollback · 7 tests, acceptance and the performance objective · 8 the dependency table and the
bounded recommendation · 9 S7b (design, implementation, corrections, acceptance, the notification
follow-up) · 10 S7c (the plan as corrected by the review of `6ca66ba`, the implementation §10.8, the
follow-up's acceptance §10.9, the two correction rounds §10.10–§10.11 as history, the acceptance §10.12) ·
11 S7d (the current-code survey, the two routes compared, the recommendation and the decisions it needed —
§11.1–§11.6 as prepared; §11.7 the corrections from the review of `46e5afe`; §11.8 the guardian-reference
corrections from the review of `8330f08`; §11.9 S7d as implemented on top of `b67bce5` after the Founder's
decisions D-A and D-B; §11.10 the one correction after the review of `62e9c1a`; **§11.11 the independent
acceptance at `4f954ad`**; §11.12 the S7a–S7c nested-restore observation classified as a separately scoped
follow-up; §11.13 the review of `6956f52` — acceptance record confirmed, three corrections to the next-stage
brief in the plan; §11.14 the review of `e7f7692` — two further corrections to that brief: action-aware
snapshot compatibility and the per-reference audit contract).

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
  approved rule to drop them, decided before the cutover, not by the migration) — **superseded for
  dispatches by §9 (15 October 2026): ordinary deletion creates these rows legitimately, so the
  S7b import counts them and never refuses them**; a channel
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
`dispatch_attempt` belongs to its dispatch (the `dispatch.notification_id` check first written here
is withdrawn by §9: no foreign key, orphans are legitimate), every S7d `channel.request_id`
resolves to a request in the same snapshot, every `message.channel_id` resolves. A failure rolls the whole save back with
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

**Where the phases stand (19 October 2026, S7 complete).** Phases S7a, S7c and S7d are reached: the
notification, outbox/push-log and channel rows of a send are table rows, and the S7d benchmark (§11.9:
`notificationsPersistenceBench.mjs 3000 100`) shows the `channels` blob no longer rewritten per save. The
`ledger` row the send still appends is a blob rewritten by every save (309 491 bytes in that run), and so
are `requests`, `trials`, `recruitmentCases` and every other unconverted collection. **The objective is
therefore not met by S7's completion, and — corrected 19 October 2026 after the review of `6956f52` — it is
not met by moving the `ledger` either.** What a send *mutates* (channels, ledger, notifications, push log) is
not what its save *persists*: `store.mjs:177–183` serialises and UPSERTs every collection that is not a table
on every save, whether or not it changed. The reviewer's design check (`review-6956f52-design-checks.mjs`,
rerun unchanged here) excludes all eight proposed audit collections through the real server-mode skip list,
appends a real channel message and saves: `requests`, `trials` and an unrelated collection are UPDATEd with
identical content. Moving the audit collections (plan §D.4 Candidate A) removes **their** serialisation and
UPSERT work from every save and nothing more. The objective is reached only when every collection a save
persists is a table, or when a separately authorised change to the save path writes only changed blobs — not
proposed in any current step. The earlier sentence here that the objective would be reached "for the send
path only" when the ledger became a table was wrong and is withdrawn.

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
| **S7b** `dispatches` + `dispatch_attempts` | **independently ACCEPTED at `ac50b60` (16 October 2026; §9.9)** | as first written: `notification_id → notifications`; orphan rows need a resolution record before cutover (§5.3); whether dispatches cascade with notifications is a policy question (§4.3 a). **Superseded by §9:** `notification_id` is a plain reference (no FK, no cascade), orphan rows are imported and counted, today's deletion is unchanged; the cascade question stays open as policy (§9.6) and does not block S7b |
| **S7c** `outbox`, `push_log` | **independently ACCEPTED at `9119187` (17 October 2026; §10.12)** | as first written: the two-shape unification (§1.6) — built as the structural `source` discriminator (§10.4); the six plain-text code call sites remain an **owner decision** (cleanse, mask like S6a, or carry as is) — S7c carried the rows as they are |
| **S7c** `push_tokens` storage move | **independently ACCEPTED at `9119187` (§10.12)** | tokens stored losslessly as JSON, the route's rule reproduced, no uniqueness constraint (§10.4) |
| **S7c** push-token audience re-keying (staff pushes) | needs a **product/behaviour decision** — not taken by S7c | which identity a staff push targets; what to do with existing `org`-kind rows; kept out of the storage move (§6.2) |
| **S7d** `channels` + `messages` + `message_attachments` | **independently ACCEPTED at `4f954ad` (18 October 2026; §11.11)** — implemented on top of `b67bce5` (§11.9), corrected once (§11.10); migration `0012_channels`; the §2.3 transitional code-checked request reference approved by the Founder (D-A), today's deletion reproduced inside the deletion unit (D-B, a scope confirmation) | `request_id` → S8's `recruitment_requests` (§2.2) stays a code-checked reference until S8a rebuilds the table with the foreign key (plan §D.3); the ordering column for equal timestamps (§1.2) is `messages.position`; retention OPEN (S4b) |
| S7d `channels.player_id` deletion behaviour | the Founder confirmed the storage-only reading (**D-B**, §11.9); the retention question itself is still a **product-policy answer** for S4b | message retention after deletion (`s4-deletion-decision.md` §4 "review"); the repository deletes explicitly inside the deletion unit, no CASCADE in the DDL |
| the `ledger` rows every send writes | needs **another storage stage** (the S6 audit tables): the `ledger` table with its `players(id)` foreign key needs **S4b and identity-snapshot compatibility** (plan §D.2a — the snapshot's DELETE/reinsert of `players`, the same fact as §11.8's for guardians); without the foreign key it needs the Founder's approval of the checked-reference shape (plan §D.2, Q4). Moving it does not meet the whole-snapshot-write objective (§7.3) | `ledger.player_id RESTRICT` (S6 review §4.1); plan §D.4 Candidate A |
| "no whole-database write on send" | **not met by S7's completion, and not met by moving the S6 `ledger` or the other audit blobs either** (§7.3, corrected 19 October 2026): the save persists every non-table collection regardless of change (`store.mjs:177–183`); met only when every persisted collection is a table (S8–S14) or a separately authorised save-path change writes only changed blobs — not proposed. The earlier wording of this row ("needs S7a + S7c + S7d + the S6 ledger") is withdrawn | §7.3; plan §D.4 "what a send mutates versus what its save persists" |
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

### 8.3 S7a as implemented (`ba6956d`, 14 October 2026; corrected in §8.4–§8.5; **accepted at `0641b2c`, §8.6**)

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
with the coupled state landing in the same transaction. The push and the SSE `notify` event are
effects of that write and go out only once the save that carries it committed — standalone or
inside a unit alike (§8.4, finding 1; the first implementation let them out at once outside a
unit, which the independent review rejected: that interpretation is withdrawn).

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

### 8.4 The first correction round — review of `ba6956d` (four findings), corrected in `7655bae` (14 October 2026; history — the current status is §8.6)

The independent review of `ba6956d` did not accept S7a and supplied a reproduction script
(`review-ba6956d-reproductions.mjs`, run unchanged: exit 1 with three REPRODUCED on the starting
source, exit 0 with three CORRECT after the corrections; kept outside application source in the
handoff package). Failing-first regressions were written before any source change
(`testNotifications.mjs`, four tests; `testNotificationsServer.mjs`, one route-level test) and
their failure on unchanged `ba6956d` is recorded in the handoff logs. No existing assertion was
weakened; one existing immediate-mode test now registers the tool instance's save hook before it
joins a unit, which the correction below requires.

1. **Effects wait for the durable write (HIGH).** As built, `notify()` outside a unit pushed and
   wrote the SSE frame and replay entry at once (through `store.afterCommit`, which runs
   immediately outside a unit, and `broadcast`), while the row was only queued for the next save:
   a failed save delivered news about a row the file never held. The staged coupling is kept and
   completed: the repository has a second FIFO, `afterDurable(fn)`, each entry bound to the writes
   queued before it; the store's `commit()` report runs the effects bound to the flushed writes,
   in order, each through the store's `afterCommit` (counted, logged, never thrown into the save —
   a provider error after COMMIT is a delivery failure, not a rollback, and never replays the
   batch); a failed flush or a failed COMMIT keeps the writes and their effects queued, and the
   successful retry delivers them exactly once; a rolled-back unit discards the effects it
   registered while effects of writes queued before the unit survive and run with the next save or
   unit that commits them. `notify()` registers the push and the `notify` event through
   `afterDurable`, minimises the event payload through the registry at the call site (a bad call
   site still fails inside the unit), calls `persist()` itself and never from an effect, so no
   effect schedules a save; `broadcast()` keeps its registry check and immediate transport for
   every other event, its transport half is now `publishEvent()`. Coalescing still sends no second
   push; quiet hours, audience isolation (`shouldDeliver`) and the public payload are unchanged.
   A development-only save seam, `internal:save.sqlite_commit`, fails the real COMMIT of the next
   ordinary save after every data-layer hook flushed, so the route-level regression proves it on
   the real server (a message posted, the save failing at COMMIT, no row / push / frame, no
   replay-log entry on a reconnect with a real `Last-Event-ID` cursor — the first version of this
   test reconnected without a cursor and so never entered the replay branch; corrected in §8.5 —
   the feed showing the pending row, the next `persistNow()` committing it with exactly one push
   and one frame, a repeat coalescing with a second frame and no second push). This is a
   durability boundary, not exactly-once delivery: a crash between COMMIT and the effect loses the
   push or frame, exactly as before S7a.
2. **Owned immediate transactions restore memory (HIGH).** `create()` and the other operations
   mutate the mirror before their statements run; in a transaction of its own a statement or
   COMMIT failure left the ghost row, index entry, preference record or in-place edit in memory
   (a retry with the same id was refused as a duplicate). The owned branch of `operation()` now
   takes the repository's `snapshotState()` first and restores it in place on any failure —
   rows, the id index, counts, preferences and every read-only row, preference or feed view a
   caller holds. Joined units already restored through the store's rollback; that path is now
   enforced: a repository given the participant API refuses to join a unit (and, in staged mode,
   to write or register an effect at all) until its `saveHook()` was taken for registration — the
   hook is how the rollback reaches the mirror. A caller-owned raw transaction keeps the explicit
   `reload()` contract and is distinguished in the tests.
3. **Unknown data is never lost silently (MEDIUM).** `extra[k] = raw[k]` dropped an own
   `"__proto__"` key of legacy JSON (assignment rewrites the prototype); the audience mapping
   silently dropped any field beyond `kind` and `id`. Every copy of an unknown field — validation,
   insert parameters, read, export, in-place restoration — is an own data property
   (`Object.defineProperty`), so such a key round-trips through the migration, the mirror, a unit
   rollback, a snapshot save and the copy-only rollback blob; the audience, the acknowledgment
   contract and a category map refuse an unknown field, the whole migration or snapshot write,
   before any row is written or any blob retired (blob and `saveSeq` unchanged, the diagnostic
   names the entry and the field, never the text). No new normalisation of a meaningful null or
   absent value was introduced.
4. **The handoff package (MEDIUM).** The first package carried only the Player test files, so
   the Player gate could not run from it. The package builder now archives the complete tracked
   `scoutbox-server/` and `scoutbox-player/` trees (git archive of the committed tree: no runtime
   data, credentials, environment files or `node_modules` are tracked), extracts the final ZIP to
   a fresh directory with no link back into the checkout, installs dependencies there and runs
   both mandatory gates from the copy, recording their exit codes in the package.

### 8.5 The second correction round — review of `7655bae` (two participant-contract defects, one coverage gap), corrected in `0641b2c` (14 October 2026; history — the current status is §8.6)

The second independent review confirmed the four §8.4 corrections (its unchanged first script:
exit 0, three CORRECT; the Player gate ran from the package) and supplied a second script,
`review-7655bae-reproductions.mjs`, run unchanged: exit 1 with three REPRODUCED assertions on
`7655bae`, exit 0 with three CORRECT after this round; the first script stays exit 0. Failing-first
regressions (two tests in `testNotifications.mjs`) were recorded failing on unchanged `7655bae`
before any source change; no existing assertion was weakened.

1. **The default immediate participant ran effects before COMMIT (MEDIUM).** With the factory
   default `runEffect` (a tool's runner), `store.unit` given and the save hook registered, an
   effect registered inside a unit of work ran at once — before the unit's COMMIT, and once even
   when the unit then rolled back. Now an effect registered while a unit is open is queued, in
   either mode and whatever runner the instance was given, and runs only when the registered save
   hook reports the unit's COMMIT; a rolled-back unit discards it (`restoreState`). A standalone
   immediate write still runs its effect at once after its own commit; staged effects still wait
   for the carrying save; a caller-owned raw transaction is still refused. Tested with the real
   default constructor: nothing while the unit is active, nothing after a thrown abort, a caught
   operation failure or a real COMMIT failure, exactly once after the commit and never on a later
   save, a throwing and a rejecting effect reported through `warn` with the data still committed.
2. **A caught precondition refusal bypassed the unit (MEDIUM).** The save-hook registration guard
   ran before `unit.join`, so a caller that caught the refusal could still commit the unit's other
   edits around the notification that never happened. While a unit is open, every precondition —
   the hook taken for registration, the argument shape — is now checked inside `unit.join`, for
   writes and for effects, in both modes: a caught refusal poisons the unit (the store's
   "cannot commit: a nested (joined) unit failed" at its end), the unrelated edit is restored,
   SQLite, the revision and the mirror are unchanged, no transaction stays open; uncaught it fails
   the same way; after `store.setSaveHook(repo.saveHook())` the same unit commits the coupled
   edit and the writes in one revision. The standalone staged refusal and the immediate own
   transaction outside a unit are unchanged. Taking the hook is still the registration the
   repository can see; it does not prove the store registered it.
3. **The replay assertion never entered the replay branch (coverage).** The route-level test's
   "replay" reconnect sent no `Last-Event-ID`, so the server replayed nothing and the zero
   notify frames proved nothing. The helper now takes a real cursor, records each frame's event
   id, and waits for the server's `caught_up`; the test anchors on a committed notify event
   first (positive control: a reconnect from the id before it replays exactly that event), then
   proves that a reconnect from that id replays no entry for the notification whose save failed,
   then that the same reconnect replays exactly the committed notification after the retry. No
   replay runtime defect was found; this is a coverage and reporting correction.

### 8.6 Independent acceptance of S7a — `0641b2c600cd1f082436b4b24dbb052b98ee00d7` (15 October 2026)

**Decision of the independent review:** *accepted for the bounded S7a migration milestone at
`0641b2c`; no remaining blocking finding.* Not production or deployment approval; not acceptance of
later stages. The reviewed package was `scoutbox-s7a-handoff-0641b2c.zip`, SHA-256
`dad5275e1ad4d9d361ea67a4677a41ab1e0330ab68fbeeefd1787c807490b9d4` (archive integrity passed, all
510 manifest entries matched, both packaged reviewer scripts byte-identical to the reviewer's
originals, exactly the six declared files changed from `7655bae`, no Player source changed). The
archive does not independently establish the checkout's Git ancestry or clean status; those are
reported provenance.

**What the review verified** (its own runs, real Node v24.19.0, dependencies installed offline from
the supplied lockfiles with lifecycle scripts disabled, from the extracted package):

- `review-ba6956d-reproductions.mjs` and `review-7655bae-reproductions.mjs`, both unchanged: exit 0,
  three CORRECT each (owned-transaction mirror rollback and retry; server effects waiting for the
  carrying save; own unknown JSON keys preserved; the default joined effect delivered only after a
  successful unit and never after a rollback; a caught registration refusal aborting its unit).
- Backend `npm test`: a first attempt exited 1 at `testWriterAtomicity` server start-up with
  `EADDRINUSE` on a local port — a bind failure before that suite's assertions, retained as an
  unsuccessful attempt, not counted; the complete unchanged-source rerun exited 0, 21 suites,
  304 reported checks/tests. `SCOUTBOX_PRE_S7A_SERVER` pointed at the accepted `2d7ddeb` server
  (the `812e13b` handoff identifies its server source as unchanged from that commit): the rollback
  copy booted, feeds and preferences matched, and the old build accepted new writes.
- Player `npm test -- --runInBand`: exit 0, 4 suites, 41 tests.
- The real older-Node runtime probes were explicitly skipped (`SCOUTBOX_TEST_NODE_BINS` unset);
  browser tests, the demo rebuild and the wider E2E battery were not independently rerun.

**Limits the acceptance carries forward** (current contract, not history): the effects queue is
process memory — a crash between COMMIT and delivery can lose a push or frame, and exactly-once
external delivery is not claimed; a caller-owned raw transaction's rollback still requires the
explicit `reload()`; registering the save hook with the store is the caller's responsibility, and
taking a hook alone cannot prove the store registered it (the repository refuses, inside the joined
boundary, until the hook was taken).

**Boundary the review set for the next stage:** S7b (dispatch records and their attempts). The
existing proposal (SQL03 `dispatches.notification_id … ON DELETE CASCADE`, §5.3 "orphan dispatches
must be resolved before migration") conflicts with the ordinary deletion behaviour of the current
build, which removes a player's notifications and retains their dispatch rows; that inconsistency
is reconciled by the design amendment in §9 before any implementation. The amendment authorises
no retention rule, deletion clean-up, foreign-key behaviour change or storage cutover.

---

## 9. S7b design amendment — `dispatches` and `dispatch_attempts` (prepared 15 October 2026 on `0641b2c`; corrected by the independent review of `dc4b559`; implemented 15 October 2026 on top of `dc4b559`; **independently ACCEPTED at `ac50b60`, §9.9** — the "pending" wording inside §9.7–§9.8 is the dated history of those rounds)

This section is the implementation-ready amendment for S7b, **corrected in place** where the
independent review of `dc4b559` found it wrong (the attempt-shape CHECK, the timestamp contract, the
callback lookup — each correction is marked "corrected" below) and followed by the implementation
record (§9.7). It reads the code as it is at
`0641b2c` (functions named, not historical line numbers), rests on a synthetic probe whose results
are recorded in §9.5 (`scoutbox-server/scripts/probeS7bDispatches.mjs`, outside `npm test` and
outside every runtime path), and **supersedes** the following earlier text where they conflict:
SQL03's `dispatches` DDL (`notification_id … REFERENCES notifications(id) ON DELETE CASCADE`, the
`audience_kind` / `channel` / `provider` / `status` / `fail_reason` CHECKs, the minted
`dispatch_attempts.id`, the `ok NOT NULL DEFAULT 0` on note rows, the partial UNIQUE on
`provider_message_id`), §5.3's "orphan references … resolved before the cutover" for dispatches,
§5.4's "every `dispatch.notification_id` resolves", and §4.3(a)/§8 table row "S7b … orphan rows
need a resolution record before cutover". Everything else in §§1–8 about dispatches stands. The
SQL03 file was rewritten with the implementation (§9.7; `scripts/testSchemaDdl.mjs` compares it with
migration `0010_dispatches` column for column, checks the total attempt CHECK and the absence of a
foreign key on `dispatches`).

### 9.1 The lifecycle today, reproduced, and the storage designs compared

**Reproduced on synthetic fixtures through the real routes** (probe §9.5, section "deletion"):
Maria (Eastport) opens a contact thread with the adult seed player and posts a message; the sweep
creates two dispatch rows per player-audience notification — `in_app` `delivered` (`to` =
`"player:<id>"`) and `email` `skipped` (`skipReason` "no email on record", `to` null). The player
deletes the account (`DELETE /player/account` → `deletePlayerData`, one unit of work). Result: the
2 player-audience notification rows are gone from the table; **all 4 dispatch rows that referenced
them remain**, statuses unchanged (18 dispatch rows before, 18 after); the next sweep processes 0
rows and leaves them byte-identical; `GET /admin/delivery` still lists them. Guardian-audience
notifications about the minor and their rows are untouched. This is the ordinary behaviour of the
current build (`deletePlayerData` never touches `db.dispatches`; §4.2), and every reader of a
dispatch's notification is already null-safe (`notifications.byId(d.notificationId)?.…` in the sweep's
quiet re-check, send and read-mirroring steps; `ackHandler` starts from a notification).

| | (A) behaviour-preserving reference — **recommended** | (B) the SQL03 proposal: `REFERENCES … ON DELETE CASCADE` | (C) `REFERENCES … ON DELETE RESTRICT` |
|---|---|---|---|
| `notification_id` | `TEXT NOT NULL`, the id as stored, **no foreign key**; an ordinary index | enforced parent | enforced parent |
| today's account deletion | unchanged: notification rows go, dispatch rows stay (as the probe shows) | **changes behaviour**: the dispatch rows go with the notification — a retention/deletion decision (§4.3(a), §4.4) the storage move must not take | **blocks** today's deletion: `notifications.deleteForAudience` would fail on a referenced row until dispatches are deleted first — a behaviour change in the other direction |
| import of an existing file | orphan references are **counted** in the cutover record and the dry run, never a refusal | orphan references **refuse** the whole migration until each is deleted, re-parented or rewritten — a data decision per row, before any cutover, for rows the application created legitimately | same refusal |
| copy-only rollback | writes every row back; nothing lost | rows cascaded away since the cutover cannot be written back — the old build would show fewer delivery records than before the upgrade | writes every row back |
| S4b interaction | none (no FK) | a `players(id)` decision later could make the cascade chain inert or surprising | none |
| what it decides | nothing: a technical reference, polymorphic like the notification's audience | a retention rule by schema | a deletion-order rule by schema |

**Recommendation: (A).** It is the smallest design that stores exactly what the application writes
and reads, keeps today's deletion and rollback intact, and leaves the retention question where §4.4
left it. **No approval is needed before implementing (A)** beyond the review of this design: it
encodes no policy. The one product question remains open and is stated for the Founder in §9.6; if
it is ever decided as "delete delivery records with the person", the implementation is an explicit
act inside the deletion unit (`dispatches.deleteForNotifications(ids)` next to
`notifications.deleteForAudience`, the S6a/S7a pattern), never a CASCADE. This preparation chooses
no retention policy, adds no cascade, blocks no deletion and cleanses no row.

### 9.2 Writers, readers and the coupled work (current code; m13/delivery.mjs unless named)

- **`dispatchSweep()`** — the only creator. Step 1 reads `notifications.view` (the S7a mirror),
  `db.deliveryCentreSince` (a notification older than it gets external rows `skipped` "predates
  delivery centre"), `destinationsFor()` (reads `findPlayer`/`isAdult`, `db.guardians`, `db.users`
  with `deliveryPrefs.channels.email`), `quietHoldUntil()` (the notification's `deferredPush`), and
  pushes one row per destination. Step 2, for due `queued`/`retrying`/`held_quiet_hours` rows:
  a `held` row with no attempts yet records the quiet re-check **note** row and a new `nextAt`; then
  `fakeSend()` — which decrements **`db.deliveryFailInject[channel]`** and on success pushes an
  **`db.outbox`** row — a **send** attempt row, then `accepted` + `providerMessageId`, or after
  `MAX_ATTEMPTS` (4) send rows `failed` + `failedAt` + `failReason` + an **`db.opsEvents`**
  `delivery_failed` row + `ctx.emitWebhook('delivery.failed')` (which pushes **`db.webhookDeliveries`**
  rows for the org's active endpoints and calls `persist()`), or `retrying` with `nextAt` from
  `RETRY_MS[sendCount]`. Step 3 mirrors an in-app read to `openedAt`/`opened`. The pass ends with
  **`persistNow()`** when anything changed; it runs at registration (boot) and on the 60 s interval
  (400 ms under `M13_FAST_RETRY`) together with `webhookSweep()`. **Under S7b every dispatch and
  attempt write of a pass must commit in the same transaction as the outbox row, the fail-inject
  decrement, the ops event and the webhook delivery row of that pass** — they are coupled state, not
  effects. The staged write mode of S7a gives exactly that: the repository's queued statements run
  inside the `persistNow()` save that carries those blobs. The sweep is synchronous and the provider
  is in-process; a real asynchronous provider would have to be called outside any transaction and its
  answer recorded inside the next write (§3.3), which the current structure already respects.
- **`notifyAction()`** — writes through `notify()` (S7a); no dispatch write.
- **`ackHandler()`** — `unit(() => { notifications.ack(…); for each dispatch of the notification:
  actionedAt = at; status → 'actioned' only if RANK[status] < RANK.actioned })`. Under S7b the loop
  becomes `dispatches.markActioned(notificationId, at)` joined inside the same unit: the
  notification contract and the dispatch rows commit together or not at all (already proven for the
  blob by `testNotificationsServer.mjs` "acknowledgment"; the probe confirms the terminal `skipped`
  row keeps its status and gains `actionedAt`). As implemented the loop stays in the handler
  (`dispatches.forNotification(id)` then `dispatches.patch(…)` per row, joined inside the same unit);
  the RANK rule stays in m13/delivery.mjs.
- **`POST /callbacks/delivery`** — HMAC and 5-minute window; ≤ 100 events; a `callbackId` already in
  **`db.deliveryCallbacksSeen`** counts as a duplicate (the array is capped at 5 000 by splicing
  1 000); an unknown `providerMessageId` is still remembered as seen and applies nothing (probe:
  seen grew by 4 for 5 posts, one of them a duplicate); `delivered` sets `deliveredAt ??=` and raises
  to `delivered`; `opened` sets `openedAt ??=`, `deliveredAt ??= openedAt` and raises to `opened`;
  `bounced`/`failed` records `failReason` (sliced to 120) and moves to `failed` only from
  `RANK ≤ accepted`; ends with `persistNow()`. Lookup is `find` by `providerMessageId` — the FIRST
  matching row in insertion order. Under S7b (**corrected by the review of `dc4b559`**, implemented
  as such): the lookup is `dispatches.byProviderMessageId(value)` over the in-memory mirror with
  strict equality (`===`) — the first row in insertion order whose stored id equals the value, an
  explicit `null` matching the first row whose id is null, an omitted (`undefined`) id matching
  nothing while the `callbackId` is still remembered, duplicates legal, no string coercion and no SQL
  `= NULL`; the handler keeps its RANK logic and writes through `dispatches.patch`, with
  `deliveryCallbacksSeen` staying a blob in the same `persistNow()` save.
- **Views** — `GET /org/delivery` (rows whose `audience` is an `org_user` of the org, newest first,
  paginated), `GET /admin/delivery` (counts by status, `awaitingAck` from the notifications
  repository, the last 100 rows reversed), `GET /admin/metrics` in m13/enterprise.mjs
  (`dispatchBacklog` = rows `queued`/`retrying`). `POST /admin/delivery/inject-failure` writes the
  blob counter only; `POST /admin/delivery/sweep` runs a pass.
- **Exports, backup, restore** — the enterprise backup spreads `db` and names the table-backed
  collections explicitly (`notifications: notifications.exportRows()` …); S7b adds
  `dispatches: dispatches.exportRows()` (attempts re-nested, insertion order). A restore and the
  persistence tools write the collection through the snapshot dispatcher (`writeTableBacked`), as
  S7a does; the `storeContract.mjs` entry stays because `migrateM13` still names the container
  (the data layer replaces it with the read-only view at attach, the S7a pattern).
- **Deletion** — `deletePlayerData` does not touch dispatches; under (A) unchanged.
- **Start-up** — `registerDelivery` creates `db.deliveryFailInject` and `db.deliveryCentreSince` if
  absent (both stay blobs), then runs the first sweep; the repository attaches before m13 registers,
  so the boot sweep writes through it.
- **Observed, not changed by S7b (pre-existing behaviour to label, not to fix here):** (i) a
  `queued`/`retrying` external row whose notification was deleted would be sent with an empty text
  (`n?.text ?? ''`) — not observed in the probe (the deleted adult had no address), visible by
  reading the send step; (ii) the sweep stores a provider error in `failReason` untruncated while
  the callback path slices to 120; (iii) a notification with the `system` audience (the moderation
  report path) gets an `in_app` dispatch whose `audience.kind` is `system`.

### 9.3 The accepted shape and the exact mapping

The dispatch literal has had **one shape since M13** (`git log -S` on the literal: created in
`e865531`, unchanged since): always all 18 keys, with `null` — never absent — for `to`,
`skipReason`, `providerMessageId`, `actionDeadline`, `deliveredAt`, `openedAt`, `actionedAt`,
`failedAt`, `failReason` when unset (probe: one key set over 18 rows). Attempt rows have **two
shapes**, also unchanged: a **send** row `{at, ok, error}` (`error` null when `ok`) and a **quiet
re-check note** row `{at, note}` (no `ok`, no `error`; at most one, always before the first send row
when present — probe: `[note, send:fail, send:fail, send:ok]`). The retry counter is the number of
send rows (`attempts.filter(a => !a.note)`), so note rows must never count.

| Blob field | Column | Type / rule | Notes |
|---|---|---|---|
| (array position) | `seq INTEGER PRIMARY KEY` | assigned at insert, kept by backup/restore/rollback | insertion order is what `recent`, the org view and the callback `find` depend on; `createdAt` is not an ordering key (same millisecond rows) |
| `id` | `id TEXT NOT NULL UNIQUE` | `dsp-*` (the prefix is shared with m16 disputes; ids are globally unique via the counter) | |
| `notificationId` | `notification_id TEXT NOT NULL` | **no FK** (§9.1); index | orphans kept and counted |
| `audience.kind`, `audience.id` | `audience_kind`, `audience_id TEXT NOT NULL` | **no CHECK** (a `system` audience exists, §9.2) | an audience with any other field refuses the entry (S7a rule) |
| `channel`, `provider` | `TEXT NOT NULL` | **no CHECK**: non-empty strings; vocabulary (`in_app`/`email`, `in_app`/`local-fake`) lives in code | |
| `to` | `to_address TEXT` | nullable; personal data (an e-mail address, or `"kind:id"`) | never in a diagnostic |
| `status` | `status TEXT NOT NULL` | **no CHECK**: the nine values are code vocabulary; a stored value outside `RANK` is inert today and must stay so | |
| `skipReason`, `providerMessageId`, `failReason` | `TEXT` nullable | **no length CHECK** on `fail_reason` (the sweep does not truncate) | `providerMessageId`: ordinary index, **no UNIQUE** (random, not guaranteed by code) |
| `nextAt`, `createdAt` | `INTEGER NOT NULL` | written by the server itself (`Date.now()` or a sum of it): integers; a fraction is refused by the repository and by STRICT | |
| `actionDeadline`, `actionedAt`, `failedAt` | `INTEGER` nullable | server-written clocks (the ack's and the sweep's `Date.now()`, the notification's deadline) | `actionDeadline` is a copy of the notification's deadline at creation (probe) |
| `deliveredAt`, `openedAt` | `REAL` nullable (**corrected by the review of `dc4b559`, finding 2**: the first draft said `INTEGER`) | written by the provider callback route as `Number(ev.at) \|\| Date.now()`: a finite JavaScript number that MAY be fractional (1700000000000.5 is a value the `0641b2c` build stores and its JSON blob preserves). The repository accepts a finite number (integer-valued or not) or `null`, refuses anything else, and stores it as the writer's double — node:sqlite binds every JavaScript number as a double, so a REAL column states exactly what is stored; an INTEGER column would refuse the fraction and an `ANY` column would store a whole number as REAL anyway. A non-finite callback `at` (`Infinity` from a string) is the one legacy in-memory state: the previous build held it in memory, where its nullish rule treated the clock as set for every later event in the process, and its JSON save wrote `null` — the repository keeps the number in the mirror, stores NULL, exports null, and a restart reads null, exactly so (**corrected by the review of `26d492b`, finding 3**, §9.8: the first implementation nulled it at write time and let a later event replace it); the callback API is unchanged. Proven through the real route, migration, export, restart, backup and rollback (`testDispatchesServer.mjs` test 3; `testDispatches.mjs`) | `??=` semantics kept: an existing clock is never replaced |
| unknown top-level field | `extra_json` (object CHECK) | own-property copy, round-trips (S7a finding 3) | |
| `attempts[i]` | `dispatch_attempts (dispatch_seq INTEGER NOT NULL REFERENCES dispatches(seq) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, attempted_at INTEGER NOT NULL, ok INTEGER, error TEXT, note TEXT, PRIMARY KEY (dispatch_seq, seq))` | `seq` = array index; `kind` = `'quiet_recheck'` iff the row has `note`, else `'send'`; **no minted id** (the SQL03 `dat-<n>` would consume the global counter); `ok` **nullable**: NULL on a note row, 0/1 on a send row; **total CHECK (corrected by the review of `dc4b559`, finding 1** — SQLite treats a NULL CHECK result as a pass, so the first draft's `ok IN (0,1)` admitted a send row with `ok` NULL): `CHECK ((kind='send' AND ok IS NOT NULL AND ok IN (0,1) AND note IS NULL) OR (kind='quiet_recheck' AND ok IS NULL AND error IS NULL AND note IS NOT NULL))`, proven through direct SQL on the real DDL (`testDispatches.mjs` "the actual schema") | written back as `{at, note}` or `{at, ok, error}` exactly (probe: 8 attempt rows round-trip byte-for-byte); a note row is never counted as a send; no attempt id is minted and no global counter is consumed |

The child FK on `dispatch_seq` is internal to the pair of tables (an attempt is a part of its
dispatch, never shared) and is the only foreign key S7b adds. **Constraints the proposal had that
current code does not guarantee — therefore not added:** UNIQUE `provider_message_id`; one row per
`(notification_id, channel)` (a restored snapshot may hold duplicates; current code tolerates them);
the four CHECK lists; `fail_reason ≤ 120`; `ok NOT NULL`. **Refusals (whole write, text-free, entry
index + field):** a non-object entry, a missing/empty `id`, a duplicate `id`, a non-string
`notificationId`, a malformed audience, a non-string `channel`/`provider`/`status`, a non-integer
`nextAt`/`createdAt`, a non-integer non-null `actionDeadline`/`actionedAt`/`failedAt`, a non-finite or
non-numeric non-null `deliveredAt`/`openedAt` (corrected: a finite fraction is accepted, see the table),
a non-string non-null `to`/`skipReason`/
`providerMessageId`/`failReason`, `attempts` not an array, an attempt row that is not an object,
has neither or both of `note`/`ok`, a non-integer `at`, a non-boolean `ok`, a non-string non-null
`error`/`note`, or **any unknown key on an attempt row** (attempt rows have no `extra_json`; the
only writer is the sweep). Nothing is coerced; no absent-to-null normalisation exists because the
literal never writes an absent key — an entry missing one of the 18 keys is refused as a shape this
build never wrote. Minor routing (`guardian_routed` skip), historical suppression (`predates
delivery centre`) and the `accepted` / `delivered` / `opened` distinctions are values stored as given.

### 9.4 Migration, authority, snapshot outcomes, rollback

- **Identifier:** the next unused is **`0010`** → `0010_dispatches`. The plan's `0010_recruitment`
  (S8a) is a placeholder and moves to the next free number when S8a is approved, as `0008_safety_audit`
  did (plan §Migration numbering). **Registered and implemented** (§9.7).
- **Atomic import** (one transaction, the 0009 pattern): create the two tables and indexes; read the
  `dispatches` blob; **absent** blob → import nothing, record the cutover; **empty** array → same;
  **non-array / non-JSON** → refuse; validate every entry (§9.3) collecting problems, refuse the
  whole step on the first list (`DISPATCHES_IMPORT_BLOCKED`, codes/ids/counts only); insert rows in
  array order (`seq`) and attempts by index; write `meta.dispatchesCutover` = counts
  (`imported`, `attempts`, per-status counts, `orphanReferences` — rows whose `notification_id` is
  absent from `notifications` at import time, information only); delete the blob row. A refusal
  leaves the blob, the file and `saveSeq` untouched and the previous build still boots it.
- **Authority:** `0010_dispatches` in `data_migrations` — never the tables' existence or row counts.
  A stale in-memory `db.dispatches` array at attach (the seed's container, `migrateM13`'s `??= []`,
  a restored pre-S7b backup's blob just imported) is dropped and its blob row deleted; a non-empty
  array not just imported is reported as a count (the S7a rule).
- **Snapshot writes** (restore, tools, the persistence suites): the dispatcher validates entries,
  rewrites both tables in array order inside the caller's transaction, and refuses the whole write on
  the first problem; **final-state validation** checks only what the schema enforces — every attempt
  belongs to its dispatch (trivially, nested) — and does **not** require `notification_id` to resolve
  (§9.1 (A)). A backup from any build restores through 0010 with orders intact.
- **Copy-only rollback to the accepted `0641b2c` build:** `repositories/dispatchesRollback.mjs` +
  `scripts/dispatchesRollback.mjs` (`npm run rollback:dispatches -- <data-dir> <fresh-empty-dir>`):
  open read-only, `VACUUM INTO` a copy, write every dispatch back into the `dispatches` blob in `seq`
  order with `attempts` re-nested in `seq` order (note rows as `{at, note}`, send rows as
  `{at, ok, error}`, extras spread back), drop the two tables, remove the `0010` record and its meta
  key, advance `saveSeq`, foreign-key check, VACUUM, revalidate; **every post-cutover dispatch,
  attempt and unrelated record is retained**. Refusals, no output: `LATER_SCHEMA` (any
  `data_migrations` id the tool does not know — the S7a tool refuses a real `0010_dispatches` file this
  way (`testDispatches.mjs`), the S7b tool a `0011_future_step` one), `NOT_CUT_OVER`, `OUTPUT_NOT_EMPTY`,
  `UNEXPECTED_SCHEMA`. **Old-build proof:** `SCOUTBOX_PRE_S7B_SERVER` pointing at an `0641b2c`
  checkout boots the copy (its log carries no `0010_dispatches`), `GET /admin/delivery` and the org
  view return the same rows, statuses and attempt arrays, and its sweep keeps writing to the blob;
  the S7a tool then rolls the copy further back to `812e13b` if needed.

### 9.5 Synthetic compatibility probe — results (`scripts/probeS7bDispatches.mjs`, 15 October 2026, Node v22.22.2; the JSON is in the handoff package)

| Observation | Result on `0641b2c` | Classification |
|---|---|---|
| Ordinary deletion | 2 player-audience notifications removed, their 4 dispatch rows (2 `in_app` `delivered` with `to` `"player:<id>"`, 2 `email` `skipped`) retained unchanged; next sweep processes 0 and alters nothing; `/admin/delivery` lists them; guardian rows untouched | current behaviour, **preserved by (A)**; the retention question is policy (§9.6) |
| Retry and note ordering | a deferred-push guardian notice: `held_quiet_hours` → attempts `[note, send:fail, send:fail, send:ok]`, status `accepted`; 3 send attempts counted for 4 rows | current behaviour, mapped exactly (`kind`, `seq`) |
| Exhausted retries | 4 send rows → `failed`, `failedAt` set, `failReason` 25 chars untruncated, one `opsEvents` `delivery_failed`, 0 webhook rows (no endpoint) | current behaviour; the untruncated `failReason` is a pre-existing inconsistency, stored as is |
| Callbacks | `opened` first → `deliveredAt = openedAt`; duplicate `callbackId` → `duplicates: 1`, nothing applied; late `bounced` → `failReason` recorded, status stays `opened`, `failedAt` null; later `delivered` → no regression; unknown provider id → applied 0 but remembered as seen (seen +4 for 5 posts) | current behaviour, preserved (RANK semantics, `??=` timestamps, seen-before-lookup) |
| Acknowledgment coupling | before `[in_app delivered, email skipped]` → after `[in_app actioned, email skipped]`, both `actionedAt` = the notification's `ackedAt`; `actionDeadline` equals the notification's deadline | current behaviour; S7b joins `markActioned` in the same unit |
| Mapping round trip | 18 dispatch rows, 8 attempt rows: blob → proposed rows → blob **byte-identical**; one dispatch key set; attempt key sets `{at,note}` and `{at,ok,error}`; no unknown keys | the §9.3 mapping is lossless on observed data |
| Proposed constraints vs observed data | FK NOT NULL to notifications: **4 orphan rows → unsatisfiable** on this ordinary file; UNIQUE `provider_message_id`: satisfied here, not guaranteed by code; one row per (notification, channel): satisfied here, not guaranteed; `audience_kind` CHECK: satisfied here, refused for the `system` audience path; status/fail_reason/attempt-shape CHECKs: satisfied here | the FK and the CHECKs are dropped by this amendment; the shape rule on attempt rows is kept |

### 9.6 Implementation checklist, files, tests, acceptance (as planned; what was built is §9.7)

**Files (expected; the names as built are in §9.7):** new `repositories/dispatches.mjs` (the three concerns of S7a's repository:
validators, table access `DISPATCHES_TABLE` for the snapshot dispatcher, the staged/immediate
repository with mirror, views `db.dispatches`, methods `createForNotification`, `recordAttempt`,
`transition`, `markActioned(notificationId, at)`, `applyCallback`, `byProviderMessageId`, `due(now)`,
`forAudiences`, `countsByStatus`, `recent(n)`, `backlogCount`, `exportRows`, `saveHook`,
`afterDurable` is **not** needed — the sweep's external effects today are blob rows, not deliveries);
new `repositories/migrations/0010_dispatches.mjs` (REGISTERED at implementation);
new `repositories/dispatchesRollback.mjs` + `scripts/dispatchesRollback.mjs`; `repositories/index.mjs`
(`DATA_MIGRATIONS`, `TABLE_BACKED`, snapshot dispatch, attach, `runEffect`, report domain);
`m13/delivery.mjs` (sweep, ack, callbacks, views through the repository; `RANK` semantics
unchanged); `m13/enterprise.mjs` (explicit backup export, metrics backlog); `storeContract.mjs`
(reason); `sql/03` (rewritten per §9.3) and `scripts/testSchemaDdl.mjs`; `package.json` (`npm test`
chain, `rollback:dispatches`); docs (`sqlite-schema.md`, `sqlite-migration-plan.md`, `OPERATIONS.md`
operator section + cutover procedure, `CLAUDE.md`); older suites' expected lists for `0010` and
rollback chains starting with the S7b tool (as S7a did for `0009`).

**Failing-first tests** (written and recorded failing on unchanged `0641b2c` before any source change):
`scripts/testDispatches.mjs` — migration shapes and refusals (the 18-key literal, both attempt shapes,
an own `"__proto__"` key round-trip, an unknown attempt key refused, orphan references imported and
counted, absent/empty/non-array blob outcomes, `saveSeq` and blob unchanged on refusal); repository
operations in immediate and staged mode (owned-transaction failure restores memory, joined unit
caught failure poisons the unit, hook registration inside the join, real COMMIT failure, retry);
snapshot replace/final-state; copy-only rollback (every row back, `LATER_SCHEMA` for a `0011_*`
id, the S7a tool's `LATER_SCHEMA` on a 0010 file, exit codes, injected COMMIT failure leaves no
output). `scripts/testDispatchesServer.mjs` — through the real routes: a sweep pass commits its
dispatch rows, attempts, outbox row, fail-inject decrement and ops event in ONE revision (second
connection); the retry ladder with the note row and the counter (fixture: probe §9.5 "retry");
callbacks ordering, duplicates, unknown ids (fixture: probe "callbacks"); the acknowledgment unit
under `internal:unit.sqlite_commit` (both unchanged, retry lands both, SIGKILL keeps both — the
existing S7a test extended to the table); **ordinary deletion leaving the orphans exactly as today**
(fixture: probe "deletion"); a SIGKILL mid-retry and the restart resuming the schedule; backup →
restore → rollback → re-upgrade with orders intact; the `0641b2c` build booting the rollback copy.
Both reviewer scripts (`review-ba6956d`, `review-7655bae`) stay unchanged and green; `m13E2E`
unchanged and green.

**Acceptance criteria:** every behaviour in §9.5 reproduced on the table-backed build with the same
observable results; no CASCADE, no FK to `notifications`, no new CHECK on vocabulary; orphans
imported and counted, never refused or rewritten; attempts round-trip byte-for-byte; the sweep's
coupled blob writes in the same transaction as its rows; the ack unit atomic; copy-only rollback
proven on the actual `0641b2c` build; both mandatory gates green on the final tree and from a fresh
extraction; no diagnostic carries a text, an address or a token.

**For the Founder — one open product question, not blocking (A):** today a deleted person's
delivery records stay (the `in_app` rows carry `"player:<id>"`, the e-mail rows the address of a
guardian or staff member, the outbox rows the mail text). Keeping them means the delivery audit
survives the person; deleting them with the notification means the audit loses the record that a
message was delivered. Consequence of deciding "delete": a new explicit act in the deletion unit
(dispatches, and separately the S7c outbox rows), a behaviour change with its own tests — not a
schema cascade. **Recommendation:** keep today's behaviour for S7b and decide the question together
with the §4.4 retention items (S4b), where the outbox and push log raise the same question.
The design was reviewed (review of `dc4b559`: "sufficient to proceed … with the corrections") and
implemented as §9.7 records; the question stays open and is unchanged by the implementation.

### 9.7 S7b as implemented (15 October 2026, one local commit on `feat/sqlite-schema` on top of `dc4b559`; written while pending independent acceptance — **since accepted at `ac50b60`, §9.9**)

**Authorisation and boundary.** The independent review of `dc4b559` found the preparation
"sufficient to proceed to a bounded S7b implementation with the corrections" and the next-step
instruction authorised local implementation, synthetic tests and a local commit only — no push, no
deployment, no retention-policy change, no S7c/S7d, S4b, S6 audit tables or S8, no staff-push
re-keying, no real external delivery. This section records what was built against that instruction;
acceptance is the reviewer's, not this record's. The commit hash is in the handoff note that carries
this tree (it cannot be written into a file that is part of the commit).

**The three corrections, honoured as instructed.**

1. *Attempt-shape CHECK (finding 1).* `dispatch_attempts` carries the total predicate
   `(kind='send' AND ok IS NOT NULL AND ok IN (0,1) AND note IS NULL) OR (kind='quiet_recheck' AND
   ok IS NULL AND error IS NULL AND note IS NOT NULL)`, proven through direct SQL on the real DDL
   (`scripts/testDispatches.mjs` "the actual schema": a send row with `ok` NULL, a send row with a
   note, a note row with `ok` or `error`, a note row without its note and an unknown kind are each
   refused; both send outcomes and a note are accepted; the key is `(dispatch_seq, seq)` with no
   minted id). A note row is never counted as a send (the sweep's `sends` counter and the real-route
   ladder test: `[note, send:fail, send:fail, send:ok]` → `accepted`; four send rows → `failed`).
2. *Timestamp contract (finding 2).* Each timestamp's writer was inspected: `createdAt`, `nextAt`,
   `actionDeadline`, `actionedAt`, `failedAt` and an attempt's `at` are the server's own
   `Date.now()` (or a sum of it, or the notification's deadline) — integers, INTEGER columns, a
   fraction refused by the repository and by STRICT. `deliveredAt` and `openedAt` are written only by
   `POST /callbacks/delivery` as `Number(ev.at) || Date.now()`: a finite number, fractional or not.
   The repository accepts exactly that shape (a finite JavaScript number or `null`; `NaN`,
   `±Infinity`, a string, an object are refused by name) and the two columns are **REAL**: a
   JavaScript number is a 64-bit double and so is the column, so 1700000000000.5 is stored and read
   back exactly, as is an integer-valued clock (node:sqlite binds every JavaScript number as a double;
   an `ANY` column would store a whole number as REAL anyway, so REAL states what is stored). The
   non-finite case is distinguished from the finite fraction: the route keeps `Number(ev.at) ||
   Date.now()` and writes `null` when that is not finite — what the previous build's JSON save
   persisted for `Infinity`. No value is rounded, no API changed. Proven through the real route
   (`testDispatchesServer.mjs` test 3: fractional exact and `typeof` REAL on a second connection, the
   admin view showing the same value; `null` and `0` fall back to the server clock; an existing clock
   is kept; `"Infinity"` → `null` while the status still rises), through the migration import, the
   export, a restart, the backup/restore and the rollback blob (`testDispatches.mjs`,
   `testDispatchesServer.mjs` test 8).
3. *Callback lookup (finding 3 and the compatibility edge).* `dispatches.byProviderMessageId(v)` is
   `Array.find` over the mirror with `===`: the first row in insertion order whose stored id equals
   the value; an explicit `null` matches the first null row; `undefined` matches nothing (the
   `callbackId` is still remembered first, as before); duplicates are legal (no UNIQUE, an ordinary
   index); no string coercion, no SQL `= NULL`. The dedup-before-lookup order, the unknown-provider
   bookkeeping, the late bounce, the unknown status (`applied` counted, nothing changed) and the RANK
   semantics are unchanged and proven through the real route.

**What was built (files).** `repositories/dispatches.mjs` (validators for the eighteen-key literal and
the two attempt shapes; `DISPATCHES_TABLE` for the snapshot dispatcher; `importDispatchesBlob`; the
staged/immediate repository with the mirror behind `db.dispatches`, methods `create(row)`,
`recordAttempt(id, attempt)`, `patch(id, fields)` — the eight fields the sweep and the callback
route change, each validated per column — reads `byId`, `list`, `forNotification`,
`notificationIdsWithRows`, `byProviderMessageId`, `countsByStatus`, `backlogCount`, `exportRows`,
and the S7a save-hook contract `flush/commit/rollback/snapshotState/restoreState`; **no effects
queue** — the next-step instruction forbade an after-durable queue for persisted blob state, and a
dispatch has no push or live event); `repositories/migrations/0010_dispatches.mjs` (registered;
requires `0009_notifications`; refuses pre-existing tables; atomic import with the cutover record
`meta.dispatchesCutover` = `{ imported, attempts, withExtraFields, orphanReferences, byStatus }`,
text-free); `repositories/index.mjs` (`DATA_MIGRATIONS`, `TABLE_BACKED`, the snapshot dispatch after
the notification tables, the staged attach with the save hook, the stale-array rule, the report
domain); `repositories/dispatchesRollback.mjs` + `scripts/dispatchesRollback.mjs`
(`npm run rollback:dispatches`); `m13/delivery.mjs` (sweep, acknowledgment, callbacks and the admin
counts through the repository; RANK, retry schedule, destination rules and the callback contract
unchanged); `m13/enterprise.mjs` (`dispatches: dispatches.exportRows()` in the backup;
`dispatchBacklog` from the repository, same definition); `server.mjs` (the repository in the m13
context); `storeContract.mjs`; `m13/shared.mjs` (comment); `sql/03` rewritten for both tables and its
scope header; `scripts/testSchemaDdl.mjs` (column-for-column comparison, the total CHECK, the absence
of a foreign key on `dispatches`); `scripts/probeS7bDispatches.mjs` (one explicit, labelled change:
its storage reader reads the tables after the cutover and the blob before it); `package.json`
(`npm test` chain of 23 suites; `rollback:dispatches`); the older suites' expected migration lists and
rollback chains (the S7b tool first, then S7a, S6a, S5, S4a); `testNotifications.mjs` keeps its files
at the S7a level and gives the delivery context a dispatches repository; `testNotificationsServer.mjs`
reads the dispatch rows from the table after the cutover and runs the S7b tool before the S7a tool in
its old-build proof. Documents: this section, the plan, the schema document, `OPERATIONS.md`
(operator section and cutover procedure), `CLAUDE.md`, `README.md`.

**Deliberate readings, recorded.** (i) REAL columns for the two callback clocks (above). (ii) The
export convention of S7a is kept: unknown own fields come first, then the eighteen keys in the
literal's order; a legacy row with an unknown field elsewhere exports byte-identical up to that
reordering (the tests state the convention explicitly). (iii) A sweep pass whose `persistNow()` save
fails at COMMIT leaves memory as the intended state and its rows, attempts and status changes queued;
the failure schedules no save of its own and a pass that changes nothing requests none, so the retry
lands with the next save that does change something (the store's contract since S3, unchanged for
every blob collection; proven in `testDispatchesServer.mjs` test 1 with a real COMMIT failure and a
second connection). (iv) *Superseded by §9.8 (finding 3):* the first implementation stored a non-finite callback clock
as `null` at write time, which let a later event in the same process replace it — a precedence change
the independent review reproduced; the corrected build keeps the previous build's in-memory state. (v) `fail_reason` is stored untruncated; the callback route's
own 120-character truncation of its input is unchanged. (vi) The orphan count in the cutover record is
information only; nothing acts on it.

**Failing-first.** Both new suites were written first and run on the unchanged `dc4b559` tree (logs
in the handoff package, `logs/failing-first-*`): `testDispatches.mjs` fails at import (the module does
not exist — scaffolding evidence only); `testDispatchesServer.mjs` run one test at a time fails tests
1, 2, 3 and 8 on concrete bad-state assertions (no `0010_dispatches` record, `no such table:
dispatch_attempts`, no typed column to read the fractional clock from, no explicit backup export and
no rollback tool) and **passes tests 4, 5, 6 and 7 as differential proofs of unchanged behaviour**
(the acknowledgment unit under a real COMMIT failure, the orphans after an ordinary deletion, the
coupled webhook row with a configured synthetic endpoint, the SIGKILL mid-retry) — the same tests pass
on the S7b tree reading the tables. Two test defects were found and corrected in that step (the admin
view lists newest first; the boot sweep may append an attempt before a read after a restart).

**Verification on the final tree (Node v22.22.2; every command and exit code is in the handoff
package's logs and `REVIEW-START-HERE.md`).** `testDispatches.mjs` 8 checks; `testDispatchesServer.mjs`
8 checks, run twice — without `SCOUTBOX_PRE_S7B_SERVER` (the old-build boot reported SKIPPED) and with
it pointing at a detached `0641b2c` worktree (the pre-S7b build booted the rollback copy, listed the
same rows, statuses and attempt arrays, and kept writing); `testNotificationsServer.mjs` with
`SCOUTBOX_PRE_S7A_SERVER` (the S7b tool, then the S7a tool, then the `812e13b` boot); the design probe
of the review run unchanged on `dc4b559` (exit 0, baseline evidence) and on this tree (its SQL
sections reproduce and verify; its third section cannot run because it builds the dc4b559 handler
context without the dispatches repository — reported, not relabelled; a separately labelled
adaptation in the package's evidence directory feeds the real repository and reads the real table:
exit 0); both S7a reviewer scripts unchanged (exit 0, 3 CORRECT each); `probeS7bDispatches.mjs` on this
tree with its table-reading adapter (the same observations as §9.5); `m13E2E.mjs` 212 checks; the
backend gate (`npm test`, 23 suites) and the Player gate (`npm test -- --runInBand`) on the final tree
and again from the fresh extraction of the handoff ZIP. Skipped honestly: the real older-Node checks
(`SCOUTBOX_TEST_NODE_BINS` unset); the old-build boots inside the fresh extraction (the old builds are
outside the package; they ran in the checkout).

**Limits.** No real data, no deployment, no retention decision. The `0641b2c` boot proof used the
synthetic seed on temporary directories. A crash between a sweep's COMMIT and nothing else loses
nothing (the sweep has no external effect); a provider that were asynchronous would need the §3.3
structure, which this code does not yet have. The Founder's question in §9.6 stays open.

### 9.8 Correction round — independent review of `26d492b` (15 October 2026; three findings, each reproduced by the reviewer's script and corrected; history — **the corrected commit `ac50b60` was accepted, §9.9**)

The review of `26d492b` kept S7b IMPLEMENTED, PENDING INDEPENDENT ACCEPTANCE and reproduced three
findings with `review-26d492b-reproductions.mjs` (four checks; the first two are one finding). The
script, run unchanged on `26d492b`, reproduced all four; run unchanged on the corrected tree it
reports none (the handoff carries both outputs). Failing-first regressions were added to the two S7b
suites and recorded failing on `26d492b` before any source change (`testDispatches.mjs` "review of
26d492b, finding 1/2/3"; `testDispatchesServer.mjs` "review of 26d492b, finding 3 (real route)").

1. **Every patch refusal is a participant failure** (`repositories/dispatches.mjs` `patch`). The first
   implementation validated the patch object and looked the row up before entering the participant
   boundary, so a caught `patch(id, null)` or `patch(missingId, …)` never reached `unit.join` and the
   enclosing unit could commit its earlier work. Now only a VALID empty patch on an existing row is a
   no-op outside the boundary; every other refusal — not an object, a missing row, an unknown field,
   an invalid value — is raised inside `operation()`, so inside a unit of work it poisons the unit
   even when caught. `create` and `recordAttempt` already raised every refusal inside the boundary
   (audited, unchanged). Proven for the staged repository and for an immediate one participating in
   the same store unit, caught and uncaught, with a hook-less repository, a write pending before the
   refused unit (it stays pending and lands with the retry), held views and a second connection.
2. **Unknown nested data is detached** (`cloneJson`, `cloneExtras`, `copyRow`, `exportRow`,
   `restoreInto`). The first implementation copied unknown top-level fields by reference and cloned
   only the known `audience` and `attempts` on export and in transaction snapshots, so a caller
   mutating its input after `create`, or a returned export, changed the mirror without a repository
   write, and a nested edit through an export inside an aborted unit survived the rollback. Now every
   unknown field is a prototype-safe JSON clone at ingress (create, import, snapshot replace), on
   export and in every transaction snapshot (own `"__proto__"`, `"constructor"` and `"toString"`
   keys kept at every depth, arrays, nulls and booleans included); a value JSON cannot carry
   (undefined, a function, a symbol, a bigint, a non-finite number, a class instance) refuses the
   whole write by name instead of being dropped or nulled silently by `JSON.stringify`. The read-only
   views refuse nested writes. Attempt order and the export convention are unchanged.
   *Observed, not changed (outside this bounded round):* the accepted S7a notifications repository
   copies its unknown fields the same shallow way; it is reported here for the reviewer, not
   refactored.
3. **The legacy non-finite callback clock keeps its precedence** (`m13/delivery.mjs` callback
   route; `patch`, `storedClock`, `exportRow`). The first implementation mapped a non-finite
   `Number(ev.at) || Date.now()` to `null` before writing, so a later event — in the same batch or a
   later request of the same process — could set the clock, where the previous build's in-memory
   `Infinity` had blocked it (its JSON save wrote `null`; a restart therefore read null). Now the
   route writes the number as it is; `patch` accepts any number for `deliveredAt` / `openedAt`; the
   mirror keeps it (the nullish rule sees the clock as set; a view or an HTTP response serialises it
   as null, as before); the column stores NULL; the export and the backup shape carry null; a
   transaction snapshot keeps the in-memory number (a rolled-back unit restores it); a restart reads
   null. Nothing else is kept, nothing leaks into a stored shape, nothing survives a restart. Create
   and the import still refuse a non-finite value (JSON never carries one); finite clocks, the
   `0`/`null` fallback and the existing-clock rule are unchanged. Proven through the real route
   (one batch, a later request, an opened sequence, the admin view and the backup export, a
   restart, an existing finite clock, a failed save followed by a retry) and at the repository.

Everything §9.7 lists as accepted work is kept: the total attempt CHECK, exact finite fractional
clocks, the first-match lookup, no minted attempt ids, open vocabularies, partial-snapshot
semantics, no shadow blob, the coupled saves, the acknowledgment unit, the read-only views, the
copy-only rollback to `0641b2c`, option A without cascade or cleanup, and the documented
pending-save retry limitation (not redesigned). Verification of the corrected tree is in the handoff
note and its logs.

### 9.9 Independent acceptance of S7b — `ac50b60257b89387aa1dec44bad7f571e61aa74e` (16 October 2026)

The independent review of the correction handoff `scoutbox-s7b-fix1-handoff-ac50b60.zip` (SHA-256
`413fa69f067adbff7014ff70549db1cfd872dd5f27f4dd4e59626b954087c5f9`, 477 manifest entries verified)
**accepts S7b at `ac50b60` for the bounded dispatch/attempt storage milestone and its three
corrections**, subject to its validation and limits. What the reviewer verified on real Node v24.19.0
(offline `npm ci --ignore-scripts` in both projects): backend `npm test` exit 0, 23 suites / 324
checks (after local-network permission; the accepted `2d7ddeb` pre-S7a and `0641b2c` pre-S7b servers
booted the rollback copies with equivalent reads and accepted writes); Player `npm test -- --runInBand`
exit 0, 4 suites / 41 tests; `review-26d492b-reproductions.mjs` unchanged exit 0 (4 CORRECT, the callback
comparison against the unmodified `dc4b559` handler); `review-ba6956d-reproductions.mjs` and
`review-7655bae-reproductions.mjs` unchanged exit 0 (3 CORRECT each); the packaged reviewer scripts
byte-identical to the originals. **Limits stated by the review:** not deployment approval and not
acceptance of the whole migration; real older-Node checks skipped (`SCOUTBOX_TEST_NODE_BINS` unset);
browser suites, the demo rebuild, the wider E2E battery, the standalone compatibility probe and
`m13E2E` not independently rerun (the sender's runs are evidence, not independent executions); the
staged-save retry limitation (§9.7 reading iii) and the in-memory notification external-effect crash
window (§8.6) remain documented. S7b retains orphan dispatches without a notification cascade; the
acceptance decides no retention policy. §9.7 is what was built, §9.8 the correction round, both dated
history; this section is the current status.

**Separately confirmed by the same review:** the notification-extras isolation defect §9.8 reported
for the reviewer (the accepted S7a repository's shallow copies of unknown nested fields). The
reviewer's `review-ac50b60-notification-isolation.mjs` reproduces it on `ac50b60` (an export mutation
changes the mirror; an export mutation inside an aborted unit survives the rollback; the stored
`extra_json` keeps `['original']`). It is an existing S7a defect, not a regression of the corrected
dispatch repository; its correction is §9.10.

### 9.10 Notification-extras follow-up — corrected (16 October 2026, commit `6ca66ba`; **independently ACCEPTED at `6ca66ba` for its bounded scope — §10.9**)

`repositories/notifications.mjs` now detaches unknown nested data exactly as the dispatch repository
does, with a local `cloneJson` (no cross-project helper): a prototype-safe JSON clone at ingress
(`validateNotificationRow`, so the legacy import and the snapshot replace never share the caller's
objects), at storage (`rowParams`), on export and in every transaction snapshot (`copyRow`), and on
restore (`restoreInto`, which assigns a fresh clone of the snapshot's copy). Own `"__proto__"`,
`"constructor"` and `"toString"` keys survive at every depth with arrays, nulls and booleans; a value
JSON cannot carry (undefined, a function, a symbol, a bigint, a non-finite number, a class instance)
refuses the import or the snapshot write whole, by name, instead of being dropped or nulled silently
by `JSON.stringify`. The public API is unchanged (`create` still takes known arguments only; no
extras argument was added); coalescing, the acknowledgment, preferences, mandatory categories, effect
staging and the replay cursor are untouched (the existing S7a suites run unchanged). The reviewer's
script, run unchanged: on `ac50b60` exit 1 (`exportAliased: true, leakedRollback: true`, mirror
`['original','outside-write','aborted-unit']`, stored `['original']`); on the corrected tree exit 0
(`CORRECT`, mirror and stored `['original']`). The failing-first regression (`testNotifications.mjs`
"review of ac50b60") was recorded failing on `ac50b60` before the change and covers export aliasing,
a second export, nested prototype-like keys, a nested write through the view, a rolled-back unit
(export edit and repository write), a real COMMIT failure, the stored JSON, a reload, the snapshot
dispatcher, the copy-only rollback blob, the non-JSON refusals at import and at snapshot write, and
the unchanged coalescing / acknowledgment / preferences around a row with extras.

---

## 10. S7c — `outbox`, `push_log`, `push_tokens` (plan prepared 16 October 2026 on `ac50b60`; **three design assumptions corrected by the independent review of `6ca66ba`** (§10.3, §10.4, §10.6, §10.7); implemented 16 October 2026 on top of `6ca66ba` (§10.8), corrected twice (§10.10, §10.11); **independently ACCEPTED at `9119187`, §10.12** — the "pending" wording inside §10.7–§10.11 is the dated history of those rounds)

This is the one current plan for the third S7 sub-step, kept as the design record and corrected in
place where the independent review of `6ca66ba` (its baseline script `review-6ca66ba-compatibility.mjs`,
run unchanged on the starting tree: exit 0, three observations REPRODUCED) showed an assumption wrong:
**(D1)** the push row already has a save scheduled — the sender's `nextId('push')` calls the server's
debounced `persist()` — so no durability decision was needed and none was taken; **(D2)** a token is
stored losslessly as JSON and the route is unchanged — no `TOKEN_INVALID`, no refusal of legacy
non-string rows, no uniqueness constraint; **(to:null)** an accepted queued dispatch without a
destination is swept into a delivery record with `to: null`, so the destination column is nullable.
Each correction is marked where it applies; the uncorrected text is not kept as current. It reuses the survey of §1.6–§1.9 (the
two outbox shapes, the push log, the push tokens, the persistence paths), the boundary rules of
§3.2, the cutover rules of §5 and the rollback design of §6.2, and the pattern S7b built (§9.3–§9.4,
§9.7) — it does not repeat them; where this section states something more precisely than an
earlier one, this section is current. The storage move keeps every observable behaviour of the
current build; the behaviour questions that were already flagged (the staff push identity, the six
plain-code mail sites, retention) are carried through unchanged and listed in §10.3, not decided
here. Line numbers in this section are those of **`ac50b60`** (`S:` server.mjs, `AD:` adapters.mjs,
`DL:` m13/delivery.mjs, `EN:` m13/enterprise.mjs, `ORG:` m14/organisations.mjs, `CR:`
m23/contactRoutes.mjs, `IX:` repositories/index.mjs). The probe that produced the observations
cited as "probe" is `scoutbox-server/scripts/probeS7cOutboxPush.mjs` (§10.6; outside `npm test`; its
JSON is in the handoff package).

### 10.1 The accepted row shapes, and every writer and reader (current code)

**Outbox — two writers, two literals, told apart structurally.**

| Shape | Literal (key order as written) | Writer | Persisted by |
|---|---|---|---|
| (a) mailer | `{id:'mail-N', ts, to, subject, text, transport:'sendgrid'\|'dev-outbox', delivered}` (AD:90; pushed AD:95 **before** the provider call; `delivered` is `!live` at creation and, on the live transport, overwritten on the same object by `res.ok` or `false` after the `fetch` settles, AD:108–110) | `createMailer.send`, called from nine sites: S:1335 (guardian sign-up code), S:3165 (club e-mail challenge — **the only site passing `secrets`**, S:3169), S:3916 (reference request), ORG:236, 533, 717, 918, CR:521, EN:88 | the route's own `persistNow()` in the same save as the business row (EN:89; ORG:536, 718, 920; CR:544 — and a **second** `persistNow()` when the mail promise settles, writing `contact.emailCopy = {state, to:'guardian', outboxId, at}` CR:546–551), or the debounced `persist()` (S:1335 has none of its own and lands with the save `nextId` schedules; S:3171 calls `persist()`; S:3916 is `void`) |
| (b) delivery centre | `{id:'mail-N', at, channel, to, text (first 300 characters of the notification text), providerMessageId:'fm_<16 hex>', provider:'local-fake'}` (DL:50) | `fakeSend` (DL:44–52), called only by the sweep (DL:130) for a due `queued`/`retrying`/`held_quiet_hours` external dispatch; `in_app` rows are created `delivered` (DL:108) and never pass through it, so `channel` is `'email'` today | the sweep's `persistNow()` (DL:151, when it changed anything) — the same save as the dispatch row and its attempt (S7b; probe "outbox (b)": `sameRevisionAsDispatchRow: true`) |

Observed on the probe's file (4 rows, 3 (a) + 1 (b)): the key sets are exactly the two literals;
a field a shape does not have is **absent** (no `channel`/`providerMessageId` key on (a), no
`subject`/`delivered` key on (b)), never `null`; no value is `null` or `undefined` anywhere; every
row has a non-empty `to` (every site passes an address it validated or read from a record; ORG:717
and CR:519 guard on the address existing); `delivered` is `true` on every (a) row (dev transport);
ids are unique with a strictly increasing numeric suffix minted by `nextId` (one counter for every
collection, so `mail-N` numbers are sparse); **string order of the ids is not array order in general**
(`mail-999` sorts after `mail-1000`) and `ts`/`at` may tie (nothing forbids it) — **array position
is the only total order**, read newest-first by `/admin/outbox` (S:4413) and counted by
`/admin/overview` (S:4396). Shape (a) is identified by `ts`+`subject`+`transport` present and
`at`+`channel`+`provider` absent, shape (b) by the reverse; an entry matching both or neither is
unmapped (§5.3). The S6a contract observed through the probe: the persisted (a) row of the
challenge carries `OUTBOX_SECRET_PLACEHOLDER`; `/admin/outbox` serves the full text from the mailer's
process memory before a restart (the same row, only `text` differs) and the placeholder after it;
the other five code-bearing sites persist the code in clear (probe "outbox (a1)":
`codeInPersistedText: true` — the known defect, §1.6, carried through).

**Push log — one writer, one literal.** `{id:'push-N', ts, audience:{kind,id}, title:'ScoutBox',
body, transport:'expo'|'dev-log'}` (AD:126; pushed AD:127 **before** any Expo call, whether or not
a token matches), written only by `createPushSender.send`, called only from `notify` (S:922) through
`notifications.afterDurable` when `deferredPush` is false — i.e. **after the COMMIT of the save that
carried the notification row**, by the effect mechanism S7a's correction introduced (§8.4). `body`
is the notification's `text`, which the notification repository has already required to be a string
(repositories/notifications.mjs:631) — a push row never carries a non-string body. The audience is
the `{kind, id}` the repository validated (`audienceOf`, notifications.mjs:233–239: both non-empty
strings, nothing else, **kind open**). Persisted by whatever save comes next (§10.2). Read by
`/admin/push-log` (S:4414, `slice(-200).reverse()` — the last 200 by array position, newest first)
and counted by `/admin/overview` (S:4397). A coalesced repeat writes no push row (S7a; probe:
`rowsAfterSecondMessage: 0`). Key set observed: exactly the literal; audience kinds observed
`guardian`, `org_user`, `player`; no current `notify` call site passes another kind (grep of
`notify(` at `ac50b60`).

**Push tokens — one writer, one literal, a natural key the code enforces by rewriting the array.**
`POST /push/register` (S:4022–4031): `db.pushTokens = db.pushTokens.filter(not the same
(kind, refId, token))` then `push({kind: session.kind, refId: session.refId, token, ts})`, then
`persist()`. `kind` is the session kind — `player` (S:1254, S:4015), `guardian` (S:1342), `org`
(S:1851, S:1970, EN:122, EN:321) with `refId` = **the organisation's id**, `ts_reviewer`
(m25/index.mjs:129); nothing else creates a session. Observed (probe "push tokens"): the same device
token under a player, a guardian and an org session is three rows; re-registering an existing triple
keeps the count, updates `ts` and **moves the row to the end of the array** (position 0 → 3) — array
order is "last registration" order, not first; the org row is `('org', 'org-eastport')` while the
staff push rows it would serve carry `('org_user', <user id>)`, so under the sender's filter (AD:131,
`t.kind === audience.kind && t.refId === audience.id`) the one staff push row on the file matches
**0** tokens (defect 10 of the schema document, §1.8, carried through). **The route accepts any truthy
JSON value as a token** (`if (!token)`, S:4026): a number and an object were both answered 201 and
stored as they came (probe "non-string input": stored token types `number`, `object`, `string`) —
JSON input the current build accepts that no `TEXT` column can hold losslessly (§10.4).

**Consumers audited (startup, deletion, export, backup, old-build rollback).**

- *Startup:* the containers are `db.outbox ??= []`, `db.pushLog ??= []`, `db.pushTokens ??= []`
  (S:279–281) and the seed's empty arrays (seed.mjs:485–487); after cutover these become the
  repository's read-only views, as `db.dispatches` did (§9.7), and the stale-array rule of §5.1
  applies (a non-empty array at attach that was not just imported is reported as a count and
  dropped).
- *Deletion:* `deletePlayerData` (S:4220–4276) and the guardian child deletion touch **none** of the
  three (probe "deletion": counts unchanged; the deleted player's 2 token rows and 2 push rows stay;
  the revoked session can no longer register). `exportPlayer` (S:4278) exports none of them.
- *Backup:* `POST /admin/backup` spreads `db` (EN:475) — today the three arrays go out as blobs;
  after cutover they are exported explicitly through the repositories' `exportRows()` as
  `dispatches` is (EN:475), in stored form (the withheld text, never the dev full text).
- *Restore:* a boot on a `db.json` → the legacy import writes the three collections through the
  migration's import (§5.1; ST:356–380); a restore of a post-cutover backup goes through the same
  import from the stored shape (§6.1).
- *Store contract:* `outbox` (storeContract.mjs:124), `pushLog` (:139), `pushTokens` (:140) are
  module/core entries removed at cutover, as S6a–S7b did.
- *Snapshot dispatcher:* `readTableBacked` / the per-table `replace` (IX:87–97, 171) gain the three
  tables; a snapshot **omitting** a collection leaves its table untouched (the existing rule,
  IX:171 `present.includes(table.name)`), a snapshot carrying an empty array empties it.
- *Dependants by reference:* m23's `contact.emailCopy.outboxId` (CR:546, 551) names an outbox
  row by id — a reference written in a later save than the row itself (plan §S8 "contacts' outbox
  copies"); S7c keeps the id and the timing, so the reference keeps resolving exactly as today.
- *Old-build rollback:* the copy-only tool of §10.5 writes the three blobs back in the old literals;
  the `ac50b60` build (S7b accepted) reads them.

### 10.2 Where each write commits, relative to the business action, the dispatch rows, the notification effects and the remaining blob bookkeeping

The server attaches every S7 repository in **staged** mode (§9.7): a repository mutation is applied
to the mirror at once and its SQL is queued into the next save (`persistNow()` or the debounced
`persist()`), or joined into the open unit of work. S7c uses the same mode for the three new
repositories, so **the save that carries a row is the save that carries the blob entry today** —
the timing of every path below is preserved, only the storage changes.

| Path (current, observed) | After S7c (proposed) |
|---|---|
| **Mail from a route** (nine sites): the mailer pushes the (a) record synchronously, the provider call runs afterwards (never inside a unit, §3.2), the route's `persistNow()` saves the record with the business row in one revision (probe "outbox (a2)": the invite row and its mail row in revision 2 → 3), or the debounced save carries it (probe "outbox (a1)": not in the database at the response, landed with the next revision). The live transport's `record.delivered = res.ok` mutates the already-pushed object and lands with whatever save follows. | `createMailer.send` calls `outbox.append(record)` (staged INSERT, same save as today) and, on the live transport only, `outbox.markDelivered(id, ok)` after the `fetch` settles (staged UPDATE, the next save — as the mutated object did). `secrets` withholding, `devDeliveries` and the `/admin/outbox` read-time merge stay in the mailer and the route, unchanged (§3.2 last bullet). No mailer call site changes. |
| **Mail from the sweep** (b): `fakeSend` pushes the record inside the sweep; the sweep's `persistNow()` commits it with the dispatch row, the attempt, the status patch, the fail-inject decrement and the ops/webhook rows in one revision (S7b §9.7; probe: `sameRevisionAsDispatchRow: true`). | `fakeSend` calls `outbox.append(record)` — staged into the same save as the dispatch repository's rows. One revision, as today. |
| **Push log**: `notify` creates the notification row (staged) and registers `pushSender.send` as an after-durable effect; the route's `persistNow()` (S:1016 for a message) commits the row; the effect then writes the push record into memory. **It is in `/admin/push-log` at once but in no save yet** (probe "push log timing": 1 row in memory, 0 in the database at the response). **CORRECTED (review of `6ca66ba`, D1):** the earlier text said "nothing schedules a save for it" — wrong. The sender's `nextId('push')` (AD:126) calls the server's `nextId`, which calls the debounced `persist()` (S:665, S:159–169): the push row ALWAYS has a save scheduled about two seconds after the effect ran. The reviewer's real-server measurement with `M13_FAST_RETRY` unset: 2044 ms (this tree's rerun: 2016 ms), zero dispatch rows for the notice, no further request; the preparation probe's 400 ms sweep had masked the timer (its `persistNow()` came first). | `createPushSender.send` calls `pushLog.append(record)` — staged into the next save, exactly as today; **nothing else changes**: no new durability policy, no recursive save, no redundant timer, no change to `nextId`/`persist` or to the after-durable boundary. The push row is written by an effect that runs *after* the notification's COMMIT, so it can never be in the notification's save; it is durable with a **later** save and is never reported durable with the first. The actual guarantee: the existing best-effort debounce (about two seconds; an earlier save by a sweep or a route may carry it first); a failed save keeps it pending for the next one; a crash or an event-loop stall in that window loses the push-log row (an audit record of a push already handed to the transport — the push is not re-sent, the row is not reconstructed; the notification row is intact). No at-least-once or exactly-once delivery claim follows from an in-memory after-durable callback. Tested in both modes (`testOutboxPushServer.mjs` [compat] D1 normal / accelerated). |
| **Push tokens**: filter-then-push on the array, then the debounced `persist()`. | `pushTokens.register({kind, refId, token, ts})` = staged `DELETE WHERE (ref_kind, ref_id, token) = ?` + `INSERT` with a **new `seq`** (so the view's order stays "last registration last", byte-for-byte the array behaviour the probe recorded), then the route's `persist()` as today. |
| **Remaining blob bookkeeping**: every save still upserts every non-table-backed blob (ST:177–183). | The three collections leave the blob save (the §7.3 phase "S7c: `pushLog`/`outbox` leave it"); the store's blob write is otherwise unchanged; the sweep's `opsEvents`/`webhookDeliveries` blobs and the routes' other blobs stay in the same save as the new rows (the §3.2 correction: coupled blob writes inside the same commit). |

Nothing here moves an external effect before a COMMIT: the mailer's provider call and the push
remain outside every transaction (§3.2 "network calls never inside a SQLite transaction"; the store
refuses async work inside a unit, ST:236–245). The accepted after-durable boundary (S7a §8.4) is
untouched: the push still runs after the notification's save committed.

### 10.3 What S7c preserves, what it carries through unchanged, and the one real conflict

- **No staff push re-keying.** Tokens stay `('org', <org id>)` as the route writes them; the sender's
  filter stays `(audience.kind, audience.id)`; staff pushes keep matching no token (probe: 0 of 1).
  The re-keying is the behaviour change the plan's S7 objective describes and §1.8/§6.2 keep out of
  the storage move; it needs the registration route to resolve the staff user and a decision on the
  existing `org` rows. Carried through.
- **No audience change, no retention cleanup, no cascade.** Deletion leaves all three collections
  as today (probe "deletion"); `/admin/push-log`'s 200-row window stays a read-time slice; nothing
  prunes the outbox. The §4.4 retention items stay open.
- **No provider change.** `transport`/`provider` values are written by the adapters as today;
  `delivered` keeps its meaning (the provider's synchronous answer or `!live`, §3.2); the unread
  `deliveryFailInject.push` counter stays unread.
- **No redaction or erasure of historical mail or codes.** The six plain-code sites (§1.6) keep
  writing what they write and every historical row is imported byte-for-byte; the migration never
  reads `text` for a diagnostic and never rewrites it. The S6a withholding at S:3165 is preserved as
  it is (probe "outbox (a3)", "restart"). Whether to mask or cleanse the other five is the owner
  decision §8.1 records; S7c does not take it.
- **No constraint current data does not satisfy.** The structural constraints kept in §10.4 are the
  ones the writers already guarantee (and the dry run on the real file reports any row that fails
  one as a refusal, never a coercion); the vocabulary CHECKs of the proposed DDL are dropped
  (§10.4 says which and why). **CORRECTED (review of `6ca66ba`):** the proposed `to_address TEXT
  NOT NULL` and the "non-empty `to`" validation would have refused an accepted stored state — the
  dispatch repository accepts a queued e-mail dispatch with `to: null`, and the real boot sweep over
  it writes a delivery record with `to: null`, saves it and marks the dispatch accepted (the
  reviewer's script and `testOutboxPushServer.mjs` [compat] "null destination"). The column is
  nullable, the key is preserved as present-and-null on the way back, and the case is covered
  through migration, sweep save, restart, backup and rollback. No new delivery rule.
- **The non-string token — CORRECTED (review of `6ca66ba`, D2): a representation problem, not a
  conflict.** The route accepts any truthy JSON value (the reviewer registered a number, a string, a
  boolean, two equal objects and two equal arrays: nine requests, seven persisted rows — 1/1/1/2/2 —
  because the route's filter is JavaScript `===`: a repeated primitive collapses its earlier row,
  structurally equal objects and arrays never match). The earlier proposal (`TOKEN_INVALID` at the
  route, refusal of legacy non-string rows, a UNIQUE triple) is **withdrawn**: it would have changed
  the API and merged the object/array rows. The token is stored LOSSLESSLY as JSON text
  (`token_json`, validated at decode) and decoded on read into an ordinary value of the same type —
  the reviewer round-tripped the seven values through a STRICT SQLite JSON column and then called the
  real `createPushSender` with a stubbed provider: every outgoing token value and type was preserved,
  so what Expo receives does not change. `register` reproduces the route's rule exactly (primitives
  by strict equality of value and type — in SQL, equality of the JSON text, which for primitives is
  the same relation; objects and arrays never), appends the new row last, and there is **no
  uniqueness constraint**. Legacy rows of any JSON token type import as they are. This is technical
  compatibility, not a product decision; no Founder approval was needed or asked.
- **No other implementation blocker found.** The staged repository, the snapshot dispatcher, the
  effect mechanism and the rollback-tool chain all exist; S7c adds three tables to the same
  machinery.

### 10.4 Lossless mappings, detached extras, ordering keys, the constraints that are real, and text-free refusal

**The DDL as implemented** (`repositories/outboxPush.mjs` `OUTBOX_PUSH_DDL`; `sql/03` rewritten to match,
checked column for column by `scripts/testSchemaDdl.mjs`; **CORRECTED** from the prepared proposal by the
review of `6ca66ba`: `to_address` nullable, `delivered` NULL for a delivery row under a total structural
CHECK, `token_json` instead of a TEXT token, and NO unique triple; **AMENDED IN PLACE after the review of
`40aa05c`** (§10.10): the destination pair `to_address` / `to_json` under an exclusivity CHECK — 0011 was
registered but never accepted or released, so the one registered migration carries the corrected DDL and no
`0012` encodes an unreleased intermediate shape):

```sql
CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,            -- insertion order (array position); never a client value
  id                  TEXT NOT NULL UNIQUE,           -- 'mail-N'
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),  -- shape (a) | shape (b): structural, decides the way back
  created_at          INTEGER NOT NULL,               -- ts (a) | at (b)
  to_address          TEXT,                           -- personal data; a STRING destination; NULL is a value a writer produces (an accepted queued dispatch)
  to_json             TEXT CHECK (to_json IS NULL OR (json_valid(to_json) AND json_type(to_json) NOT IN ('text', 'null'))),  -- any OTHER JSON destination value (review of 40aa05c, F2: the coercing invite routes hand the mailer an ARRAY), decoded on read
  subject             TEXT,                           -- (a) only; NULL = the key is absent in (b)
  text                TEXT NOT NULL,                  -- withheld text for the one `secrets` site; as written elsewhere
  transport           TEXT NOT NULL,                  -- transport (a) | provider (b); no vocabulary CHECK
  delivered           INTEGER,                        -- (a) only, 0/1; NULL = the key is absent in (b)
  channel             TEXT,                           -- (b) only; NULL = absent in (a); no vocabulary CHECK
  provider_message_id TEXT,                           -- (b) only; NULL = absent in (a)
  extra_json          TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
  CHECK (to_address IS NULL OR to_json IS NULL),       -- a destination is in one column, or null
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL)
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL))
) STRICT;
CREATE INDEX outbox_created_at ON outbox (created_at);

CREATE TABLE push_log (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,                 -- 'push-N'
  created_at    INTEGER NOT NULL,                     -- ts
  audience_kind TEXT NOT NULL,                        -- open, as notifications.audience_kind is (S7a)
  audience_id   TEXT NOT NULL,                        -- polymorphic, no foreign key
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  transport     TEXT NOT NULL,                        -- no vocabulary CHECK
  extra_json    TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX push_log_created_at ON push_log (created_at);
CREATE INDEX push_log_audience_seq ON push_log (audience_kind, audience_id, seq);

CREATE TABLE push_tokens (
  seq           INTEGER PRIMARY KEY,                  -- "last registration last" (the array's order)
  ref_kind      TEXT NOT NULL,                        -- the session kind as written: player | guardian | org | ts_reviewer today; no CHECK
  ref_id        TEXT NOT NULL,
  token_json    TEXT NOT NULL CHECK (json_valid(token_json)),  -- ANY JSON value the route accepted, lossless; decoded on read
  registered_at INTEGER NOT NULL,                     -- ts
  extra_json    TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX push_tokens_ref_seq ON push_tokens (ref_kind, ref_id, seq);
```

- **Kept (structural, already guaranteed by the writers, verified in SQL by `testOutboxPush.mjs`):**
  `NOT NULL` where every writer writes a value (`id`, `created_at`, `text`, `transport`, the push
  row's audience/title/body, the token's kind/refId/json/ts); `UNIQUE id` on both logs; the total
  **source CHECK** on the outbox — a mailer row carries `subject` and `delivered` (0/1) and no
  `channel`/`provider_message_id`, a delivery row the reverse — so NULL always means "absent key",
  never a value, and the way back rebuilds exactly the writer's literal; `json_valid` on the token
  and on every `extra_json`. **Dropped from the prepared proposal (review of `6ca66ba`):** `to_address
  NOT NULL` (an accepted queued dispatch yields `to: null`); the `UNIQUE (ref_kind, ref_id, token)`
  triple (it would merge the object/array rows the route keeps separate; the route's rule lives in
  `register`, not in a constraint); `delivered NOT NULL DEFAULT 0` (a delivery row has no such key —
  NULL under the structural CHECK, not a fabricated 0).
- **Dropped from the proposed DDL (vocabularies):** `transport IN (…)` on both logs, `channel IN
  ('email')`, `audience_kind IN (…)`, `ref_kind IN (…)`. Reason: the S7a/S7b rule — the notification
  audience kind is open (notifications.mjs:233–239) and a push row copies it, so `audience_kind
  IN (player, guardian, org_user)` would refuse a kind the accepted repository admits (probe:
  `'other'` refused by the CHECK); `ref_kind IN (…)` would refuse `'org_user'` (probe) — exactly the
  value a future re-keying writes — so the vocabulary would force a schema change on a behaviour
  change; `transport`/`channel` are adapter literals that an added provider or channel would extend.
  None of these drops admits anything the current writers do not already write; the dry run reports
  the observed vocabularies as counts.
- **NULL behaviour, with the actual predicates (probe "executed SQL" on the prepared DDL;
  `testOutboxPush.mjs` "the actual schema" on the implemented DDL):** a lone CHECK whose result is
  NULL **passes** (the prepared `channel IS NULL OR channel IN ('email')` admitted a NULL channel);
  what refuses an absent value is `NOT NULL` — which is why the implemented outbox uses a **total
  structural CHECK** keyed on `source` instead of per-column defaults: a mailer row without
  `subject` or `delivered`, or carrying `channel`, is refused; a delivery row carrying `subject` or
  `delivered`, or lacking `channel`/`provider_message_id`, is refused; `delivered = 2` is refused;
  `to_address` NULL is **accepted for both sources**; `token_json` must be valid JSON of any type;
  a duplicate `id` is refused by `UNIQUE`; the same token under another kind, and duplicate token
  rows, are admitted. The STRICT `TEXT` conversion of a bound number the probe recorded (`424242` →
  `'424242.0'`) is why a plain TEXT token column was rejected in favour of JSON text.
- **The mapping, verified lossless (probe "JavaScript mapping" on observed rows; `testOutboxPush.mjs`
  migration and rollback tests byte-for-byte, key order included):** (a) `{id, ts, to, subject, text,
  transport, delivered}` ⇄ `source='mailer'`, `created_at=ts`, `delivered = 0/1`, `channel = NULL`,
  `provider_message_id = NULL`; (b) `{id, at, channel, to, text, providerMessageId, provider}` ⇄
  `source='delivery'`, `created_at=at`, `transport=provider`, `subject=NULL`, `delivered=NULL`; the
  way back rebuilds **exactly the source shape's keys in the writer's literal order** (no
  `subject`/`delivered` on a (b) row, no `channel`/`providerMessageId` on an (a) row; `to: null`
  present-and-null), because the old build and every reader compare whole objects. Push log: `{id,
  ts, audience:{kind,id}, title, body, transport}` ⇄ the six columns. Tokens: `{kind, refId, token,
  ts}` ⇄ `ref_kind`, `ref_id`, `token_json` (`JSON.stringify` / prototype-safe decode), `registered_at`;
  `seq` order = array order ("last registration last").
- **Accepted input, per field (no coercion; a refusal names the collection, the position, the id
  where there is one and a reason — never `to`, `text`, `token` or `body`):** `id` non-empty
  string, unique in its collection; `ts`/`at` a safe integer (a shape's keys all present, none of the
  other shape's → otherwise "matches both/neither"); `subject` a string ((a));
  `text` a string; `transport`/`provider` a non-empty string; `delivered` a boolean ((a) only); `to` **any
  JSON value** (a string → `to_address`; null → NULL/NULL; anything else, in practice the ARRAY the coercing
  invite routes hand the mailer → `to_json`, review of `40aa05c` F2 — a non-JSON value is refused by name,
  except the non-finite numbers JSON syntax produces inside such an array, which are kept live and persisted
  as the accepted build's JSON null — review of `78c14b9`, §10.11);
  `channel` and `providerMessageId` non-empty strings ((b) only); push `audience` exactly `{kind, id}`
  with both non-empty strings (the S7a rule, an extra audience field refuses); `title`, `body` strings;
  token `kind`, `refId` non-empty strings, `token` **any JSON value** (null, boolean, number, string,
  array, plain object — a detached prototype-safe clone) **including the non-finite numbers JSON syntax
  produces** (`1e400` → `Infinity`; kept live, persisted as JSON null — review of `40aa05c` F1, §10.10),
  `ts` a safe integer; **no uniqueness** on tokens. **Unknown keys** on any entry go to `extra_json` through the prototype-safe JSON clone
  (`cloneJson`, the dispatch and notification repositories' approach, local to the module): detached
  at ingress, export and snapshot; own `"__proto__"`/`"constructor"`/`"toString"` keys preserved at
  every depth (inside a token too); a value JSON cannot carry (`undefined`, a function, a symbol, a
  bigint, a non-finite number, a class instance) refuses the write whole, by name. Exported views
  list extras first, then the known keys, as S7b does.
- **JSON input versus non-JSON in-memory state a current writer can produce:** the live mailer's
  `record.delivered = res.ok` is a boolean (the adapter now also calls `outbox.markDelivered(id, ok)`,
  because the stored row is a detached copy and a mutation of the local record alone would be lost);
  a rejected `fetch` writes `false`; `ts`/`at` come from `Date.now()`; the push body is the string the
  notification repository validated; the token is whatever JSON the route parsed (never `undefined`,
  a function or a symbol — JSON cannot carry them; the repository refuses them by name should a
  direct caller pass one). **Corrected by the review of `40aa05c` (F1):** a non-finite number DOES reach
  the token collection — JSON syntax `1e400` parses to `Infinity`, the route checks truthiness only — so
  the token's clone keeps it live and `token_json` holds JSON.stringify's `null`, as the blob did; no
  REAL/`ANY` column is needed because the persisted value was always null. The mailer's `to` is not always
  a string either (F2): the coercing invite routes hand the mailer an array. Cloning does not change the
  token matching rule:
  primitives compare by value; an object a caller still holds is compared by reference against the
  mirror's detached clone and never matches — exactly the rule the route's freshly parsed bodies
  always had (the one theoretical difference, an in-process caller re-registering the same object
  reference, has no writer).

### 10.5 Migration identifier, atomic import, authority, snapshots, failure recovery, copy-only rollback and the old-build proof

- **Identifier:** the next unused was **`0011`** (`repositories/migrations/` ended at
  `0010_dispatches.mjs`; `DATA_MIGRATIONS` IX:49), reconfirmed at implementation → **`0011_outbox_push`,
  assigned and REGISTERED** (`repositories/migrations/0011_outbox_push.mjs`, §10.8); the plan's
  `0011_scouting` placeholder (plan §S9) moves to the next free number when that stage is approved,
  as `0010_recruitment` did for `0010_dispatches` (§9.4). The S7b rollback tool refuses a file
  carrying `0011_outbox_push` (`LATER_SCHEMA`; `testOutboxPush.mjs`, `testOutboxPushServer.mjs`), and
  the S7c tool knows every earlier id.
- **Atomic import (one transaction, the 0009/0010 pattern):** create the three tables and indexes;
  read the `outbox`, `pushLog` and `pushTokens` blobs **from the file**; for each: **absent** → import
  nothing; **empty array** → nothing; **non-array / non-JSON** → refuse; validate every entry (§10.4)
  collecting problems and refuse the whole step on the first non-empty list
  (`OUTBOX_PUSH_IMPORT_BLOCKED`, with `{collection, position, id?, code}` entries only); insert in
  array order (`seq`); write `meta.outboxPushCutover` = counts only (`outbox: {imported, bySource:
  {mailer, delivery}, withExtraFields}`, `pushLog: {imported, byAudienceKind}`, `pushTokens:
  {imported, byKind}`); delete the three blob rows. A refusal leaves the blobs, the file and `saveSeq`
  untouched and the previous build still boots it (§5.1, §5.3).
- **Authority:** `0011_outbox_push` in `data_migrations` — never the tables' existence or row
  counts; the record without the tables or the tables without the record → `UNEXPECTED_SCHEMA` at
  boot (§5.1). A stale in-memory array at attach (the containers S:279–281, the seed's, a restored
  pre-S7c backup's blob just imported) is dropped and its blob row deleted; a non-empty array not
  just imported is reported as a count (the S7a rule).
- **Snapshot writes** (restore, tools, the persistence suites): the dispatcher validates every entry
  of each **present** collection, rewrites that table in array order inside the caller's transaction,
  and refuses the whole write on the first problem; a collection **omitted** from the snapshot leaves
  its table untouched (IX:171, the existing rule), an empty array empties it; **final-state
  validation** checks only what the schema enforces (unique ids, the unique triple) — nothing
  cross-table, because none of the three references another table. A backup from any build restores
  through 0011 with orders intact; the exported outbox rows carry the withheld text (§6.1).
- **Failure recovery — two different things (wording CORRECTED, review of `6ca66ba`):** boot after a
  crash mid-migration finds the pre-cutover file (no record, blobs intact) or the post-cutover file
  (record, tables, blob rows gone), never a mixture (one transaction; the 0007/0008
  SIGKILL-between-steps tests are reused, §5.4). After cutover, **a failed ORDINARY staged save**
  (at a statement or at the real COMMIT) leaves the mirrors as they are and keeps every queued
  statement for the next save: memory is the intended state, nothing is dropped, the next save by
  anybody lands it once (the staged retry limitation of §9.7 reading iii applies unchanged: a failed
  `persistNow()` schedules no retry of its own). **An ABORTED UNIT OF WORK** — a thrown failure, a
  queued statement failing at the unit's flush, a real COMMIT failure, a caught participant refusal —
  restores the mirrors and the queue to the state they had when the unit began (`snapshotState` /
  `restoreState`), held views included; writes pending before the unit stay pending. Both are
  tested (`testOutboxPush.mjs` "staged mode", `testOutboxPushServer.mjs` [cutover] "failed ordinary
  save"). Provider side effects are outside database rollback either way.
- **Copy-only rollback to the accepted `6ca66ba` build** (which carries the notification nested-extras
  correction; the pre-S7c build is no longer `ac50b60`): `repositories/outboxPushRollback.mjs` +
  `scripts/outboxPushRollback.mjs` (`npm run rollback:outbox-push -- <data-dir> <fresh-empty-dir>`),
  the S7b tool's structure: open read-only, `VACUUM INTO` a copy; `KNOWN_MIGRATIONS` = the S7b
  tool's list + `0011_outbox_push`, any other id → `LATER_SCHEMA`; `NOT_CUT_OVER`, `OUTPUT_NOT_EMPTY`,
  `UNEXPECTED_SCHEMA` as before; in one transaction write every outbox row back as its **source
  shape's literal in the writer's key order** (`extra_json` keys spread first; `to: null` present),
  every push row as the sender literal, every token as the route literal with its value decoded to
  the type it was registered with, each blob in `seq` order; drop the three tables; remove the
  `0011` record and `meta.outboxPushCutover`; advance `saveSeq`; `foreign_key_check`; VACUUM;
  revalidate (tables gone, record gone, blob counts equal the table counts, every untouched table —
  the S7a and S7b tables included — byte-identical). **Every post-cutover mail, push and token row
  and every unrelated record is retained.** The chain then continues: the S7b tool rolls the copy to
  `0641b2c`, the S7a tool to `812e13b`, and so on; the S7b tool refuses a copy still carrying 0011.
- **Old-build boot/write proof (an actual old server, as S7a/S7b):** `SCOUTBOX_PRE_S7C_SERVER`
  pointing at a `6ca66ba` checkout boots the rolled-back copy (no `0011` applied), `GET /admin/outbox`
  and `GET /admin/push-log` return the same ids in the same order as the S7c build did; a token
  (an object token included) registered and a mail sent on the old build land in its blobs; the S7c
  build then re-upgrades the file (0011 import from the blobs) with every row and order intact, the
  old build's writes included (`testOutboxPushServer.mjs`, last test). When the old checkout is
  unavailable the gate reports the skip, as before.

### 10.6 Synthetic compatibility probe — results (`scripts/probeS7cOutboxPush.mjs`, 16 October 2026, Node v22.22.2, real server on a temporary directory, second read-only connection; the JSON is in the handoff package)

| Observation | Result on `ac50b60` (+ the §9.10 correction) | Classification |
|---|---|---|
| Outbox shape (a), three routes | guardian sign-up: `{id, ts, to, subject, text, transport, delivered}`, not in the database at the response, landed with the next revision (debounced); the persisted text contains the one-time code; org invite: same shape, committed by the route's `persistNow()` in the same revision as the invite row (2 → 3); club challenge: the persisted text carries the placeholder, `/admin/outbox` serves the full text before a restart (same row, only `text` differs) and the placeholder after | current behaviour, preserved (staged append = same save; the S6a contract untouched) |
| Outbox shape (b), the sweep | `{id, at, channel, to, text, providerMessageId, provider}` with `text` = the first ≤ 300 characters of the notification text, written in the same revision as the dispatch row whose `provider_message_id` it carries (1 row) | current behaviour, preserved |
| Outbox collection | 4 rows; two key sets; absent keys absent, nothing `null`/`undefined`; every row has `to`; ids unique with a monotonic numeric suffix; 0 timestamp ties here with no rule against them; admin view newest-first by array position | `seq` is the ordering key; `source` the discriminator (JavaScript mapping) |
| Push-log timing | notification row committed at the response (revision 10, 0 dispatch rows yet); 1 push row in memory and 0 in the database at the response; landed 318 ms later with revision 11 — the sweep's save that created the notification's 2 dispatch rows (400 ms sweep under `M13_FAST_RETRY`; 60 s in production); the row's `body` equals the notification text. **CORRECTED (review of `6ca66ba`):** the probe's conclusion "the effect schedules no save of its own" was wrong — the accelerated sweep masked the sender's own `nextId()`/`persist()` debounce. The reviewer's measurement with `M13_FAST_RETRY` unset: landed after 2044 ms, zero dispatch rows, no request (this tree: 2016 ms); the probe's commentary and §10.2 are corrected, its original output kept as evidence | current behaviour, preserved unchanged (no new policy); the existing best-effort debounce, not a guarantee |
| Push-log collection | one key set; a coalesced repeat adds 0 rows; title `'ScoutBox'`; kinds `guardian`, `org_user`, `player` | current behaviour, preserved |
| Push tokens | one key set; the same token under player/guardian/org sessions = 3 rows; re-registration 4 → 4 rows, `ts` updated, row moved from position 0 to 3; org row `('org', <org id>)`; the one staff push row matches 0 tokens; unauthenticated 401, missing token 400; **a number and an object accepted (201) and stored as such**. The reviewer's baseline adds: nine registrations (number ×2, string, boolean ×2, equal objects ×2, equal arrays ×2) → seven rows (1/1/1/2/2): primitives collapse by `===`, objects and arrays never | current behaviour, **preserved**: the order is reproduced by DELETE + INSERT (new `seq`); the staff defect carried through; the token is stored losslessly as JSON with the route's rule (§10.3 D2, corrected) |
| Deletion | `DELETE /player/account`: outbox 4 → 4, push log 4 → 4, tokens 6 → 6; the deleted person's 2 token rows and 2 push rows stay; player notifications 0; the revoked session cannot register | current behaviour, preserved; retention stays open (§4.4) |
| JavaScript mapping | 4 outbox, 4 push-log, 4 token rows: blob → proposed columns → blob **byte-identical** (key order included); no unknown keys | the §10.4 mapping is lossless on observed data |
| Executed SQL (in-memory SQLite, the PREPARED DDL with `seq`) | every observed row inserts except the object-valued token (cannot be bound); a numeric token is **converted** to `'424242.0'` by a STRICT `TEXT` column; NULL behaviour of every CHECK and `NOT NULL`; `'other'` refused by the proposed `audience_kind` CHECK; `'org_user'` refused by the proposed `ref_kind` CHECK; the duplicate triple refused, the same token under another kind admitted | the vocabulary CHECKs are dropped (D3, the preservation rule); **superseded** by the implemented schema (§10.4): JSON token text instead of a TEXT column (the conversion is why), nullable destination, `delivered` NULL for a delivery row under the total source CHECK, no unique triple — exercised in SQL by `testOutboxPush.mjs` |
| Null destination (the reviewer's baseline; `testOutboxPushServer.mjs` [compat]) | a queued e-mail dispatch with `to: null` accepted by the dispatch repository; the real boot sweep writes a delivery record with `to: null`, saves it, marks the dispatch accepted; survives restart; carried by the backup with the key present | current behaviour, preserved: `to_address` nullable, the key present-and-null on the way back |
| Restart | the admin outbox lists the same 4 ids in the same order; the challenge mail shows the placeholder after the restart; 4 push rows, 6 token rows | current behaviour, preserved |

### 10.7 Bounded implementation checklist, expected files, failing-first regressions, acceptance checks, decisions needed

**Checklist (in order; each step keeps both gates green):** (1) D1–D3 resolved — by the independent
review of `6ca66ba`, none a product decision (below); (2) failing-first
suites written and recorded failing on the unchanged tree; (3) `repositories/outboxPush.mjs` — the
three repositories in one module (validators; `OUTBOX_TABLE`, `PUSH_LOG_TABLE`, `PUSH_TOKENS_TABLE`
for the snapshot dispatcher; staged/immediate participation with mirrors; views `db.outbox`,
`db.pushLog`, `db.pushTokens`; methods `outbox.append`, `outbox.markDelivered`, `pushLog.append`,
`pushTokens.register`, `pushTokens.forAudience(kind, id)` (the sender's filter, unchanged
semantics), `exportRows` ×3, `count` ×3, `recent(n)` for the two admin views; no `afterDurable`
— these rows are records, not effects); (4) `repositories/migrations/0011_outbox_push.mjs`
(registered at implementation, `DATA_MIGRATIONS`, `TABLE_BACKED`, the snapshot dispatch list);
(5) writer conversion: `adapters.mjs` (mailer append + live `markDelivered`; push sender append +
`forAudience`), `m13/delivery.mjs` (`fakeSend` append), `server.mjs` (`/push/register` →
`register`; containers; the data-layer destructure; `/admin/outbox`, `/admin/push-log`,
`/admin/overview` read the views unchanged), `m13/enterprise.mjs` (explicit backup export),
`storeContract.mjs` (three entries removed); (6) `repositories/outboxPushRollback.mjs` +
`scripts/outboxPushRollback.mjs` + `package.json` (`rollback:outbox-push`, the `npm test` chain);
(7) `sql/03` rewritten per §10.4 and `scripts/testSchemaDdl.mjs`; (8) older suites' expected lists
(`TABLE_BACKED`, rollback-chain revision counts, dump except-lists) for `0011`; (9) docs
(`sqlite-schema.md`, `sqlite-migration-plan.md`, `OPERATIONS.md` operator section + cutover
procedure, `CLAUDE.md`, this section's status line); (10) verification and the handoff package.

**Failing-first regressions** (written before any source change; recorded failing with reasons on
the unchanged tree): `scripts/testOutboxPush.mjs` — migration shapes and refusals (both outbox
literals round-trip; an entry matching both or neither shape refused; a non-string token, a
duplicate id, a duplicate triple, an extra audience field refused by position/kind; own
`"__proto__"` key round-trip through `extra_json`; a non-JSON value refused by name; absent / empty
/ non-array blobs; `saveSeq` and the blobs unchanged on refusal; the cutover counts); repository
operations in immediate and staged mode (owned-transaction failure restores the mirror; a joined
unit's caught failure poisons the unit; real COMMIT failure; retry; `register` order = DELETE +
INSERT; `markDelivered` on a missing id refused inside the participant boundary); snapshot
replace / omitted collection / final state; copy-only rollback (every row back in the writer's key
order, `LATER_SCHEMA` for a `0012_*` id, the S7b tool's `LATER_SCHEMA` on a 0011 file, exit codes,
an injected COMMIT failure leaves no output). `scripts/testOutboxPushServer.mjs` — through the real
routes: the invite's mail row and invite row in ONE revision (second connection); the sign-up's
mail row with the debounced save; the challenge's withheld row and the admin view's full text, then
the placeholder after a restart; the sweep's (b) row with the dispatch rows in one revision; the
push row after COMMIT in a LATER revision — never in the notification's — with a SIGKILL between
the two leaving the notification and no push row (no re-send on restart); token register /
re-register order and the 400 for a non-string token (D2); a deletion leaving all three
collections untouched (fixture: probe "deletion"); backup → restore → rollback → re-upgrade with
orders intact; the `ac50b60` build booting and writing to the rollback copy
(`SCOUTBOX_PRE_S7C_SERVER`). The four reviewer scripts stay unchanged and green; `m13E2E`,
`testNotificationsServer`, `testDispatchesServer` unchanged and green.

**Independent acceptance checks:** every §10.6 behaviour reproduced on the table-backed build with
the same observable results (the probe runs unchanged against it, its adapted reader the only
difference, as §9.5's did); no diagnostic carries a text, an address, a code or a token; no new
vocabulary CHECK; `delivered` never NULL; the push row never in the notification's revision and
never reported durable with it; every write refused whole or applied whole; the three blobs gone
from the save after cutover and back after rollback; both mandatory gates green on the final tree
and from a fresh extraction; the old-build proof on the actual `ac50b60` checkout.

**The three "decisions" as resolved by the independent review of `6ca66ba` — none was a product
decision, and the earlier claim that they needed new Founder approval is withdrawn:**

- **D1 — push-row durability window: no decision existed.** The push sender's `nextId('push')`
  already calls the server's debounced `persist()` (S:665); the sender has always had its save
  scheduled. S7c changes nothing here: no new policy, timer or recursive save. The row is durable with
  that later save (best effort, about two seconds; a crash, a failed save or an event-loop stall still
  loses or delays it) and never with the notification's preceding commit (§10.2).
- **D2 — non-string push tokens: lossless storage, no API change.** No `TOKEN_INVALID`, no refusal of
  supported legacy rows, no coercion to text, no uniqueness constraint. The token is JSON text decoded
  on read; `register` reproduces the route's `===` rule (§10.3, §10.4).
- **D3 — vocabulary CHECKs: dropped, by the already-authorised preservation rule** (open
  `transport`/`provider`/`channel`/`audience.kind`/`kind` values as current behaviour supports them);
  only the structural constraints of §10.4 are kept.
- Not S7c decisions, restated so they are not re-asked: the staff push re-keying, the five
  plain-code mail sites, retention after deletion (§4.4), the org-deletion question. The S7d
  blockers (§8.1) are unchanged.

S7c was implemented (§10.8) and, after two correction rounds (§10.10, §10.11), **independently ACCEPTED at
`9119187` (§10.12).**

### 10.8 S7c as implemented (16 October 2026, one local commit on `feat/sqlite-schema` on top of `6ca66ba` — `40aa05c`; written while pending independent acceptance — **the corrected line was accepted at `9119187`, §10.12**)

**Baseline first.** The reviewer's `review-6ca66ba-compatibility.mjs` was run unchanged on the
starting tree before any edit: exit 0, `REPRODUCED D1` (elapsed 2016 ms, 0 dispatch rows, normal
sweep 60 000 ms), `REPRODUCED D2` (numbers 1, strings 1, booleans 1, objects 2, arrays 2), `PROVEN`
(typed JSON round trip through STRICT SQLite preserving the real sender payload), `REPRODUCED` the null
destination, `PASS`. It is a **baseline-only script**: it reads the pre-S7c blobs (`collections`
rows named `pushLog`, `pushTokens`, `outbox`) and drives `registerDelivery` with a plain `db` array
and no outbox repository, so it does not apply to the cut-over tree and is not presented as a
post-cutover test; the same observations are covered table-aware by the two new suites
(`[compat]` tests, which pass on both trees) and its unchanged script and both logs are in the handoff.

**Built** (the plan of §10.7, with the three corrections): `repositories/outboxPush.mjs` — one
participant for the three tables (one queue, one snapshot), the validators (`validateOutboxRow`,
`validatePushLogRow`, `validatePushTokenRow` and the collection forms), `outboxSourceOf` (structural
shape detection), `cloneJson` (local, the dispatch/notification approach), the snapshot tables
`OUTBOX_TABLE` / `PUSH_LOG_TABLE` / `PUSH_TOKENS_TABLE`, `importOutboxPushBlobs`, and
`createOutboxPushRepository({ sqlite, now, log, unit, staged })` with `outbox.append` /
`outbox.markDelivered` / `outbox.byId` / `outbox.exportRows`, `pushLog.append` / `pushLog.exportRows`,
`pushTokens.register` (the route's filter-then-push: primitives by `===`, objects never; DELETE by
`(ref_kind, ref_id, token_json)` for primitives only, then INSERT with a new `seq`) /
`pushTokens.forAudience` (the sender's filter, detached copies with the registered types) /
`pushTokens.exportRows`, views `db.outbox`, `db.pushLog`, `db.pushTokens`, `attach`, `reload`,
`counts`, `pending`, the save hook, `snapshotState` / `restoreState` (rows by identity, held views
restored in place); `repositories/migrations/0011_outbox_push.mjs` (REGISTERED, after 0010; the three
tables; the three blobs imported from the file in array order, nothing coerced; `meta.outboxPushCutover`
= counts only — by source, by audience kind, by token kind and token type); `repositories/index.mjs`
(`DATA_MIGRATIONS`, `TABLE_BACKED` + 3, the snapshot dispatch list, the staged attach with the
stale-array rule, `outboxPush` / `outbox` / `pushLog` / `pushTokens` on the data layer, the report
domain `outboxPush`); `repositories/outboxPushRollback.mjs` + `scripts/outboxPushRollback.mjs`
(`npm run rollback:outbox-push`; exit codes 0/1/4/5/10 as the S7b tool); `adapters.mjs`
(`createMailer(db, nextId, { outbox })` appends the record before the provider call and, on the live
transport, sets `record.delivered` on the caller's record **and** calls `outbox.markDelivered` —
the stored row is a detached copy, so the earlier mutation of the local object alone would have
been lost; `createPushSender(db, nextId, { pushLog, pushTokens })` appends through the repository
and filters tokens through `forAudience`; both keep the plain-array behaviour when no repositories
are passed, which is what the reviewer's feasibility check and the older tool call sites use);
`m13/delivery.mjs` (`fakeSend` → `outbox.append`, `to` as the dispatch holds it — null included;
without `ctx.outbox` the record is pushed onto a `db.outbox` **array** exactly as before the cutover,
the same fallback `adapters.mjs` keeps — the server always passes the repository; the fallback is
what keeps the unchanged reviewer scripts `review-26d492b-reproductions.mjs` and
`review-6ca66ba-compatibility.mjs` running, both of which build a bare context around an array; a
first implementation that threw without the repository broke the former, which the final-tree run of
the four reviewer scripts caught); `server.mjs` (the data-layer destructure, the adapters
built with the repositories, `POST /push/register` → `pushTokens.register` with the same
truthiness check, response and `persist()`, the m13 context); `m13/enterprise.mjs` (the backup
exports the three collections explicitly in their legacy shapes); `storeContract.mjs` (reasons);
`sql/03` (the three sections rewritten; header lines) and `scripts/testSchemaDdl.mjs` (0011,
the three tables column for column, the S7c assertions); `package.json` (the two new suites in
`npm test`, the rollback script); the older suites' lists and rollback chains for 0011
(`testDataLayer`, `testCoreSchema`, `testCoreIdentityMigration`, `testCoreIdentityRollback`,
`testOneTimeCodes`, `testPlayerSubrecords`, `testMediaDeletions`, `testNotifications` — whose
`registerDelivery` context now carries an outbox repository — and `testDispatches`, whose
S7b-tool proof now builds an S7b-level file, since the S7b tool refuses a 0011 file; then, found
by the first final-tree run of the backend gate rather than by the focused runs: `testSessions`,
`testOrgs`, `testCoreIdentityServer` and `testNotificationsServer`, whose rollback chains now start
with the S7c tool (the S7b tool's `LATER_SCHEMA` refusal of a 0011 file is asserted where the chain
asserted the earlier tools' refusals), `testOrgs` and `testCoreIdentityServer` expecting
`0011_outbox_push` in the capabilities' migration list, `testIdentityRepositories` expecting the
three collections in `TABLE_BACKED`, `testDispatchesServer` reading the outbox
from the table after the cutover and chaining the S7c tool before the S7b tool, and
`testOneTimeCodesServer` reading the saved, code-withheld mail from the table);
`scripts/probeS7cOutboxPush.mjs` (readers adapted to the tables; the D1 and D2 commentary corrected
in place, the uncorrected output kept in the handoff as evidence).

**Failing-first.** Both suites were run on the unchanged `6ca66ba` tree before the implementation
(logs in the handoff): `testOutboxPush.mjs` — the `[compat]` test passes, the first `[cutover]`
test fails on `0011_outbox_push is registered as the next unused identifier` (a concrete assertion
on `DATA_MIGRATIONS`, not a missing module); `testOutboxPushServer.mjs` — the four `[compat]`
tests (D1 normal and accelerated, D2 through the route, the null destination) pass, the first
`[cutover]` test fails on `this proof reads the S7c tables`.

**Readings recorded with the implementation (none a behaviour change):** (i) the mirror's token is a
detached clone, so an in-process caller re-registering the **same object reference** gets a new row
where today's array would have collapsed it by reference — no writer does this (the route's bodies
are always fresh), and the rule for the route is identical; (ii) `markDelivered` is a staged UPDATE
that lands with the next save, as the mutated blob entry did; (iii) a mailer row with a `to` JSON cannot carry
(an undefined, a function — corrected by the review of `40aa05c`, §10.10: an array or any other JSON value is
accepted and stored losslessly), or a push row whose audience is not exactly `{kind, id}` of non-empty strings,
refuses the import — the S7a audience rule and the writers' literals; the dry run on the real file
reports any such row before a cutover is scheduled.

**What stays open, unchanged:** retention of these rows after a deletion (§4.4), the staff push
identity (tokens under `org`, pushes to `org_user` — 0 matches on the probe's file, carried through),
the five plain-code mail sites, the external-effect crash window (a push handed to the transport
whose row is lost to a crash before its later save; no re-send, documented and tested), the
staged-save retry limitation (§9.7 reading iii).

### 10.9 Independent acceptance of the notification nested-extras follow-up — `6ca66bab1041eeb907b08f1e352fb78acdf73abd` (16 October 2026)

The independent review of `scoutbox-s7c-prep-handoff-6ca66ba.zip` (SHA-256
`270649999a5fc1e6ee6539831a95615a4d617741fe14b6e95ca557b5a700bf5c`, 457 manifest entries verified)
**accepts the notification nested-extras correction at `6ca66ba` for its bounded scope** (§9.10; not
production approval). What the reviewer verified on real Node v24.19.0 (offline `npm ci
--ignore-scripts`): backend `npm test` exit 0, 23 suites / 325 checks, with the accepted `2d7ddeb`
pre-S7a and `0641b2c` pre-S7b builds booting the rollback copies; Player `npm test -- --runInBand`
exit 0, 4 suites / 41 tests; the four reviewer scripts unchanged, exit 0 (1, 4, 3 and 3 CORRECT).
S7b stays accepted at `ac50b60`. The same review did **not** accept the S7c preparation unchanged: its
three findings (D1 scheduling overlooked; D2 solvable without an API change and the UNIQUE triple
behaviour-changing; the null destination) are corrected above and implemented in §10.8. Limits stated
by the review: real older-Node checks skipped (`SCOUTBOX_TEST_NODE_BINS` unset); browser suites, the
full E2E battery and `m13E2E` not independently rerun; S7c implemented must return for independent
acceptance.

### 10.10 Independent review of `40aa05c` — two compatibility defects, corrected on top of `40aa05c` in `78c14b9` (17 October 2026; history — the status at the time was pending; **the line was accepted at `9119187`, §10.12**)

**What the review found** (`review-40aa05c-summary.txt`; reproduction `review-40aa05c-reproductions.mjs
<candidate-root> <6ca66ba-root>`, run unchanged on the unchanged `40aa05c` tree against the `6ca66ba`
checkout before any edit: exit 1, three REPRODUCED checks for two defects, the ordinary-message push control
CORRECT on both builds — the log is in the handoff).

- **F2 — an accepted invitation could end the process; the same legacy record blocked the upgrade.**
  `POST /org/invites` validates `email` with `RegExp.test`, which coerces: `["a@b.c"]` passes, the invite
  stores `String(email)`, and `mailer.send` receives the ORIGINAL array. The accepted build persisted the
  array. §10.4's first implementation refused every non-string `to`; the route still answered 201, the
  rejection of `void mailer.send(...)` was unobserved and ended the process with exit 1, and a file the
  `6ca66ba` build had written refused to upgrade (`OUTBOX_PUSH_IMPORT_BLOCKED`). The survey of the
  coercing writer paths: `m13/enterprise.mjs` `/org/invites` (RegExp.test) and `m14/organisations.mjs`
  player invite (`emailProblem`, `String(email ?? '')`) hand the ORIGINAL value on; every other mailer
  site builds a string (`String(...)`, `reqText`, a guardian record) or `null` comes from a dispatch. An
  array is the only non-string, non-null shape a writer can produce (an object or a number never passes
  either regular expression), but the representation covers any JSON value, not a hand-picked singleton.
- **F1 — raw JSON number overflow tokens failed registration.** `1e400` parses to `Infinity`; the route
  accepts it (truthy), the old array kept the live value until a restart (`===`: a repeated `+Infinity`
  collapsed, `-Infinity` was a separate row) and `JSON.stringify` wrote `null` at the save — also inside an
  object or an array. Five raw requests: five 201 and `[null,null,{"n":null},[null]]` on `6ca66ba`; five 500
  and nothing stored on `40aa05c` (`cloneJson` refused the non-finite number).

**Corrections (`repositories/outboxPush.mjs`; failing-first regressions recorded on the unchanged `40aa05c`
tree — `testOutboxPush.mjs` "[review of 40aa05c, F2]" fails on the import refusal and "[F1]" on the
non-finite refusal; `testOutboxPushServer.mjs` "[review of 40aa05c, F2]" fails on "the process is alive"
(exit code 1) and "[F1]" on five 500s — logs in the handoff):**

1. **The destination is any JSON value, stored losslessly in two columns:** a string in `to_address`, null
   as NULL in both, any other value JSON-encoded in `to_json` (`CHECK`: valid JSON that is neither a JSON
   string nor JSON null; `CHECK (to_address IS NULL OR to_json IS NULL)`), decoded on read into the value
   and type the writer handed over — in the export, the admin view, the backup, the snapshot reader
   (`OUTBOX_TABLE.read`, which the reviewer's script and the rollback use), the rollback blob and the
   re-upgrade. Explicit null and ordinary strings are unchanged; a non-JSON destination is still refused by
   name. The migration's DDL is amended in place (above). **Scratch databases already at `40aa05c`** (the
   0011 record present, `outbox` without `to_json` — only synthetic files; no real database carries the
   shape) are refused at attach by name, `OUTBOX_PUSH_SCHEMA_STALE`, before any statement is prepared and
   with the file untouched; `scripts/outboxPushRollback.mjs` reads that shape (every destination there is a
   string or null) and this build re-upgrades the copy into the corrected table (`testOutboxPush.mjs`).
   The two fire-and-forget mail sites (`/org/invites`, the reference request) now observe the promise: a
   refused record or a failed send is logged by id (no address), never an unhandled rejection; the invite
   stands, as it always did; nothing manufactures a success record and the awaited sites are unchanged.
   Proven through the real route and a second connection: 201, the process alive, invite row and mail
   record in the route's one save with the array; the two-element array the regular expression also
   passes; a string; an object still 400; the admin view, restart, backup, restore, rollback blob and
   re-upgrade keep the array; the live transport with the locally intercepted provider receives the same
   JSON as before (`personalizations[0].to[0].email` = the array) and the row records its answer; the
   actual `6ca66ba` build reads the rollback copy, writes an array itself, and a file it created from
   scratch with an array invite upgrades on this build (`testOutboxPushServer.mjs`).
2. **Non-finite token values are kept live and persisted as null.** `cloneJson` takes an option; the
   token's clone (`validatePushTokenRow`, the mirror copies, the unit snapshot/restore, `forAudience`,
   `exportRows`) keeps a non-finite number as is, so the route's strict-equality rule works on the live
   value exactly as the array did (a repeated `+Infinity` collapses; `-Infinity` is another row; a
   persisted null from an earlier process is never the live `Infinity`); `token_json` holds
   `JSON.stringify`'s null, so a restart reads null as before; the provider receives the same payload
   (`to: null`, locally intercepted; identical on the `6ca66ba` build). Because `+Infinity`, `-Infinity`
   and a persisted null all read `"null"` in SQL, **a replacement deletes the removed rows by their own
   `seq`** (tracked per mirror row; the previous DELETE by `(kind, refId, token_json)` is gone), never by
   JSON text. Every other field — a registration's unknown fields, the outbox, the push log — keeps the
   strict rule; `undefined`, functions, symbols, bigints and class instances are still refused by name;
   the route's falsy-token 400 is unchanged and no `TOKEN_INVALID` policy exists. Proven in the
   repository (both write modes, aborted unit, failed save and retry, restart, backup, rollback) and
   through the real route with RAW bodies (five 201 and `[null,null,{"n":null},[null]]`; the same five again
   collapse only their own live rows; after a restart a new `1e400` removes none of the persisted nulls;
   finite primitives and fresh structurally equal objects as before; the `6ca66ba` build boots the
   rollback copy and persists its own raw overflow registration as null; re-upgrade).

**The backend-gate timing observation (reviewer: Node v24.19.0 / macOS; `testOutboxPushServer.mjs:118`,
the normal-mode push row not observed within 12 s, twice; an unchanged later run of the full suite passed;
the reviewer's own control probe passed on both builds).** Investigated, cause not confirmed: the
assertion is unchanged. What was inspected: the save path (`persist()` is a 2 s trailing debounce, `if
(saveTimer) return`, the timer nulled before the save; `persistNow()` clears and nulls it; `store.save` is
synchronous and absorbed only inside an open unit, which is synchronous too — no lost-wakeup path was
found); the effect path (the message's notification is created inside a unit, its after-durable push
effect runs after the unit's COMMIT, appends the push row to the staged queue and calls `nextId()` →
`persist()`); the deferral rule (`pushDeferred`: quiet hours need preferences the seeded recipient has
none of; the school-hours mute applies to minors and the seeded recipient was born in 2004); the
coalescing rule (a second identical unread `message` notification within six hours coalesces and sends no
push — the test sends one message per server); locking (WAL, `busy_timeout = 5000`, the test polls through
short read-only connections, which do not block a WAL writer). Six consecutive runs of the normal-mode test
on this machine (Node v22.22.2) passed, each landing through the 2 s debounce. What changed in the test,
supported by that evidence: (i) the in-memory check now asserts that THIS message's push row is in the admin
push log (it previously passed on any earlier row); (ii) on a timeout the assertion carries content-free
diagnostics — elapsed time, save revisions, row counts, the staged-write and pending-effect counts the
server reports, the child's exit code and its log tail with addresses redacted — so a recurrence is
diagnosable. No timer, retry or policy was added; the later-save boundary is unchanged. If the failure
recurs on the reviewer's machine, the diagnostics are the next evidence.

**Documents updated in place:** this section, §10.4, the status header; `sqlite-migration-plan.md` (status,
S7c objective); `sqlite-schema.md` (the outbox and token rows); `sql/03` (the DDL and the mapping);
`OPERATIONS.md` (the S7c section: destinations, non-finite tokens, scratch databases at `40aa05c`);
`CLAUDE.md`. Status at the time of this round: S7c corrections implemented, pending independent acceptance
(history; the review of `78c14b9` found one more boundary, §10.11, and the corrected `9119187` was accepted,
§10.12). S7b stays accepted at `ac50b60`; the notification nested-extras follow-up stays accepted at `6ca66ba`.

### 10.11 Independent review of `78c14b9` — one remaining destination boundary, corrected on top of `78c14b9` in `9119187` (17 October 2026; history — the status at the time was pending; **`9119187` was accepted, §10.12**)

**What the review found** (`review-78c14b9-summary.txt`; reproduction `review-78c14b9-reproductions.mjs
<candidate-root> <6ca66ba-root>`, run unchanged on the unchanged `78c14b9` tree against the `6ca66ba` checkout
before any edit: exit 1, one REPRODUCED finding — the log is in the handoff). The review verified both gates on
real Node v24.19.0 (backend 25 suites / 346 checks, Player 4 / 41), the five earlier reviewer scripts (all CORRECT)
and the actual pre-S7a/S7b/S7c rollback boots; the earlier push-timing failure did not recur there, which is a
passing run, not a root cause (the §10.10 observation and its diagnostics stand).

The two §10.10 corrections were proven separately — arrays for destinations, non-finite numbers for tokens — but
the coercing invite writer produces BOTH in one destination: raw JSON `["…"]`, `[1e400,"…"]` and
`[[-1e400],"…"]` all pass its regular expression, the elements parse to ±Infinity, and the accepted build kept
the live array until a restart and wrote null / nested null in those positions at the save. On `78c14b9` the
three invites answered 201 and the process stayed alive (the promise handler of §10.10), but `validateOutboxRow`
still applied the strict clone to `to`, so two mail records were refused after the route had reported success —
one outbox record instead of three, two refusals in the log.

**Correction (`repositories/outboxPush.mjs`; failing-first regressions recorded on the unchanged `78c14b9` tree —
`testOutboxPush.mjs` "[review of 78c14b9]" fails on the `to[0]` non-finite refusal, `testOutboxPushServer.mjs`
"[review of 78c14b9]" on the two refusals logged after 201 — logs in the handoff):** the destination's clone keeps
non-finite numbers live (`NON_FINITE_KEPT`) in validation, in every detached copy (`copyOutboxRow`: export,
`forAudience`-style reads, the unit snapshot and its restore), so the held view and the export show the live
array and the admin view and the provider serialise it to null exactly as the accepted build's array did; the
save boundary (`destinationColumns`) writes `JSON.stringify` of the live value — the accepted build's JSON, null
in the overflow positions, the array structure kept — and a bare non-finite destination (no writer produces one)
persists as the old JSON `null` (NULL/NULL). The earlier claim that a non-finite destination is refused is
withdrawn (test, comment and this document). Everything else is unchanged: ordinary strings, explicit null,
ordinary and nested arrays, both source shapes, insertion order, the save boundary, the promise handling, the
token semantics and deletion by `seq`, the strict rule for unknown fields, the push log and the dispatches, the
`40aa05c` scratch-file refusal and its rollback/re-upgrade path; no migration, no schema change. Proven in the
repository (live copies, detachment, failed save and retry, aborted unit, restart, backup, rollback, re-upgrade)
and through the real route with the three raw bodies (three 201, alive, no refusal logged, three invite rows and
three mail records in the routes' own saves, the stored JSON text, the admin view, restart, backup, restore, the
live transport's provider payload with the local stub, the rollback blob and the re-upgrade), with the actual
`6ca66ba` build persisting the same destinations for the same raw bodies, its file upgrading on this build, and
it reading and extending the rollback copy. Status at the time of this round: S7c correction implemented,
pending independent acceptance (history — the commit, `9119187`, was accepted, §10.12). S7b stays accepted at
`ac50b60`; the notification nested-extras follow-up stays accepted at `6ca66ba`.

### 10.12 Independent acceptance of S7c — `911918749687a3acdca430fe011d6c868ee640df` (17 October 2026)

**Decision, as recorded by the reviewer** (`review-9119187-summary.txt`, in the next-step bundle): *"S7c is
ACCEPTED for the bounded storage-migration scope reviewed here. No remaining blocking finding was identified
in this correction. This is not production/deployment approval or acceptance of unfinished S7d, S4b,
remaining S6 or S8 work."* S7b remains accepted at `ac50b60`; the notification-extras follow-up at `6ca66ba`.
The acceptance is a bounded code-review conclusion on the packaged source; it is not production, security,
legal-compliance or deployment approval, and it does not approve any retention, deletion, re-keying or
provider decision.

**What was reviewed.** `scoutbox-s7c-fix2-handoff-9119187.zip` (SHA-256
`30a2fc304b03692f54967391450e35fd413c4dc0f5ab7a19b5f164d1aa6edf5f`), declared commit `9119187`, parent
`78c14b9`: the checksum, a safe extraction and all 471 manifest entries verified; the six supplied reviewer
scripts byte-identical to the independent originals; the packaged source compared against the previous
handoff — the runtime change confined to `repositories/outboxPush.mjs`, the two focused suites and five
documents updated, the Player source unchanged; every manifest entry rechecked after testing.

**What the reviewer confirmed about the correction.** The unchanged `review-78c14b9` script passes against
the actual pre-S7c `6ca66ba` server: three raw invitation bodies produce three 201 responses, three
invitation records and three outbox records; the server stays alive and logs no destination refusal; the
older and current builds persist matching ordinary, null-containing and nested-null destination arrays.
Source inspection confirmed that accepted non-finite destination elements survive validation, detached
exports and transaction snapshot/restore, and that serialisation keeps the previous JSON boundary — the
missing-mail-record behaviour fixed without globally relaxing unknown fields, changing the schema, altering
the token replacement rule or changing the save boundary. The focused suites also cover failed-save retry,
aborted-unit restoration, restart, backup/restore, stubbed provider payloads, rollback and re-upgrade; the
earlier array-destination, process-crash and numeric-overflow-token corrections remain covered and passing.

**Independent results on the extracted, unmodified tree** (real Node v24.19.0, npm 11.6.0; dependencies
installed offline from cache with `npm ci --ignore-scripts` in both projects, both exit 0):

| Check | Result |
|---|---|
| backend `npm test` | exit 0 — 25 suites, 348 checks |
| Player `npm test -- --runInBand` | exit 0 — 4 suites, 41 tests |
| `m13E2E` | exit 0 — 212 checks |
| the six unchanged reviewer scripts | all exit 0 — 16 CORRECT checks in total |
| actual old-build rollback boots inside the backend gate | pre-S7a `2d7ddeb`, pre-S7b `0641b2c`, pre-S7c `6ca66ba` — old-build reads, writes and re-upgrade, not only a constructed legacy fixture |
| the earlier intermittent normal-mode push-timing failure (§10.10) | **did not recur** — a passing run, not evidence of a root cause; none has been established and the assertion and its content-free diagnostics stand |

**Limits the reviewer stated.** Additional real older/minimum-Node runtime binaries were not supplied (the
runtime suite reports that skip and labels its API-masking simulations separately); this work's Node 22
results are separate reported evidence, not the reviewer's runs. Browser suites, demo rebuilds, the full
wider E2E battery and production services or data were not exercised. No claim of exactly-once external
delivery is made; the documented later-save push durability window (D1, §10.3: a crash between the
notification's save and the next ordinary save loses the push row after the push was handed to the
transport) remains. No application source was edited, committed, pushed, merged or deployed by the review.

**What S7c is, now that it is accepted** (unchanged by this record; §10.8, §10.10, §10.11 are the detail):
`outbox`, `push_log` and `push_tokens` are tables since migration `0011_outbox_push`, written through
`repositories/outboxPush.mjs`; the destination is any JSON value (`to_address` / `to_json`, mutually
exclusive; a non-finite number inside an accepted array kept live and persisted as the old JSON null);
tokens are lossless JSON with the route's replacement rule by row `seq` and no uniqueness constraint; the
push row rides the sender's existing save scheduling; both outbox shapes, the promise handling, the strict
rule for unknown fields and the save boundary are as accepted. Not part of S7c, carried through unchanged
and still undecided: the staff push re-keying, the plain-code mail sites, retention after deletion, the
org-deletion question. No new e-mail validation, token uniqueness, re-keying or migration is introduced by
this record.

---

## 11. S7d — prepared 17 October 2026 from the code at `9119187` (§11.1–§11.8, dated history); IMPLEMENTED 18 October 2026 on top of `b67bce5` (§11.9), corrected after the independent review of `62e9c1a` (§11.10); independently ACCEPTED at `4f954ad` (§11.11); the S7a–S7c nested-restore observation classified (§11.12)

**Status now (19 October 2026): independently ACCEPTED at `4f954ad92cda6ca5178cc6c3d5485265684e0c03` for the bounded
backend storage-migration scope (§11.11) — not production, security, legal-compliance or deployment approval.** §11.9 is
the implementation record, §11.10 the one correction the independent review of `62e9c1a` required (an aborted unit of
work restores the nested objects of a held view by identity); both are dated history now. The Founder approved D-A and
D-B explicitly (recorded verbatim in §11.9); migration `0012_channels` is registered; the "PREPARED, NOT
IMPLEMENTED, NOT AUTHORISED" wording in the paragraph below and in §11.1–§11.8 is the status at the time those
sections were written and is kept as the dated record the implementation followed.

**Status at preparation (17 October 2026): PREPARED, NOT IMPLEMENTED, NOT AUTHORISED.** This section is a documentation-only readiness and
sequencing record: a read-only survey of the current code, a comparison of the two routes the plan allows
after S7c, one recommended smallest coherent milestone, and the decisions it needs. No migration is
registered, no identifier assigned, no repository, endpoint, DDL or runtime behaviour changed, no test
added; §10.12's acceptance is not reopened. Line numbers are those of `9119187` (`S:` is `server.mjs`).
Nothing here decides a retention period or a deletion policy.

### 11.1 Where the authoritative data lives today — tables versus blobs

| Record | Lives in | Evidence |
|---|---|---|
| `orgs`, `org_users`, `sessions`, `guardians`, `players` (+ twelve `player_*`), `media_deletions`, `email_challenges`, `pairing_codes`, `notifications`, `notification_prefs`, `dispatches`, `dispatch_attempts`, `outbox`, `push_log`, `push_tokens` | **tables** | `repositories/index.mjs:79` `TABLE_BACKED`; the store skips them at a blob save and `writeTableBacked`/`readTableBacked` carry them through a whole snapshot (`store.mjs:179`, `:384`) |
| `channels` (with nested `messages[]`, `attachment`, `readBy`) | **blob** | `storeContract.mjs:69` (`guarantee: 'migration'`); the one writer `openChannel` (S:952–972) pushes into `db.channels`; messages appended by `postMessage` (S:995–1026) |
| `requests` (`contactChannel`, `caseId`, `trialId`) | **blob** | `storeContract.mjs:172`; writers S:2242 and S:2874 (the open-day path); the acceptance routes set `request.contactChannel = channel.id` (S:1587 guardian, S:3433 player); the tombstone nulls it (S:4228) |
| `trials` (`requestId`, `caseId`) | **blob** | `storeContract.mjs:192`; `db.trials.push` S:2323; tombstoned by `tombstoneTrial` (S:4157–4207) |
| `recruitmentCases` | **blob** | `storeContract.mjs:146`; writers `m12/scouting.mjs:460`, `m17/rooms.mjs:579`, `:936`; name cleared on deletion (S:4258–4260) |
| `ledger` | **blob** | `storeContract.mjs:106`; `ledgerAppend` (S:687–694) is called by every message send (S:1004) and by both acceptance routes (S:1588, S:3434) |
| `reports`, `moderationLog` | **blobs** | `storeContract.mjs:154`, `:109`; `moderateOrRefuse` (S:1136–1150) pushes to both on a hit, then `persist()` |
| `blocks`, `orgNotes`, `opsEvents`, `sourceChanges`, `idvQueue` | **blobs** | S6, not started (plan §S6) |

So of the references the proposed `channels` DDL and the proposed `recruitment_requests` DDL make between
them, **every target but `org_users` is a blob today**: `channels.request_id → recruitment_requests`
(SQL03:71) names a table that does not exist; `recruitment_requests.case_id → recruitment_cases` (SQL02:539),
`trial_id → trials` (:540) and `user_id → org_users` (:519) name two blobs and one table;
`requests.contactChannel → channels` (SQL02:499 "no FK") points back at a blob. What that means for an
S8a-first route (corrected after the independent review of `46e5afe`, §11.7): **the request–trial pair is
not a dependency problem** — S8a introduces `recruitment_requests` and `trials` together, and a table can be
created in the same milestone as the table that references it, with both foreign keys enforced from the
start (`trials.request_id → recruitment_requests` RESTRICT, SQL02:632; `recruitment_requests.trial_id →
trials` SET NULL, :540): a request is inserted with `trial_id` null, its trial inserted, and the link filled
in the same transaction — the reviewer's probe `review-46e5afe-design-checks.mjs` demonstrates this with the
actual two definitions on an in-memory database (a feasibility check of the pair only, not approval of the
recruitment design). **What remains a real dependency is `recruitment_cases`**: `recruitment_requests.case_id`
(SQL02:539) and `trials.case_id` (SQL02:633) both reference a table of S8b, so an S8a-first route either
carries those two case columns as validated references without foreign keys until S8b (a transitional
device of the §2.3 kind, needing its own approval), or grows to S8a+S8b. No count of transitional
references is claimed beyond that: which columns need the device depends on how S8a and S8b are cut, and
that is decided when S8 is prepared, not here.

### 11.2 Readers, writers, deletion and the snapshot paths (current code)

- **Channel writers.** One creator, `openChannel` (S:952), called from the two acceptance routes (S:1586,
  S:3432), each of which then sets `request.contactChannel`, appends a ledger row, may issue a trial
  (S:1590, S:3436) and calls `persistNow()` (S:1607 guardian, S:3445 player) — **outside any unit
  of work**: the request's status change, the channel, the trial and the ledger row are one *save*, not one
  `unit()`. `postMessage` (S:995) appends the message, the ledger row and the notifications and calls
  `persistNow()` (S:1023). Read receipts: `channel.readBy.*` written at S:1634, S:2392, S:3475. No writer
  updates `requestId` after creation.
- **Channel readers.** Guardian routes (S:1614–1641), org routes (S:2366–2399), player routes (S:3453–3483),
  the player export (S:4140), `/admin/overview` count (S:4406), `/admin/channels` (S:4527), the SSE
  `channelId` lookup (S:523), m26 `channelReadableBy`/link-thread (m26/index.mjs:402, 1215) — the m26
  `linkedThreads[].channelId` references hold channel ids with no integrity rule and are left dangling by a
  player deletion (§4.2).
- **Request readers that cross into channels.** `postMessage` looks the request up to notify its creator
  (S:1013–1014); the accept routes hold the request as the argument, so the channel's `requestId` is the id
  of a request present in `db.requests` by construction.
- **Deletion (one unit, S:4245–4285).** `players.remove`, the requests and trials replaced by id-only
  tombstones (S:4256–4257; `contactChannel: null`, S:4228), the cases' name cleared, the module hooks, then
  `db.channels = db.channels.filter((c) => c.playerId !== playerId)` (S:4279) — the player's channels, their
  messages, attachments and receipts hard-deleted, guardian–club threads included — then
  `notifications.deleteForAudience` (S:4280, the S7a repository joined in this unit). Ledger rows stay
  (S:4283). No guardian or organisation deletion route exists (§4.2).
- **Snapshot paths.** A backup (`m13/enterprise.mjs:431`) writes `db.json` with every blob and the table-backed
  collections in row form; a restore boots a copy of the directory, and the store writes table-backed
  collections back through `writeTableBacked(sqlite, snapshot.db)` (`store.mjs:179`) — the place where
  S6a's `PAIRING_CODE_PLAYER_MISSING` and S7a's shape checks run against the same snapshot. Copy-only
  rollback tools chain newest-first (`outboxPushRollback` → `dispatchesRollback` → `notificationsRollback`
  → `oneTimeCodesRollback` → …), each refusing a later schema by migration id.
- **What the send path writes after S7a–S7c.** A message send still writes the `channels` and `ledger` blobs
  (and, on a moderation hit, `moderationLog`/`reports`) through `persistNow()`, plus the staged notification
  row; the push row lands with the later save (D1). Moving channels alone leaves `ledger` — and, on the
  acceptance path, `requests` and `trials` — as whole-blob writes in the same save: **the "no whole-database
  write on send" objective is not met by S7d alone** (§7.3 phases stand). This section does not propose a
  dirty-save or performance refactor.

### 11.3 The two routes compared — what enforces integrity at each boundary

Route **A**: S7d (`channels`, `messages`, `message_attachments`) with the §2.3 transitional validated
`request_id` (no foreign key; validated in code against the authoritative `requests` blob). Route **B**:
recruitment first — S8a (`recruitment_requests`, the request slots and the trial tables) so that `channels`
can later reference a table directly.

| Boundary | Route A — S7d with the transitional reference | Route B — S8a first |
|---|---|---|
| ordinary write (channel open) | the repository's `open(request)` refuses a `requestId` that is not the id of a request in `db.requests` (the blob is still authoritative), refuses a second channel for one request (the unique index `channels_request_id`, SQL03:86, is real DDL and enforced by SQLite), staged into the acceptance route's own `persistNow()` save as S7b/S7c stage theirs — the request's status, the channel row, the trial and the ledger row stay one save | `recruitment_requests` and `trials` rows written by repositories inside the request/trial routes with their mutual foreign keys enforced from the start (request inserted with `trial_id` null, trial inserted, link filled in the same transaction — §11.1, §11.7); the two `case_id` columns (requests :539, trials :633) either wait for `recruitment_cases` (S8b) or ship as validated references without FK — a transitional device of the §2.3 kind needing its own approval; `contact_channel_id` stays a plain id (SQL02:499 says so) because `channels` is still a blob |
| joined transaction (deletion unit) | the repository's `deleteForPlayer(playerId)` joins the deletion `unit()` (S:4245) exactly where the filter runs today (S:4279): the same rows go, in the same transaction as the tombstones and the notification deletion | the request/trial tombstoning (S:4256–4257) becomes repository updates in the unit; channels stay a blob filter |
| import (the cutover migration) | preflight refuses the cutover, file unchanged, when a channel's `requestId` names no request in the file's `requests` blob or two channels name one request (ids listed, no text) — the §5.3 pattern; message ordering keyed by array position (the ordering column, §1.2) | preflight validates the natural keys SQL02 lists (one pending request per org/player/type — bypassed today by the open-day path, SQL02:505; the 1:1 trial link) and every `case_id`/`trial_id` against the blobs or tables as they stand; the plan already says conflicts are "resolved by data fix with a written record, never by the migration guessing" |
| snapshot write — full or PARTIAL (restore, persistence suites) | the **final combined state** is validated whichever side the snapshot carries (§11.5 "Snapshot validation"): incoming channels against the final `requests` (the supplied collection, or the retained blob when `requests` is omitted); incoming `requests` against the retained channels when `channels` is omitted; both supplied → the proposed combination; one miss refuses the whole transaction, unrelated data untouched (the identity `trials` reconciliation and the S6a `PAIRING_CODE_PLAYER_MISSING` precedents, `identity.mjs`, `oneTimeCodes.mjs`) | the same final-state device for the two `case_id` columns against the snapshot's or retained cases until `recruitment_cases` is a table; the request–trial pair is enforced by its own foreign keys |
| deletion | today's explicit filter reproduced as an explicit repository delete inside the unit; **no CASCADE and no RESTRICT on `players(id)`** in the S7d DDL (§2.4: a RESTRICT would fail today's hard delete; a CASCADE encodes an open retention decision) | the tombstone rewrite of requests/trials becomes row updates; `recruitment_requests.player_id` still has no FK (SQL02:511; O1/S4b) |
| copy-only rollback | `channelsRollback` rewrites every channel with its nested messages, attachments and `readBy` into the `channels` blob the `9119187` build reads; refuses a later schema; the S7c tool refuses a file carrying the S7d id — nothing lost, proven by booting the copy on the actual `9119187` build | the same for requests/trials — a larger blob shape (slots, history, keys, day/schedule containers, tombstone shapes) to prove losslessly |
| the eventual foreign-key upgrade | when S8a creates `recruitment_requests`, its migration rebuilds `channels` with `REFERENCES recruitment_requests(id) ON DELETE RESTRICT` (SQLite cannot add a FK in place; the S4a/S5 rebuild pattern) after its own preflight proves every `request_id` resolves — true by construction if A's validation has held | when S8b creates `recruitment_cases`, `recruitment_requests` and `trials` are rebuilt with their `case_id` FKs if those shipped as validated references; `channels` (still a blob) joins at S7d with a direct FK |
| size of the step | three tables, one creator, one appender, three receipt writers, one deletion site, ~20 readers; the smallest aggregate left in S7 | 14 tables for requests + trials (SQL02; the trial day/schedule/attendance/consent containers; `keys` → `idempotency_keys`), fifteen `db.requests` and ten `db.trials` sites in `server.mjs` alone plus `m23/*`; O1's open parts bear on `recruitment_requests.player_id` directly; the largest aggregate in the system |

Neither route may use an empty placeholder table or silently drop an integrity check (§2.2). Each route
carries at least one validated non-FK reference somewhere until a later stage: A carries
`channels.request_id` until S8a; B carries whatever its cut leaves pointing at `recruitment_cases` until S8b
(the request–trial pair itself needs none, §11.1) and still leaves `channels` for later. **A is recommended as
the smaller coherent step on its actual scope**: three tables, one creator and one appender, no `players(id)`
reference, one already-specified device (§2.3 step 4) — against B's fourteen tables, the largest aggregate in
the system, the open O1/O2 decisions the plan §S8 lists as blocking its migration, and the `recruitment_cases`
dependency. The recommendation does not rest on B needing more transitional references than A.

### 11.4 Which deletion and retention decisions block which route

| Decision | Kind | Blocks A (S7d, storage-only)? | Blocks B (S8a)? | Where it is needed |
|---|---|---|---|---|
| message retention after a player deletion (`s4-deletion-decision.md` §4 "messages — review") | **product policy / legal** | **not if** the step is explicitly storage-only and reproduces today's hard delete of the player's threads inside the unit, with no CASCADE and no RESTRICT in the DDL (decision **D-B** below confirms that reading) | no | S4b (the tombstone makes a CASCADE inert; the retention form must be designed then) |
| the §2.3 transitional validated `request_id` (code-enforced, no FK, later FK rebuild) | **technical design approval** | **yes** (decision **D-A**) | no (B needs its own approval only for what its cut leaves pointing at `recruitment_cases` — the two `case_id` columns — not for the request–trial pair, §11.1) | S7d |
| O1 open parts — country code on the retained record; child-status stamping | product policy | no (S7d adds no `players(id)` reference and no safeguarding stamp) | partly — `recruitment_requests.player_id` gets its FK only at S4b/S8a amendment (plan §S8) | S4b, S8a |
| O2 — organisation deletion policy | product policy | no (`org_id RESTRICT` on a table nobody deletes from changes nothing; §2.4) | yes for the file-02 `RESTRICT` choice (plan §S8) | S8a |
| dispatch cascade with notifications (§4.3 a) | product policy | no | no | S7b follow-up / S4b |
| removed-staff notifications and e-mail destinations (§4.1) | product policy | no | no | a behaviour change of its own |
| staff push re-keying (§1.8) | product/behaviour | no | no | a behaviour change of its own |
| plain-text codes in six mail sites (§1.6) | owner decision | no | no | an S6-area correction |
| retention periods for the append-only logs (§4.4) | product policy / legal | no | no | before any pruning is designed |

**Could a bounded storage-only step preserve today's explicit deletion behaviour without deciding
retention?** Technically yes: the repository deletes the player's channels inside the deletion unit exactly
where the filter runs today, the DDL carries `player_id TEXT NOT NULL` with **no** `REFERENCES players(id)`
clause (as `pairing_codes.player_id`, SQL03:912–926, already does by design), and the retention question
stays open with its answer to be designed at S4b. The trade-off is explicit: the DDL then documents that it
encodes no lifecycle for the player reference; a later retention decision in either direction (erase, or
keep in some redacted form) is a behaviour change with its own migration and tests, not a free consequence of
the table; and the step must be labelled as preserving today's behaviour, not as settling it. **This option
is not selected here** — it needs the Founder's confirmation (D-B), because choosing it means the messages of
a deleted player keep being erased for now, which is today's behaviour but is also one side of the open
question. The alternative is to wait for the retention answer before S7d (then A is blocked until S4b's
policy work, and nothing in S7 can proceed; S6's audit tables wait for S4b too; B is the only movable
storage step and it is the largest).

### 11.5 The recommendation — S7d, storage-only, with the §2.3 transitional reference (PREPARED 17 October 2026; IMPLEMENTED 18 October 2026 as recorded in §11.9 — the wording below is the specification the implementation followed)

**Objective.** `channels`, `messages` and `message_attachments` become tables with lossless, one-to-one
mappings (§1.2); `db.channels` becomes a read-only view in insertion order with each channel's `messages`
nested as today; every route answers exactly as before; today's deletion behaviour is reproduced, not
changed; a copy-only rollback loses nothing. It is a storage move only.

**Scope.** The three tables of SQL03:69–158 with these amendments to make before the DDL is written
(corrected after the review of `46e5afe`, §11.7): `request_id TEXT NOT NULL` **without** the `REFERENCES
recruitment_requests(id)` clause and with a comment stating the transitional validation and the planned
rebuild at S8a; `player_id TEXT NOT NULL` **without** a `REFERENCES players(id)` clause (today's hard delete
reproduced in code; §2.4); `guardian_id` **without** a `REFERENCES guardians(id)` clause, validated in code
against the final identity state (the `pairing_codes.player_id` precedent, SQL03:912) — a **bounded design
choice, not a SQLite necessity**; its trade-off against a deferred foreign key and the exact validation
trigger are in "Dispatch order and retained constraints" below, corrected after the review of `8330f08`
(§11.8); `org_id … REFERENCES orgs(id) ON DELETE RESTRICT` **kept** as DDL; an insertion-order key on
`channels` (`seq INTEGER PRIMARY KEY`, `id TEXT NOT NULL UNIQUE`, the S7a–S7c pattern — the list order every
reader sees today is `db.channels` array order) and an ordering column on `messages` for equal `created_at`
(array position at import, the next position at append — §1.2); `extra_json` on `channels`, `messages` and
`message_attachments` for present legacy and unknown own fields (next paragraph). **The earlier instruction
that the view may omit `orgUserIdForNotify` is withdrawn** (§11.7): the field is never written by the current
creator, but a value present in a legacy record IS observable — `channelViewFor` (S:1048) spreads the channel,
the JSON export carries it, and the reviewer's probe shows both with the actual function — so it is preserved
like any other present legacy field, with no dedicated column and no new runtime use. **Exclusions:** no FK to
`recruitment_requests` or `players`; no CASCADE or RESTRICT tied to the player or request lifecycle; no
retention or pruning; no change to moderation, visibility, blocks, typing, SSE, read receipts' semantics or
the ledger (which stays a blob); no touch of `requests`, `trials`, `recruitmentCases`, m26 `linkedThreads`;
no re-keying; no S4b, S6 or S8 work; no performance claim beyond the measured §7.3 phase; no general
persistence refactor.

**Legacy-field preservation (the storage-only contract, stated precisely).** Every present, JSON-compatible
own field of a legacy record that the mapping does not name is preserved losslessly and round-trips through
import, the live view, export, the unit snapshot and its restore, a whole-snapshot write and the copy-only
rollback — at every level: unknown own keys of a **channel** (`orgUserIdForNotify` among them) in the channel's
`extra_json`; unknown own keys of a **message** in the message's `extra_json`; unknown own keys of an
**attachment** in the attachment's `extra_json`; unknown own keys inside the known nested objects **`readBy`**
and **`sender`** kept under those known key names inside the parent's `extra_json` (a known key can never
collide with an unknown one, so the nesting is unambiguous and needs no extra column). Copies are detached
and prototype-safe (`setOwn` at every depth; an own `"__proto__"` key is data — the S7a rule, `notifications.mjs`
`cloneJson`/`setOwn`), spread back FIRST on export so the mapped fields win (the S7a/S7b/S7c convention).
Absence is preserved as absence: no key is manufactured, no `null` invented for a missing field, no present
value erased, no payload shape normalised. A value JSON cannot carry cannot come from a file (the blob was
JSON); a live non-finite number is kept live for the process and persisted as the blob's JSON would have
written it (null), the S7c rule — never a refusal of the whole record for that reason alone. Unknown fields
are preserved, not validated against a vocabulary; the refusals below concern only the literal's required
fields and the reference checks.

**Prerequisites.** (1) decision D-A approved; (2) decision D-B confirmed; (3) the SQL03 amendments above
agreed as the DDL to build (a documentation change in `sql/03`, asserted by `testSchemaDdl`); (4) the next
free migration identifier, assigned only when the step is authorised (the plan's rule; none is assigned here).

**Transaction boundaries.** `channels.open(request)` is called where `openChannel` is called today, inside
the acceptance routes' flow, and **staged into the save the route already performs** (`persistNow()`, the
S7b/S7c staged-participant pattern) so the request's status, the channel row, the trial and the ledger row
remain one committed save — the routes are not converted to `unit()` for this step (that would be a wider
change to the acceptance flow; it is noted, not proposed). `messages.append(channelId, msg)` is staged into
`postMessage`'s `persistNow()` save with the ledger row and the notification; the duplicate `clientMsgId`
check is a read on the repository. Read receipts are one `UPDATE` each, staged into the routes' saves.
`channels.deleteForPlayer(playerId)` **joins the deletion unit** at S:4279 (the S7a `deleteForAudience`
precedent). Every refusal is raised inside the participant boundary; a failed ordinary save keeps the
pending state for the next save; an aborted unit restores the pre-unit mirror (the S7c snapshot/restore
hooks).

**Migration and preflight rules.** The migration imports the `channels` blob from the file in one
transaction, records the cutover and its counts (channels, messages, attachments, receipts, unknown-field
rows — never text) in `meta`, and deletes the blob row after the rows are written (the 0008–0011 pattern).
Accepted shapes are §5.2's: the `openChannel` literal with `readBy`, messages of the `postMessage` literal
with `clientMsgId` present or absent and `attachment` null or one of the two shapes; unknown fields detached
into `extra_json` with own keys preserved (the S7a rule); nothing coerced. **Refusals, whole write, file
unchanged, ids only:** a channel whose `requestId` names no request in the file's `requests` blob; two
channels naming one request; a message whose `sender.kind` is outside the three kinds; an attachment of
neither shape; a channel missing a required field of the literal. A stale in-memory `channels` array after
cutover is dropped and counted, never imported (the S6a/0006 rule). Refusal text names no message content.
The request-existence check is exactly that — the id names a request present in the final `requests` — and
is kept distinct from any new rule about a request's `status`, `contactChannel` or other fields, which would
need evidence from the existing writers (tombstoned requests keep their id with `contactChannel: null`,
S:4228; nothing removes a request from `db.requests`, S:4256 is the only reassignment) and is not proposed.

**Snapshot validation — the FINAL combined state, in both directions** (corrected after the review of
`46e5afe`, §11.7). The snapshot contract allows PARTIAL writes: an omitted collection is retained unchanged,
an explicitly supplied non-array refuses, absence and an empty array are distinct (`repositories/index.mjs:111–134`
`checkTableBackedShapes`; `store.mjs` `writeBody`). The channels table joins `writeTableBacked` with ONE
final-state assertion in the identity `trials`-reconciliation and S6a `assertPairingCodesConsistent` shape
(`index.mjs:146`, `:170`). **Trigger (corrected after the review of `8330f08`, §11.8 — the earlier
"channels written OR requests present" missed identity-only snapshots):** the assertion runs when **any** of
these holds — `channels` was written; the snapshot carries `requests` (present as a key); **the identity pair
(`players` + `guardians`) was written**. A snapshot that touches none of the three leaves every reference
untouched and needs no check. **Sources, per parent and child, always the FINAL state of this transaction:**
the channels are the rows of the `channels` table after this snapshot's dispatch (the incoming collection if
written, the retained rows otherwise); the guardians are the rows of the `guardians` table after the identity
rewrite (read back from the table, never from the incoming array alone); the organisations are the `orgs`
table after its prune; the requests are `Object.hasOwn(db, 'requests') ? db.requests : <the retained requests
blob read from the file>`. Never an empty set for an omitted collection; a present non-array is a malformed
explicit value and refuses.
- *Identity pair supplied, `channels` and `requests` omitted* (the case the review of `8330f08` named): every
  **retained** channel's `guardian_id` (when non-null) must name a guardian in the rewritten `guardians`
  table; a miss refuses the whole transaction (`CHANNEL_GUARDIAN_MISSING`, channel and guardian ids only) —
  tables, unrelated blobs and the save revision unchanged. Retained guardians rewritten in place pass, with
  channel, message and receipt rows, order and content untouched (the channel group is not dispatched).
- *Incoming `channels`, `requests` omitted:* every incoming channel's `requestId` must name a request in the
  **retained** requests blob; a miss refuses the whole transaction (`CHANNEL_REQUEST_MISSING`, channel ids
  only), nothing written, the retained data untouched.
- *Incoming `requests`, `channels` omitted:* every **retained** channel's `request_id` must name a request in
  the incoming collection; a miss refuses (`CHANNEL_REQUEST_MISSING`, the orphaned channel ids), so a request
  cannot be removed under a channel that still names it. A check that runs only when channels are replaced
  would miss this case; the assertion is keyed on the presence of `requests` too.
- *Both supplied:* the proposed final combination is validated — a coordinated removal (request and its
  channel both absent) succeeds; an invalid combination refuses the entire transaction without altering
  unrelated data.
- *Identity pair and `channels` supplied:* a guardian and its channel removed together succeed when every
  remaining channel's `guardian_id`, `org_id` and `request_id` resolve; an invalid coordinated replacement
  (a guardian removed, a channel naming it kept or incoming) refuses whole — no partial deletes, no leaked
  effects (the snapshot write schedules none).
- *Incoming `channels` with an invalid `guardian_id`, identity omitted:* refused against the **retained**
  `guardians` table (`CHANNEL_GUARDIAN_MISSING`); likewise an incoming `org_id` naming no organisation is
  refused by the `org_id` foreign key at the INSERT.
- *Malformed explicit collections:* `channels` present but not an array refuses before any statement (the
  `checkTableBackedShapes` rule); `requests` present but not an array refuses whenever the assertion needs it
  (the identity `trials` wording: "supplied with the snapshot is … not an array"); an **empty** `requests`
  array with retained or incoming channels refuses (every channel orphaned) — it is a supplied value, not an
  omission. No silent cleanup, no dropped rows, no invented parents.
- *Where it runs, who reports:* inside the one snapshot transaction, in `writeTableBacked` after the channel
  rows are dispatched and before the blob loop writes `requests` and the other blobs (the incoming `requests`
  value is read from the snapshot object, as the identity code reads `trials`); a refusal throws out of
  `writeTableBacked`, `write()` rolls the transaction back, and the caller — the restore boot (`store.mjs:375`,
  fatal, `db.json` left in place), the persistence suite or the legacy import — receives the typed error. The
  staged save hooks are not involved: an ordinary server-mode save does not pass through `writeTableBacked`
  (`asSnapshot` false), and its channel rows were validated at `open` time inside the participant boundary.
  The duplicate-request rule (two channels, one request) is the unique index and fires on the offending
  INSERT inside the same transaction.

**Dispatch order and retained constraints** (corrected after the review of `46e5afe`, §11.7). "No
CASCADE/RESTRICT" in this section means **no constraint that encodes the unapproved player or request
lifecycle** — nothing more. These remain: `org_id … REFERENCES orgs(id) ON DELETE RESTRICT` (real DDL, as
SQL03:74 proposes; organisations are upserted and pruned, never rewritten, `orgs.mjs` `prune`); the unique
index on `request_id`; `messages.channel_id … REFERENCES channels(id) ON DELETE CASCADE` (SQL03:114) and
`message_attachments.message_id … REFERENCES messages(id) ON DELETE CASCADE` (SQL03:147) — internal
parent–child cascades that fire **only after an explicit channel deletion** (the repository's
`deleteForPlayer` inside the deletion unit, or a snapshot that no longer lists the channel) and reproduce
today's nesting, where a message exists only inside its channel array; and the identity/org snapshot prunes
as they are.

*The guardian reference — the engine facts, corrected after the review of `8330f08` (§11.8).* The earlier
text here claimed that a RESTRICT action fires immediately even under `PRAGMA defer_foreign_keys` and that
the proposed `guardian_id … RESTRICT` (SQL03:80) therefore could not coexist with the identity snapshot
rewrite (`DELETE FROM guardian_children; DELETE FROM players; DELETE FROM guardians;` then reinsertion,
`identity.mjs:205–207`). **That claim is withdrawn.** The reviewer's probe `review-8330f08-design-checks.mjs`,
run unchanged here (Node v22.22.2, SQLite 3.51.2; the reviewer: Node v24.19.0, SQLite 3.53.3), verifies on
the real engine that: (a) with the pragma off, RESTRICT refuses at the DELETE whether or not the column is
declared `DEFERRABLE INITIALLY DEFERRED` — the declaration and the pragma are different mechanisms; (b) with
`PRAGMA defer_foreign_keys = ON` inside the transaction, deleting and reinserting a retained guardian commits
with its channel intact; (c) a retained channel whose guardian is genuinely gone is refused at COMMIT and
rolled back; (d) an explicit `PRAGMA foreign_key_check` run before the child rows are cleaned still sees the
intermediate orphan even with deferral. So a foreign key is **possible**. What a foreign-key design would
actually require in this codebase: (1) the normal snapshot transaction does not enable the pragma — the one
occurrence in `store.mjs:403` is the test seam `failCommitOfOpenTransaction`, not `write()`'s setup — so
`write()` would set `PRAGMA defer_foreign_keys = ON` for snapshot writes; (2) `identity.mjs:225` runs
`PRAGMA foreign_key_check` immediately after the identity rewrite and throws on any broken reference, so a
coordinated removal (guardian and its channel both absent) would fail there unless the channel rows the
snapshot no longer lists are deleted **before** the identity rewrite while the new channel rows are inserted
**after** it — a split dispatch of the channel group — or that check is relaxed to the end of the snapshot
write. Both are changes to existing persistence code outside the new table group. **The bounded choice this
section keeps is the code-validated reference:** `guardian_id` carries no FK clause (the
`pairing_codes.player_id` precedent, SQL03:912–926, chosen there for the same rewrite), and the final-state
assertion above, with its corrected trigger, reproduces RESTRICT semantics in code for every parent-only
removal while allowing a coordinated one. **Trade-off, stated:** the code path carries the integrity rule
instead of the engine, so it must run on every path that can rewrite guardians (next paragraph) and its
coverage is proven by the regression cases, not by a constraint; in exchange the store's transaction setup,
the identity check and the dispatch structure stay as they are. The foreign-key alternative above is concrete
and in scope if DDL enforcement is preferred at implementation time; it is described, not implemented, and
choosing it is part of approving S7d's DDL, not a decision this document takes.

*Every path that can remove or replace a guardian, and how the rule covers each (surveyed at `8330f08`).*
Ordinary writers: `guardians.insert` and `guardians.update` (identity.mjs:805, :829; callers S:1337, 1365,
1388, 1425, 1444, 1699, 4122, 4506) never remove a row; `players.remove` (identity.mjs:768) deletes a player
and its link rows and never a guardian; `unlink`/`ageUp` (identity.mjs:549, :757) remove link rows only;
`DELETE /guardian/children/:id` (S:4307) deletes the **child player** through `deletePlayerData`; there is **no
guardian-deletion HTTP route** today (§4.2). Nothing to validate on these paths — a guardian cannot
disappear through them. Snapshot writes (`writeTableBacked`: the legacy `db.json` import at boot,
`store.mjs:375`; a restore; the persistence suites) — the only paths that rewrite the `guardians` table
wholesale — are covered by the assertion with the identity-pair trigger. The S7d cutover migration imports
the `channels` blob on a file whose identity tables are already live (0005 precedes it), so its preflight
validates every channel's `guardian_id` against the `guardians` table of the same file and refuses the
cutover otherwise (ids only, file unchanged). The copy-only rollback tools run newest-first: the S7d tool
restores the channels blob before `coreIdentityRollback` may drop the identity tables (that tool refuses a
later schema, `LATER_SCHEMA`, coreIdentityRollback.mjs:160), so no rollback leaves a channel row behind
without its guardian table.

**Ordering within `writeTableBacked`:** the channel group is dispatched **after** the identity pair and the
users/sessions writes and **before** the `sessions`/`users`/`orgs` prunes (`index.mjs:154`), deleting the rows
the snapshot no longer lists and upserting the rest, so that a legitimate full replacement removing an
organisation **and** its channels succeeds (the channel rows are gone before the org prune), while an
organisation removed with its channel retained is refused atomically by the `org_id` RESTRICT at the prune,
and a guardian removed with its channel retained — whether the identity pair came alone or with channels — is
refused by the final-state assertion, which runs **after** the prunes and reads the final `guardians`, `orgs`
and `channels` tables and the final requests. Both refusals roll the whole transaction back with unrelated
data and the save revision untouched. This is a dispatch-order rule and one assertion for one new table
group, not a general persistence refactor.

**Order preservation.** The channel list order every reader sees (`db.channels` array order: the guardian,
org, player, admin and export routes all filter that array) is the `seq` insertion key; messages within a
channel keep array order through the ordering column, ties on `created_at` included. Both survive save,
restart, export (`db.json` row form in `seq` order), a whole-snapshot write (rows inserted in the snapshot's
array order) and the copy-only rollback (`ORDER BY seq`, messages by position).

**Copy-only rollback.** `repositories/channelsRollback.mjs` + `scripts/channelsRollback.mjs <data-dir>
<fresh-empty-dir>`: every channel rewritten into the blob literal with its nested messages in order,
attachments and `readBy`, the migration record removed, the S7d tables dropped from the copy; refuses a file
carrying a later schema; the S7c tool refuses a file carrying the S7d id (`LATER_SCHEMA`, the chain rule).
Proven by booting the copy on the actual `9119187` build, reading the same channel ids, messages and
receipts in the same order through `/org/channels`, `/guardian/channels`, `/player/channels` and
`/admin/channels`, posting a message there, and re-upgrading the extended copy on the S7d build — nothing
lost.

**API compatibility.** Every channel, message and receipt payload byte-identical in shape and order
(`channelViewFor`, `/admin/channels` returning every channel with ids; present legacy fields such as
`orgUserIdForNotify` still present, absent ones still absent); the channel list in today's array order;
messages oldest-first with insertion order preserved for equal timestamps; `201` with the stored message on a duplicate `clientMsgId`;
`/admin/overview` counts; the player export's `threads`; the SSE `channelId` lookup; m26 `channelReadableBy`
and link-thread behaviour; the backup format (`db.json` carries the channels in row form as S7a–S7c's
tables do) and a restore into a fresh directory.

**Failing-first tests** (recorded failing on the unchanged `9119187` tree before the implementation):
`scripts/testChannels.mjs` — migration shapes and refusals (orphan `requestId`, duplicate request, bad
sender kind, bad attachment, unknown fields detached), repository open/append/receipts/delete, staged save
and failed-save retry, aborted unit restore, ordering with equal timestamps, snapshot replace with the
request validation, rollback and re-upgrade; `scripts/testChannelsServer.mjs` — the real routes through
both acceptance paths (adult and guardian), messages from all three sender kinds with both attachment
shapes, the duplicate `clientMsgId`, read receipts, the player deletion through a second connection (the
player's threads gone, guardian–club threads of that player included, as today; other players' intact),
backup/restore, SIGKILL between accept and save, the copy-only rollback on the actual `9119187` build
(`SCOUTBOX_PRE_S7D_SERVER`) and the re-upgrade. **Added by the review of `46e5afe` (§11.7) — design
requirements for the future suites, not claims about an unimplemented repository:**
- legacy-field preservation: a channel record carrying `orgUserIdForNotify` and an unknown own key (an own
  `"__proto__"` key among them), a message with an unknown own key and an unknown key inside `sender`, an
  attachment with an unknown own key, an unknown key inside `readBy` — each imported, visible in
  `channelViewFor` for every viewer kind, in `/admin/channels`, in the player export, in `db.json`, after a
  restart, through a whole-snapshot write and through the copy-only rollback blob, with absent fields absent
  (no manufactured null) and present values byte-identical; a live non-finite number persisted as null, as the
  blob's JSON would;
- partial snapshots, both directions: `channels` supplied with `requests` omitted against retained requests
  (valid passes; an orphan refuses, nothing written); `requests` supplied with `channels` omitted (a request
  removed under a retained channel refuses; a request set that keeps every referenced id passes); both
  supplied (a coordinated removal of a request and its channel passes; an invalid combination refuses the
  whole transaction with unrelated collections untouched — asserted by reading them back); `requests`
  supplied as an empty array with retained channels refuses; `channels` or `requests` supplied as a non-array
  refuses before any statement; absence versus empty array distinguished in every case;
- parent pruning order: a full replacement removing an organisation together with its channels succeeds; an
  organisation removed while its channel is retained refuses atomically (the `org_id` RESTRICT);
- the guardian reference, every trigger (added by the review of `8330f08`, §11.8): (i) identity pair only —
  `players` and `guardians` supplied, `channels` and `requests` omitted — with a referenced guardian removed:
  refused atomically (`CHANNEL_GUARDIAN_MISSING`); the tables, the unrelated blobs and the save revision
  (`meta.saveSeq`) read back unchanged; (ii) identity pair only with every referenced guardian retained:
  succeeds, and the channel, message and receipt rows, their order and their content read back identical;
  (iii) identity pair and `channels` supplied, a guardian and its channel removed together: succeeds when
  every remaining `guardian_id`, `org_id` and `request_id` resolves; (iv) an invalid coordinated replacement
  (a guardian removed while a channel naming it is kept or incoming): refused whole — no partial deletes,
  no leaked effects, unrelated data and the save revision unchanged; (v) `channels` only with an invalid
  `guardian_id`, identity omitted: refused against the retained `guardians` table; plus the identity rewrite
  of retained guardians with guardian channels present succeeding (the pairing-codes precedent in practice);
- order: the channel list order and the message order, ties on `created_at` included, identical through
  save, restart, export, a whole-snapshot write and the rollback blob;
- request-existence only: a channel whose request is a tombstone (`contactChannel: null`, `playerName: null`)
  imports and restores unchanged — no status or field rule is added.
Existing suites unchanged and green: `apiE2E`, `connectedE2E`, `m13E2E`, `m23ContactE2E`,
`m23P4AClosureE2E`, `m26*` (linked threads), the S4a/S5 deletion suites, both gates.

**Acceptance criteria.** Both gates green on the final tree with the four old-build paths available
(pre-S7a/S7b/S7c/S7d); the two suites above; the §7.3 phase-S7d benchmark number recorded honestly (the
ledger blob still written per send, stated); the preflight refusals exercised on synthetic files; the
rollback proven on the actual `9119187` build; no route payload changed; no present legacy field dropped and
none manufactured; no retention behaviour, no player- or request-lifecycle cascade or restrict, no re-keying
introduced; the partial-snapshot cases in both directions, the five guardian-trigger cases and the
prune-order cases above exercised; the DDL comment states the transitional reference, the S8a rebuild and the
guardian-reference choice with its trade-off (a code-validated reference, not an engine impossibility); the
documents updated in place with S7d marked pending independent acceptance until reviewed.

**Likely files** (from the survey, not line-guessed): new `repositories/channels.mjs`,
`repositories/migrations/<next-id>_channels.mjs`, `repositories/channelsRollback.mjs`,
`scripts/channelsRollback.mjs`, `scripts/testChannels.mjs`, `scripts/testChannelsServer.mjs`;
`repositories/index.mjs` (`TABLE_BACKED`; the snapshot dispatch order — the channel group after the identity
pair and users/sessions, before the `sessions`/`users`/`orgs` prunes, with the final-state assertion after the
prunes, keyed on `channels` written OR `requests` present OR the identity pair written — "Snapshot
validation" and "Dispatch order and retained constraints" above);
`server.mjs` (`openChannel`, `postMessage`, the three `readBy` routes, `deletePlayerData`, the readers listed
in §11.2 if the view does not cover them, the SSE lookup); `m26/index.mjs` (reads only, if the view does not
cover them); `m13/enterprise.mjs` (backup export); `storeContract.mjs` (remove `channels`);
`repositories/outboxPushRollback.mjs` (refuse the S7d id); `docs/architecture/sql/03_messaging_safety_audit.sql`
(the amended DDL and comments); `scripts/testSchemaDdl.mjs`; `OPERATIONS.md`; `CLAUDE.md`; this review and
the plan.

**Alternatives considered and not recommended first:** B (S8a) — §11.3; the S6 `ledger` — blocked by S4b
(S6 review §4.1); S4b — blocked by the open country-code decision (`s4-deletion-decision.md` §10 table);
S7d with a direct FK — impossible without S8a (§2.2).

### 11.6 Decision brief for the Founder — only what blocks the recommendation

Recommended path: **S7d, storage-only, with the transitional validated request reference** (§11.5). It is
next because it is the last S7 aggregate, the smallest coherent storage step left, has one creator and one
appender, needs no `players(id)` reference, and its one design device is already specified; the
recruitment-first alternative is larger (fourteen tables, the largest aggregate in the system), still depends
on `recruitment_cases` for its two `case_id` columns (the request–trial pair itself can ship with its foreign
keys enforced, §11.1 — corrected after the review of `46e5afe`) and carries the open O1/O2 policy decisions.
Technical and retention/legal questions are kept apart below. No retention period is invented; no note here
establishes legal compliance.

**Blocking decisions (two).**

- **D-A (technical design approval).** Approve the §2.3 step-4 transitional reference for `channels.request_id`:
  `NOT NULL`, unique index, **no foreign key**, validated in code against the authoritative `requests` blob at
  every write, import and whole-snapshot write, with a stated FK rebuild when S8a creates
  `recruitment_requests`. *Options:* approve (S7d can be prepared for implementation); refuse (S7d waits for
  S8a; the next storage step is then S8a, the largest, or nothing in S7); amend (state the amendment; it is
  re-prepared, not implemented).
- **D-B (scope confirmation, a policy-adjacent reading, not a retention decision).** Confirm that S7d may
  **reproduce today's deletion behaviour unchanged** — a deleted player's threads, messages, attachments and
  receipts are erased inside the deletion unit, guardian–club threads included, as `S:4279` does today — with
  no CASCADE or RESTRICT in the DDL and the retention question left open for S4b. *Options:* confirm (the
  storage step proceeds; the retention answer is designed at S4b and would be a behaviour change of its own);
  decline (S7d waits for the retention answer; then no S7 step can proceed until S4b's policy work, and S6's
  audit tables wait for S4b as well); decide retention now (a product/legal decision outside this brief — if
  taken, it becomes part of S4b's design, and S7d still ships storage-only with the DDL written to match).

**Fixed decisions, restated (unchanged unless the Founder changes them).** Under-18 accounts without a valid
guardian link stop migration until resolved. The full birth date is the chosen precision for the proposed
minimal deletion record (not approval of the whole deletion rewrite). Country-code retention and
safeguarding child-status stamping remain OPEN by explicit choice. Message retention after deletion and the
organisation-deletion policy are not approved by any constraint a proposed DDL file contains.

**Deferred — not blocking S7d, with the stage that needs each:** message retention form after deletion
(S4b); country code and child-status stamp (S4b); O2 org deletion (S8a); dispatch cascade with
notifications (S7b follow-up or S4b); removed-staff notifications/e-mail (a behaviour change of its own);
staff push re-keying (its own change); plain-text codes in six mail sites (S6-area correction); retention
periods for the append-only logs (before any pruning); the "no whole-database write on send" objective
(needs the S6 `ledger` or a store dirty-save change — a later, separately scoped step).

### 11.7 Corrections to this section from the independent review of `46e5afe` (17 October 2026; documentation only)

The review of the documentation handoff `46e5afe` (`review-46e5afe-summary.txt`) found the S7c acceptance
record accurate (all 418 packaged non-Markdown files identical to the accepted `9119187`) and raised three
**design corrections to this proposed section** — findings in a proposal, not defects in S7c, which stays
accepted at `9119187`. Each is corrected in place above; this subsection records what changed and why. The
reviewer's read-only probe, `review-46e5afe-design-checks.mjs <repository-root>`, exits 0 on the unchanged
tree (its log is in the handoff): it verifies two design premises with the actual DDL and the actual view
function on an in-memory database with synthetic rows, and its four minimal parent tables are isolated test
fixtures, **not** proposed production placeholder tables. It is not a failing-first regression; nothing of
S7d exists to regress.

1. **The recruitment-first comparison** (§11.1, §11.3, §11.4, §11.6; the plan's S7 and S8 sections) claimed
   that S8a-first necessarily needs transitional non-FK references for both `recruitment_requests.case_id` and
   `trial_id`. Wrong for `trial_id`: S8a includes `trials`, a table may be introduced in the same milestone as
   the table that references it, and the proposed DDL lets a request be inserted with `trial_id` null, its
   trial inserted, and the link filled in one transaction with both foreign keys enforced — the probe shows it.
   The `recruitment_cases` dependency stays real for both `recruitment_requests.case_id` (SQL02:539) and
   `trials.case_id` (SQL02:633). The text now says so and no longer rests the recommendation on a count of
   transitional references; S7d is still recommended, on its actual scope.
2. **`orgUserIdForNotify`** (§11.5 Scope) was marked omittable because the current creator never writes it.
   Withdrawn: `channelViewFor` (S:1048) spreads the record, so a present legacy value is observable in every
   viewer's response and in the JSON export (the probe shows both). The storage-only contract now states
   lossless preservation of every present JSON-compatible legacy or unknown own field at channel, message,
   attachment, `readBy` and `sender` level in detached, prototype-safe `extra_json`, absence preserved as
   absence, no dedicated column, no new runtime use.
3. **The transitional-integrity specification** covered a full snapshot only. It now specifies the FINAL
   combined state for partial writes in both directions (incoming channels against retained requests;
   incoming requests against retained channels; both; malformed explicit collections; absence versus empty
   array), where the assertion runs relative to the staged hooks and the blob loop and which boundary reports
   the failure; the dispatch order around the retained `org_id` RESTRICT and the identity rewrite (a
   coordinated parent-and-channel removal succeeds; a parent-only removal that would orphan a protected
   channel refuses atomically); that "no CASCADE/RESTRICT" concerns the unapproved player/request lifecycle
   only, with the retained constraints and the internal cascades listed; and channel-list order alongside
   message order. This round also introduced `guardian_id` without a FK clause on the `pairing_codes.player_id`
   precedent, with the check in code — **but justified it with an incorrect engine claim ("the proposed
   RESTRICT cannot coexist with the identity snapshot rewrite; RESTRICT fires immediately even under
   `PRAGMA defer_foreign_keys`") and a trigger that missed identity-only snapshots; both are corrected in
   §11.8, and the sentence is kept here only as the history of this round.** Concrete cases were added to the
   future failing-first suites as requirements.

Housekeeping from the same review: the schema document's §5.0 counts-table row still read "O1 is implemented
at S4" and now says S4b, not implemented. Status after this round: **S7c accepted at `9119187`; S7d PREPARED /
NOT IMPLEMENTED with these corrections; D-A and D-B still unanswered** (no answer is recorded in the bundle;
none is inferred).

### 11.8 Corrections to the guardian-reference design from the independent review of `8330f08` (18 October 2026; documentation only)

The review of the documentation handoff `8330f08` (`review-8330f08-summary.txt`) accepted the recruitment-first
and legacy-field corrections of §11.7 and the request-side partial-snapshot contract, and found two issues in
the guardian-reference design §11.7 had introduced — findings in an unimplemented specification, not defects
in S7c, which stays accepted at `9119187`. Both are corrected in place in §11.5 ("Snapshot validation",
"Dispatch order and retained constraints", the failing-first cases, the acceptance criteria, "Likely files");
the superseded sentence in §11.7 item 3 is marked as history. Nothing is implemented; no DDL, test or source
file changed; no identifier assigned; D-A and D-B remain unanswered (no answer is recorded in the bundle and
none is inferred).

1. **Validation coverage.** The assertion's trigger read "`channels` written OR `requests` present", which does
   not run for an identity-only partial snapshot (`players` and `guardians` supplied, `channels` and `requests`
   omitted) — the retained channels stay while a guardian can disappear. The trigger now includes the identity
   pair, the final-state sources are named per parent and child (the `channels`, `guardians` and `orgs` tables
   after this transaction's dispatch and prunes; the requests as supplied or retained), absent collections
   stay distinct from explicit empty arrays and malformed values, and five regression cases were added
   (identity-only with a referenced guardian removed → atomic refusal with tables, unrelated blobs and the save
   revision unchanged; identity-only with every guardian retained → success with channel/message/receipt
   order and content unchanged; identity pair plus channels with a guardian and its channel removed together →
   success; an invalid coordinated replacement → whole refusal with no partial deletes or leaked effects;
   channels only with an invalid guardian → refusal against the retained identity tables). The guardian
   write paths were surveyed: no ordinary writer removes a guardian (`guardians.insert`/`update` only;
   `players.remove`, `unlink`, `ageUp` touch players and link rows; `DELETE /guardian/children/:id` deletes the
   child player; **no guardian-deletion HTTP route exists**), so the snapshot writes are the only paths that
   rewrite guardians and the assertion with the identity trigger covers them; the S7d import validates against
   the live `guardians` table of the same file; the rollback chain refuses a later schema.
2. **The engine claim.** §11.7 justified dropping the proposed `guardian_id … RESTRICT` with "RESTRICT fires
   immediately even under `PRAGMA defer_foreign_keys`". **That is false and is withdrawn.** The reviewer's
   `review-8330f08-design-checks.mjs`, run unchanged here before any edit (exit 0; Node v22.22.2, SQLite 3.51.2;
   the reviewer: Node v24.19.0, SQLite 3.53.3; the log is in the handoff), verifies four engine facts — with the
   pragma off RESTRICT refuses at the DELETE with or without a `DEFERRABLE INITIALLY DEFERRED` declaration;
   with the pragma on, deleting and reinserting a retained guardian commits with its channel intact; a
   genuinely orphaned retained channel refuses at COMMIT and rolls back; an explicit `foreign_key_check` before
   the child cleanup still sees the intermediate orphan — plus one explicitly modelled specification predicate
   (the old trigger is false for an identity-only snapshot). It uses in-memory synthetic fixtures; it is not a
   failing-first regression and not a production schema proposal. Only Node 22 is a supported server runtime on
   this machine (`/opt/node20`, `/opt/node21` exist but are below the server's minimum), so no second supported
   binary ran it here. §11.5 now states the real trade-off: a foreign key is possible, but would need the
   normal snapshot transaction to set the pragma (today's only occurrence, `store.mjs:403`, is the
   `failCommitOfOpenTransaction` test seam) and the early `identity.mjs:225` `foreign_key_check` to be moved
   or the channel group split around the identity rewrite — changes to existing persistence code; the
   code-validated reference is kept as the bounded choice with that trade-off stated, and the foreign-key route
   is described as the in-scope alternative, not implemented.

**Gate evidence the review recorded, kept as recorded.** The reviewer's Player gate passed (4 suites / 41
tests). Their backend gate did **not** achieve a clean full run on the unchanged `8330f08` tree (Node
v24.19.0): attempt 1 exited 1 when `testOneTimeCodesServer.mjs:46` timed out after 30 s waiting for a child
server to start (last output "snapshot loaded (sqlite): players table-backed, 0 ledger rows"; cause
unestablished); attempt 2, unchanged source, exited 1 at `testDispatchesServer.mjs:292` ("the ladder resumed
after the restart": the wait returned null after 20 s). A focused `TEST_ONLY='crash recovery'` run of that one
case then passed; that does not turn either full attempt into a pass, no root cause is established, and these
are distinct from the `46e5afe`-round `EADDRINUSE` event. This session's reproduction on the unchanged
application code (Node v22.22.2, before any edit; log `reproduce-reviewer-failures@8330f08.txt` in the handoff):
the focused case passed (1 selected check, 31 s) and the whole one-time-codes server suite passed (10 checks,
42 s); neither failure reproduced here. The full gates of this round and their attempt counts are in the
handoff's `gates-summary.txt`. Status after this round: **S7c accepted at `9119187`; S7d PREPARED / NOT
IMPLEMENTED with the corrected guardian design; D-A and D-B still unanswered** (the status at the time; the
decisions and the implementation followed in §11.9).

### 11.9 S7d as implemented (18 October 2026, one local commit on `feat/sqlite-schema` on top of `b67bce5` — dated history; accepted at `4f954ad`, §11.11)

**Status at the time of writing: IMPLEMENTED, PENDING INDEPENDENT ACCEPTANCE (accepted since, §11.11).** Not production, security, legal-compliance or deployment
approval; not acceptance of S4b, the remaining S6 tables or S8; nothing pushed, merged or deployed; no real data, no
real provider. The independent review of `b67bce5` (`review-b67bce5-summary.txt`) accepted the corrected §11.5
specification as the basis for the bounded storage migration and handed over a conditional implementation prompt,
to be applied only with both Founder decisions. Both were given before any source edit.

**The Founder's decisions, recorded verbatim (18 October 2026).**

> I approve D-A: migrate messaging first, using the transitional code-checked request reference until recruitment
> requests move to tables at S8a. I confirm D-B: for this storage-only migration, preserve today's behaviour of
> deleting a deleted player's message threads, including guardian–club conversations. This does not decide our
> future message-retention policy. Proceed with the reviewed S7d implementation plan from b67bce5. Keep all other
> agreed restrictions, run backend and Player tests, complete the Markdown cleanup review, commit locally and
> provide the verified handoff package. Do not push, merge or deploy.

D-A is the transitional reference of §2.3/§11.5: `channels.request_id` is `NOT NULL UNIQUE` with no foreign key
(`recruitment_requests` does not exist yet), checked in code at every write boundary; S8a rebuilds the table with
the foreign key after its own preflight. D-B is a scope confirmation for this storage-only step, not a retention
decision: the deleted player's threads — guardian–club threads included — are deleted explicitly inside the
account-deletion unit, exactly as the array filter did; no CASCADE, no RESTRICT and no retention rule is encoded,
and the retention question stays OPEN for S4b (`s4-deletion-decision.md` §4). Under-18 records without a valid
guardian link still stop migration; the full birth date stays selected for the proposed deletion record; country
retention and child-status stamping remain OPEN; nothing here approves S4b, a message-retention period, an
organisation-deletion policy, the staff-push re-keying or a user-interface change.

**What was built (the files, all under `scoutbox-server/` unless stated).**

- `repositories/channels.mjs` — the repository and the migration support: `CHANNELS_DDL` (the three tables as the
  DDL document now shows them, §11.5 "Scope"), `validateChannel` / `validateMessage` / `validateAttachment` (the
  channel literal, the message literal, the two attachment shapes; nothing coerced; the three sender kinds, the two
  counterparties and the two attachment kinds are the only vocabularies narrowed, exactly as the writers produce
  them), the lossless row mapping (array position → `seq` and `position`; every unknown own field at channel,
  message, attachment, `readBy` and `sender` level into `extra_json`, the nested ones under their known key;
  absent optional keys recorded in `absent_keys_json` so the way back manufactures no null — `orgUserIdForNotify`
  preserved exactly, as §11.7 required), `importChannelsBlob` (the 0012 import, text-free refusals
  `CHANNELS_IMPORT_BLOCKED`), `CHANNELS_TABLE` (the whole-snapshot `read`/`replace` used by backups, restores and
  the persistence suites), `assertChannelReferencesConsistent` (the FINAL-state assertion of §11.5 as corrected in
  §11.8: request, guardian and organisation references of every retained or incoming thread; `CHANNEL_REQUEST_MISSING`,
  `CHANNEL_GUARDIAN_MISSING`, `CHANNEL_ORG_MISSING`, `CHANNEL_REQUESTS_MALFORMED`; ids only) and
  `createChannelsRepository` (`open`, `appendMessage`, `markRead`, `deleteForPlayer`, `exportRows`, the staged
  save hook and the unit-of-work participant contract of S7a–S7c: a failed ordinary save keeps the pending state,
  an aborted unit restores the mirror in place, held views included — at `62e9c1a` the restore replaced the NESTED
  objects of a thread with clones, so a held `readBy` kept the failed value; corrected in §11.10 to the graph memento,
  every object by identity).
- `repositories/migrations/0012_channels.mjs` — REGISTERED after `0011_outbox_push`: creates the three tables,
  imports the `channels` blob through the validation above (a channel whose request is not in the file's `requests`
  blob, whose guardian is not in `guardians` or whose organisation is not in `orgs` refuses the whole step), retires
  the blob row, records counts only in `meta.channelsCutover`; refuses to run before 0011 or when a table exists.
- `repositories/index.mjs` — `channels` in `TABLE_BACKED` and `readTableBacked`; the dispatch order of §11.5:
  the channel group after the identity pair and the staff and BEFORE the organisation prune (an organisation
  removed under a retained thread is refused by the org foreign key at the prune), the final-state assertion after
  the prunes whenever `channels` was written, `requests` was supplied or the identity pair was written (an omitted
  `requests` collection is judged by the retained blob, never by an empty set); `attachDataLayer` creates the
  repository in staged mode with `requests: () => db.requests`, registers its save hook, drops the stale in-memory
  array and its blob row, defines `db.channels` as a read-only view and reports the domain.
- `server.mjs` — `openChannel` returns `channels.open(literal)` (the literal unchanged); `postMessage` appends
  through `channels.appendMessage` (the duplicate-`clientMsgId` answer stays the writer's rule, read from the view
  first, 201 with the stored message); the three `/channels/:id/read` routes write through `channels.markRead`;
  `deletePlayerData` calls `channels.deleteForPlayer(playerId)` inside the deletion unit where the array filter ran
  (D-B); `channels` is handed to the module context. `m13/enterprise.mjs` exports `channels: channels.exportRows()`
  in the admin backup. `storeContract.mjs` records the view. Every reader is unchanged (the three list routes, the
  export, the admin audit and overview, the SSE lookup, m26's linked-thread reads).
- `repositories/channelsRollback.mjs` + `scripts/channelsRollback.mjs` (`npm run rollback:channels`) — the
  copy-only rollback to the `b67bce5` build: every thread written back into the `channels` blob in `seq` order with
  its messages in `position` order, each in its writer's literal (extras first, absence preserved, both attachment
  shapes, `clientMsgId` present or absent), the three tables dropped, the 0012 record and its meta key removed,
  `saveSeq` advanced, every other table byte-identical, revalidation, no output on failure; exit codes 0/1/4/5/10;
  `KNOWN_MIGRATIONS` extends the S7c chain, and the S7c tool refuses a 0012 file (`LATER_SCHEMA`, exit 4).
- `docs/architecture/sql/03_messaging_safety_audit.sql` — the three tables amended in place to the DDL the
  migration creates (column for column, index for index; `scripts/testSchemaDdl.mjs` compares them) with the
  mapping comments of §11.5/§11.7/§11.8; `scripts/notificationsPersistenceBench.mjs` appends through the repository
  when the tree has one and reports the channels and ledger blob bytes; `package.json` runs the two new suites.
- Tests: `scripts/testChannels.mjs` (9 checks at `62e9c1a`; a tenth, the held nested view across an aborted unit,
  was added by the correction of §11.10: the lossless import, every refusal, the actual schema, the
  repository in both modes, joined units, real COMMIT failures, the snapshot dispatcher, the FINAL-state assertion
  in every direction of §11.5 — the five guardian cases included — and the rollback) and
  `scripts/testChannelsServer.mjs` (5 checks through the real server: both acceptance paths, all three sender
  kinds, both attachment shapes, the duplicate `clientMsgId`, the three receipt routes, typing, the per-audience
  views, the export, the admin audit, SSE scoping, the block, the account deletion of D-B, the cutover, the
  SIGKILL windows, the real COMMIT failure, the backup, a restore, the S7c tool's refusal, legacy and unknown
  fields through the import, the rollback booted by the actual `b67bce5` build and the re-upgrade). Both were
  written first and recorded failing on the unchanged `b67bce5` tree (logs in the handoff): every `[cutover]`
  check fails on a concrete assertion (the 0012 record absent, the tables absent, a restore keeping the blob, the
  rollback tool absent); the `[compat]` checks pass on both trees — they are the behaviour the move preserves.
  The older suites' migration lists and rollback chains were extended to 0012 (the S7d tool runs first on a file
  this tree wrote); `testUnitOfWork` uses another new blob collection name because `db.channels` is a view.

**What the implementation decided inside the approved scope.** The optional literal keys (`playerName`,
`orgVerified`, `scoutName`, `scoutRole`, `guardianId`, `readBy.org`, `readBy.counterparty`, a message's
`attachment`, `sender.name`) are nullable columns plus `absent_keys_json`, so present-and-null and absent round-trip
distinctly; `clientMsgId` follows the writer's rule (present ⇔ a non-empty string; a present null is refused as
malformed, since no build ever wrote one). A trial request accepted on either path opens a thread too, exactly as
before (the server suite records it). The repository refuses a second thread for one request, a request not in the
live `requests` collection, a missing organisation or a missing guardian by name (`CHANNEL_*` codes, ids only). The
org-side and counterparty-side standing checks (blocks, suspension, visibility) are unchanged and still refuse both
sides after a block. No vocabulary, payload, status code or ordering changed.

**Verification (Node v22.22.2, npm 10.9.7, SQLite 3.51.2; every log in the handoff package).** Both new suites
pass with `SCOUTBOX_PRE_S7D_SERVER` pointing at an actual `b67bce5` checkout (the old build booted the rollback copy,
listed the same threads, posted a message into its blob; this build re-upgraded the copy with that message).
The backend gate `cd scoutbox-server && npm test` and the Player gate `cd scoutbox-player && npm test -- --runInBand`
ran after the implementation with the four old-build paths supplied; their counts, attempt counts and the fresh-extraction
runs are in the handoff's `gates-summary.txt` and the sidecar. The six historical reviewer scripts and both design
probes ran unchanged. The synthetic benchmark (`notificationsPersistenceBench.mjs 3000 100`): 2 blob rows per save,
387 302 blob bytes, channels blob 0 bytes (not rewritten), ledger blob 309 491 bytes (rewritten), mean 2.18 ms per
save — the `ledger` is still a blob, so the whole-database-write objective is narrowed again, not met (§7.3). The
reviewer's two Node 24 failures of the `8330f08` round (§11.8) stay recorded as recorded; nothing here establishes
their cause. Not run: browser suites, the demo rebuild, the wider E2E battery beyond what `npm test` and the focused
suites contain, real data, real providers.

**Known limits.** The request reference is code-validated until S8a (D-A); `guardian_id` is code-validated (the
bounded choice of §11.8, the deferred-foreign-key route still the stated alternative); `player_id` carries no
lifecycle clause (D-B); retention is OPEN. A guardian-deletion path, should one be added, must keep the §11.8
invariant (the final-state assertion covers snapshot writes; no ordinary writer removes a guardian today).

### 11.10 Correction from the independent review of `62e9c1a` (18 October 2026; one local commit on top of `62e9c1a` — dated history; accepted at `4f954ad`, §11.11)

**Status at the time of writing: IMPLEMENTED AND CORRECTED ONCE, PENDING INDEPENDENT ACCEPTANCE (accepted since, §11.11).** Not production, security, legal-compliance
or deployment approval; not acceptance of S4b, the remaining S6 tables or S8; nothing pushed, merged or deployed; no
real data, no real provider. S7a, S7b and S7c stay accepted as recorded; D-A and D-B are not reopened or changed.

**The finding (P2, `review-62e9c1a-summary.txt`, reproduced by `review-62e9c1a-reproductions.mjs` in two failure
paths).** The repository's `restoreState` restored each thread and each message IN PLACE but rebuilt their nested
objects from the detached snapshot copy (`restoreInto` → `clone(copy[k])`), so `row.readBy` — and likewise a message's
`sender`, its `attachment` and every unknown nested field — became a NEW object after a rollback. `readonlyView` caches
one proxy per target object, so a caller holding `channels.byId(id).readBy` (the nested receipts view, not the outer
thread) stayed attached to the discarded object: after an aborted unit it still read the failed receipt
(`1791720000001` in the reviewer's fixture) while a fresh lookup and the database read `null`, and it never followed a
later committed receipt. Both paths reproduce: an exception thrown from the unit body, and an actual SQLite UPDATE
failure during the unit's flush. The in-memory view contract of §11.5 ("an aborted unit restores the mirror … held
views included") was therefore not met for nested views; no durable corruption was observed, and no current HTTP
route is shown to hold a nested receipts view across a unit — the repository's public contract and the real
unit-of-work failure paths demonstrate it directly. The reviewer's two attachment compatibility controls (a clip
whose media omits `url`, normalised to `url: null` by the S5 mapping, accepted by both the `b67bce5` and the candidate
server; the baseline-written attachment upgrading through 0012) pass and are NOT a finding; attachment validation is
unchanged.

**The correction (`repositories/channels.mjs` only; no DDL, migration, route, payload, retention or policy change).**
`snapshotState()` now captures the graph memento of the whole mirror — `captureGraph([rows])`
(`repositories/memento.mjs`, the facility the identity and organisation repositories already use): every plain object
and array reachable from the thread list, by identity, with its own data properties by reference. `restoreState()`
calls `restoreGraph`, which puts every captured object back to its captured keys and values IN PLACE: the thread list,
each thread, its `readBy`, its `messages` array, each message, its `sender`, its `attachment` and every unknown nested
field keep their identity, so every held view — nested ones included — reads the pre-unit state afterwards and
follows the next committed write. Objects created during the unit (a new thread, a new message) are no longer
referenced once their parents are restored; nothing is cloned, so key order, absence versus null (no key is
manufactured or dropped — restoreGraph deletes keys added during the unit and reassigns the captured ones) and live
non-finite values in unknown fields come back exactly as captured; own `"__proto__"` keys are data to the memento (an
own data property shadows the accessor on assignment, and no repository operation deletes a key, so no restore has
to recreate one). The queue is trimmed to its pre-unit length as before, so writes queued BEFORE the unit stay pending
and land once with the next save; a failed ORDINARY save still never reaches `restoreState` (its mirror and queue are
the intended state, §11.5). Both write modes share the one `restoreState`: the staged server path (the store's unit
of work) and the immediate path (the repository's own transaction, `operation()`), so the correction covers both. The
detached-copy helpers remain for `exportRows` (the admin backup) only; the clone-based `restoreInto` is gone.

**Failing-first evidence (recorded on the unchanged `62e9c1a` source before the edit; logs in the handoff).** The
reviewer's script, unchanged, on the clean tree: `REPRODUCED` in both failure paths, exit 1 (mandatory mode), and the
same with the two passing controls against the actual `b67bce5` checkout. The new tenth check of
`scripts/testChannels.mjs` holds `channels.byId('chan-1').readBy`, a message's `sender` and `attachment` and an unknown
nested field (`legacyMeta`) before the unit, queues a message BEFORE the unit, aborts the unit by a thrown body and —
in a second pass — by a `BEFORE UPDATE ON channels` trigger refusing the receipt at the flush, then asserts: the held
receipts object reads the pre-unit value, a fresh lookup returns the SAME object, a second connection agrees, the
pre-unit write is still the only pending one, nothing landed, the next save lands that write exactly once together
with a new receipt, and the held receipts follow it; then the immediate mode's own transaction with the same trigger.
It failed on the unchanged source at its first assertion (`body: the held receipts object reads the pre-unit value`:
`1791720000001` instead of `null`). A scratch probe of the immediate-mode path (kept in the handoff's `review/`, a
harness of this round, not a reviewer artefact) reproduced the same on a `git archive` of `62e9c1a` — its first
version read the held value after the later commit (a harness slip, corrected before the recorded runs).

**Verification (Node v22.22.2, npm 10.9.7, SQLite 3.51.2; every log in the handoff).** The reviewer's script,
unchanged, on the corrected tree: `CORRECT` in both failure paths, exit 0, in both modes (the controls still
`CORRECT`). `testChannels.mjs` (10 checks), `testUnitOfWork.mjs` (17) and `testChannelsServer.mjs` (5, with the actual
`b67bce5` build booting the rollback copy) pass. The six historical reviewer scripts and both design probes ran
unchanged; the focused real-server suites the correction can touch (`m13E2E`, `connectedE2E`, `m23ContactE2E`) ran;
the backend gate `cd scoutbox-server && npm test` with the four old-build paths and the Player gate ran on the final
tree after every edit, and again from the fresh extraction of the handoff ZIP (old builds skipped there, stated) —
exit codes, counts and attempts in the handoff's `gates-summary.txt` and sidecar. Not run: browser suites, the demo
rebuild, `apiE2E` and the wider E2E battery (unchanged since `62e9c1a`'s run), real older-Node runtimes, real data,
real providers.

**Observed, not changed (for the reviewer and the Founder).** The accepted S7a–S7c repositories restore their outer
rows by identity but rebuild SOME nested values from clones on rollback (`notifications.mjs`: unknown nested fields —
`actionRequired` and `categories` are merged in place; `dispatches.mjs`: the attempt objects and unknown nested
fields — `audience` in place; `outboxPush.mjs`: every nested value, an array destination or an object token included).
That is the same class as this finding for a caller that would hold such a nested view across an aborted unit; whether
any caller does was not surveyed in this bounded round, those milestones are accepted at their recorded commits, and
nothing there is changed here. The graph memento would bound each of them the same way should the Founder ask.
(Classified in §11.12 on 19 October 2026.)

### 11.11 Independent acceptance of S7d — `4f954ad92cda6ca5178cc6c3d5485265684e0c03` (18 October 2026)

**Conclusion recorded (`review-4f954ad-summary.txt`, verbatim in substance):** "ACCEPTED within the reviewed backend
storage-migration scope. The single P2 finding from 62e9c1a is closed. No new blocking finding was identified in this
six-file correction. S7d is independently accepted at 4f954ad92cda6ca5178cc6c3d5485265684e0c03. Together with the
previously accepted S7a, S7b and S7c, this completes the four planned S7 sub-steps. It does not complete the entire
SQLite migration or authorize production, deployment, new deletion policies, S4b, remaining S6 or S8." The review
compared the package with the previous verified package and found exactly the six declared changes; the earlier
reproduction script was byte-identical to the reviewer's held copy. It is an archive review: branch state and tree
cleanliness were reported by the package, not observed live.

**What the reviewer ran (Node v24.19.0, SQLite 3.53.3, npm 11.6.0; both applications installed from an offline cache
with lifecycle scripts disabled, exit 0).** The original reviewer script of `62e9c1a`, unchanged: exit 0 in both
failure paths; both real-server attachment compatibility controls still pass (controls, not findings); the
immediate-mode probe rerun against both packaged builds — exit 1 on `62e9c1a`, exit 0 on `4f954ad`. Backend
`npm test`: first full attempt, exit 0, 27 suites / 363 checks, with the actual pre-S7a, pre-S7b, pre-S7c and
pre-S7d server paths supplied (the logs show the old builds booting the rollback copies, `b67bce5` reading the S7d
copy, writing a message, this build re-upgrading it). Player `npm test -- --runInBand`: first attempt, exit 0,
4 suites / 41 tests. The six historical reviewer scripts rerun independently, all exit 0 (the two S7c comparisons
against the actual `6ca66ba` build; the dispatch comparison against its bundled historical handler). Both design
probes pass; the reviewer's first invocation of `review-46e5afe-design-checks.mjs` omitted its root argument and
exited 1 before checking code — a reviewer invocation error, corrected and retained, not an application regression.
A permission-review timeout while reading the final backend log was retried; the test process itself had returned
exit 0 and was not restarted.

**Limits the reviewer stated, carried here unchanged.** Real alternate Node runtimes were not supplied (the runtime
suite skipped those checks; its simulation is not an old-runtime result); browser suites, the wider E2E battery, real
data and real providers were not exercised; the probes establish design premises, not implementation acceptance;
the no-whole-collection-rewrite objective is not met (`ledger` and other domains still blobs — §7.3). The §11.10
observation about the older repositories is a separately scoped follow-up: the reviewer confirmed some nested values
are rebuilt by the S7a–S7c restore code and did **not** establish a current caller-visible stale-value failure; no
change to those repositories is authorised by this acceptance (§11.12 classifies it).

**Standing decisions, restated by the reviewer and unchanged here:** D-A and D-B remain approved for S7's bounded
storage work; under-18 without a valid guardian link stops migration; the full birth date is chosen for the proposed
deleted-player record; country retention and future safeguarding child-status stamping remain OPEN; S4b is not
implemented; the remaining S6 audit tables and the S8 dependencies need their recorded decisions resolved before
dependent implementation — consolidated in `sqlite-migration-plan.md` §D (the Founder's list, §D.5).

### 11.12 The nested-restore observation of §11.10, classified (19 October 2026; read-only; no source changed)

**Question.** The accepted S7a–S7c repositories rebuild SOME nested values from clones when a unit of work aborts
(§11.10 "Observed, not changed"). Is that (a) a proven caller-visible defect of the S7d class — a held nested view
reading a stale VALUE — (b) a public-contract/identity risk only, or (c) an unproven concern?

**Classification: (b) — a public-contract/identity risk with no caller-visible stale value established.** The S7d
defect needed two conditions together: a nested object that a repository method **mutates in place** after the row
exists (`readBy[side] = at` in `markRead`) **and** a restore that **replaces** that object with a clone. Read against
the code at `4f954ad`, no S7a–S7c repository combines the two:

| Repository | Nested values a method mutates in place after creation | Restored how | Nested values rebuilt from clones on restore | Mutated after creation by any method? |
|---|---|---|---|---|
| `notifications.mjs` | `row.actionRequired` (`ack` :673; `coalesce` :656 `Object.assign`), `prefs.categories` (`updatePrefs` :716 `Object.assign`) | **in place** — `restoreInto` :535 (`Object.assign(obj.actionRequired, v)`), :536 (categories cleared then reassigned) | `row.audience` (a known key: :537 assigns the snapshot copy's clone, `copyRow` :355 spreads it); unknown nested fields (:537 `cloneJson`) | **no** — `audience` is written only by `create` (:639); extras only by the import |
| `dispatches.mjs` | the `attempts` **array** (`recordAttempt` :516 `push`) | the array **in place** (:443: length reset, elements re-pushed) | each attempt **object** (:443 `copyAttempt`); `audience` is merged in place (:442); unknown nested fields (:444 `cloneJson`) | **no** — an attempt object is never touched after its push; `patch` (:540) writes top-level keys only |
| `outboxPush.mjs` | none | — | every nested value (`restoreInto` :521–523 `cloneJson` of every key): an array `to`, the push log's `audience`, an object or array `token` | **no** — `markDelivered` (:563) writes the top-level flag; `register` (:607–608) removes and appends whole rows; `append` only creates |

**Evidence (synthetic probe, this round's harness in the handoff `review/probe-nested-restore.mjs`, run on
`4f954ad`; log `logs/probe-nested-restore@4f954ad.txt`).** Through the repositories' public API and the store's
real `unitOfWork`: eight nested views held before an aborted unit that exercised every in-place mutation above
(`ack`, `coalesce` with a new deadline, `updatePrefs`, `recordAttempt`, `patch`, `markDelivered`, a token
replacement). After the abort every held view read its pre-unit value and equalled a fresh lookup, and the
database agreed where a column exists; identity was preserved for the four in-place-mutated values
(`actionRequired`, `categories`, `audience` of a dispatch, the `attempts` array) and lost for the four
clone-rebuilt ones (a notification's `audience`, one attempt object, an outbox `to`, a push token). A later
**committed** change through the same methods was then seen through every held view whose value any method
can change (`actionRequired`, `categories`, `attempts`); for the four clone-rebuilt values no method changes
them after creation, so held and fresh stay equal indefinitely. Zero stale values in eight views; exit 0. The
probe also confirms by text that the three in-place mutation sites exist and that `outboxPush.mjs` has none.

**One caveat recorded, no defect.** `restoreInto` in `notifications.mjs` merges `actionRequired` with
`Object.assign` (:535), which would not delete a key **added** to that object during a unit; no method adds one
(`ack` writes `ackedAt`/`ackedBy`, `coalesce` assigns exactly the three `ACTION_KEYS`, :652/:656), and an
import-time unknown key inside it is present in both the object and its copy. It becomes a defect only if a
future method adds keys there.

**Limits.** The probe exercises the repository API and the store's unit of work, not live HTTP routes; whether
any route or module holds one of the four clone-rebuilt nested views across an aborted unit **and compares it by
identity** was not surveyed exhaustively (a value comparison cannot differ, as shown; an identity comparison
could) — the classification is "identity risk, unproven as a defect", not "no caller can be affected". It
describes the code at `4f954ad`; a new in-place mutation of a clone-rebuilt value would recreate the S7d class.

**Proposed bounded fix for a future authorisation (not made here; S7a–S7c acceptance unchanged).** Replace the
three clone-based `restoreInto`/`restoreList` restores with the graph memento the identity, organisation and
channels repositories use (`captureGraph([rows…])` in `snapshotState`, `restoreGraph` in `restoreState` —
exactly §11.10's change), one function each in `notifications.mjs` (:532–539, :759–767), `dispatches.mjs`
(:439–446, :562–568) and `outboxPush.mjs` (:521–525, :634–641), with a tenth-check-style regression per suite
(a held nested view across a thrown-body and a flush-refused unit; identity, value, pending queue, later commit).
No schema, migration, route, payload or retention change; the rollback tools are untouched. It is a uniformity
and defence-in-depth change, not a blocker for S4b, S6 or S8.

### 11.13 Review of `6956f52` — the S7 acceptance record confirmed; three corrections to the next-stage brief (19 October 2026; documentation only)

The independent review of `6956f52` (`review-6956f52-summary.txt`) confirmed the acceptance record of §11.11
(S7d accepted at `4f954ad`; all four S7 sub-steps accepted; no new regression in the accepted code; backend
27 suites / 363 checks and Player 4 / 41 on Node v24.19.0 with the four actual old builds; the unchanged S7d
reproduction exit 0; the eight-view nested-restore probe of §11.12 rerun exit 0 — no stale values for those
fixtures, identity loss still reported, a bounded follow-up and not a universal claim) and found the
**next-stage brief** (`sqlite-migration-plan.md` §D) not implementation-ready on three P2 documentation
points, each corrected in place in the plan: **F1** the proposed foreign keys to `players(id)` and
`guardians(id)` need identity-snapshot compatibility — the snapshot's DELETE/reinsert of both tables
(`identity.mjs:205–207`, the fact §11.8 established for `channels.guardian_id`) refuses an unchanged valid
snapshot under any immediate `RESTRICT` child, a guardian "never deleted by a route" included, and a tombstone
does not address it (plan §D.2a: the two bounded alternatives, the six required checks, and the consequence
that S4b alone does not make the permanent keys ready); **F2** moving the `ledger` and the other audit blobs
does not meet the whole-snapshot-write objective for a send — the save still serialises every remaining blob
(§7.3 corrected above; plan §D.4); **F3** Candidate A no longer contradicts Q2 — it is proposed as a
behaviour-preserving stage that defers stamping with Q2 OPEN and a later additive migration (plan §D.4, §D.5).
The reviewer's design-check script `review-6956f52-design-checks.mjs` installs the drafted `idv_queue` and
`ledger` DDL only in disposable synthetic databases, exercises the real snapshot writer, and models the
exclusion of all eight audit names in the real save loop; it runs unchanged on this tree (exit 0, Node
v22.22.2) and verifies those engine and store facts — design premises, not regressions in S7, and a corrected
document does not make them disappear. No source changed; S7a–S7d acceptance and D-A/D-B are untouched.

### 11.14 Review of `e7f7692` — S7 still accepted; two further corrections to the next-stage brief (19 October 2026; documentation only)

The independent review of `e7f7692` (`review-e7f7692-summary.txt`) kept S7 ACCEPTED (backend 27 suites /
363 checks and Player 4 / 41 on Node v24.19.0 with the four actual old builds; the held `6956f52` design checks
and the unchanged S7d reproduction exit 0; the eight-view probe of §11.12 still zero stale values) and found
the corrected brief of §11.13 not yet implementation-ready on two P2 documentation points, both corrected in
place in the plan. **F1 — deferral is not preservation.** §D.2a Alternative A had said `PRAGMA
defer_foreign_keys` defers *every* foreign-key action, so a parent deleted and reinserted inside the
transaction keeps all its children. The reviewer's script `review-e7f7692-design-checks.mjs` (three in-memory
checks, exact child rows before and after COMMIT) shows what §11.8 (b) actually established and no more: with
the pragma on, a `RESTRICT` child survives the DELETE/reinsert (`{c, p}`); a `SET NULL` child has its
reference **nulled at the DELETE** (`{c, null}`); a `CASCADE` child is **deleted at the DELETE** (empty);
reinserting the parent undoes neither, and COMMIT and `foreign_key_check` succeed in all three cases. The
withdrawn claim that RESTRICT cannot be deferred stays withdrawn; the universal claim is withdrawn too. Plan
§D.2a is now action-aware: the deferral (A0) covers the drafted `RESTRICT` references exactly (12 to `players`,
1 to `guardians` at `e7f7692`); every `SET NULL` (6 + 7) and `CASCADE` (28) reference needs one of three bounded
designs — preserve the parent rows by upsert-and-prune (A1), enforcement off for the snapshot write only with a
final check (A2), or capture-and-rewrite the retained children including omitted collections (A3, the S5
precedent) — chosen when first needed; a clean final check restores nothing; the required checks assert exact
rows with child collections omitted and supplied. This section's own §11.8 text concerns the `RESTRICT`
guardian reference of `channels` and stands. **F2 — one contract per reference.** Candidate A had required
the five player-audit references to be refused when their parent is missing *and* to import and preserve the
ids of deleted players; the reviewer's fourth check deletes a synthetic adult through the real repository and
unit of work with its ledger row retained, reopens, and saves an unchanged snapshot — it **succeeds today**,
and a separately labelled model of the strict rule rejects it. The plan now states one per-reference contract
(§D.4): the five historical player-audit references are **tolerant** (shape-validated; unresolved ids counted
and reported, never refused, never given a fabricated parent, never deleted; today's `handleReport` accepts an
unchecked `targetPlayerId`, so a parent-existence rule would be a labelled behaviour change and is not
proposed; account deletion unchanged), and the `idv_queue` guardian reference is **strict** (the
`channels.guardian_id` pattern; every writer resolves the guardian first). Q4 and Q4b are reworded to match,
check (d) is domain-specific, and the acceptance includes a real deletion/retained-audit round trip through
backup, restore, the `4f954ad` rollback copy and re-upgrade. **Housekeeping:** the last stale §8.1 row ("no
whole-database write on send") is aligned with the corrected §7.3 above. No source changed; S7a–S7d
acceptance, D-A/D-B, the full birth date and the legacy-minor rule are untouched; country retention and
child-status stamping stay OPEN; Q4, Q4b and Q5 remain the Founder's, and nothing is inferred from this record.

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
