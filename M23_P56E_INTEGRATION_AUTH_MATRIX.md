# M23 P5.6E — the cross-app authorization matrix

Every row is enforced on the server. A client list is convenience; the server
decides and refuses.

## 1. The order every P5.6E request runs

| # | Step | Where |
| --- | --- | --- |
| 1 | Authenticate the session | canonical org / player auth |
| 2 | Resolve the actor, their org and their tiers | `agent.resolveMembership` / `orgAuth` / `playerAuth` |
| 3 | Refuse a non-agency org on the agent lane | `AGENT_ACTION_NOT_PERMITTED` — "the Agent workspace is for agency organisations" |
| 4 | Refuse a role without the action | `m24/shared.mjs` PERMISSIONS → `AGENT_ACTION_NOT_PERMITTED` |
| 5 | Resolve the relationship by id, as **this agent's** | `agent.findOwnAgreement` → uniform `REPRESENTATION_NOT_FOUND` 404 |
| 6 | Ask the decision layer for the surface | `m27` `decide({ surface, clientId, agentUserId })` |
| 7 | Project or write | the route's own body |
| 8 | Audit + event + notification | case `history[]`, registry event, canonical notification |

Steps 5 and 6 are re-run on **every** read and every write. Nothing is cached
from the page the caller was looking at. A relationship that ended one second ago
closes the next read; that is asserted over HTTP in group AR.

## 2. Who may reach what

`✓` = permitted, subject to the decision layer. `404` = concealed as
nonexistent. `403` = refused about the caller's own state. `—` = no such route.

| Route | Representing agent | Same-agency colleague | Agency admin | Foreign agency | Owning club lead | Club scout | Foreign club | Player (subject) | Other player | T&S admin key |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /org/agent/clients/:id/contacts` | ✓ | 404 | 403 | 404 | 403 | 403 | 403 | 401/403 | 401/403 | 401 |
| `GET /org/agent/clients/:id/trials` | ✓ | 404 | 403 | 404 | 403 | 403 | 403 | 401/403 | 401/403 | 401 |
| `POST /org/agent/clients/:id/opportunities/:oppId/share` | ✓ | 404 | 403 | 404 | 403 | 403 | 403 | 401/403 | 401/403 | 401 |
| `POST …/opportunities/shares/:id/withdraw` | ✓ (own share) | 404 | 403 | 404 | 403 | 403 | 403 | 401/403 | 401/403 | 401 |
| `GET /org/agent/clients/:id/opportunities/shares` | ✓ | 404 | 403 | 404 | 403 | 403 | 403 | 401/403 | 401/403 | 401 |
| `GET /org/agent/handoffs` | ✓ (invited only) | empty | 403 | empty | 403 | 403 | 403 | 401/403 | 401/403 | 401 |
| `GET /player/agent/shared-opportunities` | — | — | — | — | — | — | — | ✓ (own) | own only | — |
| `PATCH /player/agent/relationships/:id/sharing` | 403 | 403 | 403 | 403 | 403 | 403 | 403 | ✓ (own) | 404 | 401 |
| `GET /org/rooms/:id/transaction-handoff` | 404 | 404 | 404 | 404 | ✓ | 403 view-only answer | 404 | 403/404 | 404 | 401 |
| `POST /org/rooms/:id/transaction-handoff` | 404 | 404 | 404 | 404 | ✓ | 403 | 404 | 403/404 | 404 | 401 |
| `POST …/transaction-handoff/withdraw` | 404 | 404 | 404 | 404 | ✓ | 403 | 404 | 403/404 | 404 | 401 |
| `GET /org/rooms/:id/contacts` (routing view) | 404 | 404 | 404 | 404 | ✓ | ✓ read | 404 | — | — | 401 |

Three properties of this table are load-bearing:

1. **A foreign agency and a nonexistent relationship are the same answer.** Both
   are `REPRESENTATION_NOT_FOUND`, so the route is no oracle over who any agency
   represents. Asserted by AP4/AP5.
2. **An agency administrator's refusal is about their role, not the record.** The
   same 403 comes back for a client the agency never represented, so the role
   gate is no oracle over the client list either. Asserted by #3/#3b.
3. **A club's case is invisible to an agency session, not merely closed.** 404,
   never 403 — a 403 would confirm the case exists. Asserted by AP7 and #16.

## 3. The club's handoff: nine blockers, permission first

`handoffBlockers` returns codes, in this order:

| Code | Means |
| --- | --- |
| `HANDOFF_NOT_PERMITTED` | your role cannot do this |
| `HANDOFF_DECISION_REQUIRED` | no finalised formal decision to progress |
| `HANDOFF_CASE_STATE` | the case is not at offer consideration |
| `HANDOFF_SUBJECT_UNAVAILABLE` | the person is gone |
| `HANDOFF_MINOR` | the minor pathway is closed |
| `HANDOFF_BLOCKED` | a block stands |
| `HANDOFF_EXISTS` | one invitation already stands |
| `HANDOFF_TRANSACTION_EXISTS` | a live transaction already covers this |
| `HANDOFF_COMPLIANCE_UNAVAILABLE` | compliance cannot be evaluated |

`HANDOFF_NOT_PERMITTED` is reported **first and alone**. A viewer who cannot
invite is told that, and nothing else: they do not receive a checklist of what a
recruitment lead could do. Asserted by P3.

And the readiness view calls the same function the mutation calls, so a club that
forces the POST gets exactly the answer the screen showed. Visibility of a button
is not authorization (§38); asserted by #22.

## 4. Facts the server derives and the request cannot set

The body is ignored, and the server derives, for: the contact's recipient, the
routing snapshot, `routedToAgent`, the agent's identity in any snapshot, the
handoff's status, `representedAtInvitation`, `transactionId`, a share's author,
a share's rev, the agreement a handoff matches, and the licence and compliance
states. Group #30–#32 forges each of these over HTTP and finds none of them
reaches a field.

## 5. Two refusal vocabularies, and why both exist

- A **domain refusal** names itself with a code (`DISCLOSURE_WITHHELD`,
  `HANDOFF_DECISION_REQUIRED`, …), because the surface has to word it and a
  screen reader has to read it.
- A **route that does not exist** answers a bare 404 with no body. Several of
  P5.6E's strongest guarantees are of this kind: there is no agent trial-confirm
  route, no Trust-Score write, no Passport write. Nothing to name, because
  nothing is there.

The suite's hygiene sweep distinguishes the two and requires a code from every
refusal that reached a handler (HY3), no 5xx anywhere (HY4), no person, agency or
email in any refusal body (HY5), and no mention of an offer, fee, commission or
signing (HY6).
