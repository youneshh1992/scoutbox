# M23 P5.6D — Transaction authorization matrix

Every row is enforced on the server. A client list is convenience; the server
decides and refuses.

## 1. The eighteen-step order (§66)

Every material transaction mutation runs this order. No step is skipped and none
is reordered.

| # | Step | Where |
| --- | --- | --- |
| 1 | Authenticate the session | canonical org / player / reviewer auth |
| 2 | Resolve the actor (user, org, tiers) | `agentViewer` / `clubViewer` / player auth |
| 3 | Resolve the transaction by id | `txById` |
| 4 | Conceal a foreign transaction as nonexistent | `ownTransaction` / `clubTransaction` / player lane → uniform `TRANSACTION_NOT_FOUND` 404 |
| 5 | Resolve the caller's party role | derived from `parties[]`, never from the body |
| 6 | Resolve the current capability | `m24/shared.mjs` matrix: `transactions.read` / `transactions.write` |
| 7 | Resolve representation authority when acting as agent | `transactionRepresentations` → `representationAgreements`, scope and status read live |
| 8 | Resolve blocks / safeguarding | `isBlocked` on every party; a block ends the question |
| 9 | Resolve the current jurisdiction policy set | `jurisdictionPolicies`, effective at now |
| 10 | Verify licence facets | `agent.facetStatesFor`, fail-honest |
| 11 | Evaluate the conflict engine | P5.6C `evaluateConflict` over the rebuilt projection |
| 12 | Verify required consents | P5.6C `regulatoryConsents` ledger, current state |
| 13 | Minor gate | `MINOR_PATHWAY_DISABLED` fails closed |
| 14 | Manual-review requirement | an open `regulatoryReviews` item blocks progression |
| 15 | Verify the status transition | `ACTOR_TRANSITIONS` / `COMPLIANCE_TRANSITIONS` |
| 16 | rev + idempotency | `guardRev` → 409, `normaliseClientKey` + `payloadFingerprint` |
| 17 | Mutate | one authoritative write |
| 18 | Audit + event | `history[]` append, registry event, notification |

Steps 7–14 are re-run at **mutation time**, not read from the page the caller was
looking at. A snapshot that was clear when the page loaded and is stale when the
button is pressed refuses with `TRANSACTION_COMPLIANCE_STALE`.

## 2. No client-supplied auth facts (§67)

The server derives, and ignores the body, for: party role, agent authority,
compliance outcome, consent status, reviewer status, club signatory, player
identity, policy version, licence state, transaction status, rev ownership,
jurisdiction, date of birth and guardian consent. A create carrying a forged
`status`, `rev`, `compliance`, `policyVersion`, `dob` and `guardianConsent`
produces a `DRAFT` at rev 1 whose compliance says the parties are not confirmed,
and the forged policy version reaches no field of the record.

## 3. Who may do what

`A` = the licensed agent who owns the transaction. `AA` = agency administrator.
`AS` = other agency staff (analyst / assistant / finance). `P` = the individual.
`G` = guardian. `ECS` / `RCS` = engaging / releasing club **signatory**.
`ECM` / `RCM` = other club user at that party club. `TS` = named Trust & Safety
reviewer. `—` = refused.

| Action | A | AA | AS | P | ECS | ECM | RCS | RCM | TS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Read the agency's transaction list | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| Read one transaction it is party to | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (states only) |
| Create a transaction | ✓ | — | — | — | — | — | — | — | — |
| Add / remove a party | ✓ | — | — | — | — | — | — | — | — |
| Confirm own participation | — | — | — | ✓ | ✓ | — | ✓ | — | — |
| Bind / withdraw a representation | ✓ | — | — | — | — | — | — | — | — |
| Request a consent | ✓ | — | — | — | — | — | — | — | — |
| Answer a consent | — | — | — | ✓ | ✓ | — | ✓ | — | — |
| Re-evaluate compliance | ✓ | — | — | — | — | — | — | — | — |
| Change status (actor transitions) | ✓ | — | — | — | — | — | — | — | — |
| Record working particulars | ✓ | — | — | — | — | — | — | — | — |
| Add a document (own lane) | ✓ | — | — | ✓ | ✓ | — | ✓ | — | — |
| Read a document reference | per class | per class | per class | per class | per class | per class | per class | per class | — |
| Add a scoped note | ✓ | — | — | ✓ | ✓ | — | ✓ | — | — |
| Link an Inbox thread | ✓ | — | — | — | ✓ | — | ✓ | — | — |
| Record a link (case / trial / opportunity) | ✓ | — | — | — | — | — | — | — | — |
| Read process metrics | — | — | — | — | — | — | — | — | ✓ |
| Act on a transaction at all | — | — | — | — | — | — | — | — | — (TS reads; it does not run one) |

Notes on the rows that matter most:

- **Creation** (§62) is the licensed individual's alone. An analyst, an assistant,
  a finance user and an agency administrator without the `licensed_agent` tier are
  all `AGENT_ACTION_NOT_PERMITTED` 403. A club user has no agent workspace at all;
  a player token is no agency session. A licensed agent with no profile is
  `AGENT_VERIFICATION_REQUIRED`.
- **Creating grants nothing** (§63): no representation, no consent, no player
  authority, no club authority. Each is separately resolved.
- **Club signatory** (§64): binding the club — confirming participation,
  answering a consent, linking a thread, filing a club document — needs the
  recorded verification administrator. A club user without it reads the ask and
  is told so in as many words; the server refuses with `SIGNATORY_REQUIRED` 403
  whatever the screen showed. An agent can never act for a club.
- **Player authority** (§65): the individual's own acts are the individual's (or
  a lawful guardian's where enabled). An agent's scope never substitutes for
  them, and a guardian-managed account cannot answer a consent belonging to
  someone else.
- **Reading** is every agency member's, scoped to the agency's own transactions,
  because a transaction's existence is agency-operational. Every *write* is the
  licensed individual's. This is `m24/shared.mjs`: `transactions.read` admits all
  five tiers, `transactions.write` admits `licensed_agent` only.

## 4. Concealment doctrine

A transaction the caller is not party to behaves as nonexistent:
`TRANSACTION_NOT_FOUND` 404, the same body a genuinely unknown id produces, for a
foreign agency, a foreign club, another individual and a guessed id alike. No
refusal says "blocked", "minor", "disputed" or names a party — that uniformity is
what makes the concealment work.

The one deliberate split: for a record the caller **can already read**, a
safeguarding hold is reported as `TRANSACTION_PARTY_UNAVAILABLE` 422 rather than
a 404. Pretending an already-visible transaction vanished would be a lie to a
legitimate party; the honest refusal still names no party and no reason.

## 5. Error contract

| Class | Codes |
| --- | --- |
| 400 input | `TRANSACTION_INPUT_INVALID`, `TRANSACTION_CLIENT_KEY_INVALID`, `DOCUMENT_INPUT_INVALID`, `NOTE_INPUT_INVALID`, `TERMS_INPUT_INVALID` |
| 403 authority | `TRANSACTION_ACTION_NOT_PERMITTED`, `TRANSACTION_PARTY_CONFIRMATION_NOT_PERMITTED`, `DOCUMENT_VISIBILITY_NOT_PERMITTED`, `SIGNATORY_REQUIRED`, `AGENT_VERIFICATION_REQUIRED`, `REPRESENTATION_REQUIRED`, `REPRESENTATION_SCOPE_INSUFFICIENT`, `REPRESENTATION_CONFLICT` |
| 404 concealment | `TRANSACTION_NOT_FOUND`, `TRANSACTION_PARTY_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `NOTE_NOT_FOUND`, `MESSAGE_THREAD_NOT_FOUND` |
| 409 concurrency / state | `TRANSACTION_VERSION_CONFLICT`, `TRANSACTION_IDEMPOTENCY_CONFLICT`, `TRANSACTION_PARTY_EXISTS`, `TRANSACTION_TRANSITION_NOT_ALLOWED`, `TRANSACTION_NOT_LIVE`, `TRANSACTION_ARCHIVED`, `TRANSACTION_ALREADY_CONFIRMED`, `DOCUMENT_SUPERSEDED`, `DOCUMENT_VERSION_CONFLICT` |
| 422 not-yet-permitted | `TRANSACTION_PARTIES_NOT_CONFIRMED`, `TRANSACTION_COMPLIANCE_PENDING`, `TRANSACTION_COMPLIANCE_BLOCKED`, `TRANSACTION_COMPLIANCE_STALE`, `TRANSACTION_PARTY_UNAVAILABLE`, `CONSENT_REQUIRED`, `REGULATORY_REVIEW_REQUIRED`, `JURISDICTION_UNSUPPORTED` |
| 503 provider | `REGULATORY_PROVIDER_UNAVAILABLE` |
| 500 | `TRANSACTION_STATE_UNKNOWN` (a state the map does not describe; fails closed) |

Every code is declared in `m26/errors.mjs` with its status. A refusal carries a
code and no stack, no internal frame, no party name, no reviewer name, no note
text, no document label, no agreement reference and no fee term. 78 distinct
refusals were collected across the acceptance run and every one satisfies that.

## 6. Rate limits

Canonical `RATE_LIMIT_POLICY`, actor-scoped, hourly:
`transaction_write` 60, `transaction_status_write` 60,
`transaction_document_write` 120, `transaction_note_write` 120.
A limited call is 429 with the canonical body, before any mutation.

## 7. Download and message authorization

- **Documents** (§80): every reference read re-authorises. The response is a
  reference into the canonical evidence store plus a sentence saying that holding
  it is not authority to read the file; no long-lived URL is issued.
- **Messages** (§81): a linked thread still goes through the Inbox's own
  authorisation. `readable` on the projection is the Inbox's answer, not the
  transaction's. Transaction membership alone exposes no thread.
