# M23 P7.1 — Signing attack surface

Every action the signing workflow exposes, with what it depends on and what
can go wrong. This is the map the P7.1 hardening suites are written against
(m23SigningHardeningE2E, the extended m23SigningPersistence,
m23SigningHardeningLive). "Cov." names the suite groups that prove the
row; H-codes are the P7.1 hardening changes (M23_P71_SIGNING_DEFECT_REGISTER.md).

Common to every club route: the session resolves to an org user **per
request** (`orgAuth` → `db.users`), the role on the case is re-derived
(`roomRole` → `roomCan`), `isLead` is the current role string; the package is
looked up in the caller's organisation only, then `signingIntegrity` and
`signingConsistency` (now including the `db.signings` coupling, H4) must be
clean or the package is `SIGNING_STATE_UNKNOWN` (500, no internals). Common
to every recipient route: the package is found only among sound, presented
packages whose recipient party names the session's player.

| # | Action | Actor | Route / service | Resource scope | Authority depends on | Temporal | Evidence | rev / key | Rate | Block | Side effects | Privacy risk | Concurrency risk | Cov. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | read case signing surface | club reader | `GET /org/rooms/:id/signing` | case in org | `offer_view` | expiry derived at read | — | — | — | readiness names BLOCKED | none | note visible to club only | — | P7 B, live A; H P |
| 2 | start package | room lead / recruitment lead | `POST /org/offers/:id/signing` | Offer in org | `offer_issue`; Offer ACCEPTED + revision ACCEPTED; case `offer_accepted`; recipient adult; not blocked; subject present | expiry 1 h–90 d from server clock; contract days DATE_ONLY | — | key `start` (fp: offer, contract, note, expiry) | `signing_start` 30/h org | 403 `SIGNING_BLOCKED` | package DRAFT, history, audit, `signing_created` | note is club-private | start vs start → one live package (`PACKAGE_EXISTS`) | P7 B,C; H E, J1 |
| 3 | edit draft | manage | `PATCH /org/signings/:id` | package in org, DRAFT | `offer_issue` | contract days validated | — | `expectedRev` | `signing_document_write` 120/h org | — | history | — | stale rev 409 | P7 G; H M |
| 4 | attach document | manage | `POST /org/signings/:id/document` | DRAFT | `offer_issue` | — | m14 sniff + size + name; SHA-256 recomputed from bytes (D-P7-1) | `expectedRev` | `signing_document_write` | — | vault row `organisation_internal` with `meta.signingPackageId`; history | bytes never leave the org | replace vs party completion impossible (DRAFT only) | P7 G; H B, C |
| 5 | replace draft document | manage | same route, DRAFT again | DRAFT | as 4 | — | a new vault row; the old digest is gone from the revision | `expectedRev` | as 4 | — | as 4 | — | — | H B |
| 6 | present (ready) | manage | `POST /org/signings/:id/ready` | DRAFT with document + start day + parties | `offer_issue`; not blocked; subject present | expiry re-validated; **no mutation before the rate check** (H6) | **vault bytes re-hashed and matched to the revision digest, row must be this package's own** (H1) | key `ready`; `expectedRev` | `signing_document_write` | 403 | READY, history, audit, `signing_ready`, player + agent notified | notification text names no term | ready vs cancel: one winner by state | P7 G; H B, C |
| 7 | party complete (player) | the addressed adult | `POST /player/signings/:id/complete` | presented package addressed to the session's player | recipient party `forEntityId` = session player; actor kind `player`; case `offer_accepted`; not blocked | server instant; expiry derived | current revision + exact digest named; **bytes re-verified** (H1); evidenceRef written | key `party` (fp: type, revision, digest; actor bound) | `signing_party_completion` 30/h per player | 409 `STATE_INVALID` (never "blocked") | party COMPLETED, IN_PROGRESS, history, audit, `signing_party_completed`, club leads notified | name never echoed | duplicate vs duplicate → one completion; vs cancel/void/expiry/supersede → one winner | P7 D; H F, J, K, L |
| 8 | party complete (club) | recruitment lead | `POST /org/signings/:id/parties/club/complete` | package in org | `isLead` now; as 7 | as 7 | as 7 | key `party`; `expectedRev` | `signing_party_completion` 30/h per user | 403 | as 7, player notified | — | as 7 | P7 J; H E, J |
| 9 | attach executed document | manage | `POST …/executed-document` | READY / IN_PROGRESS | `offer_issue` | — | as 4; evidence only, completes nothing | `expectedRev` | `signing_document_write` | — | history | club-only document | — | P7 J1, J2 |
| 10 | complete | recruitment lead | `POST /org/signings/:id/complete` | package in org | `isLead` now; gate: state, revision active, document, every party, evidence, digests, temporal order, contract days, Offer + revision ACCEPTED, references, case `offer_accepted`, no other completed signing, not blocked; **bytes re-verified** (H1) | server instant | evidence refs re-checked | key `complete`; `expectedRev` | `signing_closure` 30/h org | gate `BLOCKED` | unit of work: revision + package COMPLETED, ONE `db.signings` row (unique per package **and per Offer**, H3), level/availability/timeline, invoice, lifecycle `signed`, links, key, history, audit, persist; then effects, `signing_completed`, notifications | row carries no term | complete vs complete/cancel/void/expiry → one winner; failure anywhere → rollback | P7 K, P, AD; H J, Q |
| 11 | cancel | manage | `POST …/cancel` | DRAFT/READY/IN_PROGRESS | `offer_issue` | — | — | key `cancel`; `expectedRev` | **`signing_safety_closure` 60/h org** (H17) | allowed | CANCELLED, history, audit, `signing_cancelled`, player notified if presented | reason club-only | vs complete: one winner | P7 L; H J |
| 12 | void | recruitment lead | `POST …/void` | READY/IN_PROGRESS | `isLead` | — | confirmations invalidated, kept | key `void`; `expectedRev` | `signing_safety_closure` | allowed | VOIDED … | reason club-only | vs complete: one winner | P7 AD; H J |
| 13 | void (T&S) | named reviewer | `POST /admin/signings/:id/void` | any package | `req.reviewer` | — | — | reason required | — | — | VOIDED, club + player notified | — | after completion refused | H U |
| 14 | supersede | manage | `POST …/supersede` | READY/IN_PROGRESS | `offer_issue` | — | old revision SUPERSEDED, new DRAFT, every party pending | key `supersede`; `expectedRev` | `signing_document_write` | — | history, audit, `signing_superseded`, player notified | — | vs party completion: one winner (revision named) | P7 H; H J, N |
| 15 | expire | nobody (derived) | `effectiveStatus(pkg, now)` | live packages | — | `expiresAt` vs server instant, `isExpiredAt` (at the instant: expired); **stored expiry beyond the maximum is corruption** (H11) | — | — | — | — | none (never written) | — | final signature vs expiry: the mutation's own instant decides | P7 R; H K, S |
| 16 | read package / history | club reader | `GET /org/signings/:id`, `/history` | package in org | `offer_view` | — | — | — | — | — | — | note, names: club only | — | P7 C; H E, O |
| 17 | list (recipient) | addressed adult | `GET /player/signings` | sound, presented, addressed | session player | — | — | — | — | package readable, act refused | — | no note, no unpresented revision, no name | — | P7 D, T; H F, T |
| 18 | document fetch (club) | club reader | `GET /org/signings/:id/document?kind&revisionId` | package in org | `offer_view` | — | **bytes re-verified before serving** (H1) | — | — | — | — | evidence row must be the org's | — | H B, T |
| 19 | document fetch (player) | addressed adult | `GET /player/signings/:id/document` | presented revision of an addressed package | session player | — | as 18 | — | — | — | — | executed document never served | — | H B, T |
| 20 | agent view | representing agent | `GET /org/agent/clients/:id/signings` | packages of the client over Offers the client shared | own agreement; `client_private` decision (basis, adult, blocks, licence, compliance); scope employment/transfer; licence current | — | — | — | — | player's block on the agency → 403 | — | no note, digest, name, bytes; narrower than the player's | — | P7 F; H G |
| 21 | guardian routes | guardian | `/guardian/signings…` | dormant | pathway table (all closed) | — | — | — | — | — | list `[]`, read 404, act 422 | — | — | P7 E; H H |
| 22 | deep link (club) | club user | `#/recruitment/rooms/:id` → Signing tab | case | re-derived on every request | — | — | — | — | — | — | — | — | live |
| 23 | deep link (agent) | agent | `#/clients/:rel/offers` | relationship | re-derived: 403/404 after loss | — | — | — | — | — | — | — | — | P7 live E; H G, I |
| 24 | notification | server | `notify(recruitment_signing)` | player, club leads, agent while basis holds | preference gate; block suppresses | — | — | coalesced when identical and unread | — | — | inbox rows | text names acts only | retry: coalesced, no second push | H V |
| 25 | event | server | `broadcast(signing_*)` | `org_private` to the org | audience by registry | — | — | — | — | — | SSE + replay log | ids + party type only; registry strips anything else | one per act | P7 V; H U |
| 26 | completed signing read | club reader | `GET /org/signings` (list), journey, Offer summary | rows of the org | `orgAuth` | — | — | — | — | — | — | row has no term/note/bytes | — | P7 K, T |
| 27 | affiliation / contract projection | server | `recordCompletedSigning` | player row, grassroots squad | the ONE writer | — | — | idempotent per package + per Offer (H3) | — | — | `under_contract`, availability, level, timeline, squad (grassroots), invoice | — | rolled back with the unit of work | P7 K, AD; H Q |
| 28 | legacy signing route | club | `POST /org/players/:id/signing` | player visible to org | `visibleToOrg`, not blocked; refused when an accepted Offer or a package exists (`SIGNING_CANONICAL_REQUIRED`) | — | — | none (no key) | — | 403 | the ONE writer with `LEGACY_RECORDED` | — | two rows for one player and club are possible by design (no Offer, repeated recording) — documented, not a P7 signing | P7 X; H W |
| 29 | player self-declared contract status | player | `POST /player/availability` | own row | session | — | — | — | — | — | `contractStatus` may diverge from a completed signing; **detected as `PLAYER_CONTRACT_STATUS_DIVERGED`, never repaired** (H4) | — | — | H P |

## Counts

29 actions; 21 with a mutation; 13 keyed by `clientKey`; 11 rev-guarded; 5
rate policies (`signing_start`, `signing_document_write`,
`signing_party_completion`, `signing_closure`, `signing_safety_closure`);
7 events; 1 notification type; 3 audiences (club, player, agent) plus T&S.

## Not on the surface (by design, re-proven in H)

No route names an actor, a role, a time, a player id or a digest that the
server then trusts; no route rebinds a package to another Offer, player,
case or organisation; no agent write route; no guardian write; no
post-completion mutation of any kind (edit, attach, cancel, void, supersede,
T&S void); no external signature provider.
