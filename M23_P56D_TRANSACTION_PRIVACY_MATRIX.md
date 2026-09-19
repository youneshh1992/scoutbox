# M23 P5.6D — Transaction privacy matrix

The governing rule: **transaction membership is not visibility.** Being a party
tells you that a transaction exists and what its state is. Everything else is
granted class by class, side by side.

## 1. Room roles

Seven roles, resolved by the server from the transaction and the caller. A caller
holds the roles their position gives them and no others.

| Role | Held by |
| --- | --- |
| `representing_agent` | the licensed agent who owns the transaction |
| `party_individual` | the player who is the individual party |
| `party_guardian` | a lawful guardian of that individual (architecture present; minor pathway closed) |
| `party_club_signatory` | a recorded verification administrator at a party club |
| `party_club_member` | another user at a party club |
| `agency_admin_observer` | an agency administrator at the owning agency |
| `trust_safety` | a named, authenticated Trust & Safety reviewer |

For a club role the **side** matters as well as the role: the engaging and the
releasing club both hold `party_club_signatory`, so every club-side check is made
against the caller's own `partyRole` too.

## 2. Document and note visibility classes

| Class | Admits | Side-checked |
| --- | --- | --- |
| `AGENT_PRIVATE` | `representing_agent` | — |
| `PLAYER_PRIVATE` | `party_individual`, `party_guardian` | — |
| `ENGAGING_CLUB_PRIVATE` | `party_club_signatory`, `party_club_member` | engaging only |
| `RELEASING_CLUB_PRIVATE` | `party_club_signatory`, `party_club_member` | releasing only |
| `PLAYER_AGENT_SHARED` | `representing_agent`, `party_individual`, `party_guardian` | — |
| `ENGAGING_AGENT_SHARED` | `representing_agent`, `party_club_signatory`, `party_club_member` | engaging only |
| `RELEASING_AGENT_SHARED` | `representing_agent`, `party_club_signatory`, `party_club_member` | releasing only |
| `ALL_TRANSACTION_PARTIES` | agent, individual, guardian, club signatory, club member | — |
| `T_AND_S_ONLY` | `trust_safety` | — |

Three deliberate properties:

1. **`AGENT_PRIVATE` does not admit `agency_admin_observer`.** A same-agency
   colleague is one agent for conflict purposes and a separate person for data
   (P5.6A DR-26). The administrator who can see that the transaction exists
   cannot read the representing agent's private file.
2. **Nothing but `T_AND_S_ONLY` admits `trust_safety`.** A reviewer reads states
   and ids. Their surface, `/ts/transactions`, carries no document content, no
   note text and no party name.
3. **Unknown class → false.** `canSeeVisibility` fails closed, so a
   hand-edited or future class discloses nothing.

**Writing is narrower than reading.** `uploadableVisibilities` excludes
`T_AND_S_ONLY` for everyone, and refuses to let the individual file anything into
a club-side class. A club is offered only its own side's classes plus
`ALL_TRANSACTION_PARTIES`.

## 3. What each party sees

| Datum | Agent | Agency admin | Individual | Engaging club | Releasing club | T&S |
| --- | --- | --- | --- | --- | --- | --- |
| Transaction exists, type, state, jurisdiction | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Party roles | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (roles only) |
| Party names | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Agency name | ✓ | ✓ | ✓ | ✓ | ✓ | id only |
| Compliance state + reason code | ✓ | ✓ | ✓ (word) | ✓ (word) | ✓ (word) | ✓ + policy versions |
| Consent states | ✓ | ✓ | own + required roles | own + required roles | own + required roles | counts |
| Own-side documents | ✓ | per class | ✓ | ✓ | ✓ | ✗ (count) |
| The other club's private documents | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| The agent's private documents / notes | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Own scoped notes | ✓ | per class | ✓ | ✓ | ✓ | ✗ (count) |
| Working particulars | per class | per class | per class | per class | per class | ✗ |
| Linked conversations | exists + Inbox says readable | exists | exists | exists | exists | count |
| Audience timeline | own | own | own | own | own | ✗ (audit instead) |
| Platform audit detail | ✗ | agency audit, actor-as-role | ✗ | ✗ | ✗ | ✓ |
| Process metrics | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

## 4. What the transaction never grants

| Boundary | Enforcement |
| --- | --- |
| **Club-private recruitment data** (§46) | No projection reads `recruitmentCases`, assessments, Recruitment Room discussion, the P5 decision row, the Director Dashboard, Second Look or Nobody Missed. There is no field for any of them to arrive in, and the club UI's own private note is never shown to the agent or the individual. |
| **Player-private data** (§47) | Being a party grants no Passport, no Box Cam, no medical, no private development plan and no account information. Each remains an explicit, separate grant. |
| **Agent-private data** (§48) | No other client of the agent, no internal note, no unrelated agreement and no agency-wide confidential information is reachable from a transaction. A client list is not a field of it. |
| **Fee arrangements** (§56) | No fee field exists at all. Detailed fee workflows are deferred, so there is nothing to scope. Working particulars carry a summary and a party scope, never an amount. |

## 5. Timeline audiences (§39/§40)

A timeline is what one party may see of what happened. The platform audit is
separate and holds more.

| Audience | Reaches |
| --- | --- |
| `all_parties` | every party role |
| `agent_only` | `representing_agent` |
| `player_and_agent` | agent, individual, guardian |
| `club_side` | a club at that side, and the agent |
| `per_document` | exactly whoever the DOCUMENT's own visibility class admits |
| `audit_only` | nobody's timeline — the audit only |

Mapped:

- created, party added / confirmed / removed, status changed, held, cancelled,
  closed, archived, compliance evaluated, compliance stale, message linked, terms
  recorded → `all_parties`
- representation attached / withdrawn → `agent_only` (a regulated act of the
  agent's, not a club's timeline entry)
- consent requested → `player_and_agent`
- document added / superseded / removed → `per_document`
- note added, internal evaluation, subject tombstoned → `audit_only`

`per_document` exists because of defect **D11**: these entries were originally
`all_parties`, which announced to every party that an `AGENT_PRIVATE` document had
been added and named its class — exactly the disclosure the class exists to
prevent. An entry whose detail carries no class reaches nobody.

A timeline entry names the actor as a **role** ("Representing agent", "Club
signatory", "Trust & Safety (attributed)"), never a person. Detail is allowlisted
to ids, roles, codes and states; note text, document labels, reasons and evidence
references never enter one.

## 6. Verified leakage tests

| Case | Result |
| --- | --- |
| #7 engaging club reads the releasing club's private document / note | refused — side check, both in the API and in the club UI |
| #8 releasing club reads the engaging club's private document / note | refused — same, proven in both directions in the browser |
| #9 agent reads a club-private note | refused |
| #10 club reads an agent-private note or document | refused, in the API and on the console |
| T&S evidence to parties | `T_AND_S_ONLY` admits only `trust_safety`; nobody may write it |
| agency colleague reads the agent's private file | refused (`AGENT_PRIVATE` excludes `agency_admin_observer`) |
| a club-private note in the individual's card | absent |
| a document label or note text in the Trust & Safety console | absent; counts only, and the console says so |
| a removed player's PII in a transaction list | absent — the projection reads the live record and finds none |
