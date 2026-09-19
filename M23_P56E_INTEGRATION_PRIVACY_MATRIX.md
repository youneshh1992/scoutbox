# M23 P5.6E — the cross-app privacy matrix

Three parties meet in this milestone and each holds something the others must not
have. This document says what each may see, and names the test that proves it.

## 1. What the AGENT may see of the club's work

| Fact | Agent sees | Test |
| --- | --- | --- |
| That a club wrote to their client | yes, with the club's name | C5 |
| The message the club addressed to them both | yes — they are a party to it | C6 |
| The recruitment case id | **no** | C7, J5 |
| An assessment, a rating, a scorecard | **no** | C8, D5, L1 |
| A shortlist position, a priority, a ranking | **no** | C8, G3 |
| A club-private note | **no** | C9 |
| The Recruitment Room | **no — 404** | #16 |
| The formal decision, its outcome or its reasons | **no** | #17, F3, O2 |
| Second Look / Nobody Missed / the Director Dashboard | **no** | #18–#21 |
| That a transaction workspace was invited | yes — they were invited | F1 |
| Why the club decided to invite it | **no** | F3, O2 |

The case id deserves its own line. It reaches the **workspace** — the transaction
the agent opens may cite the invitation it answers — but it is not printed on the
agent's screen as an internal reference to read (F2, F2b). And in a transaction's
`links`, it is projected only to the representing agent and to the club that owns
the case; the player, a releasing club and Trust & Safety each see it **absent**,
not redacted, so its existence is not disclosed either (R1–R4). That scoping was
defect **E-6**.

## 2. What the AGENT may see of the player's work

| Fact | Agent sees | Gate | Test |
| --- | --- | --- | --- |
| The relationship and its state | yes | own agreement | AN2 |
| The trial's state and schedule | yes | `trialVisibility` | K5, K6, D6 |
| The venue **name** and town | yes | `trialVisibility` | K7, D2 |
| The venue's exact **address** | **no** | held for the family (P4B D-23) | K8, D3 |
| The club's joining instructions | **no** | — | K9, D4 |
| The trial's evidence list / Box Cam | **no** | no field exists | M1, D5 |
| Whether a trial report is **owed** | yes | a state, not its content | L2 |
| What a report **says** | **no** | — | L1 |
| Their client's own opportunity board | yes | same eligibility the player has | G2, D8 |
| A date of birth | **no** | — | privacy sentinel |
| Medical data | **no** | player-controlled, never projected | P5.6B |

## 3. What the CLUB may see of the representation

| Fact | Club sees | Gate | Test |
| --- | --- | --- | --- |
| That this player is represented | only with `clubPresence` on | player's choice | E1, N2 |
| By whom (agent name, agency name) | only with `clubPresence` on | player's choice | E2 |
| Which jurisdictions the agent works in | **no** | flattened to the one asked about | E-p3 |
| A licence state for the jurisdiction in question | yes, as a word | with an honest caveat | E3, E-p5 |
| The agreement's term, scope, fee or commission | **no** | no field exists | E-p4 |
| That an invited client **was** represented | yes | the fact the club needs | F5b |
| **Who** that agent is, via the handoff | **no** | still the player's disclosure | E11, F5c, F9, P10 |
| Inside the transaction workspace | **no** | it opened; not what is in it | F8 |

The club-facing presence projection is exactly six fields. It was seven: an
earlier version projected the nested per-jurisdiction facet map whole, which would
have told a club which member associations an agent is registered in — a fact
about the agent's business, not about this player. That was defect **E-8**.

## 4. What the PLAYER may see

| Fact | Player sees | Test |
| --- | --- | --- |
| Their own three disclosure choices and their states | yes | D1, A3 |
| What their agent has put in front of them, named to the agent | yes | G7, D15, D16 |
| That applying is their own act | yes, in words | G6, D17 |
| An Apply button inside the shared-opportunity card | **no** | G8, D18 |
| The club's case id, decision or assessment | **no** | R3, journey `shared` projection |
| The agent's fee or commission | **no** | D3, A7 |

## 5. What a COLLEAGUE and a FOREIGN AGENCY may see

Nothing of another agent's client. A same-agency colleague sees no routed
contact (S1, J6, AP6), no trial, no share, no invitation (S2), and cannot bind
themselves to another agent's client (#4). A foreign agency's agent gets the
**identical** answer a nonexistent relationship gets (AB1, AP5), so the two are
indistinguishable.

Agency membership is not the mandate. That sentence is the whole of §5, and the
suite asserts it eleven times.

## 6. What a REMOVED person leaves behind

When a player deletes their account, the relationship becomes an **id-only
tombstone**: the ids and the dates stay, because an agency's record of a mandate
it really held is a real record; the person goes. The projection carries no name
(#34), and every surface closes with `SUBJECT_UNAVAILABLE` rather than with a
blank page (S-p6, #34b).

## 7. Events and notifications carry ids only

| Event | Payload |
| --- | --- |
| `representation_disclosure_changed` | `orgId`, `agreementId`, `agentUserId` — not **which** choice |
| `contact_agent_routed` | `orgId`, `contactId`, `agentUserId` — not the club, not the subject, not a word of the message |
| `agent_opportunity_shared` | `orgId`, `agreementId`, `agentUserId` — not which opportunity, not the client |
| `transaction_handoff_invited` | ids and a represented flag |
| `transaction_handoff_withdrawn` | ids |

Group AQ reads these declarations out of the registry and asserts that not one of
them has a field for a name, a date of birth, a note, an outcome or a reason code.
