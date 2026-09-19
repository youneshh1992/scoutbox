# M23 P5.6E — the Contact routing contract

A club's approach may reach the player **and** their agent. It may never reach the
agent instead.

## 1. Two modes, and why there is no third

```js
CONTACT_MODES = ['player_only', 'both'];
```

§21 mentions an `agent_only` mode illustratively. It is **not built**, and the
reason is stronger than the mandate's phrasing:

An `agent_only` message would create no player Inbox row. ScoutBox would then
have to call it "delivered" to somebody who has no way to read it — which is a
lie — or build a second Inbox for agents so the word could be true, which §20
forbids outright. Both roads end somewhere the milestone must not go, so the mode
does not exist. There is no option in either club app that offers it (B7, N1b),
and no value the server would accept if one were forged (H-p9: an unknown mode is
read as the safest one, not honoured).

The club's own copy says so: *"There is no option that reaches an agent instead
of the player."*

## 2. The route is a request, not a permission

The club **asks** for a mode. Whether it is honoured is decided by
`contactRouting(...)` — and decided **again** when the message is sent, not when
the page loaded.

```
club picks 'both'  →  draft stores contactMode: 'both'
send               →  routing re-derived NOW
                      permitted  → recipient = player, agent = { agentUserId, ... }
                      refused    → recipient = player, agentRefusal = <code>
```

A refusal never fails the contact. The player is always a valid route, so a
message whose agent leg is refused still reaches the player, and the club is told
which rule refused it (H-p5).

## 3. What is stored, and what it says about itself

`contact.routingSnapshot` records **who was validly routed**, as roles and ids:

```js
{
  at, mode,
  targets: [{ role: 'player', id }, { role: 'agent', id, agreementId }],
  agent: { agentUserId, agreementId, agencyOrgId },
  honest: 'Who this message was routed to when it was sent. A later change to
           the client's choices does not rewrite this record.',
}
```

Three properties:

- The snapshot **names the individual agent**. A snapshot claiming an agent with
  no agent in it is worse than no snapshot, and the first implementation produced
  exactly that: `agentClientBasis` omitted `agentUserId`, so every snapshot
  recorded `agent: { agentUserId: null }` and no agent was ever notified. That
  was defect **E-4**, fixed at the root with a fail-closed guard beside it.
- A failed routing produces **no snapshot** (H-p13). There is nothing to record.
- The snapshot is never edited. §22 in one line.

`contactIntegrity` validates both the mode and the snapshot, so a corrupt row is
`contact_mode_unknown` / `routing_snapshot_malformed` / `routing_snapshot_unsent`
rather than a silently mis-rendered contact.

## 4. Re-derivation at mutation time

Everything is asked again at send: the basis, the client's `contactRouting`
choice, the block, the agent's licence, and the compliance answer for the
`approach_adult` action in the case's own jurisdiction.

| Changed between draft and send | Result |
| --- | --- |
| Client turned `contactRouting` off | player only, `DISCLOSURE_WITHHELD` (AS2, AS3) |
| Client blocked the club | the whole send is refused, `CONTACT_BLOCKED` (Y1, #26) |
| Relationship ended | player only, `REPRESENTATION_NOT_ACTIVE` |
| Agent's licence lapsed | player only, `LICENCE_NOT_CURRENT` (#11, #11b) |
| Player is a minor | guardian route, no agent substituted for a guardian (H-p6) |

The block case is the one that refuses the **whole** contact rather than
degrading it: a family that has blocked a club has said something about the club,
not about the routing.

## 5. Idempotency, and the upgrade that nearly broke it

The create fingerprint includes `contactMode`, so two drafts with the same
`clientKey` and different modes are a conflict rather than a silent overwrite.

Adding that field would have broken every pre-P5.6E `clientKey`: a replay of a
draft created before the upgrade would have hashed differently and created a
second draft. The route therefore accepts a **legacy fingerprint** when the
stored record's own mode agrees with the request's. Caught by
`m23ContactPersistence`; recorded as defect **E-5**.

## 6. What the agent receives

- A notification of type `representation_contact`, in the mutable
  `representation` category, through the **canonical** notification system
  (AH1, AH2).
- A row on `GET /org/agent/clients/:id/contacts`, filtered to the contacts whose
  snapshot names **this** agent (S1, J6).
- The club's name, the message addressed to them both, the state, and the time.
  Nothing of the club's thinking (C7–C9, J5).

A refused agent leg is recorded as `contact_agent_routing_refused` on the
contact's own history, so the club can see why, and broadcast as
`contact_agent_routed` when it succeeded — ids only.

## 7. The grassroots app behaves identically

One `orgRouter`, one routing function, one chooser component mirrored into both
club apps. AL2 asserts the grassroots screen carries the same routing surface,
because a privacy rule that differs between two club apps is a privacy rule with
a hole in it.
