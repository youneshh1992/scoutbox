# M23 P5.6C — the conflict engine

`scoutbox-server/m25/conflict.mjs` is a pure function. Given the same inputs and the
same clock it returns the same outcome, the same reasons and the same `inputHash`.
It reads no database, no request and no session; the domain layer assembles its
inputs and records its output.

## Five outcomes, and what each means

| Outcome | Meaning |
|---|---|
| `CLEAR` | Under the named versions, no encoded rule prohibits this combination. |
| `PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED` (alias `PERMITTED_WITH_CONSENT`) | Permitted **only** with prior written consent from each named party. |
| `PROHIBITED_CONFLICT` | An ACTIVE rule prohibits it. Consent cannot cure it; no reviewer can approve past it. |
| `MANUAL_REGULATORY_REVIEW_REQUIRED` | The deciding rule's status is uncertain or unencoded. A named reviewer decides; nothing proceeds meanwhile. |
| `INSUFFICIENT_DATA` | A fact the evaluation needs is missing. No result is guessed. |

Severity is monotonic: `mostSevere` means a block always beats a clearance, and
adding a fact can never turn a prohibition into a permission.

`CLEAR` is deliberately **not** called "compliant". The projection and the UI say
it is a platform result under named versions, not a legal conclusion and not a
governing body's approval.

## England, as encoded

| Combination | Outcome |
|---|---|
| One party only | `CLEAR` (reason `SINGLE_PARTY`) |
| Individual + engaging entity | `PERMITTED_WITH_CONSENT` under `ENG-6.3`, consent outstanding from **both** |
| Individual + releasing entity | `PROHIBITED_CONFLICT` under `ENG-6.4` |
| Engaging + releasing entity | `COMBINATION_NOT_PERMITTED` — no rule permits it |
| Any of the above with consents on record | `CLEAR` with reason `DUAL_CONSENTED` |

## FIFA rules whose status is uncertain

Where the deciding rule is `UNDER_LEGAL_REVIEW` or `UNKNOWN`, the engine returns
`MANUAL_REGULATORY_REVIEW_REQUIRED` with `RULE_STATUS_UNCERTAIN` or
`POLICY_NOT_ENCODED`. It does not fall back to the FIFA text, and it does not fall
back to "permitted". A `SUSPENDED` or `PENDING_IMPLEMENTATION` rule yields
`NO_ACTIVE_RULE_DECIDES` — the absence of an in-force rule is reported, never read
as permission.

## Connected agents are attributed

`ENG-6.5` counts connected agents as one. The domain layer passes
`connectedAgentUserIds`, and a colleague's verified representation in another open
context naming the same parties is folded into the evaluated agent's party set,
with reason `CONNECTED_AGENT_ATTRIBUTION`. Outstanding consents are deduplicated by
party role, so one party is asked once however many connected agents reach it.

The colleague is never *judged* in the reasons: `evaluateAgentUserIds` bounds whose
state is assessed to the agent the evaluation is for, so an agent never sees a
verdict about a colleague's own standing.

## Consent sufficiency

`consentSufficiency` is where "there is a consent record" becomes "this consent
counts". A consent is sufficient only when all hold:

- status `granted`, never revoked (a revocation is reported first, as
  `CONSENT_REVOKED`, because it is a fact in its own right);
- same context (`CONSENT_WRONG_CONTEXT`), same agent (`CONSENT_WRONG_AGENT`), same
  party role (`CONSENT_WRONG_PARTY`);
- given by the party or its recorded signatory (`SIGNATORY_REQUIRED`);
- given **in advance** of the agent's first act for the second party
  (`CONSENT_NOT_IN_ADVANCE`), where "in advance" is measured against the
  second-earliest `firstActAt` among the agent's representations, not the first;
- naming a policy version in which the deciding rule was ACTIVE
  (`CONSENT_POLICY_VERSION_STALE`);
- for England, carrying full particulars and a legal-advice offer
  (`PARTICULARS_MISSING`, `LEGAL_ADVICE_NOT_OFFERED`).

A representation confirmed by attributed review records **no** act by the agent:
`firstActAt` stays null until the agent themselves acts, so a consent obtained
after the review is still in advance.

## Snapshots and re-checking

Every evaluation is appended to the context with its reasons, consent state, policy
versions, `evaluatedAt` and `inputHash`, plus a snapshot of the parties and
representations it saw. Nothing is overwritten. The engine is re-run, at mutation
time, on: opening a context, adding or removing a party, declaring or withdrawing a
representation, every consent answer including revocation, a review decision, a
party's account deletion, and an explicit re-evaluate. An earlier clearance never
authorises a later act.

## Other services and declared interests

`other_services` carries a presumption: such work is presumed to be agent services
unless shown otherwise (`OTHER_SERVICES_PRESUMPTION`), which raises attributed
review rather than clearing. A declared interest appears as `INTEREST_DECLARED` and
is visible in the reasons rather than buried.

## What the engine refuses to invent

- A missing party, a removed party or a minor party is `PARTY_REMOVED` /
  `MINOR_PARTY` into `INSUFFICIENT_DATA`, never an assumed absence.
- An unresolvable scope is `SCOPE_UNRESOLVED`, never defaulted to national.
- An agent whose own facets do not permit a regulated act is `AGENT_STATE_INVALID`;
  the evaluation does not proceed as if they were verified.
- An unknown transaction type is `TYPE_UNKNOWN`.

## Verification

`m23AgentComplianceE2E` groups G–O and the thirty adversarial cases cover the
England matrix, the uncertain-rule paths, connected-agent attribution, every
consent-insufficiency reason code, determinism of `inputHash`, monotonic severity,
and the refusal to record anything when the outcome is a refusal.
`m23AgentComplianceLive` groups B, D, F, G and N1 drive the same engine through the
real agent workspace.
