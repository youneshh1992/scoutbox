# M23 P5.6C — the versioned jurisdiction policy engine

A regulatory rule has two independent properties: **what it says** and **whether it
is currently operative**. Conflating them is how software ends up enforcing a rule
a court has suspended, or ignoring a national rule that displaced an international
one. P5.6C keeps them apart, in one place.

## One module, not scattered conditionals

`scoutbox-server/m25/policyVersions.mjs` holds the encoded versions as data.
`scoutbox-server/m25/policy.mjs` holds the pure functions that select and read
them. No route, projection or client contains a jurisdiction conditional: a change
of rule status is a change of **data**, and `m23AgentComplianceE2E` proves it by
publishing a second England version at runtime and watching a previously
`MANUAL_REGULATORY_REVIEW_REQUIRED` context become `PERMITTED_WITH_CONSENT`
without a deploy.

## What a version is

```
{ id, regulator, jurisdiction, policyVersion, supersedes,
  effectiveFrom, effectiveTo, status, sourceVersion,
  rules: { [ruleId]: { ruleStatus, textStatus, sourceRef, note, params, overrides } } }
```

- `jurisdiction` is a member-association code; `INT` is the FIFA level.
- `status` is `proposed` or `published`. Only `published` versions are ever read by
  an evaluation.
- `effectiveFrom` / `effectiveTo` bound applicability in time, so a version that is
  stored but not yet in force decides nothing.
- `sourceRef` names where the text came from. **The engine never reads the text.**

### Rule status, the operative fact

| `ruleStatus` | Meaning in the engine |
|---|---|
| `ACTIVE` | In force. It decides. |
| `SUSPENDED` | Not in force. It decides nothing, and its absence does not imply permission. |
| `PARTIALLY_SUSPENDED` | Parts are in force; the engine will not guess which, so it escalates. |
| `JURISDICTION_OVERRIDE` | A national rule displaces this one. The reason names both ids. |
| `PENDING_IMPLEMENTATION` | Not yet in force (`effectiveFrom` in the future). |
| `UNDER_LEGAL_REVIEW` | Operative status contested. The engine refuses to decide. |
| `UNKNOWN` | Not encoded. The engine refuses to decide. |

`textStatus` is separate and purely descriptive. A rule whose text is known
verbatim but whose enforcement is enjoined is `textStatus: 'PUBLISHED'` with
`ruleStatus: 'UNDER_LEGAL_REVIEW'`, and the engine treats it as undecided.

## What is encoded today

| Version | Regulator | Scope | Notes |
|---|---|---|---|
| `jp-fifa-2025-1` | FIFA | `INT` | The FFAR baseline. 12(8)–(10) are `UNDER_LEGAL_REVIEW` and carry `overrides` to the England rules; 19 is `SUSPENDED`; the minor-timing formula is deliberately left unresolved. |
| `jp-eng-2026-27-1` | FA | `ENG` | England 2026/27. Multiple representation (6.3) `ACTIVE` with consent, particulars and a legal-advice offer; acting for the individual and the releasing entity (6.4) prohibited; connected agents counted as one (6.5); 7.13 `PARTIALLY_SUSPENDED`. |
| `jp-usa-2024-1` | USSF | `USA` | Licence plus a domestic authorisation (background check). Multiple representation and minors are `UNKNOWN` — honestly not encoded. |
| `FIFA-RSTP-2027` | FIFA | `INT` | `PENDING_IMPLEMENTATION`, `effectiveFrom` 2027-01-01. |

Anything else is **unsupported**, which is a real answer: `JURISDICTION_UNSUPPORTED`
(422) or a `POLICY_NOT_ENCODED` reason into attributed review. Nothing is assumed
permitted because ScoutBox has not encoded it.

## How a policy set is chosen

`applicablePolicySet(rows, memberAssociations, now)` always includes `INT` and adds
each named national association. Multiple overlays are normal: an England transfer
reads FIFA and FA together. `selectPolicyVersion` picks, per jurisdiction, the
published version whose effective window contains `now`, preferring the highest
`policyVersion`. Missing jurisdictions come back in `missing` rather than being
silently dropped.

When national and international rules both reach a question, the engine reports
`SCOPE_MIXED` or, where the FIFA rule carries `overrides`, `NATIONAL_RULE_APPLIES`
with both rule ids — never a silent pick.

## The structured decision

`evaluatePolicy(...)` returns a decision object, never a boolean:

```
{ allowed, blocked, requiresConsent, requiresGuardian, requiresMinorAccreditation,
  requiresNationalRegistration, requiresDomesticAuthorisation, requiresManualReview,
  reasons: [{ code, ruleId, ruleStatus, regulator, jurisdiction, policyVersion }],
  policyVersions, ruleIds, ruleStatuses, facetGaps }
```

Callers read fields; they never re-derive them. Every reason carries the rule id,
that rule's operative status and the version it came from, so a refusal shown to
an agent can be traced to an encoded fact.

## Publication

`POST /ts/compliance/policies` proposes a version (administrator only, rate-limited
to 10/day). `POST /ts/compliance/policies/:id/approve` publishes it, and refuses
the proposer (`POLICY_DUAL_CONTROL_REQUIRED`). Publication **never re-verdicts** an
existing evaluation: every open context whose last evaluation predates the new
version is flagged `reEvaluationPending`, the agent's screen shows
"re-evaluation needed", and the new verdict exists only once someone asks for it.
Historical evaluation rows keep the versions they were decided under, which
`m23AgentComplianceE2E` §80 asserts row by row.

Consents are versioned too: a consent that names only a superseded version is
insufficient (`CONSENT_POLICY_VERSION_STALE`), so a policy change re-opens the
question rather than quietly carrying an old answer forward.

## Verification

- `m23AgentComplianceE2E` groups C/D/E/F and the C14–C26 publication sequence:
  version selection, effective windows, overrides, mixed scope, dual control,
  re-evaluation flagging, historical rows, and the stale-consent consequence.
- `m23AgentCompliancePersistence` §1/§2: the three versions are seeded as published
  rows attributed to migration 2306, idempotently, with no reviewer invented; §5:
  an emptied policy store makes every jurisdiction unsupported rather than clear.
