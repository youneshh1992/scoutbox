# M23 P6.1 — Offer authorization revalidation

Every Offer request re-derives who the caller is and what they may do
from the live store, at the request's own instant. Nothing about
authority is cached on a session, an Offer, a key, a link or a stream.
This document lists each authority fact, where it is read, what makes it
stale, and the proof that staleness takes effect at once.

## 1. Facts and their sources

| Fact | Read from | On which requests | Goes stale when |
| --- | --- | --- | --- |
| Org membership | `db.users` row (`orgAuth`: removed users 401 `USER_REMOVED`; sessions deleted at removal) | every org request; every SSE frame (`shouldDeliver`) | staff removal |
| Lead tier | `isLead(req.orgUser)` from the live user row | draft, edit, issue, withdraw, revise | tier change |
| Room role | `roomRole({ room, user, isLead })` — owner / `leadScoutUserId` / assignment / restriction, from the live case row | every Offer route on a case (`offerFor` → `roleFor` → `roomCan`) | lead reassignment, room restriction, assignment removal |
| Case ownership | the case row's `orgId` equals the session's org | every club route | never (tenant is immutable); a foreign id is 404 |
| Recipient rule | `resolveContactRecipient` at NOW (adult → player; minor → closed pathway) | issue (snapshot), every recipient read, accept, decline, share | age boundary, guardian change, player deletion |
| Addressed person | the live revision's `recipientSnapshot` compared with the session (kind + id) | recipient read, accept, decline, document | a re-issue to a different recipient (new revision) |
| Block | `isBlocked(playerId, orgId)` live | draft, issue, revise, accept, share; agent projection | block placed or lifted |
| Agent basis | `integration.basisFor` at the request instant: own agreement, active, client-confirmed, not ended | agent projection, agent notification | termination, dispute, expiry, an agreement confirmed after the instant asked about |
| Agent scope | `basis.scope` includes employment or transfer | agent projection | scope change (a second, commercial-only agreement opens nothing) |
| Agent licence | `integration.licenceCurrentFor(agentUserId, jurisdiction, at)` — **added in P6.1** | agent projection | facet inactive / unverified |
| Agency affiliation | `agent.resolveMembership` | agent projection | affiliation ended |
| Client share | `offer.agentShare.agentUserId === req.orgUser.id` | agent projection | un-share (works without an active agent — P6.1) |
| Deep link | the same reads as above; a link carries no authority | every read by id | any of the above |

## 2. Order of checks on a mutation

authority (membership → tier → room role → tenant) → subject present →
block → case state → decision → one live Offer → revision state → rev →
idempotency key → content → recipient NOW → readiness → rate limit →
write. A replay under a used key is answered only after authority has
been re-derived (§22): **an old key is not a capability token** (G17).

## 3. Proofs that staleness bites immediately

| Scenario | Result | Check |
| --- | --- | --- |
| Tom made room lead, issues with key KT, demoted, retries KT | 403 `OFFER_NOT_PERMITTED` before the replay | G13–G17 |
| Demoted lead tries withdraw / revise | 403; the read stays (club memory) | B1–B3 |
| Room restricted to lead + assignees | the unassigned scout loses even the read | B4 |
| Staff removed while a session is open | 401 on read, mutation and read-by-id; the SSE stream goes silent | A1–A6; server `shouldDeliver` |
| Client ends the representation | agent projection 403 `REPRESENTATION_NOT_ACTIVE`; the deep link in the agent app shows no term (live S4d–S4g) | C11–C12, live S4 |
| Same agency, admin, analyst, foreign agency | 404 `REPRESENTATION_NOT_FOUND`; no per-Offer route | I1–I3, live S4h–S4i |
| Commercial-only mandate | 403 `SCOPE_INSUFFICIENT` | C3 |
| Agreement confirmed after the instant asked about | 403 `REPRESENTATION_NOT_ACTIVE` — temporal fail-closed | C3a |
| Licence lapses | 403 `LICENCE_NOT_CURRENT`; re-verification restores (nothing deleted) | C4–C5 (D-P61-2) |
| Client blocks the agency | `BLOCKED`; lifted → restored | C6–C7 |
| Client un-shares after the agent is gone | 200; nothing readable | C8–C9 (D-P61-8) |
| Affiliation ended | nothing readable | C10 |
| Body claims `actorType: 'guardian'`, `isAdult`, `canAccept`, `playerId` | ignored; the wrong player gets 404 | N/T (T1) |
| A lead-tier colleague reads Harbour's Offer | 404 identical to an invented id | G12, J1 |
| Restart | every rule above holds on the rebooted store | Z1–Z6, persistence §5 |

## 4. What P6.1 changed here

- `integration.licenceCurrentFor` is exported on the P5.6E seam and
  consulted by the agent Offer projection (D-P61-2). `client_private` is
  not a regulated *action* in P5.6E, so the decision never asked; the
  route's own contract said it did.
- Un-share no longer requires an active agent (D-P61-8): a client can
  always take a share back.
- Nothing else: every other row above was already live-derived in P6 and
  is now proven under drift.
