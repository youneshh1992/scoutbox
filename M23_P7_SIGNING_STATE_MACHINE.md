# M23 P7 — Signing state machine

Two machines, one per object. Every transition is an explicit act by a
named human actor (§104) and is refused by name when the state does not
allow it.

## 1. Package

```
            start (lead, over an ACCEPTED Offer revision, case at offer_accepted)
                │
                ▼
            ┌───────┐  cancel                         ┌───────────┐
            │ DRAFT │ ───────────────────────────────▶│ CANCELLED │
            └───────┘                                 └───────────┘
                │ ready (document + start day + parties)      ▲
                ▼                                             │ cancel
            ┌───────┐  first party confirms   ┌─────────────┐ │
            │ READY │ ───────────────────────▶│ IN_PROGRESS │─┘
            └───────┘                         └─────────────┘
                │  void (lead) ───────────────────────┐   │ complete (lead, gate empty)
                │  supersede ──▶ new revision, back to DRAFT   ▼
                ▼                                     │ ┌───────────┐
            ┌────────┐                                │ │ COMPLETED │  (terminal; one db.signings row)
            │ VOIDED │◀───────────────────────────────┘ └───────────┘
            └────────┘
   EXPIRED = derived for DRAFT / READY / IN_PROGRESS once expiresAt has passed; never stored.
```

| From | Act | To | Actor | Gate |
| --- | --- | --- | --- | --- |
| — | `POST /org/offers/:id/signing` | DRAFT | room lead / recruitment lead (`roomCan(role,'offer_issue')`) | `canStart`: no completed/live package over the Offer; Offer ACCEPTED, revision ACCEPTED; case `offer_accepted`; recipient allowed; not blocked; subject present; contract days valid; expiry valid |
| DRAFT | `PATCH /org/signings/:id`, `POST …/document` | DRAFT | manage | `canAttachDocument` (DRAFT only), `expectedRev` |
| DRAFT | `POST …/ready` | READY | manage | `canMarkReady`: document with evidenceId + sha256, `contract.startDate`, ≥1 party; `expectedRev`; `clientKey` |
| READY / IN_PROGRESS | `POST /player/signings/:id/complete` | IN_PROGRESS | the addressed player (session) | `canCompleteParty`: current revision named, party pending, actor kind allowed, digest equals the revision's; case still `offer_accepted`; not blocked |
| READY / IN_PROGRESS | `POST …/parties/club/complete` | IN_PROGRESS | recruitment lead (`isLead`) | same gate, `expectedRev` |
| READY / IN_PROGRESS | `POST …/executed-document` | unchanged | manage | attaches evidence only |
| READY / IN_PROGRESS | `POST …/complete` | COMPLETED | recruitment lead | `completionGate` empty (M23_P7_SIGNING_EVIDENCE_MODEL.md §4); unit of work with rollback |
| DRAFT / READY / IN_PROGRESS | `POST …/cancel` | CANCELLED | manage | reason optional; the Offer and the case are untouched |
| READY / IN_PROGRESS | `POST …/void` | VOIDED | recruitment lead; T&S reviewer via `/admin/signings/:id/void` | reason required for T&S; confirmations on the revision are invalidated, history kept |
| READY / IN_PROGRESS | `POST …/supersede` | DRAFT (revision n+1) | manage | old revision SUPERSEDED, every party pending again |
| any terminal | anything | refused | — | `SIGNING_ALREADY_COMPLETED` / `SIGNING_CANCELLED` / `SIGNING_VOIDED` / `SIGNING_EXPIRED` |

The refusal is named after the **state that stopped the act** on a package
the caller may already read (`stateRefusal`), never after anything the
caller may not see.

## 2. Revision

DRAFT → READY (present) → IN_PROGRESS (first party) → COMPLETED (canonical
completion); DRAFT/READY/IN_PROGRESS → SUPERSEDED (supersede) or CANCELLED /
VOIDED with the package. `currentRevisionId` always points at the latest
revision (`current_revision_not_latest` is corruption).

## 3. What each state means to each audience

| State | Club | Player | Agent |
| --- | --- | --- | --- |
| DRAFT | editable, "not presented" | **absent** (a draft is invisible, not redacted) | absent |
| READY | presented, awaiting signatures | the exact revision and digest, "Sign this document" | "Presented for signature" |
| IN_PROGRESS | some signatures recorded | "You signed … waiting for the other parties" or still their turn | "Signing in progress", n of m parties |
| COMPLETED | completed note with contract days, no control | "Signing completed" | "Signed" |
| CANCELLED / VOIDED / EXPIRED | terminal, "start a new signing" offered when the Offer allows | terminal, `nextAction: null` | terminal |

## 4. Lifecycle coupling

Only `COMPLETED` touches the case, through the ONE validator and the ONE
lifecycle writer (`confirmSignedOutcome`, M23_P7_LIFECYCLE_INTEGRATION.md).
Cancel, void, supersede and expiry move nothing. A case that leaves
`offer_accepted` while a package is live (hold, resume) freezes the package:
every confirmation and the completion answer `SIGNING_LIFECYCLE_CONFLICT`
until the case is back at `offer_accepted` (E2E L5–L8).

## 5. Concurrency and idempotency (§31–§34)

Every club mutation names `expectedRev` (integer, never coerced) and is
refused `SIGNING_REV_CONFLICT` when the package moved. Every act that
creates a fact carries a `clientKey`, per act list; a replay with the same
payload fingerprint returns the same result with `idempotent: true`, a
replay with a different payload is `SIGNING_IDEMPOTENCY_CONFLICT`. Races
(completion vs cancel, completion vs void, final signature vs expiry, N
concurrent completions) have exactly one winner because every act runs on
the single-threaded store with its gate re-evaluated inside the act (E2E P).
