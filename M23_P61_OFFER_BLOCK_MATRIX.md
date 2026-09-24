# M23 P6.1 — Offer block matrix

A player's (or a guardian's) block of an organisation, placed at every
point of the Offer's life. The rule is P6's §9, re-proven at each
transition: **a block stops new communication and new commitments; it
rewrites no fact and never traps either side.** The block is read live
from `isBlocked(playerId, orgId)` on every request — never cached on the
Offer, never on the case.

| Block placed… | Draft | Edit draft | Issue | Recipient read | Accept | Decline | Withdraw | Revise | New draft | Case | Proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **before any Offer** | 403 `OFFER_BLOCKED` | — | — | — | — | — | — | — | 403 `OFFER_BLOCKED` | unchanged | E2E R1; hardening D10 |
| **after a draft** (nobody was sent anything) | — | 200 (club-private text) | 403 `OFFER_BLOCKED` | invisible (a draft always is) | — | — | 200 (closure) | — | 403 `OFFER_BLOCKED` | unchanged | D5–D10 |
| **after issue** (the recipient holds a live revision) | — | — | — | 200 — what was sent stays readable | 403 `OFFER_BLOCKED` (lift the block first) | 200 — a refusal is always open | 200 — closure; the case steps back to `offer_consideration` | 403 `OFFER_BLOCKED` | 403 `OFFER_BLOCKED` | moves only through withdraw or decline | D11–D16; E2E R |
| **after acceptance** | — | — | — | 200 | — (answered) | — (answered) | 409 `OFFER_STATE_INVALID` (nothing to withdraw) | 409 `OFFER_STATE_INVALID` (no revision over an accepted Offer, block or not) | 409 (a live Offer exists) | stays `offer_accepted`: the acceptance is historical fact | D1–D4 |
| **after decline / withdrawal / expiry** | — | — | — | 200 (history) | — | — | — | 403 `OFFER_BLOCKED` | 403 `OFFER_BLOCKED` | unchanged | D10, D16 |
| **lifted** | every act returns to its state rule | | | | | | | | | | E2E R (lift) |

Notes

- **A block never deletes or hides history.** The recipient keeps
  reading the revisions they were sent; the club keeps reading its own
  record. Trust, analytics and Second Look are untouched (nothing in m28
  writes to them).
- **A block does not imply Inbox access in either direction.** After an
  acceptance under a block the club still cannot open a new
  communication on the case (D4): Offer access and Contact access are
  different gates.
- **The agent projection under a client's block of the agency** closes
  at once (`BLOCKED` from the P5.6E decision; hardening C6) and reopens
  when lifted (C7) — nothing was deleted.
- **Guardian blocks** take the same path through `isBlocked`; the minor
  pathway is closed regardless, so no guardian-addressed Offer exists to
  be blocked in this build (S-p1, S-p2).
- **No block state is stored on the Offer.** A snapshot with a block
  lifted or placed after a restart reads correctly because every request
  asks the block table (Z, persistence 5.x).
