# M23 P5.6E — the cross-app integration model

P5.6E makes ScoutBox Agent a **participant** in work the other apps already own.
It adds no domain. It adds one decision layer, four projections, two writes, and
nothing else.

## 1. What this milestone is, stated plainly

P5.6B gave an agent an identity and a client relationship. P5.6C gave that
relationship a regulatory gate. P5.6D gave an agency a transaction workspace.
Each of those was a domain of its own.

P5.6E is not. It is the wiring between them and the apps that were already
there: Player, Pro Club, Grassroots, Contact Inbox, Trials, Recruitment
Decisions, Transactions, Notifications, Events, Audit, Passport and Trust. The
question it answers is always the same shape:

> *Given the relationship, the policy, the consent, the block and the privacy
> rules as they stand right now — may this agent be a party to this piece of
> work, and how much of it may they see?*

## 2. The one decision layer

`scoutbox-server/m27/integration.mjs` is pure: no database, no clock of its own,
no events, no writes. It takes facts and returns a verdict.

```
decideAgentSurface({ surface, basis, subject, policy, disclosure, ... })
  → { allowed: true,  surface, basis }
  → { allowed: false, code, rule }
```

`scoutbox-server/m27/index.mjs` is the db-bound seam. It reads the canonical
stores, asks the pure layer, and owns the routes. Nothing else in the codebase
decides an agent's access to another app's work.

### 2.1 Ten surfaces

| Surface | Regulated | Scopes | Adult only | Needs disclosure |
| --- | --- | --- | --- | --- |
| `client_private` | no | — | yes | no |
| `passport_basic` | no | — | yes | no |
| `passport_shared` | no | — | yes | yes |
| `evidence_shared` | no | — | yes | yes |
| `contact_participation` | yes | employment, transfer | yes | yes |
| `trial_projection` | no | — | yes | yes |
| `trial_coordination` | yes | employment, transfer | yes | yes |
| `opportunity_share` | yes | employment, transfer | yes | no |
| `transaction_initiation` | yes | employment, transfer | yes | no |
| `club_agent_presence` | no | — | yes | yes |

A surface that is **regulated** maps to a real P5.6C policy action
(`approach_adult` or `declare_representation`). It never invents a name of its
own, because a name of its own would be a policy ScoutBox made up.

`trial_coordination` is declared and **has no route**. It exists so that the
answer to "may an agent confirm a trial for their client?" is a decision the
system can state, rather than a gap. §26 forbids a second Trial workflow, so the
decision is recorded and the route does not exist.

### 2.2 The rule order is fixed

```
SURFACE → BASIS → SUBJECT → AGE → BLOCK → SCOPE → DISCLOSURE → SHARE → LICENCE → COMPLIANCE
```

Read it as a sentence: *is this a real question; does this agent hold authority;
does the subject still exist; are they an adult; has anyone blocked anyone; does
the mandate cover this kind of work; has the client agreed to this being visible;
has this particular thing been shared; is the licence current; is compliance
clear?*

Two orderings matter and are deliberate:

- **BLOCK before SCOPE, DISCLOSURE, LICENCE and COMPLIANCE.** Safety outranks
  every convenience, and a CLEAR compliance answer never overrides a block.
- **AGE before BLOCK.** A minor is refused before anything else is consulted, so
  no refusal about a child can be read as a statement about a block.

The first refusal wins. A refusal therefore never leaks the facts that come
later in the order: a blocked player's refusal says nothing about the agent's
licence, because the licence was never looked at.

### 2.3 Twelve deny codes

`SURFACE_UNKNOWN`, `NO_REPRESENTATION`, `REPRESENTATION_NOT_ACTIVE`,
`REPRESENTATION_AMBIGUOUS`, `SUBJECT_UNAVAILABLE`, `MINOR_PATHWAY_DISABLED`,
`BLOCKED`, `SCOPE_INSUFFICIENT`, `DISCLOSURE_WITHHELD`, `SHARE_REQUIRED`,
`LICENCE_NOT_CURRENT`, `COMPLIANCE_NOT_CLEAR`.

One meaning each. None of them is an age oracle beyond the single named minor
pathway, and none of them quotes a person.

## 3. The authority, and only that authority

```js
agentClientBasis({ agreements, agentUserId, clientId, now })
```

wraps `agreementGrantsAccess(a, agentUserId, now)` — the predicate P5.6B made
canonical — and returns the individual it authorises:

```js
{ ok: true, agentUserId, agreementId, scope, agencyOrgId, status: 'active', isRegulatoryMinor }
```

It returns `agentUserId`, and that matters: every routing snapshot, every
notification and every handoff match is keyed on the individual the basis names.
A basis that named nobody would produce a record claiming an agent with no agent
in it, which is worse than no record. (This was defect **E-4**; see the defect
register.)

Four things are **not** a basis, each proven by its own negative test:

1. A proposal the client has not confirmed.
2. A disputed relationship.
3. An `active` agreement past its `endAt` — expiry is derived on every read, not
   waited for.
4. A colleague's agreement at the same agency. Membership is not the mandate.

And a fifth, which is the legacy closure: a **legacy M13 F10 mirror row** has
`agentUserId: null`, so it can never satisfy a predicate asked about a named
agent. It still reads as history — rewriting the record would be a lie about what
happened — but it grants nothing.

## 4. What P5.6E writes

Two writes, and both live on records that already existed:

| Thing | Where it lives | Why not a new store |
| --- | --- | --- |
| The client's three disclosure choices | `representationAgreements[].disclosure` | It is a property of the relationship. A separate store would be a second place to ask the same question. |
| An agent's opportunity shares | `representationAgreements[].opportunityShares[]` | A share is something one agent said to one client inside one mandate. It ends when the mandate does. |
| The club's transaction-handoff invitation | `recruitmentCases[].transactionHandoff` | One per case, owned by the case, invisible wherever the case is. |

`SCHEMA_VERSION` stays at **2307**. There is no P5.6E migration: nothing needed
one, and §102 says not to advance schema merely because a milestone is new.

## 5. What P5.6E deliberately does not do

- **No `agent_only` contact route.** §21 lists it illustratively; it is not
  built. A message with no player Inbox row could not honestly be called
  delivered, and making it honest would need a second Inbox — which §20 forbids
  outright. Two modes exist: `player_only` and `both`.
- **No agent Trial coordination.** The agent reads the schedule. Confirming,
  rescheduling, cancelling and attendance stay with the family and the club.
- **No Offer Workflow, no Offer lifecycle state, no signing.** Not written, not
  computed, not hinted at in copy. The handoff says in words that it is not an
  offer.
- **No general minor discovery.** Every surface is `adultOnly`, and the minor
  pathway is refused before anything else is asked.
- **No agent-directed sharing writer.** `sharedFor` in the seam answers `false`
  always, because no route exists through which an agent could mark something
  shared. The surfaces that need a share therefore refuse until the *player*
  shares it, through the Passport sharing they already had.
