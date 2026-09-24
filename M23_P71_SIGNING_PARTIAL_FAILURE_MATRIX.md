# M23 P7.1 — Signing partial-failure matrix

For every write in the signing workflow: what is authoritative, what is
not, where a failure can strike, and what the state looks like afterwards.
The rule (§37): **authoritative writes commit together or not at all, and
the caller hears success only after they are persisted; non-authoritative
effects run afterwards and can fail without undoing anything.**

## 1. Classification

| Authoritative (in the unit of work, rolled back on failure) | Non-authoritative (after persistence, under `safe()`) |
| --- | --- |
| the package (status, revision, parties, evidence, keys, history, rev) | SSE broadcast (`signing_*`) |
| `db.signings` row | notifications (player, club leads, agent) |
| lifecycle `signed` (case status + history through the ONE writer) | journey badges refresh |
| `player.contractStatus`, `availability`, `level`, `timeline` | analytics (derived from rows at read time) |
| grassroots `org.squad` row (legacy path) | — |
| success-fee invoice (`db.invoices`) | — |
| ledger row | — |
| case audit row | — |

## 2. Failure points and outcomes

Seams are named after the development fault layer's `internal:` rules
(`m182/faults.mjs`, never available in production). "Proof" names the
hardening suite (H) or the persistence suite (P) check.

| # | Failure between | Mechanism | State afterwards | Caller sees | Proof |
| --- | --- | --- | --- | --- | --- |
| 1 | party evidence written → persisted (`signing.party.after_write`) | party unit of work: snapshot of the party, statuses, key list, history, case history and rev; restored on throw (H-P71-5) | party PENDING, package unchanged, rev unchanged, no key, no history line, no audit line | 500 `SIGNING_STATE_UNKNOWN` "nothing was recorded"; a retry is a real act | H Q1–Q3 |
| 2 | package COMPLETED in memory → `db.signings` row | inside the completion unit of work; the writer throws or returns duplicate → rollback | package IN_PROGRESS, no row | 409 `SIGNING_ALREADY_COMPLETED` (duplicate) / 500 | P7 AD; H Q5 |
| 3 | row written → lifecycle `signed` (`signing.complete.after_row`) | rollback truncates `db.signings`, the ledger and the invoices to their lengths, restores the player, the squad, the package, the case status and history | nothing: no row, no under_contract, case at `offer_accepted`, package IN_PROGRESS | 500 | H Q5, P7 AD12–AD13 |
| 4 | lifecycle refused (`moved.applied === false`) | same rollback | nothing | 409 `SIGNING_LIFECYCLE_CONFLICT` with the lifecycle verdict | P7 L6–L8 |
| 5 | lifecycle moved → persisted (`signing.complete.after_lifecycle`) | same rollback (case status and history restored) | nothing | 500 | H Q5; P 5.7a–5.7b (across a restart) |
| 6 | persisted → after-effects (`signing.complete.effects`) | effects run under `safe()`; the authoritative writes are already on disk | COMPLETED, one row, `signed`, under_contract; a badge refresh or a notification may be missing | 200 | H Q6; P 5.7c–5.7d |
| 7 | after-effects → broadcast / notifications | each under `safe()`; a failed notification is logged | as 6 | 200 | by construction (`safe`) |
| 8 | restart between 5 and persistence | nothing was written to disk; the in-memory rollback never mattered | after boot: IN_PROGRESS, no row, `offer_accepted` | the client retries with the same key: a real completion | P 5.7a–5.7b |
| 9 | restart after persistence, before effects | the row, the package and the case are on disk | after boot: COMPLETED, one row, `signed`; the key replays `idempotent: true`; a fresh completion is `SIGNING_ALREADY_COMPLETED` | converged | P 5.7c–5.7e |
| 10 | under_contract / level / invoice / squad | all set inside `recordCompletedSigning`, inside the unit of work; restored by the rollback (player JSON, squad JSON, invoices length) | none of them survives a failed completion; all of them exist after a successful one | — | P7 AD13; H Q5 (contract status compared before/after) |
| 11 | audit row | `audit(kase, …)` inside the unit of work; the case history length is restored on rollback | no audit row for a failed completion | — | H Q5 (history counts) |
| 12 | event | broadcast after persistence; a replay or a refused duplicate emits nothing | exactly one `signing_completed` per completion | — | H U1 |
| 13 | notification | after persistence; identical unread notifications coalesce; a refused duplicate creates none | one logical notification set | — | H V1 |
| 14 | present (`ready`) | single-store act; the expiry is validated and the bytes verified before any mutation (H-P71-6) | nothing mutated on a refusal | the named refusal | H B15, C group |
| 15 | cancel / void / supersede | single-store acts: one assignment sequence then `persistNow()` | atomic by construction | — | P7 L, H, AD |

## 3. What the caller can rely on

- A 200 from `complete` means the row, the case move, the player's contract
  status and the invoice (when due) are persisted. Nothing else is implied.
- A 500 from `complete` or a party completion means **nothing** was recorded;
  the same request may be retried with the same key.
- A 409 names the state that stopped the act; nothing was partially applied.
- After a restart, the store is exactly what the last successful
  `persistNow()` wrote; replaying the last key converges to that state.

## 4. Known non-transactional writes outside the signing (documented, unchanged)

- The legacy route persists once after the writer; its `effects()` run
  afterwards under a try/catch — the same shape as the canonical path.
- The player's self-declared contract status (`POST /player/availability`) is
  a single-field write on the player row with no coupling to a signing; a
  contradiction with a completed signing is detected as a warning
  (`PLAYER_CONTRACT_STATUS_DIVERGED`), never repaired.
