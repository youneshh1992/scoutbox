# M23 P5.6D — Transaction test report

## 1. New suites

| Suite | Checks | Negative / security / safeguarding | Result |
| --- | --- | --- | --- |
| `scoutbox-server/scripts/m23AgentTransactionE2E.mjs` | 404 | 215 (53%) | pass |
| `scoutbox-server/scripts/m23AgentTransactionPersistence.mjs` | 63 | 28 (44%) | pass |
| `e2e/m23AgentTransactionLive.test.mjs` | 108 | 46 (43%) | pass, zero page errors |

The acceptance suite runs a **pure half** — the state machine, the visibility
algebra, the compliance-state mapping, the party-revision hash, the timeline
audiences, the offer boundary, the error contract and the four separations, all
against the exported functions — and then boots a **real server** with the
synthetic verification provider and drives every lane over HTTP.

## 2. Required groups (§89)

| Group | Covered by |
| --- | --- |
| A create transaction | who may open one; the six input refusals; forged body ignored; DRAFT at rev 1 |
| B party identity | canonical ids; role/kind pairing; one party per role; releasing entity only for transfer/loan; unknown club → uniform 404 |
| C party history | confirmation by the party itself; removal tombstones rather than deletes; history appended, never overwritten |
| D state transitions | ten states; two maps; server-validated; compliance states unreachable by request; reason codes required |
| E representation bindings | transaction-specific; agreement read by reference; `declaredOnly` + review; re-derived at mutation time |
| F compliance snapshot | evaluationId, policy versions, reason codes, consent requirements, party revision, freshness |
| G stale compliance | the four staleness reasons; a stale snapshot authorises nothing; `clear` is the current answer |
| H consent integration | the P5.6C ledger reused; requested / granted / declined / revoked / superseded; no second store |
| I party change invalidation | a change withdraws what rested on it and re-evaluates |
| J document visibility | nine classes; role AND side; write narrower than read; no leakage in any direction |
| K private notes | scoped; absent rather than redacted for the lanes they exclude |
| L messages | canonical Inbox referenced; membership alone opens nothing |
| M timeline audiences | six audiences; `per_document`; `audit_only` reaches nobody |
| N Player view | own transactions only; clubs, agency, state, own consent, shared documents |
| O Agent view | list with counts and filter; six-tab detail; `allowedTransitions` |
| P engaging Club view | party role named; own side only |
| Q releasing Club view | the same, and demonstrably different from the engaging club's |
| R privacy | the three private worlds (club recruitment, player private, agent private) |
| S tenant isolation | a second agency (`org-southgate`) proves "foreign agency" is not "same-agency colleague" |
| T blocks | a blocked party ends the question; CLEAR never overrides |
| U unsupported jurisdiction | `JURISDICTION_UNSUPPORTED`; no silent allow |
| V minor closed path | `MINOR_PATHWAY_DISABLED`; fails closed |
| W rev | `expectedRev` → 409 on every mutable record |
| X idempotency | create, party change, status, binding, document, consent request, hold/cancel/close |
| Y concurrency | party races, status races, compliance change mid-mutation, consent revoked mid-mutation, reviewer decision mid-mutation, cancellation during a document write |
| Z persistence | the dedicated persistence suite, plus an in-suite restart |
| AA migration | 2306 → 2307, one step, three empty containers, replay-protected |
| AB removal / tombstone | shape kept, person gone, nothing resurrected |
| AC events | nine registry events, ids only, `txId` |
| AD notifications | canonical categories; `transaction_updates` non-mandatory; compliance mandatory |
| AE EN/FR | parity across the agent catalogue (636 keys) and the club catalogue (2127); every status, role, class, type in both |
| AF accessibility | states as words; `allowedTransitions` so no control is a guess |
| AG mobile | the transactions screen exists and is exercised at 390/360 |
| AH live / browser | `e2e/m23AgentTransactionLive.test.mjs` |
| AI corruption / legacy | a malformed row belongs to nobody instead of 500ing a list route |

## 3. The thirty adversarial cases (§90)

| # | Case | Result |
| --- | --- | --- |
| 1 | agent creates a transaction for an unrelated player | refused — no confirmed relationship, no binding |
| 2 | agency assistant creates a regulated transaction | `AGENT_ACTION_NOT_PERMITTED` 403 |
| 3 | agency admin impersonates the agent | 403 — the `licensed_agent` tier is the gate |
| 4 | foreign agent guesses a transaction id | `TRANSACTION_NOT_FOUND` 404 |
| 5 | foreign club guesses a transaction id | 404 |
| 6 | player guesses another player's transaction | 404 |
| 7 | engaging club reads a releasing-club-private document | refused (side check) |
| 8 | releasing club reads an engaging-club-private document | refused (side check) |
| 9 | agent reads a club-private note | refused |
| 10 | club reads an agent-private note | refused |
| 11 | stale snapshot used after a party change | `TRANSACTION_COMPLIANCE_STALE` 422 |
| 12 | revoked consent used after a refresh | refused; named as revoked |
| 13 | licence goes stale between load and mutation | refused with the facet reason |
| 14 | representation terminates between load and mutation | refused |
| 15 | player disputes the agent mid-workflow | access suspended; nothing here resolves it |
| 16 | club signatory role removed mid-workflow | `SIGNATORY_REQUIRED` 403 |
| 17 | transaction cancelled during a document upload | `TRANSACTION_NOT_LIVE` 409 |
| 18 | status double-transition race | one result; the loser 409 |
| 19 | body forges a policy version | ignored; reaches no field |
| 20 | body forges a consent state | ignored; the ledger decides |
| 21 | body forges a party role | ignored; derived from `parties[]` |
| 22 | body forges an agent representation | ignored; the store decides |
| 23 | hidden minor id guessed | 404 / minor gate |
| 24 | unsupported jurisdiction tries to progress | `JURISDICTION_UNSUPPORTED` |
| 25 | manual-review transaction tries ACTIVE | `TRANSACTION_COMPLIANCE_PENDING` 422 |
| 26 | prohibited transaction tries ACTIVE | `TRANSACTION_COMPLIANCE_BLOCKED` 422 |
| 27 | blocked player tries to message | refused; safeguarding ends the question |
| 28 | old idempotency key reused with a changed payload | `TRANSACTION_IDEMPOTENCY_CONFLICT` 409 |
| 29 | deleted player's PII in a transaction list | absent |
| 30 | archived transaction used to write new state | `TRANSACTION_ARCHIVED` 409 |

## 4. Refusal hygiene

78 distinct refusals were collected across the acceptance run. Every one:
carried a declared error code; carried no stack and no internal frame; named no
party, reviewer, note text or document label; carried no agreement reference and no
fee term; and never said "blocked" or "minor" — the uniformity is what makes the
concealment work.

## 5. Browser journeys (§85, §84, §83)

`e2e/m23AgentTransactionLive.test.mjs`, five browser contexts against one backend:

| Journey | What it drives |
| --- | --- |
| A/B agent | Transactions is a real destination; the list states what a state is not; a transfer is opened → DRAFT, nobody confirmed, no offer readiness, blockers named |
| C binding | the agent records that she acts for the individual — accepted because the client confirmed the relationship |
| D player | Kola, at 390px, sees both clubs, the agency, the state, no fee, no club recruitment data — and confirms his own participation |
| E engaging club | Eastport's signatory sees her side, is offered only her side's visibility classes, confirms the club, files an engaging-club-private note |
| F releasing club | Harbour's signatory does the same on the other side, and cannot read Eastport's note; Eastport cannot read Harbour's either |
| G progress | re-evaluate → clear → ACTIVE; ARCHIVED not offered from ACTIVE; no action is an offer or a signature |
| H documents | an AGENT_PRIVATE document is visible to the agent and to nobody else; the reference read returns a sentence, not a URL |
| I timeline | the club's history is a strict subset of the agent's; no agent-private class in it |
| J Trust & Safety | the reviewer gate still applies; roles and states only; no name, note text, document label or ranking; no action on the row |

Viewports: **1440**, **1280**, **390**, **360** — no horizontal scroll on the list
or the workspace at any of them, and the club projection does not overflow its
console. Accessibility: every control labelled, the six tabs a labelled tablist
with exactly one selected, every control keyboard-reachable, every compliance
state rendered as a word. FR verified with no English fallback leaking through.
**Zero page errors on all five surfaces.**

## 6. Wording sweep

Every transaction screen was swept for offer, negotiation, commission, salary and
escrow wording, after removing the sentences whose whole job is to deny the
thing — an honest denial must not be readable as a feature. Nothing remained.
`#/transactions/:id/offer`, `/signing` and `/fees` are rejected by the router
outright, and `offer_made` is not a status the server will accept.

## 7. Persistence, clean boot, upgrade (§91/§92)

`m23AgentTransactionPersistence.mjs`: 63 checks, 28 negative.

- clean boot at 2307: one new step, three **empty** containers, all three
  production-required, migration replay adds no record and changes no store;
- upgrade from a synthetic 2306 snapshot: exactly the one step runs, nothing is
  backfilled, and no existing record is reinterpreted as a transaction;
- across a restart: the transaction, its parties and their confirmation, the party
  history, the compliance snapshot and its party revision, document metadata and
  versions, notes, linked threads, terms versions, `rev`, `revMeta` and the
  idempotency keys all survive byte-for-byte; the 2307 step does not run twice.

## 8. Regression battery (§94/§95)

**Server, all green:** `m162E2E`, `m17E2E`, `m18E2E`, `m181E2E`, `m182E2E`,
`m22Blocker`, `m22E2E`, `m23E2E`, `m23ContactE2E`, `m23TrialE2E`,
`m23DecisionE2E`, `m23Persistence`, `m23BootContract`, `m23AgentE2E`,
`m23AgentPersistence`, `m23AgentComplianceE2E`, `m23AgentCompliancePersistence`,
`m23AgentTransactionE2E`, `m23AgentTransactionPersistence`.

**Browser, all green:** `navConfig` (359), `navLive` (64), `m162Live`, `m17Live`,
`m18Live`, `m181Live`, `m182Live` (37), `m182DemoSpotcheck`, `m23AgentLive` (82),
`m23AgentComplianceLive` (86), `m23AgentTransactionLive` (108),
`m23AgentDemoSpotcheck`.

**Typechecks and builds:** `scoutbox-agent`, `scoutbox-admin`, `scoutbox-club`,
`scoutbox-grassroots`, `scoutbox-player` — `tsc --noEmit` clean and a production
build for each. Demos rebuilt.

### Assertions made forward-compatible

Five suites asserted facts that P5.6D legitimately changed. Each was made relative
to the claim rather than the code bent back to fit it:

| Suite | Was | Now |
| --- | --- | --- |
| `m23TrialE2E` P6 | "the current schema is 2306" | the Trial step is frozen at 2304 and the schema has only moved forward |
| `m23AgentE2E` T1 | "the schema is 2306"; "no transaction store is guaranteed" | the Agent step is frozen at 2305 and moves forward; no agent identity database and no offers store |
| `m23AgentE2E` E1/W9/S13 | literal 2306; "no transaction room" | at or above 2306; `SCHEMA_VERSION`; no fee route, and an empty body opens no transaction |
| `m23AgentPersistence` | literal 2306 in nine places; a hand-listed pair of steps to rewind | `SCHEMA_VERSION`; "every step above 2304", so a later step cannot make the rewind a no-op |
| `m23AgentLive` A2c/N5 | swept for the word "transaction" | offer, negotiation, commission and fee — "transaction" is a destination now |
| `m182Live` J4 | "the FIRST locked category is security" | every locked control says why it is locked, and security is among them |

## 9. Demo (§86)

`m23AgentDemoSpotcheck` now covers the transaction workspace in the built
artifact: the six synthetic examples across five states (`READY`,
`COMPLIANCE_PENDING`, `COMPLIANCE_BLOCKED`, `ON_HOLD`, `CANCELLED`), the honest
"not a statement of legal validity" wording, the offer boundary stated either way
with its blockers, no date of birth on a party row, and no demo surface implying a
minor pathway is open. All synthetic; no real person.
