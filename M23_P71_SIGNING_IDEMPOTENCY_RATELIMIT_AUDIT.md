# M23 P7.1 — Signing idempotency and rate-limit audit

## 1. Keys (§25–§27, §33–§34)

| Act | Key list | Fingerprint | Bound to actor | Replay returns | Conflict on |
| --- | --- | --- | --- | --- | --- |
| start | `keys.start` (one per package; looked up across the Offer's packages) | offerId, contract, note, expiry | org | the package | a different fingerprint |
| ready | `keys.ready[]` | expiry | org | club view | — |
| party (player / club) | `keys.party[]` | party type, revision id, digest | **yes** (`actorId` on the row) | recipient / club view | a different fingerprint **or a different actor** |
| cancel / void / supersede | `keys.cancel[] / void[] / supersede[]` | action, reason | org | club view | different reason |
| complete | `keys.complete[]` | `{ complete: true }` | org | club view + the stored lifecycle verdict | — |

Rules re-proven (H = m23SigningHardeningE2E, P = m23SigningPersistence):

- same actor + same key + same payload → replay, `idempotent: true`, no write (H L1, J11; P 3.9–3.12, 5.7d)
- same key + a different digest / revision / reason → `SIGNING_IDEMPOTENCY_CONFLICT` (H L2–L3; P7 Q2, Q6)
- a different actor with the same key on the same package → conflict, never someone else's replay (H L4)
- keys are stored per package, so the same string in another organisation or on another package is independent by construction (H L6 note)
- authority is re-derived **before** the key is read: a demoted lead's replay is 403, a restored lead's replay is the original result with no new mutation (H L7–L9; P7 G17 lesson) — a key is never a capability token (§26)
- a replay across a restart returns the persisted result; a fresh act after it is refused by state (P 3.13, 5.7d–5.7e)
- `expectedRev` is required as an integer on every club mutation and refused `SIGNING_REV_REQUIRED` when missing or a string; a stale value is `SIGNING_REV_CONFLICT` after the state gate (H M1–M4)

## 2. Rate policies (§67–§68)

| Policy | Key | Budget | Protects | P7.1 change |
| --- | --- | --- | --- | --- |
| `signing_start` | org | 30 / h | packages opened | — |
| `signing_document_write` | org | 120 / h | attach, draft edits, present, supersede, executed document | — |
| `signing_party_completion` | actor: `player:<id>` or `org:<userId>` | 30 / h | a party's confirmations | — (no alias between the two kinds: the club signatory is keyed per user, the player per player) |
| `signing_closure` | org | 30 / h | **completion only** | narrowed |
| `signing_safety_closure` | org | 60 / h | **cancel and void** (club) | **new (H-P71-4)**: completion traffic can no longer exhaust the budget a safety closure needs; T&S void is unlimited |

Every policy has a finite budget, a window and a note; the registry-shape
tests (m23AgentFinalHardeningE2E AA-p6/p7) and H X1–X5 assert them, and the
source is checked to consume the intended policy on each route.

## 3. Balance (§68)

A hostile lead can spend the organisation's 30 completions an hour and its
120 document writes an hour; they cannot prevent a colleague from cancelling
or voiding a package, which draws on the separate 60/h safety budget. A
hostile player can spend their own 30 confirmations an hour on their own
packages and nothing else. No limit is keyed on a value a client supplies.
The limiter is an in-memory speed bump per process (as before); it is not
an accounting system and is documented as such in `m181/rateLimit.mjs`.

## 4. Ordering on every mutating route

authentication → concealment lookup → integrity/consistency → role/lead →
key shape → **replay** → state gate → rev → block / subject → bytes
verification (where a document matters) → **rate** → the write → persist →
effects. The rate check sits after every refusal that costs nothing, so a
refused request never consumes budget, and after the replay, so a replay
never consumes budget either.
