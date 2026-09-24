# M23 P6 — Offer terms and versioning

## 1. Immutability rule (§6)

A revision's terms, message, documents and expiry are editable only while
the revision is a DRAFT (`PATCH /org/offers/:id/draft`, own rev). At ISSUE
the revision is re-validated (complete terms, a real expiry in range,
documents still owned by the club) and frozen: `PATCH` on an issued
revision answers 409 `OFFER_STATE_INVALID` (#39). A change afterwards is a
new revision (`POST /org/offers/:id/revise`), never an edit.

## 2. Revision numbering

`revisionNumber` is monotonic per Offer and never reused
(`nextRevisionNumber`); at most 20 revisions per Offer (`OFFER_LIMITS`).
`supersedesRevisionId` is set on a revision drafted while its predecessor is
ISSUED; at issue the predecessor becomes SUPERSEDED with
`supersededByRevisionId` and `supersededAt`. A revision drafted after an
expiry, a decline or a withdrawal supersedes nothing (the predecessor is
answered history).

## 3. Historical readability (#41)

Every revision stays on the Offer exactly as it was: the club reads all of
them; the recipient reads every revision that was ever issued (with its
original terms and its status: SUPERSEDED, EXPIRED, DECLINED…); the agent
reads issued revisions' terms. A superseded revision cannot be accepted or
declined (#28, #42): the exact-revision gate refuses with
`OFFER_SUPERSEDED`.

## 4. Exact-revision answers (§22, §23, #31)

An answer names `revisionId`. The gate checks, in order: the revision
exists on this Offer (else `OFFER_NOT_FOUND` — the same word as a missing
Offer); it was issued; not superseded; not withdrawn; not expired at NOW;
not already answered; it is the LIVE revision. Only then is the response
row written and the case moved.

## 5. Draft beside a live revision (§25)

While the club drafts revision N+1, revision N remains live and answerable.
Two outcomes:

- the club issues N+1 first → N is SUPERSEDED; the recipient answers N+1;
- the recipient answers N first → the N+1 draft is discarded (status
  WITHDRAWN, `discardedByResponseId`, history `offer_draft_discarded`) and
  N becomes the current revision; a later issue attempt over an ACCEPTED
  live revision is refused (`OFFER_STATE_INVALID`).

The recipient's answer to what they were sent is authoritative; a draft
nobody was sent is not anyone's Offer.

## 6. One rev for the Offer (§28)

Every club mutation of an existing Offer requires `expectedRev` (an
integer; `'1'`, `1.5`, `true` are refused with `OFFER_REV_REQUIRED`) and
compares it with the Offer's `rev`, which moves on every change to any
revision and on every recipient answer. A stale rev answers 409
`OFFER_REV_CONFLICT` with `currentRev`. A recipient's share/unshare and a
read receipt do NOT move the rev — they are the recipient's facts, and must
not make the club's next edit conflict. A recipient may send `expectedRev`
on an answer; when sent it is checked the same way.

## 7. Idempotency (§27)

`clientKey` (≤64) on create (fingerprinted against the payload: same
key + same payload replays, same key + different payload conflicts), issue,
withdraw, revise (one list per act, per Offer, never overwritten — the key
that issued revision 1 cannot issue revision 2) and on accept/decline (the
key names the exact answer: the same key replays, the same key for a
different answer conflicts). Keys are on the record and survive a restart.

## 8. Terms vocabulary

`offerType` is `direct_recruitment` only. A transfer or a loan needs a
releasing club, which is the P5.6D transaction's business; club-to-club
terms (`transaction.terms.versions`) are a different object from the
engaging club's Offer to the player and are not touched by P6.
