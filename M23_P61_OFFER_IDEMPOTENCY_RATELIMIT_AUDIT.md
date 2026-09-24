# M23 P6.1 — Offer idempotency and rate-limit audit

## 1. Idempotency

### 1.1 Model (unchanged from P6)

Every mutating act may carry a `clientKey`. Keys live **on the Offer
record**, per act: `keys.create` (one), `keys.issue[]`, `keys.withdraw[]`,
`keys.revise[]`, and `responses[].clientKey` for answers. A key replays
the exact committed result (`idempotent: true`) or conflicts
(`OFFER_IDEMPOTENCY_CONFLICT`); it never performs a second mutation.

### 1.2 Order

authority → subject → block → state → key → rev → content. A replay is
answered **after** authority has been re-derived and **before** the rev
is read (a lost-response retry needs no rev; a demoted user gets no
replay).

### 1.3 Findings

| # | Question | Answer | Proof |
| --- | --- | --- | --- |
| 1 | The same key twice in parallel | one create, one replay of the same Offer; one Offer | G1 |
| 2 | A different key for the same semantic act | refused by state (no second Offer, no second issue) | G2 |
| 3 | The same issue key in parallel | one issue, one replay, one case move, one history line | G3 |
| 4 | A replay with a wrong `expectedRev` | replays (rev is not consulted for a replay) | G4 |
| 5 | An issue key replayed after the recipient accepted | replays the current truth (ACCEPTED), performs nothing | G6 |
| 6 | An accept key replayed | one response row | G7 |
| 7 | An accept key used to decline | 409 `OFFER_IDEMPOTENCY_CONFLICT` | G8 |
| 8 | A new key on an answered revision | 409 `OFFER_ALREADY_RESPONDED` | G9 |
| 9 | The same key at another organisation | independent (scoped to the case) | G10 |
| 10 | **The same key with a different payload** | **409 `OFFER_IDEMPOTENCY_CONFLICT` — was a silent replay before P6.1 (D-P61-1)** | G11 |
| 11 | A key or id across tenants | 404, never a replay | G12 |
| 12 | **A key after the caller lost the role** | **403 `OFFER_NOT_PERMITTED` before the replay: an old key is not a capability token** | G13–G17 |
| 13 | Keys after a restart | replay identically | Z3, Z4, persistence 3.7–3.12 |
| 14 | Keys of a superseded revision | the old issue key conflicts; keys are never overwritten | persistence 3.9 |

### 1.4 D-P61-1 in detail

`payloadFingerprint` serialised its parts with
`JSON.stringify(parts, Object.keys(parts).sort())`. A replacer **array**
filters every level of the object, so the nested `terms` object became
`{}` and two requests under one key that differed only in a term
fingerprinted identically: the second was replayed as the first, and the
caller's intended terms were silently lost. The fingerprint is now a deep
canonical serialisation (every level key-sorted, `undefined` → `null`).
The P6 assertion (#47) had passed because its two payloads differed in
a top-level field.

## 2. Rate limits

### 2.1 Policies (unchanged)

| Policy | Scope | Routes |
| --- | --- | --- |
| `offer_draft_write` | organisation | create, edit, revise (three call sites, one budget — H3) |
| `offer_issue` | organisation | issue |
| `offer_withdraw` | organisation | withdraw (a closure act with its own budget, never starved by drafting — H1) |
| `offer_response` | `${kind}:${personId}` | accept, decline (player and guardian are different persons; the player route cannot draw on a guardian budget — H2) |

Limits sit on the central m181 limiter; a replay under a used key is
answered before the limiter (unpenalised); a 429 carries the shared
`RATE_LIMITED` body.

### 2.2 Aliasing

No route, id, alias, header or body field yields a second budget: the
key is the organisation id (from the session) or the person (kind + id
from the session). Proven by source assertion (H2) and by behaviour: a
club that trips `offer_draft_write` at one case is limited at another
(H5–H6); the withdraw budget still answers (H7); a replay does not count
(H8).

### 2.3 Closure safety (§57)

Withdraw and answer budgets are ≥ 30 per window (H1). A club that is
flooding drafts can still withdraw; a recipient can always decline.

## 3. Idempotency + concurrency + authority

The three interact in one order: two parallel requests under one key
produce one act (single event loop); the second sees the first's key
row. If the caller's authority changed between the two, the second is
refused by authority first (G17), so a stolen or leaked key from a
session that has since lost its role is worthless.
