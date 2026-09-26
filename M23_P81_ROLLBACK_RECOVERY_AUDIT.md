# M23 P8.1 — Rollback and recovery audit

Every unit of work that touches more than one authoritative record, what it
snapshots, what a failure at each point leaves behind, and how a retry or a
restart converges (§15, §16, §33, §34). Persistence is one whole-store
snapshot per save (`store.save({ db })`, SQLite): a save carries the entire
in-memory state or nothing, so a crash never persists half a request.

## 1. The lifecycle writer (`m17/rooms.mjs applyLifecycleTransition`)

| Writes | Snapshot (`ctx.lifecycleSnapshot`) | Restore (`ctx.restoreLifecycle`) |
| --- | --- | --- |
| `room.room.status`, `room.stage`, `room.room.updatedAt`, `archivedAt`, `closedAt`, `rev`, `revAt`, `revBy` (`applyStatus`), `room.room.reopened` | `room.room` copied whole, `room.stage` | every key of `room.room` restored, extra keys removed, `stage` restored |
| a history entry (`room_status_changed`, and `room_reopened` on a reopen) via `audit` → `room.history` | `history.length` | truncated to the length before |
| `room.links` (a domain may set `signingId` after the move) | copied | restored |
| the broadcast (`recruitment_case_moved`) and the metric counter | not authoritative; the broadcast validates its payload against the registry BEFORE writing a frame | a throw inside the broadcast happens before any frame or persisted state |

Failure points: (a) before `applyStatus` — nothing written; (b) after
`applyStatus`, before the history entry — the **P8.1 fault seam
`lifecycle.after_status`**: the outer writer catches, restores status /
stage / rev / instants, the history length is unchanged, the caller sees a
500 and the case reads exactly as before (hardening H1); (c) after the
history entry — the move is complete; a broadcast failure is logged, the
state stands.

Restart between steps: the writer runs inside one request; a restart
before the save loses the whole request (the store is the last snapshot),
a restart after it keeps the whole move. A retry with the same `clientKey`
replays the recorded move from the history (m23 lifecycle route) and moves
nothing again (hardening Q).

## 2. Offer issue (`m28 POST /offers/:id/issue`)

Writes: the revision (`status`, `issuedAt`, `issuedBy`, recipient and
readiness snapshots), a superseded previous revision, `offer.status`, then
the lifecycle (`sendOffer`), then history, keys, revs, audit, save.
Rollback: an explicit `rollback()` restores the revision, the previous
revision and `offer.status` when the lifecycle move is refused or the
writer throws (`writer_failed`). After the move nothing else can refuse;
a throw there is a 500 with BOTH the Offer and the case moved — consistent,
and the retry replays by `issue` key (Offer hardening O4; hardening H2).

## 3. Offer answer (`m28 respondHandler`)

Writes: the response row, the revision status, a discarded draft beside the
live revision, `offer.currentRevisionId`, `offer.status`, then the
lifecycle (`recordOfferAccepted` / `recordOfferDeclined` with the
recipient as actor), then history, revs, audit, save. Rollback: an
explicit `rollback()` restores all of it when the lifecycle refuses
(`OFFER_LIFECYCLE_CONFLICT`, e.g. a held or ended case). **P8.1 fault seam
`offer.respond.after_persist`**: after the save, a failure reaches the
caller as a 500 while the store carries the whole answer; the retry with
the same `clientKey` replays (`idempotent: true`) with no second move and
no second notification (hardening H3, Q).

## 4. Decision finalize (`m23/decisionRoutes.mjs`)

Writes: the formal row, `head.supersededById`, then the lifecycle
(`considerOffer` / `rejectCase` / `holdCase` by outcome), then audit and
save. Rollback: the row is removed and the head's pointer restored when the
lifecycle refuses (decision E2E; hardening B6).

## 5. Contact send (`m23/contactRoutes.mjs`)

Writes: the send key, an attempt, then the transport (an Inbox request row
through the ONE request writer), then `status: delivered`, then the
lifecycle (`recordContact`). The transport failure path leaves an honest
`failed` attempt and no recipient row. A lifecycle refusal after delivery
is recorded on the Contact (`lifecycle.applied: false`) and logged — the
Contact IS delivered (the player has it) and the case stays where it was;
the projection names the drift (`EVIDENCE_AHEAD_OF_LIFECYCLE`) rather than
pretending the case moved. This cannot happen through the route in normal
operation (the send is refused unless the case accepts a Contact).

## 6. Trial invitation, acceptance, completion (`m23/trialRoutes.mjs`)

Each writes its own record, then moves the case (`planTrial`,
`confirmTrial`, `completeTrial`). A refused move after a completion leaves
a completed Trial on a case that did not move — reported as drift by the
projection, never repaired on read; completion is not refused by case
state on purpose (a trial that happened is recorded even on a held case).

## 7. Signing completion (`m29 POST /signings/:id/complete`)

Snapshot: the package (serialized), `db.signings.length`, `db.ledger.length`,
`db.invoices.length`, the player (serialized), the org squad (serialized),
and the lifecycle writer's own snapshot of the case. Writes, in order: the
revision and package status, the `db.signings` row (with the ledger, the
invoice, `under_contract`, the level and the squad row inside
`recordCompletedSigning`), the package completion block, the lifecycle
(`confirmSignedOutcome` through the ONE validator with the real evidence
provider, which now finds the row), the case link, keys, history, audit,
save. Rollback (`rollback(why)`): everything above restored — the package
object, the three lists truncated, the player and squad restored, the case
restored whole through `restoreLifecycle` (P8 D-P8-4) — on a duplicate row,
a refused lifecycle move, or a throw at either fault seam
(`signing.complete.after_row`, `signing.complete.after_lifecycle`). After
the save, the after-effects (`effects`, broadcast, notifications) run in
`safe()` wrappers: a failure there is logged and the completed state stands
(seam `signing.complete.effects`). Proof: Signing hardening Q1–Q6, journey
E2E Q1–Q3, persistence 5.7a–e (no duplicate row across restarts); hardening
H4–H6.

## 8. Legacy signing recording (`server.mjs POST /org/players/:id/signing`)

One call, one `recordCompletedSigning` with no package: the row, ledger,
invoice, contract word, level and squad row are written together; a second
call while a standing row exists is refused (D-P81-3). No lifecycle move
is attempted by this route (the legacy status route may then reach
`signed` with the row as evidence).

## 9. Restart at every checkpoint (§33)

`m23RecruitmentJourneyPersistence` section 1 restarts the server (SIGTERM,
which saves) after each of the nine checkpoints — `contacted`,
`trial_requested`, `trial_scheduled`, `trial_completed`,
`offer_consideration`, `offer_made`, `offer_accepted`, signing in progress,
`signed` — and P8.1 adds `under_review` (section 5), comparing the whole
projection before and after (stage, completed stages, resources, next
action, classification, timeline). Section 2 proves ONE signing row after
the final reboot; section 4 that replay applies no migration step.

## 10. Restart during a mutation (§34)

A request is one in-memory unit of work followed by one save. A restart
before the save loses the request entirely (the next boot loads the last
snapshot; the client's retry performs it again); a restart after the save
keeps it entirely (the retry replays by key). No path saves between two
writes of one unit of work: `persistNow()` is the last authoritative act
of every writer, and the debounced `persist()` only ever serializes the
CURRENT in-memory state, so a restored (rolled-back) state is what it
writes. Proof: persistence section 5 (P8.1) restarts after each fault-seam
failure and after each replayed retry and re-reads the projection.

## 11. What no rollback covers, on purpose

- Notifications and stream frames already delivered before a later failure
  (they describe what was true when sent; the receiver re-fetches).
- The metric counters (`vmetric`), which are operational, not
  authoritative.
- The moderation log of a refused text.
