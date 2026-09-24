# M23 P6 — Offer security and privacy threat model

Each threat names the control and the test that proves it. "E2E" is
`scoutbox-server/scripts/m23OfferE2E.mjs`; "P" is
`m23OfferPersistence.mjs`; "L" is `e2e/m23OfferLive.test.mjs`.

| # | Threat | Control | Proof |
| --- | --- | --- | --- |
| 1 | A club drafts or reads an Offer on another club's case | `findRoomForRequest` concealment; the Offer lookup is scoped to `req.org.id` | E2E #1, B4, C5, D2, L N3 |
| 2 | A scout, viewer or role-changed user issues an Offer | `roomCan` re-derived per request; `offer_issue` needs room lead | E2E #2, #8, L N2 |
| 3 | A positive decision silently creates an Offer | no code path creates a row except `POST /org/rooms/:id/offers`; the surface says so | E2E #4, L A3b |
| 4 | An Offer is issued from the wrong case state, without a decision, or twice in parallel | create gate: state, `decision_progress` evidence, one live Offer; issue gate re-checks state | E2E #3, B8, D10, J10 |
| 5 | The player or agent sees a draft | recipient listing requires a LIVE (issued) revision; agent projection likewise | E2E #5, #6, K1, L A5c, E1 |
| 6 | Issued terms are edited in place | PATCH refused unless DRAFT; a change is a new revision | E2E #39, #40, L A7e |
| 7 | An old revision is accepted after supersede/withdraw/expiry, or answered twice | exact-revision gate (`canRespondToRevision`) with named states | E2E #26–#30, #42, A55–A60 |
| 8 | Two answers, or an answer and a withdrawal, both land | handler re-reads state; single-threaded mutation order | E2E P (#43–#45) |
| 9 | A retry issues twice, or a reused key does something else | per-act key lists on the record, fingerprinted create | E2E #46, #47, Q, P §3 |
| 10 | A stale client overwrites a newer state | ONE Offer rev, `expectedRev` required and integer, never coerced | E2E #7, C1–C3, K3, N4–N5 |
| 11 | The decision's rationale, an assessment, a Box Cam observation or a transaction note reaches the recipient, the agent, an event, a notification or an error body | separate views; allowlisted event payloads; factual notification lines; error allowlist | E2E #36, #37, #38, I, U, V; L B2c, E4, N10 |
| 12 | The club's internal note reaches the recipient | `recipientMessage` vs `internalNote` are two fields; only the former is in the recipient view | E2E F2, A88; L B2c |
| 13 | A same-agency colleague or an agency administrator reads a client's Offer | own-agreement rule → 404; no summary path exposes Offers | E2E #18, #19; L E5 |
| 14 | An agent accepts as the player | no such route; player routes refuse org tokens; `responderMatches` never matches an agent | E2E #20, #20b, A67; L E6 |
| 15 | A lapsed mandate keeps reading through a saved deep link | basis/scope/licence re-derived per read; the share grants nothing alone | E2E #14, #48, W3 |
| 16 | A guardian accepts an adult's Offer, a child bypasses the guardian, the wrong guardian answers | `recipientSnapshot` + `responderMatches` + live rule; pathway closed | E2E #21, #23, #24, #25, S; L F |
| 17 | A minor with a corrupt DOB is treated as an adult | `isAdult` through the P5.7 parser | E2E A91 (#51) |
| 18 | An Offer is issued against a blocked, removed or unreachable recipient | block, subject-removed and recipient checks at issue; accept refused under a block, decline allowed | E2E #9, R; L (server) |
| 19 | Impossible, bare-local or client-supplied expiry timestamps | `validateExpiry` through `parseInstant`; the server's clock only; lazy expiry fails closed on unreadable values | E2E #10, #11, #12, #52, A43–A53, Z |
| 20 | The client claims when it answered, or who it is | actor and instants are server-derived; body `occurredAt`/`at` ignored | E2E Z6; routes read `req.player`/`req.guardian`/`req.orgUser` only |
| 21 | Acceptance becomes a signing (db.signings, `signed`, `under_contract`) | no signing writer imported; `confirmed_join` untouched; wording "signing pending" | E2E #32–#35, A23, A81, A85, N15–N16; P 2.8–2.9, 3.18 |
| 22 | A legacy status route writes an offer state without evidence | `STATUS_EVIDENCE_REQUIRED` unchanged; provider reads the store | E2E #16, E, X |
| 23 | A fabricated ACCEPTED row moves a case | evidence requires a matching response row; corrupt rows are refused | P §4 |
| 24 | A malformed or invented id leaks a real one, or the 404 differs | one concealment body; traversal-safe ids | E2E #49, #50, C11 |
| 25 | Offer abuse floods a recipient, or alias budgets multiply | central limiter: `offer_draft_write`/`offer_issue`/`offer_withdraw` per org, `offer_response` per person; idempotent replay before the limiter | E2E Y |
| 26 | A document reference exfiltrates another org's vault file, or a draft's document | ownership checked at draft AND issue; recipient fetch only on issued revisions addressed to them | E2E A49, B5 (documents), route `documentHandler` |
| 27 | An Offer survives or mutates across a restart inconsistently | single persisted row; byte-identical views after reboot; keys replay | P §2–§3 |
| 28 | A corrupt row crashes the process or is "repaired" | integrity check → generic 500; never repaired | P §4 |
| 29 | The player pays for visibility or priority of Offers | no paid path exists; list order is by update time | design (§85), E2E F1 |
| 30 | AI negotiates, counter-offers or auto-accepts | no such code; every state change is a human act behind explicit routes | design (§84), A24 |

## Residual risks (accepted, documented)

- Node's single-process ordering is the race arbiter; a multi-process
  deployment would need a store-level compare-and-set on `rev` (the
  `expectedRev` contract already exists for clients; the server-side CAS
  is a P7+ concern shared with every M23 domain).
- The rate limiter is in-memory per process (the M18.1 design), as for
  every other action.
- Expiry is judged at read time; an Offer nobody reads simply expires
  silently — by design, no scheduler.
