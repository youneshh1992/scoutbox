# M23 P6 — Offer state machine

Terminal at revision level. Seven statuses (§5); `viewed` is a receipt, not
a status (§40); there is no `SIGNED` and no edge toward one (§83).

## 1. Revision transitions

```
DRAFT      → ISSUED      (club: issue; requires complete terms, an expiry ≥1h/≤180d, a recipient route NOW, no block, case at offer_consideration|offer_made, transaction readiness if referenced)
DRAFT      → WITHDRAWN   (club: withdraw a draft; also: the recipient answered the live revision while this draft was open → discarded, recorded)
ISSUED     → ACCEPTED    (the addressed recipient's own act, exact revision, unexpired, unanswered, live)
ISSUED     → DECLINED    (idem, optional reason)
ISSUED     → WITHDRAWN   (club: withdraw an unanswered, unexpired issued revision)
ISSUED     → EXPIRED     (derived lazily from expiresAt at the request's clock; never written)
ISSUED     → SUPERSEDED  (club: issuing the next revision)
ACCEPTED   —             terminal: no revise, no withdraw, no re-issue over it
DECLINED   —             terminal (a new revision may be drafted once the case is back at offer_consideration)
WITHDRAWN  —             terminal
EXPIRED    —             terminal (a new revision may be drafted)
SUPERSEDED —             terminal (readable history)
```

`OFFER_REVISION_TRANSITIONS` in `offer.mjs` is the frozen table; the pure
gates (`canRespondToRevision`, `canWithdrawRevision`, `canRevise`) and the
suite's group A prove every edge and every non-edge.

## 2. Offer-level status

The Offer's `status` is its current revision's effective status; its
`liveStatus` is the live revision's. One live Offer (status DRAFT or ISSUED)
per case at a time; a new Offer can be drafted only after the previous one
is answered, withdrawn or expired — and a changed Offer is a new revision,
never a second Offer.

## 3. Case lifecycle coupling (§18)

| Offer act | Case action (M23 validator) | Case status |
| --- | --- | --- |
| issue (first) | `sendOffer` | `offer_consideration → offer_made` |
| issue (revision while at offer_made) | — (`already_there`) | unchanged |
| accept | `recordOfferAccepted`, actor = recipient | `offer_made → offer_accepted` |
| decline | `recordOfferDeclined`, actor = recipient | `offer_made → offer_declined` |
| withdraw issued | `considerOffer` | `offer_made → offer_consideration` |
| withdraw draft | — | unchanged |
| expiry | — | unchanged (the club revises or steps back) |

Every move goes through `canTransitionRecruitmentCase` with the real
evidence provider and then `ctx.applyLifecycleTransition` — the ONE writer.
A move the case cannot take rolls the Offer change back and answers
`OFFER_LIFECYCLE_CONFLICT` (409): an Offer is never left in a state the case
does not record.

After a decline the case sits at `offer_declined`, from which no edge leads
to `offer_consideration`; the lead steps back through `shortlist →
considerOffer` (the finalized decision still stands as evidence) before a
new revision can be drafted and issued. Documented, tested (m23OfferE2E O).

## 4. Validation order on a mutation (§50)

concealing lookup (404) → role (403) → clientKey shape (400) → idempotent
replay (200) / key conflict (409) → revision state (409) → `expectedRev`
(400/409) → subject removed (409) → block (403) → case state (409) →
content (400) → recipient / minor pathway (422) → transaction readiness
(422) → rate limit (429) → write.

For a recipient answer: concealing lookup → key → `revisionId` shape → the
recipient rule NOW (guardian still controls the child; adult answers their
own; minor pathway) → block (accept refused, decline allowed) → the exact
revision gate (superseded / withdrawn / expired / already answered / not
issued / not live) → optional `expectedRev` → reason → rate limit → write
→ the case through the validator with the recipient as actor.

## 5. Races (§26)

Node's single-threaded request handling serialises each mutation; the
gates above re-read state at the start of every handler, so of two
simultaneous accepts exactly one lands and the other reads
`OFFER_ALREADY_RESPONDED`; accept vs decline likewise; accept vs withdraw
leaves one winner and the loser is told which state won
(`OFFER_WITHDRAWN` or `OFFER_ALREADY_RESPONDED`). Proven in m23OfferE2E P.
