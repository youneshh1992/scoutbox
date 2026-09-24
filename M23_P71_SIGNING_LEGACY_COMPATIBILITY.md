# M23 P7.1 — Signing legacy compatibility

What P7.1 changed for records that predate P7 or bypass its workflow, and
what it deliberately left alone (§58–§59, §17, §35).

## 1. Legacy signed cases (§58)

A case at `signed` with a `LEGACY_RECORDED` row (no package) keeps its
meaning: the row is lifecycle evidence, the surface reports it as
`legacySigning`, and no package, document, party, digest or signing
instant is invented (P7 X4; persistence 4.10; hardening W3 shows a case
edited to `signed` beside a live package: the contradiction is named,
nothing written).

A `db.signings` row that **names a package** is evidence for `signed` only
if that package exists, is COMPLETED and names the row back
(`signingSupports`, H-P71-2). Before P7.1 a row planted beside a live
package satisfied the evidence rule; now it does not (hardening P10;
persistence 5.5b). Legacy rows carry no `signingPackageId` and are
unaffected.

## 2. The legacy recording route (§59)

`POST /org/players/:id/signing` is unchanged from P7: a thin caller of the
ONE writer with `method: 'LEGACY_RECORDED'`, refused
`SIGNING_CANONICAL_REQUIRED` when an accepted Offer or any live/completed
package exists for the player and club (hardening W1–W2). It has no
`clientKey`: a repeated call for a player with no Offer records twice, as it
always did. That is documented rather than changed — the route serves
recruitments outside the canonical Offer and its retirement is a product
decision, not a hardening fix.

## 3. Direct writers (§59)

The drift guard (P7 Z1–Z4, hardening ZK/ZM/ZL/ZP) sweeps the server tree:
`db.signings.push(` and `contractStatus = 'under_contract'` occur only in
`m29/index.mjs`; m29 never assigns `signed`; the signing module never reads
or writes the Trust Score. Two pre-existing writers of `contractStatus`
outside a recruitment signing remain and are named here:

| Writer | Route | Meaning | P7.1 treatment |
| --- | --- | --- | --- |
| player self-declaration | `POST /player/availability { contractStatus }` | the player's own statement about their contract situation, including one outside ScoutBox | kept; a value that contradicts a completed signing is named `PLAYER_CONTRACT_STATUS_DIVERGED` on the club's case surface and never repaired (hardening P2–P4) |
| grassroots squad release | the squad release route sets `free_agent` and `available_now` | the club released the player from its squad | kept; it is not a recruitment signing and writes no `under_contract` |

## 4. Pre-P7 evidence rows

`sha256` on evidence rows stored before D-P7-1 was computed over a decoded
string. Those rows are not signing documents (no signing existed) and are
not re-hashed; the byte verification in P7.1 applies only to vault rows a
signing revision references, all of which were written after the fix.

## 5. Packages written by P7 (schema 2308)

Every P7.1 integrity rule is satisfied by every row the P7 code could have
written: evidence references always carried the revision, the digest, the
actor and the instant; parties always carried the package's player and
club; the expiry was always validated relative to the request. The
extended persistence suite boots over a P7-written store and reads every
genuine row (persistence 2.15, 3.18, 5). No migration was added; the
schema stays 2308.

## 6. Clients built against P7

The club and player apps' API surface is unchanged. Two refusals became
more specific (`SIGNING_VOIDED`/`SIGNING_CANCELLED` on a refused completion,
P7; `SIGNING_SUPERSEDED` on a live package awaiting re-presentation, P7.1)
and both codes were already in every app's message table. The agent app's
selection of which package to show under an Offer changed (the live one
first); its API is unchanged.
