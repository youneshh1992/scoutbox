# M23 P5.6D — Transaction state machine

One authoritative transition map, in `scoutbox-server/m26/transaction.mjs`. There
is no ad hoc status write anywhere: every status change goes through the same
route, which consults the same map.

## 1. The ten states

| State | Means | Does not mean |
| --- | --- | --- |
| `DRAFT` | A workspace exists. Parties may still be resolved. | Nothing is cleared, nobody has authority, no regulated outreach is enabled, no private data is exposed. |
| `PARTIES_CONFIRMED` | Every live party has confirmed its **own** participation. | Compliance has said anything. |
| `COMPLIANCE_PENDING` | The compliance layer cannot let this progress **yet**, and the reason is named. | A generic wait. The reason is always one of eight codes. |
| `COMPLIANCE_BLOCKED` | An active rule prohibits it. | Something a reviewer may override. Only changed facts or changed policy produce a new evaluation. |
| `READY` | ScoutBox currently permits this workflow to proceed under its encoded rules. | Legally valid. Approved by any governing body. A transfer approved. A contract agreed. |
| `ACTIVE` | The parties are using the workspace. | An offer exists. Anything is signed. ScoutBox is negotiating. |
| `ON_HOLD` | Paused explicitly, with a reason code. | Resumable without a recheck. |
| `CANCELLED` | The process stopped, with a reason code. History is intact. | Deleted. |
| `CLOSED` | The workspace's operational process concluded. | Signed, completed, or a transfer done. The neutral terminal was chosen over `COMPLETED` precisely to avoid that implication (§21). |
| `ARCHIVED` | A retention / visibility state. Read-only for everyone, including the owner. | Deleted. |

`LIVE_STATUSES` = DRAFT, PARTIES_CONFIRMED, COMPLIANCE_PENDING,
COMPLIANCE_BLOCKED, READY, ACTIVE, ON_HOLD.
`TERMINAL_STATUSES` = CANCELLED, CLOSED, ARCHIVED.

No state names an offer or a signing, and the suite asserts that with a regex over
the frozen list.

## 2. Two maps, two authorities

A transition is either an **actor's** decision or the **compliance layer's**
finding. Keeping them apart is what stops a caller reaching a compliance state by
asking for it.

### `ACTOR_TRANSITIONS` — what a licensed agent may ask for

| From | To |
| --- | --- |
| `DRAFT` | `PARTIES_CONFIRMED`, `CANCELLED` |
| `PARTIES_CONFIRMED` | `CANCELLED` |
| `COMPLIANCE_PENDING` | `ACTIVE`, `CANCELLED` |
| `COMPLIANCE_BLOCKED` | `ACTIVE`, `CANCELLED` |
| `READY` | `ACTIVE`, `ON_HOLD`, `CANCELLED` |
| `ACTIVE` | `ON_HOLD`, `CLOSED`, `CANCELLED` |
| `ON_HOLD` | `ACTIVE`, `CLOSED`, `CANCELLED` |
| `CANCELLED` | `ARCHIVED` |
| `CLOSED` | `ARCHIVED` |
| `ARCHIVED` | — |

`COMPLIANCE_PENDING → ACTIVE` and `COMPLIANCE_BLOCKED → ACTIVE` are listed on
purpose. The request is *structurally* legal and is refused **by compliance**,
with the reason, at step 15/11 of the authorization order — rather than being
refused as a malformed transition, which would tell the caller nothing about why
they cannot proceed. Adversarial cases 25 and 26 exercise exactly this: a
manual-review transaction and a prohibited transaction each try `ACTIVE` and are
refused with `TRANSACTION_COMPLIANCE_PENDING` / `TRANSACTION_COMPLIANCE_BLOCKED`.

`ARCHIVED` is reachable only from a terminal state, so it is never offered from
`ACTIVE`.

### `COMPLIANCE_TRANSITIONS` — what an evaluation may move

| From | To |
| --- | --- |
| `DRAFT` | — |
| `PARTIES_CONFIRMED` | `READY`, `COMPLIANCE_PENDING`, `COMPLIANCE_BLOCKED` |
| `COMPLIANCE_PENDING` | `READY`, `COMPLIANCE_BLOCKED`, `PARTIES_CONFIRMED` |
| `COMPLIANCE_BLOCKED` | `READY`, `COMPLIANCE_PENDING`, `PARTIES_CONFIRMED` |
| `READY` | `COMPLIANCE_PENDING`, `COMPLIANCE_BLOCKED` |
| `ACTIVE` | `COMPLIANCE_PENDING`, `COMPLIANCE_BLOCKED` |
| `ON_HOLD` | — |
| `CANCELLED`, `CLOSED`, `ARCHIVED` | — |

A `DRAFT` is moved by nothing: compliance has no opinion until the parties are
confirmed. An `ON_HOLD` or terminal transaction is not re-stated underneath the
parties.

Note the direction back to `PARTIES_CONFIRMED`: `statusForComplianceState` maps
`PARTIES_NOT_CONFIRMED` and `REPRESENTATION_MISSING` to `PARTIES_CONFIRMED`
rather than `COMPLIANCE_PENDING`, because neither is a compliance question yet.
Calling them `COMPLIANCE_PENDING` would make `PARTIES_CONFIRMED` a state no
transaction ever rests in, and would tell a party that compliance is outstanding
when nothing has been asked of it.

## 3. Every transition is guarded

For each status write:

1. the transaction must be writable (not archived, not terminal, no safeguarding
   hold on a party);
2. the **idempotency key is checked before the transition check**, so a replayed
   request returns its original answer instead of `TRANSACTION_TRANSITION_NOT_ALLOWED`
   for a move that already happened (defect D5);
3. `ACTIVE` refuses a stale snapshot first (`TRANSACTION_COMPLIANCE_STALE`), then
   re-checks compliance from current facts;
4. `ON_HOLD`, `CANCELLED` and `CLOSED` require a reason code from a closed list;
5. `expectedRev` must match or the call is `TRANSACTION_VERSION_CONFLICT` 409;
6. the write, then the history append, the registry event and the notification.

Reason code lists:

- hold: `awaiting_party_decision`, `awaiting_document`,
  `awaiting_regulatory_answer`, `window_closed`, `party_request`, `other`
- cancel: `party_withdrew`, `terms_not_agreed`, `window_closed`,
  `compliance_not_cleared`, `duplicate`, `other`
- close: `process_concluded`, `proceeded_outside_scoutbox`, `superseded`, `other`

## 4. Resuming from a hold (§19)

`ON_HOLD → ACTIVE` is an actor transition, and it runs the same full recheck as
any other material mutation: representation, licence facets, policy set, conflict,
consents, blocks, minor gate. There is no auto-resume and no path that reuses the
clearance the transaction had when it was paused.

## 5. Cancellation, closure, archive

- Cancelling preserves everything. The parties, the representations, the
  documents, the notes, the links and the whole history stay; the reason code is
  recorded. Nothing is deleted.
- `CLOSED` was chosen over `COMPLETED` deliberately. "Completed" would read as a
  signed transfer to a party skimming a list.
- `ARCHIVED` is read-only for **everyone**, its owner included: a write to an
  archived transaction is `TRANSACTION_ARCHIVED` 409, and the workspace offers no
  action at all (adversarial case 30).

## 6. Client contract

The projection carries `allowedTransitions` — the server's own answer for this
caller, this status and this compliance state. The UI renders exactly those
buttons, so a disabled control is never a guess and a client cannot invent a
move. It also carries the full `transitions` map on the list response, for the
state-machine document's own test to compare against.

`offerBoundary.canStartOfferWorkflow` is computed from the same facts —
`READY`-or-`ACTIVE`, parties confirmed, compliance clear and current, every
required consent active, representation effective — and its `blockers[]` name what
is missing. It creates nothing. P6 owns the Offer.
