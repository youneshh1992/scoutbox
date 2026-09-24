# M23 P6.1 — Offer attack surface

The canonical Offer (m28) as an adversary sees it: every route, every
actor who can reach it, every input the server reads, every side effect a
write produces, and where each is proven. Nothing here is a new feature;
P6.1 hardened what P6 shipped and added no signing, no countersigning, no
negotiation and no new pathway (§96, §97).

## 1. Routes

| Route | Actor | Reads from the request | Mutates | Side effects after persist | Proof |
| --- | --- | --- | --- | --- | --- |
| `GET /org/rooms/:id/offers` | club user with `offer_view` on the case | path id | read receipt: none (club) | none | E2E B/F, hardening Q4/V1 |
| `POST /org/rooms/:id/offers` | room lead / recruitment lead | `terms`, `expiresAt`, `recipientMessage`, `internalNote`, `documents`, `clientKey`, `transactionId` | one DRAFT Offer + revision 1, `keys.create` | `offer_draft_created` (org) | E2E B, hardening F8/F9/G1/G2/J4 |
| `PATCH /org/offers/:id/draft` | lead | terms/messages/expiry/documents, `expectedRev` | the DRAFT revision, Offer rev | none | E2E C, hardening F3/F6/F7/S1 (live) |
| `POST /org/offers/:id/issue` | lead | `expectedRev`, `clientKey` | revision → ISSUED, recipient snapshot, readiness snapshot, `keys.issue[]`; case → `offer_made` through the ONE lifecycle writer | `offer_issued`, `offer_superseded` (org); recipient notification; agent notification when shared | E2E D, hardening F1–F4, G3–G4, G13–G17 |
| `POST /org/offers/:id/withdraw` | lead | `expectedRev`, `reason`, `clientKey` | live revision → WITHDRAWN (or the unissued draft only); case → `offer_consideration` when the live revision was issued | `offer_withdrawn` (org); recipient notification | E2E L, hardening F4, P4/P5, D9/D15, S5 (live) |
| `POST /org/offers/:id/revise` | lead | terms/messages/expiry/documents, `expectedRev`, `clientKey` | a new DRAFT revision, pointer moved | `offer_revision_opened` (org) | E2E K/M, hardening F2/F5, D3/D16, E12 |
| `GET /org/offers/:id`, `/history` | club user with `offer_view` | path id | none | none | E2E F, hardening J1, B3/B4 |
| `GET /player/offers`, `/:id` | the addressed adult | path id | first read receipt per live revision | none | E2E F/W, hardening E1/E2/E7–E9 |
| `POST /player/offers/:id/accept`, `/decline` | the addressed adult | `revisionId`, `reason` (decline), `clientKey` | revision → ACCEPTED / DECLINED, one response row, `keys.response`; case → `offer_accepted` / `offer_declined` through the ONE writer | `offer_responded` (org); club notification | E2E N/O, hardening P1–P6, E3/E4/E10, N/T |
| `POST /player/offers/:id/share-agent` | the addressed adult | `share` (boolean) | `agentShare` on the Offer | agent notification | E2E H, hardening C1, C7–C9 |
| `GET /player/offers/:id/documents/:docId` | the addressed adult | path ids | none | none | E2E A47–A49, hardening J3, T3 |
| `GET /guardian/offers…`, `POST …/accept`, `/decline` | a guardian | as the player routes | dormant: the pathway is closed in every jurisdiction | none | E2E G/S, hardening S-p1…S-p10 |
| `GET /org/agent/clients/:id/offers` | the agent named on the client's own agreement | path id | none | none | E2E H, hardening C2–C6, I1–I3, Z5 |

There is no delete route, no signing route, no countersign route, no
route through which an agent answers for a client, no route that takes a
status word from a body, and no route that takes an instant from a body.

## 2. Actors and what each can reach

| Actor | Can | Cannot | Hardened in P6.1 |
| --- | --- | --- | --- |
| Room lead / recruitment lead (`isLead`) | draft, edit, issue, withdraw, revise, read, history | answer, sign, delete, read another club's Offer | a demoted lead loses every act at once, including a replay under an old key (G13–G17, B1–B4) |
| Contributor scout | read the club's Offers on cases they can see | any act | a restricted room removes even the read (B4) |
| Removed staff | nothing | everything (401 `USER_REMOVED` / `ORG_AUTH_REQUIRED`) | open sessions and open SSE streams go silent at removal (A1–A6) |
| The addressed adult player | read, accept, decline, share/un-share with their agent, open a document | draft, issue, withdraw, revise, act on another player's Offer, act on a superseded/expired/withdrawn revision | body claims of identity, adulthood, guardianship or status are ignored (N/T); the mutation's single server instant decides expiry (E10) |
| Guardian | nothing until a jurisdiction opens the pathway | everything | closed for every jurisdiction incl. prototype keys (S-p1, S-p2) |
| The client's own agent | read the Offers the client shared, while basis, scope AND licence hold at the read instant | accept, decline, draft, read unshared Offers, read after the mandate ends | licence consulted at read (D-P61-2, C4/C5); temporal fail-closed on an agreement confirmed after the read instant (C3a); un-share works without an active agent (D-P61-8) |
| Same-agency colleague / agency admin / analyst / foreign agency | nothing about the Offer | everything (404 `REPRESENTATION_NOT_FOUND`; the per-Offer route does not exist) | second agency seeded; foreign agency proven over HTTP (I3) |
| Foreign club | nothing (404 identical to an invented id) | everything | oracle sweep byte-identical (J1) |
| Grassroots club | the same surface, the same rules | anything a Pro club cannot; a player outside 50 km is invisible | V1–V4 |

## 3. Inputs the server reads, and inputs it refuses to read

Read (validated, bounded, typed): `terms` (five typed fields, DATE_ONLY
days, length limits), `expiresAt` (P5.7 `parseInstant`, ≥ 1 h ≤ 180 d
from the request's server instant), `recipientMessage`, `internalNote`,
`documents` (vault references owned by the club), `clientKey`,
`expectedRev` (integer), `revisionId`, `reason`, `share`, `transactionId`.

Never read from a body, proven by the source sweep (hardening T-src):
`status`, `role`, `verified`, `licensed`, `isAdult`, `canAccept`,
`isGuardian`, `isAgent`, `complianceClear`, `currentRevision`,
`playerId`, `orgId`, `caseId`, `occurredAt`, `issuedAt`,
`revisionNumber`, `actorId`. A body that carries them is ignored (F7,
N/T).

Text: control characters, zero-width and bidirectional override
characters are stripped (D-P61-3); Unicode letters, accents and
non-Latin scripts are kept as typed; HTML is inert (no
`dangerouslySetInnerHTML` in any Offer surface, proven by source sweep);
oversize bodies are refused by the 20 MB body limit and the per-field
limits.

## 4. Side effects, and their audiences

Six org-private events (`offer_draft_created`, `offer_issued`,
`offer_revision_opened`, `offer_superseded`, `offer_withdrawn`,
`offer_responded`), each carrying ids and a status word only; delivered
only to the issuing club's staff who are still members. Notifications:
one factual line and the Offer id, to the recipient, to the club and to
the shared agent; never a term, a note, a decision or a rationale; never
to a same-agency colleague. Every side effect runs after `persistNow()`
inside `safe()`; a throwing side effect is logged and the persisted
success is still reported as a success (D-P61-6).

## 5. Reads that are not writes

Listing or reading an Offer as the recipient records a first-read
receipt for the live revision, once — a delivery fact, never a status.
Reading an expired Offer writes nothing (E9). No read moves a case,
repairs a row, materialises EXPIRED, or creates an Offer from a lifecycle
state (Q1, persistence 5.10–5.13).

## 6. Threats considered and where each is closed

| Threat | Closed by | Proof |
| --- | --- | --- |
| Two writers on one revision | ONE Offer rev, state gates before the rev, single-threaded handler | F1–F9 |
| Two answers to one revision | the response gate + one response row per revision + `OFFER_ALREADY_RESPONDED` | P1–P5 |
| Answer to a revision being replaced | supersede vs accept is decided by whichever handler ran first; the loser is told which state won | P6 |
| Expiry edge | evaluated at the handler's own instant; −1 ms lands, 0 ms refused | E1–E4, E10 |
| Stale role, membership, representation, scope, licence | re-derived from the live store on every request; SSE streams too | G13–G17, A, C, I |
| Idempotency key as a capability | authority first, replay second; a key replays only the exact payload (deep fingerprint) | G17, G11 (D-P61-1) |
| Rate-limit aliasing | one budget per organisation for club acts, per (kind, person) for answers; replays unpenalised | H |
| Cross-Offer / cross-case / cross-player confusion | ids joined only through the Offer's own record; foreign ids 404 | J2–J5, F7 |
| Case/Offer disagreement | `offerCaseConsistency`: corruption refused, warning surfaced, recipient told the case is paused | persistence 5.8–5.9, hardening P7–P9 |
| Corrupt or forged rows | integrity incl. temporal ordering, bounds, unknown statuses, pointer at a non-latest revision | persistence §4–§5 |
| Deleted player | names nulled in responses and history; new writes refused | m28 `onPlayerDeleted` |
| Partial failure | authoritative state first; side effects wrapped; lifecycle writer throw rolled back | O1–O3 |
| Restart | keys, terminal states, shares and rules survive; nothing repaired | Z1–Z6, persistence §3/§5 |
