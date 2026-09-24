# M23 P6 — Lifecycle integration

## 1. One writer, one validator (§18, §19)

`ctx.applyLifecycleTransition` (m17/rooms.mjs) remains the only code that
assigns a case status. m28 never assigns `room.status`; m23OfferE2E A24
sweeps the m28 source for any status assignment. Every Offer-caused move
first asks `canTransitionRecruitmentCase(kase, action, { role, evidence,
now })` with the REAL evidence provider — the same call the legacy status
route and the semantic-action route make.

## 2. Evidence (m23/evidence.mjs)

The three offer kinds declared since P2 are now answered from the Offer
store through `offerEvidence(db.recruitmentOffers, kase, kind, now)`:

| Kind | Satisfied when |
| --- | --- |
| `offer_sent` (needed for `offer_made`) | this case's Offer has a LIVE revision that is ISSUED (unexpired at `now`), ACCEPTED or DECLINED |
| `offer_accepted_by_recipient` (for `offer_accepted`) | the live revision is ACCEPTED **and** a response row on it exists whose actor matches the revision's `recipientSnapshot` |
| `offer_declined_by_recipient` (for `offer_declined`) | likewise, DECLINED |

A DRAFT is not evidence; an ACCEPTED status word with no response row is
not evidence (a fabricated row cannot move a case — m23OfferPersistence
§4); another case's or another org's Offer is not this case's evidence.
The provider now takes the caller's clock (`now`) so an expiry is judged at
the request's instant; the lifecycle already passed it.

`confirmed_join` (for `signed`) is untouched: an accepted Offer answers
nothing about it (#33, #34).

## 3. Legacy writers (§19)

No unsafe writer existed (M23_P6_EXISTING_OFFER_WRITER_AUDIT.md); none was
retired. Regressions prove the gates still hold with the store present:

- `POST /org/rooms/:id/status {status:'offer_made'}` with no issued Offer →
  422 `ROOM_EVIDENCE_REQUIRED` (#16);
- `POST /org/rooms/:id/lifecycle {action:'sendOffer'}` idem → 422
  `LIFECYCLE_EVIDENCE_REQUIRED`;
- `recordOfferAccepted` / `recordOfferDeclined` by a club user with an
  unanswered Offer → 422;
- `status:'signed'` / `confirmSignedOutcome` at any point → 422.

## 4. Moves P6 makes

See M23_P6_OFFER_STATE_MACHINE.md §3. Withdrawal of an issued Offer steps
the case back to `offer_consideration` via `considerOffer` — an EXISTING
edge (`offer_made → offer_consideration`), chosen because the decision
still stands and the club may issue again. No new lifecycle state and no
new edge were added (§61); `ROOM_STATUSES`, `ROOM_TRANSITIONS` and
`STATUS_EVIDENCE_REQUIRED` are byte-unchanged.

## 5. Journey (m23/journey.mjs)

`offer.available` is now true on every boot; `offer.records[]` carries
`{ id, type, status, liveStatus }` for this case's own sound rows;
`conditions.offerAwaitingResponse` is true while a live revision is ISSUED
and unexpired at the journey's clock. No term, note or document enters the
journey. `outcome.signing` is unchanged and stays null after an
acceptance.

## 6. History entries

Every Offer-caused move appends the same `room_status_changed` entry M17
writes, with `detail.lifecycleAction` and the Offer/revision ids, so M20
funnels and time series read Offer rungs exactly as before (§55 — process
only, never a player metric).
