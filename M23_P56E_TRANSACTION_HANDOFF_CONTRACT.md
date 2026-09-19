# M23 P5.6E — the transaction handoff contract

A club's formal decision to progress creates **nothing**. A recruitment lead then
makes a separate, explicit decision to invite a transaction workspace. That
invitation is not an offer, and the agency opens the workspace, not the club.

## 1. A decision is not a transaction

§33 in one sentence. The evidence:

- Finalising a formal `progress` decision moves the case to
  `offer_consideration` and writes no transaction (P8, E8).
- Immediately afterwards, `GET …/transaction-handoff` reports
  `available: true, handoff: null` — the door is open and nobody has walked
  through it (P7).
- Inviting creates an invitation and still no transaction (E13). A licensed agent
  opens the workspace by their own act, citing the invitation.

## 2. One invitation per case, on the case

```js
recruitmentCases[].transactionHandoff = {
  id, caseId, orgId, playerId,
  status: 'invited' | 'accepted' | 'withdrawn' | 'expired',
  invitedAt, invitedBy: { kind, userId, name },
  acceptedAt, withdrawnAt, transactionId,
  representedAtInvitation,          // WHETHER, resolved now — never who
  invitedAgencyOrgId, invitedAgentUserId,
  keys, rev, revAt,
}
```

It lives on the case, which means it is as invisible as the case: an agency session
and a foreign club both get the case's own 404 (AB2, AP7, AP9). No new store; §103
asked for none and none was needed.

`expired` is **derived** from the clock against `HANDOFF_TTL_MS` (30 days), not
written by a job. An invitation nobody took up reads as expired on the next read
(P-p16), and a withdrawn invitation does not block a fresh one (P-p13).

## 3. Nine blockers, permission first

`handoffBlockers({ canWrite, hasFinalProgressDecision, caseStatus, subjectPresent,
isAdult, minorPathwayOpen, blocked, existingHandoffStatus, liveTransactionId,
complianceEvaluable })` returns codes only.

`HANDOFF_NOT_PERMITTED` is reported first **and alone**: a scout is told it is not
theirs to do and gets no checklist of what a lead could do (P3). Everything else
is reported together, so a lead sees every reason at once rather than fixing them
one refusal at a time.

The function does not **take** the decision's reasons, note, evidence or author.
No refusal it produces can leak them, because they were never passed in (P-p15).

## 4. The readiness view and the mutation call the same function

`GET /org/rooms/:id/transaction-handoff` returns `{ handoff, available, blockers,
blockerVocabulary, action, note }`. The POST calls the same `handoffFacts` +
`handoffBlockers`. A club that forces the request gets exactly the answer the
screen showed (#22). Visibility of a button is not authorization; §38 made
structural.

The readiness view carries none of the decision's rationale, note, outcome,
reason codes or evidence (O1). Its own prose is the one place the words "offer"
and "note" appear, and only to say that this is **not** an offer and that
inviting is a separate decision.

## 5. What the invitation records, and what it refuses to

| Recorded | Not recorded |
| --- | --- |
| that the client **was** represented | **who** the agent is |
| the agency the invitation is addressed to | any term, fee or commission |
| the club user who invited | the decision's outcome or reasons |
| the time, and the derived expiry | anything about the player beyond their id |

`representedAtInvitation` is resolved by asking the server, not the agent. A club
that has not been given `clubPresence` still learns nothing about who represents
the player (E11, P10, F5c, F9) — because it does not need to know who in order to
know that an agency should be invited.

## 6. Binding: citing a case you were not invited to opens nothing

P5.6D's create route accepts `recruitmentCaseId`. Before the transaction is
stored, `integration.bindHandoff` checks that:

1. an invitation exists on that case,
2. it is still `invited` (not withdrawn, not expired, not already answered),
3. it was addressed to **this** agency and **this** agent,
4. the individual party is the case's own player.

A citation that does not check out creates **no transaction at all** — the bind
runs before the store, so a refusal leaves nothing behind rather than a
transaction with a reference nobody authorised.

`HANDOFF_NOT_FOUND`, `HANDOFF_NOT_INVITED`, `HANDOFF_WRONG_AGENCY` and
`HANDOFF_SUBJECT_MISMATCH` are all declared in `m26/errors.mjs` as 409s. An
undeclared code would have answered 500; that is why they are declared.

## 7. Once answered, it cannot be un-invited

A club may always withdraw its own invitation — while it is still an invitation.
Once an agency has opened the workspace, withdrawal is refused (P16, AS9):
withdrawing would not close the workspace, and pretending otherwise would be a
lie about what the button does.

## 8. The duplicate rule, and not over-blocking

`duplicateTransactionOf` refuses a second live transaction with the **same
individual, the same type and the same clubs on both sides**
(`TRANSACTION_DUPLICATE_CONTEXT`, 409). It deliberately does **not** refuse:

- a loan beside an employment contract (Q-p2, Q3),
- a different engaging club — two clubs competing for one player is normal
  (Q-p3),
- a fresh transaction after the earlier one reached a terminal state.

§37 asks for a duplicate rule that does not over-block, and the three negatives
are how that is kept honest.

## 9. The case reference, scoped

`transaction.links.recruitmentCaseId` is projected **only** to the representing
agent and to the club that is the engaging party **and** owns that case. The
player, a releasing club and Trust & Safety see it **absent**, not redacted — so
its existence is not disclosed either (R1–R4).

The first fix for this read `db.recruitmentCases` from inside the transaction
module, which broke that module's "never touch the recruitment domain" boundary.
It now asks `integration.caseBelongsTo`. Two defects, **E-6** and **E-7**.

## 10. The club's own audit trail

Inviting and withdrawing are milestones on the case's own timeline: the handoff
id, the time, the colleague who did it, and whether the client was represented
(AT1, AT1b). Never the agent, never a fee, never an offer (AT2), and none of the
decision's reasoning (AT3). Inviting a workspace is the moment a case reaches
outside the Room, and the club's audit should say so.
