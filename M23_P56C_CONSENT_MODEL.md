# M23 P5.6C — the party-specific consent model

Consent here is not a checkbox on the agent's side. It is an append-only ledger of
answers given by the parties themselves, and the conflict engine reads it as
evidence rather than as configuration.

## One record per party, per transaction, per agent

A consent row names: the agent, the agency, the context, the party role, the
subject (`player` or `club` with its id), what the agent disclosed
(`particulars`), the policy versions and the rule ids the ask was made under, and
server timestamps. It is created only by
`POST /org/agent/compliance/contexts/:id/consents/request`, and only when an
**ACTIVE** rule actually makes consent the deciding question — an agent cannot
manufacture a consent record where no rule asks for one.

## Append-only, with server clocks

- A grant sets `status: 'granted'` and `grantedAt` from the **server** clock. A
  client-supplied timestamp is ignored; the acceptance suite sends one to prove it.
- A decline sets `status: 'declined'` and `declinedAt`.
- A revocation is a **new row** (`kind: 'revocation'`, `of: <consentId>`), never an
  edit. The granted row keeps `status: 'granted'` and gains no `revokedAt` field;
  the derived status becomes `revoked` because a revocation row exists. A
  persistence check asserts the granted bytes are untouched.

The reading is deliberate: the record must show that consent *was* given and then
withdrawn, because both facts matter afterwards.

## Who may answer

| Party | Who answers | Enforced by |
|---|---|---|
| The individual | The player, in their own app | `/player/agent/consents/:id/{grant,decline,revoke}`; a guardian-managed (under-18) account is refused `COMPLIANCE_ACTION_NOT_PERMITTED` |
| A club | The club's **recorded verification administrator** — its signatory | `/org/compliance/consents/*` with `hasVerLevel(db, orgId, userId, 'verification_admin')`; anyone else is refused |
| The agent | Never | The agent has no route to answer for a party; attempts are `CONSENT_NOT_FOUND` |

`signatory` is the server's answer in the club projection, never a client claim. A
club user without that authority reads the ask and sees why they cannot answer,
rather than finding a button that fails.

## Granting takes two acknowledgements

A grant requires `acknowledgedParticulars` **and** `acknowledgedLegalAdvice`; the
server refuses without both (`CONSENT_INPUT_INVALID`). Both surfaces express this
as two explicit controls, and the primary action stays disabled until both are
confirmed. Declining requires neither: the easy path is never the one that gives
something away.

England additionally requires the ask itself to have carried full particulars and a
legal-advice offer. A consent granted against an ask that did not is insufficient
(`PARTICULARS_MISSING`, `LEGAL_ADVICE_NOT_OFFERED`) — the acknowledgement cannot
paper over a disclosure that never happened.

## In advance, not retrospectively

Consent must precede the agent's act for the second party. The engine measures this
against the second-earliest `firstActAt` among that agent's representations in the
context, so acting for one party and then obtaining consent before acting for the
second is correct, while acting for both and then asking is not
(`CONSENT_NOT_IN_ADVANCE`).

## What revocation does and does not do

A revocation is immediate: the context is re-evaluated on the same request, and the
agent's clearance returns to `PERMITTED_WITH_CONSENT` with the reason named as
`CONSENT_REVOKED` rather than merely missing. It stops any **future** regulated act
that needs that consent. It does not undo what already happened, and it erases
nothing. Both surfaces say so in those words.

## Party changes invalidate prior answers

Adding or removing a party re-evaluates the context. A consent names the context and
the party role it was given for, so it cannot drift onto a different combination:
`CONSENT_WRONG_CONTEXT` and `CONSENT_WRONG_PARTY` are separate reason codes. When a
player deletes their account, `onPlayerDeleted` removes them as a party and
re-evaluates; their consent rows keep their ids as tombstones.

## Races

Two answers to the same request race on `rev`: the second gets
`CONSENT_VERSION_CONFLICT` (409) with the current status, and the client shows the
shared conflict reading. An idempotency key replays the first answer rather than
recording a second (`CONSENT_IDEMPOTENCY_CONFLICT` when the same key carries a
different payload). Re-granting a revoked consent is refused
(`CONSENT_NOT_PENDING`): a new ask is required.

## Privacy

A consent projection carries who asked, the agency, the agent's licence **state**,
the transaction type and jurisdictions, the other party roles, and the honest
sentence about declining. It carries no fee, no commission, no contract terms, no
other party's private data and no other party's answer. Both the acceptance suite
and the live suite sweep the rendered card for fee and commission wording.

## Notifications

`regulatory_consent_requested`, `_granted`, `_declined`, `_revoked` are in the
mandatory `compliance` category, so a party cannot be left unaware that something
was asked of them, and an agent cannot miss a revocation.

## Verification

`m23AgentComplianceE2E` groups P, L, S, T and adversarial cases #12–#16, #24:
request preconditions, both lanes, both acknowledgements, the append-only ledger,
revocation, races, wrong-party and wrong-context rows, stale policy versions, and
a player's inability to answer for another.
`m23AgentCompliancePersistence` §4: the ledger, its keys and the revocation row
survive a restart byte for byte.
`m23AgentComplianceLive` groups D–G: both consent lanes in real browsers, including
the blocked grant and the revocation's immediate effect on the agent's clearance.
