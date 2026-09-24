# M23 P6.1 — Offer partial-failure audit

Where a request can fail halfway, what the store holds afterwards, and
what the caller is told. The rule: **authoritative state first, then
persist, then side effects — and a side effect that throws never turns a
persisted success into a reported failure.**

## 1. The write order in every mutating route

1. Validate (authority, state, rev, key, content, recipient, readiness).
2. Mutate the Offer in memory.
3. Move the case through `ctx.applyLifecycleTransition` (issue, accept,
   decline, withdraw of an issued revision) — inside `advanceCase`.
4. `persistNow()` — the SQLite snapshot.
5. Side effects, each inside `safe(label, fn)`: `broadcast`, recipient
   notification, club notification, agent notification.
6. Respond with the persisted truth.

## 2. Failure points

| Failure | When | Store afterwards | Caller told | Proof |
| --- | --- | --- | --- | --- |
| Validation refuses | step 1 | untouched | the named 4xx | every negative check |
| The lifecycle writer throws (`canTransitionRecruitmentCase` passed, the writer failed) | step 3 | the in-memory Offer change is rolled back before any persist; the case is untouched | 409 `OFFER_LIFECYCLE_CONFLICT` (`reason: writer_failed`) | O3 (source assertion on the catch + rollback); P6.1 `advanceCase` |
| `persistNow()` throws | step 4 | the process reports the error; the in-memory change is not on disk; the next persist writes it | 500 through the shared handler (no partial body) | store contract (P5.7); not reachable by a request |
| A broadcast or notification throws | step 5 | the persisted success stands | 200 with the persisted truth; the throw is logged with its label | O2 (no bare `broadcast?.(` remains; every effect under `safe`) |
| Process killed between persist and response | after step 4 | the write is on disk | the client sees a lost response; its retry under the same key replays | O4–O5, Z3–Z4, persistence 3.7–3.12 |
| Process killed before persist | before step 4 | nothing on disk; the case did not move (the writer and the Offer change are in the same in-memory transaction that was never persisted) | retry performs the act once | persistence §2 (SIGTERM), §3 |
| A read receipt persist throws | recipient list/read | the receipt is in memory and written on the next persist; never a status | 200 | E9 (a read never writes history when the receipt exists) |

## 3. Why there is no partial Offer

- The Offer and its revision are one JSON row; there is no separate
  revision table that could be written without the pointer.
- The case move happens in the same handler, before persist, through the
  ONE writer; its failure rolls the Offer back. The reverse (Offer written,
  case not moved) cannot happen except through corruption of the file,
  which `offerCaseConsistency` names and refuses (persistence 5.8–5.9).
- Keys are written with the act they belong to, in the same row, so a
  persisted act always has its key and an unpersisted one never does.

## 4. Restart and replay (§40, §90)

After SIGKILL (hardening Z) and SIGTERM (persistence §2–§3): club views,
recipient views and histories are byte-identical; keys replay; terminal
states hold; the paused-case warning, the same-agency rule and the share
survive; schema 2307 with no migration applied; no duplicate stores,
events or policies are registered on boot (boot-contract suite and the
cold-boot lane in the test report).

## 5. What was changed for this audit

- `safe()` around every post-persist side effect (D-P61-6).
- The lifecycle writer's throw caught, the Offer rolled back, and the
  caller told `OFFER_LIFECYCLE_CONFLICT` (D-P61-7).
- Nothing else: the persist-then-effects order already held in P6.
