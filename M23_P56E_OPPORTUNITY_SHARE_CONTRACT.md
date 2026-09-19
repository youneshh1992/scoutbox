# M23 P5.6E — the opportunity share contract

An agent may put an opportunity in front of their client. Applying stays the
client's own act.

## 1. Sharing is not applying

This is the whole contract in one line, and it is enforced structurally rather
than by wording:

- The share route takes `{ note?, clientKey? }`. There is **no parameter** that
  could start an application (G8).
- The share record has no application field, no status that means "applied", and
  no link to one.
- The player's card has **no Apply button** (D18). They apply on the
  opportunity's own screen, in their own name, exactly as they always did.
- The agent's control says "Share", never "Apply", in both languages (G11, D11).

## 2. The client's own board is the gate

An agent may only share what is **already on their client's board**:

```
GET  /org/agent/clients/:id/opportunities            the client's own board
POST /org/agent/clients/:id/opportunities/:oppId/share
```

The board is built through the same eligibility, visibility and category rules the
player sees (G2, D8). An opportunity that is not on it answers a **uniform 404**:

```
404 OPPORTUNITY_NOT_AVAILABLE
"That opportunity is not on this client's board."
```

Not "closed", not "ineligible", not "expired" — one answer, so the route is no
oracle over what a club has published or over the client's own eligibility (G4).

And nothing of the club's recruitment thinking rides along with the board: no
watchlist, no shortlist position, no tactical fit, no ranking (G3, D9).

## 3. Who may share

`clients.opportunities.share` is a `licensed_agent` permission in
`m24/shared.mjs`. The chain of refusals:

| Caller | Answer |
| --- | --- |
| The representing licensed agent | permitted, subject to the decision layer |
| An agency **administrator** | `403 AGENT_ACTION_NOT_PERMITTED` — the action is not in their role, and the same answer comes back for a client the agency never represented (#3, #3b) |
| A licensed colleague at the same agency | `404 REPRESENTATION_NOT_FOUND` (#4) |
| A foreign agency's agent | the identical 404 (AB1) |
| A club, a player, an anonymous caller | refused before the record is read (AP1–AP3) |

`opportunity_share` is a **regulated** surface: it maps to the `approach_adult`
policy action, needs `employment` or `transfer` scope, and is adult-only. A lapsed
licence closes it (S-p15); a commercial-only mandate cannot use it (S-p11).

## 4. What a share record is

```js
{ id, opportunityId, sharedAt, sharedBy: { userId, name }, note, withdrawnAt, rev }
```

It lives on `representationAgreements[].opportunityShares[]`, capped at
`MAX_OPPORTUNITY_SHARES = 200` per agreement. The author and the rev are the
store's to decide: a forged `sharedBy` or `rev: 99` in the body reaches no field
(#31).

The note is sanitised by `plainShared` — the **same** helper the Contact domain
uses — and cut at 300 characters. One sanitiser, one limit, no second rule for
this lane (AS7). A note that is not text at all is refused (AS6).

## 5. Duplicates and replays

- The same `clientKey` with the same payload **replays** rather than sharing twice
  (AE1, AS4).
- The same `clientKey` with a different payload is
  `409 AGENT_IDEMPOTENCY_CONFLICT` — a named conflict, never a quiet overwrite
  (AS5).
- A **fresh** key for an opportunity already shared and not withdrawn is a named
  duplicate rather than a second row (AE2).

## 6. Withdrawal

The agent who shared may withdraw. A colleague cannot withdraw a share they did
not make and is told the relationship does not exist (AP17); withdrawing a share
that was never made is a 404 rather than a silent success (AP18).

Withdrawal removes it from the client's surface (G10) and leaves the record with
`withdrawnAt` set — the history of what was suggested stays, because it happened.

## 7. What the client sees

`GET /player/agent/shared-opportunities` — the player's **own** route, keyed to
their own session, with no id in the path to swap (#6, AP11). It reads from the
agreements that are active **now**: a share made under a relationship that has
since ended stops appearing, because the suggestion was part of that relationship.

The card is absent rather than empty when there is nothing: a card that said "your
agent has shared nothing" would be a nudge about having an agent, and this surface
is not for that.

Each row names the agent who shared it (D16) and says in words that applying is
the client's own act (G6, D17). A minor's surface is structurally empty — there is
no path by which an agent reaches a child through an Opportunity (#7, AP10).

## 8. The client is told, through the canonical stream

A share sends `representation_opportunity`, in the **`messages`** category —
because an opportunity an agent put in front of their client is a message about a
real chance, not relationship admin — and that category is mutable, so the client
can turn it off (AR9, AR10). The event `agent_opportunity_shared` carries ids
only: not which opportunity, not the client (AQ3).
