# M23 P5.6C — privacy and error minimization, verified

Compliance work is unusually good at leaking: a refusal explains itself, a review
needs evidence, a consent names parties. Each of those is a place where one party
can learn something about another. This document records what each surface may
carry, and how that is checked rather than asserted.

## The error contract

`m25/errors.mjs` holds a **null-prototype** status table (so a crafted code cannot
reach `Object.prototype`) and `publicErrorBody`, which whitelists fields. Anything
not on the list is dropped, including fields a route author might add later:

| Allowed on an error body | |
|---|---|
| `error`, `message`, `field`, `allowed`, `status` | the refusal itself |
| `reasons[]` reduced to `code`, `ruleId`, `ruleStatus`, `regulator`, `jurisdiction`, `policyVersion`, `partyRoles`, `partyRole`, `overrideRuleId` | why |
| `consentsOutstanding[]` reduced to `partyRole`, `consentKind`, `reasonCode` | what is missing |
| `policyVersions`, `outcome`, `reviewId`, `contextId`, `retryAfter` | where to look |

**Never** on an error body: a stack, an internal field, a reviewer's name, a
reviewer's reason text, evidence references, a dispute reason, an agent user id, a
party's name, a licence number, a reference string, a date of birth.

`m23AgentComplianceE2E` collects **every** refusal the run produces (192 of them)
and sweeps the lot: each carries a code; none carries a stack or internal field;
none matches any seeded person's name or the private-dispute sentinel; no reason
entry carries `agentUserId` or a prose `note`.

## What each surface may see

| Surface | Sees | Does not see |
|---|---|---|
| Agent (own context) | party names they may already see, party roles, outcome, reasons with rule ids and statuses, own consents' status, own review items | a colleague's context, a reviewer's name or reason, evidence, another party's private data, a dispute reason |
| Agent (colleague's context) | nothing — `CONTEXT_NOT_FOUND` | its existence |
| Player | who asks, agency name, agent's licence **state**, transaction type and jurisdictions, other party **roles**, that they may decline | fee, commission, terms, the club's answer, the other party's data, the agent's licence number |
| Club signatory | the same shape, for the club | the individual's name (withheld unless the club may already see them), the individual's answer, fee |
| Reviewer | exactly the review's need: the reference under review, the agent's display name, facet and state, or the context's type, jurisdictions, party **roles** and representation statuses | a party's date of birth, contact details or profile; anything not needed to decide the item |
| Agency administrator (audit) | action, timestamp, attributed actor role, target type and ids | reviewer names, reason text, evidence references, licence numbers, references |
| Shared admin key | read-only review and policy projections | any decision power |

## Reviewer attribution, seen from the agency

An agency's audit feed shows a reviewer as the role `Trust & Safety (attributed)`,
never by name. The reviewer's own console shows the name, because the reviewer is
accountable to Trust & Safety, not to the agency they decided about. The live suite
asserts both halves: the decision carries "Marcus Bell" in the console, and the
agency feed carries the attributed role with no personal name, no evidence and no
reason text.

## Events carry no personal field

Every P5.6C event is registered in the M18.2 registry with an explicit payload
allowlist, and a development build throws on an extra key. The payloads are ids and
enums only:

| Event | Payload |
|---|---|
| `regulatory_review_requested` | `orgId`, `reviewId`, `kind` |
| `regulatory_review_started` | `orgId`, `reviewId` |
| `regulatory_review_resolved` | `orgId`, `reviewId`, `outcome` |
| `conflict_evaluated` | `orgId`, `ctxId`, `outcome` |
| `regulatory_consent_requested` / `_granted` / `_declined` / `_revoked` | `orgId`, `consentId`, `ctxId` |
| `agent_authorisation_state_changed` | `orgId`, `userId`, `state` |
| `policy_version_published` | a store ping, no subject at all |

The key is `ctxId`, not `contextId`, because the M18.2 sentinel rejects payload keys
matching `/dob|birth|email|phone|note|body|text|address|password|token/i` and
"contextId" contains "text". That is the sentinel working as intended.

## Uniform not-found

One answer — `PARTY_NOT_FOUND` (404) — covers: no such player, a blocked player, a
player the agency cannot see, an under-18 player, and a deleted player. The
representation route checks visibility and blocks **before** relationship scope, so
a blocked player cannot be distinguished from an unknown one by comparing a 403 to a
404. `m23AgentComplianceE2E` X6 exists because an earlier build failed exactly that
comparison.

Likewise a colleague's context, another player's consent and an unknown review are
all plain 404s, never 403s that confirm existence.

## Analytics

Process metrics only: review counts by status and kind, a median time to decide,
conflict-outcome counts, consent counts, a stale-facet count. No agent is named or
ranked, no agency is compared, and no payment or subscription state appears. The
endpoint says so in its own `note`.

## Wording

No P5.6C surface says "compliant", "approved by FIFA", "legally valid" or offers
legal advice. `CLEAR` is described as a platform result under named policy versions.
The player's card says ScoutBox records the answer and does not advise. The reviewer's
own screen carries "not a legal determination". The live suite sweeps the compliance
screens for offer, negotiation, commission and salary wording after removing the
sentences that exist to say there is none.

## Residual risks, stated

1. **Party names in an agent's own context.** An agent sees the names of parties
   they already have access to; a club's name is public. A club's *interest* in a
   player is therefore inferable by the agent who opened the context — which is the
   agent who put those parties there.
2. **Consent asks reveal that an ask happened.** A party learns the agent wants to
   act for someone else in that transaction. That is the point of consent.
3. **Review timing.** The absence of a decision is visible as a pending item; a slow
   review is inferable. No content leaks, only latency.
4. **Reviewer names inside Trust & Safety.** Deliberate: accountability requires it.
