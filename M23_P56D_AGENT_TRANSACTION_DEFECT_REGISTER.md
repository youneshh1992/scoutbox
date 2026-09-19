# M23 P5.6D — Agent Transaction defect register

Fourteen defects were found and fixed during P5.6D, recorded as **D2–D15**.

No `D1` was ever issued: the number was skipped during the server build, when the
first finding — how a transaction relates to a P5.6C compliance context — was
reclassified as an unspecified design decision rather than a defect, and is
recorded as the seam decision in
`M23_P56D_TRANSACTION_COMPLIANCE_INTEGRATION.md` §1. The sequence was left as-is
rather than renumbered, because the commits already cite these ids. (The commit
message on `23023f7` says "seven defects" and lists six, D2–D7; six is correct and
this register is authoritative.)

**Open Critical: 0 · Open High: 0 · Open reasonably-fixable Medium: 0 · Open Low: 0.**
Nothing is production-blocking and nothing is deferred.

---

## D2 — a shared concurrency token leaked counterparty names across party boundaries

| | |
| --- | --- |
| **Severity** | High (privacy) |
| **Area** | shared infrastructure — M18.1 `revMeta` / the 409 conflict body, as used by the transaction domain |
| **Reproduction** | The individual loads a transaction; a named person at the engaging club confirms the club; the individual reads the transaction and sees `revBy` naming that person. Symmetrically, a club reading after an agency write learns which named person at the agency acted. A 409 body carried the same name in `updatedBy`. |
| **Root cause** | `bumpRev`/`guardRev` stamp the *display name* of whoever last moved a record. Inside one organisation that is exactly the point — it is who to ask. On a multi-party transaction the same field crosses an organisational boundary, and the caller was never entitled to that person's identity. |
| **Fix** | The transaction domain stamps a **role**, not a person: `bumpTxRev` passes `{ id: null, name: actorLabel(by).label }`, so a projection says "Club signatory" or "Representing agent". The platform audit keeps the real actor, where it belongs. |
| **Regression** | `m23AgentTransactionE2E` groups R and W assert that no projection and no 409 body names a person from another party, and that the audit still carries the actor. |
| **Status** | Fixed |
| **Production blocking?** | Would have been. Not now. |

## D3 — a safeguarding stop answered 404 on a transaction the caller could read

| | |
| --- | --- |
| **Severity** | Medium (coherence / honesty) |
| **Area** | `m26/index.mjs` `writableOr` |
| **Reproduction** | A party is blocked mid-workflow. Another party, who can still read the transaction, attempts a note or a document write and receives `TRANSACTION_NOT_FOUND` 404 for a record that is on their screen. |
| **Root cause** | The concealment doctrine was applied uniformly, including to callers for whom there was nothing left to conceal. Telling a legitimate party that a record they are looking at does not exist is incoherent, and it is a lie. |
| **Fix** | Reads stay available with the person tombstoned out (the P5.6C precedent). Writes stop with `TRANSACTION_PARTY_UNAVAILABLE` 422 — one code for removed, invisible, blocked and minor alike, so it still distinguishes nothing. Naming a party on **create** keeps the uniform 404, because there the caller is probing. |
| **Regression** | Group T asserts the read/write split and that the code is identical across all four underlying causes. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D4 — `PARTIES_CONFIRMED` was a state no transaction ever rested in

| | |
| --- | --- |
| **Severity** | Medium (correctness of the state machine) |
| **Area** | `m26/transaction.mjs` `statusForComplianceState` |
| **Reproduction** | Every party confirms. No representation is bound yet. The transaction reports `COMPLIANCE_PENDING`. |
| **Root cause** | `REPRESENTATION_MISSING` and `PARTIES_NOT_CONFIRMED` were mapped to `COMPLIANCE_PENDING` with every other pending reason. Neither is a compliance question: nothing has been asked of compliance. The effect was to tell a party that compliance was outstanding when it was not, and to make `PARTIES_CONFIRMED` unreachable. |
| **Fix** | Both reasons map to `PARTIES_CONFIRMED`. |
| **Regression** | Pure group F asserts the mapping for all eight pending reasons; group D asserts that a transaction rests in `PARTIES_CONFIRMED`. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D5 — an idempotent status replay was refused as an illegal transition

| | |
| --- | --- |
| **Severity** | Medium (correctness) |
| **Area** | `m26/index.mjs` status route |
| **Reproduction** | POST a status change with a client key; repeat the identical request. The replay answers `TRANSACTION_TRANSITION_NOT_ALLOWED` 409. |
| **Root cause** | The idempotency check ran *after* the transition check — and the transition being replayed is precisely the one that already moved the transaction, so it is no longer legal from the new state. A retry after a dropped response therefore looked like a client error. |
| **Fix** | The client key is resolved before the transition check, so a replay returns its original answer. |
| **Regression** | Group X replays every idempotent mutation, including a status change, and asserts `idempotent: true` with the original body. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D6 — `/ts/transactions/metrics` was shadowed by `/ts/transactions/:id`

| | |
| --- | --- |
| **Severity** | Medium (availability of a Trust & Safety surface) |
| **Area** | `m26/index.mjs` route registration order |
| **Reproduction** | `GET /ts/transactions/metrics` → 404, because Express read `metrics` as a transaction id. |
| **Root cause** | Registration order. The parameterised route was declared before the literal one. |
| **Fix** | `/transactions`, then `/transactions/metrics`, then `/transactions/:id`, with a comment at the call site saying why the order matters. |
| **Regression** | The analytics section fetches `/ts/transactions/metrics` and asserts its shape; the live suite renders the metrics panel. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D7 — a declared-only representation answered 201, which reads as "in force"

| | |
| --- | --- |
| **Severity** | Medium (compliance semantics) |
| **Area** | `m26/index.mjs` representation binding |
| **Reproduction** | Bind a representation for a club with no ScoutBox agreement. The response is 201 Created. |
| **Root cause** | The row *is* created — but it is `declaredOnly` and not effective until a named reviewer confirms it. A 201 tells the client the binding succeeded, which is what P5.6C exists to prevent. |
| **Fix** | It answers 422 with `REGULATORY_REVIEW_REQUIRED` and the review id, exactly as the P5.6C context route does, and the binding is visible as "declared, pending review". |
| **Regression** | Group E asserts the status, the code, the review id and `data-represented="pending_review"`; the live suite reads the same refusal in the UI. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D8 — one malformed row on disk took every party's list route down

| | |
| --- | --- |
| **Severity** | Medium (availability) |
| **Area** | `m26/transaction.mjs` container access |
| **Reproduction** | Write a transaction row without its `parties` array to the snapshot (hand edit, partial write, older shape). Every list route — agent, club, player, Trust & Safety — answers 500. |
| **Root cause** | `tx.parties.filter(...)` on a row where the array is absent. One corrupt record was able to deny the whole surface rather than being contained to itself. |
| **Fix** | The pure layer reads containers through `partiesOf(tx)`, which returns `[]` for anything that is not an array. A row with no parties belongs to **nobody** — the safe reading as well as the tolerant one — so it disappears from every list instead of breaking it. Nothing is repaired on read. |
| **Regression** | `m23AgentTransactionPersistence` writes the corruption to disk, reboots, and asserts every list route still answers and the row belongs to no one. Group AI does the same in-process. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D9 — a stale snapshot still presented `clear: true`

| | |
| --- | --- |
| **Severity** | Medium (honesty) |
| **Area** | `m26/index.mjs` `projectTransaction` |
| **Reproduction** | Evaluate to CLEAR, change a party, read the transaction: `compliance.clear` is `true` and `compliance.staleness` is `INPUTS_CHANGED`. |
| **Root cause** | The pair was *accurate* — the snapshot did say clear, and the staleness field said the snapshot no longer matches the facts — but a client reading the obvious field is told the transaction is clear on the strength of an evaluation that no longer holds. A field named `clear` must be the current answer. |
| **Fix** | `clear` is `snapshot.clear && !stale`. The recorded verdict stays visible beside the staleness reason as `snapshotClear`, so nothing is hidden. |
| **Regression** | Group G asserts both fields across each of the four staleness reasons; the live suite reads "Re-check needed" in the UI. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D10 — asking for a document's reference discarded the answer

| | |
| --- | --- |
| **Severity** | Medium (usability of a compliance control) |
| **Area** | `scoutbox-agent/src/transactions.tsx` documents tab |
| **Reproduction** | Open a transaction → Documents → press **Reference**. Nothing appears. |
| **Root cause** | The read was routed through `act()`, which reloads the transaction afterwards. The parent renders a loading state while it refetches, which unmounts the tab, which throws away the `ref` state the read had just set. A pure read was triggering a write's side effect. |
| **Fix** | A dedicated `read()` runner sets busy and error but does not reload. |
| **Regression** | The live suite presses the control and asserts the reference note appears, names the canonical evidence store and carries no URL. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D11 — a private document announced itself, and its class, to every party

| | |
| --- | --- |
| **Severity** | High (privacy) |
| **Area** | `m26/transaction.mjs` timeline audiences |
| **Reproduction** | The agent files an `AGENT_PRIVATE` mandate. Each club's and the individual's timeline shows "A document was added" with `visibility: AGENT_PRIVATE` in its detail. |
| **Root cause** | `transaction_document_added` / `_superseded` / `_removed` were mapped to the `all_parties` audience. The document itself was correctly hidden — but the *entry about it* disclosed that a private document exists and which class it is, to people who cannot open it. That is the disclosure the class exists to prevent, arriving by the back door. |
| **Fix** | A new `per_document` audience: an entry about a document reaches exactly the parties the **document's own** visibility class admits, via `canSeeVisibility`. An entry whose detail carries no class reaches nobody — it fails closed. |
| **Regression** | Pure group M adds five checks (M-p10…M-p14) across an agent-private, club-private, cross-club and shared document, plus the no-class case. The live suite asserts the club's timeline is a strict subset of the agent's and contains no agent-private class. |
| **Status** | Fixed |
| **Production blocking?** | Would have been. Not now. |

## D12 — the list hash kept showing the detail

| | |
| --- | --- |
| **Severity** | Medium (navigation correctness) |
| **Area** | `scoutbox-agent/src/App.tsx` hash handler |
| **Reproduction** | Open a transaction, then navigate to `#/transactions`. The detail stays on screen while the hash says the list. |
| **Root cause** | `onHash` synced the open client, the compliance context and the agency tab from the hash, but not the open transaction, which lived only in component state. The hash and the screen could disagree indefinitely. |
| **Fix** | `onHash` sets the transaction from `transactionFromHash(...)`, so the hash is the truth. |
| **Regression** | The live suite navigates to each of four hashes and asserts each renders *its own* screen and only that one. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D13 — two missing keys rendered as raw key names

| | |
| --- | --- |
| **Severity** | Low (copy) |
| **Area** | `scoutbox-agent/src/i18n.ts` |
| **Reproduction** | Open a transaction: the back button reads `common.back`. The cancel/hold/close confirmation reads `common.confirm`. |
| **Root cause** | Both keys were used by the new screen and never added to the catalogue; `t()` falls back to the key, which is the right fallback and the wrong thing to ship. |
| **Fix** | Added in EN and FR. Parity 636/636. |
| **Regression** | A scan over every `t('…')` literal in the agent app against both dictionaries; the suite's AE group asserts EN/FR parity and that every status, role, class and type has both halves. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D14 — a tab deep link was advertised but never applied

| | |
| --- | --- |
| **Severity** | Medium (navigation correctness) |
| **Area** | `scoutbox-agent/src/App.tsx` + `transactions.tsx` |
| **Reproduction** | Open `#/transactions/atx-7/documents`. Whichever tab was last used renders. `hashForTransaction(id, tab)` produced such links and `navConfig` asserted they parse. |
| **Root cause** | The tab was parsed from the hash and then dropped: `App` passed only the id, and the screen kept its own `useState` tab. A link that the router accepted and the app wrote had no effect. |
| **Fix** | The tab lives in the hash, mirroring the client-tab pattern: `App` holds `{ id, tab }`, passes both, and switching tab **replaces** the hash so Back closes the transaction rather than walking its tabs. |
| **Regression** | `navConfig` asserts the round-trip and that `/offer`, `/signing` and `/fees` tabs are rejected outright; the live suite asserts a tab deep link opens that tab and a bare link opens Overview. |
| **Status** | Fixed |
| **Production blocking?** | No |

## D15 — the demo refused its own Transactions screen

| | |
| --- | --- |
| **Severity** | Medium (demo correctness) |
| **Area** | `scoutbox-agent/src/agentDemo.ts` permission matrix |
| **Reproduction** | Open the built demo artifact → Transactions. A 403 refusal renders where the six examples belong. |
| **Root cause** | The demo's `PERMISSIONS` map had no `transactions.read` or `transactions.write`, and `need()` refuses an unknown capability. The demo mirrors the server matrix by hand, and the two new entries were not added with the screen. |
| **Fix** | Both added, mirroring `m24/shared.mjs` exactly: read for all five tiers, write for `licensed_agent` only. |
| **Regression** | `m23AgentDemoSpotcheck` now opens the demo's Transactions screen, counts the six examples across five states, and checks the honest wording, the offer boundary, the absence of a date of birth on a party row and the absence of any claim that minors are enabled. |
| **Status** | Fixed |
| **Production blocking?** | No (demo only) |

---

## Where the defects came from

| Source | Defects |
| --- | --- |
| `m23AgentTransactionE2E` (acceptance) | D2, D3, D4, D5, D6, D7 |
| `m23AgentTransactionPersistence` | D8, D9 |
| `m23AgentTransactionLive` (browser journeys) | D10, D11, D12, D13, D14 |
| `m23AgentDemoSpotcheck` (demo artifact) | D15 |

Two of the three privacy defects (D2, D11) were invisible to the server suite's
own projections and surfaced only once a *second* party read the same record — D2
from a cross-organisation read of a shared concurrency field, D11 from comparing
one party's timeline against another's. Both are the same shape of mistake: a
mechanism that is correct inside one organisation, reused across a boundary where
the entitlement does not follow.
