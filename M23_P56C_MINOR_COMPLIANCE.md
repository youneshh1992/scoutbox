# M23 P5.6C — minors

**No minor representation pathway is live in any jurisdiction.** That is the
operative fact of this document, and P5.6C does not change it. What P5.6C adds is
the *encoding* of what such a pathway would require, evaluated against **no
subject**, so that the platform's readiness can be inspected without a single minor
becoming discoverable.

## What stays prohibited

- **General discovery of minors by agents and agencies.** Under-18 players never
  appear in `/org/agent/players`, whatever an agent's accreditation. There is no
  global browse, no mass search, no bulk approach, and no route that takes a minor
  as a subject.
- **Naming a minor as a party.** A compliance context refuses it with the uniform
  `PARTY_NOT_FOUND` (404) — the same answer as a player who does not exist, a
  blocked player, or a player the agency cannot see. The refusal is deliberately
  indistinguishable, so it is not an age oracle.
- **A client-supplied date of birth or guardian flag.** Both are ignored. The
  server reads age from the player record and guardianship from its own store; the
  acceptance suite posts a forged `dob` and `guardianConsent: true` to prove they
  change nothing.

## The gate, and where it is closed

`MINOR_PATHWAY_PRODUCTION_ENABLED = { ENG: false, INT: false, USA: false }`. Every
jurisdiction is false. `evaluateMinorGate` computes what would be required —
guardian consent first, the agent's minors authorisation for that member
association, and the accreditation of the **individual** rather than the agency —
but its result is only ever reported as readiness. No route consumes it as a
permission, because no route accepts a minor subject at all.

England's timing rule is encoded (`ENG-5.1`, academic-year-16 with a 1 September
year start); FIFA's equivalent is deliberately left as a formula the engine cannot
resolve, and `timingEncoded` reports false for it rather than guessing a date.

## What the agent sees

The Compliance screen carries a "Minors" section that states, in the UI:

> No minor representation workflow is live in any jurisdiction, and general
> discovery of minors by agencies is prohibited. This shows only what the encoded
> rules would require of you.

Per member association it then shows: whether the pathway is enabled in production
(always "pathway not enabled"), the timing rule and its operative status, whether
the encoding is complete, whether the agent *would* be ready, and which facets are
missing. Readiness is computed against no subject: there is no player, no id and no
name anywhere in that projection.

An agent with every relevant facet verified still sees "pathway not enabled",
because their own readiness was never what was blocking.

## Blocks beat clearance

A safeguarding block ends the question before any rule is consulted. The
representation route checks visibility and blocks **before** it checks relationship
scope, so a blocked player cannot be distinguished from an unknown one by comparing
refusals. `m23AgentComplianceE2E` X6 asserts exactly that ordering, because an
earlier build leaked the difference through a scope error.

## Guardian-managed accounts

A guardian-managed (under-18) account has no agent consents at all: the list answers
`{ items: [], minor: true }` with a note, and the player app renders nothing. Any
attempt to answer a consent is `COMPLIANCE_ACTION_NOT_PERMITTED` (403). The same
holds for the P5.6B relationship lane.

## What would have to change before a pathway could open

Recorded here so the gap is explicit rather than implied:

1. A jurisdiction's minor rules encoded with `ACTIVE` status **and** a resolvable
   timing formula, published under dual control.
2. `MINOR_PATHWAY_PRODUCTION_ENABLED` flipped for that jurisdiction — a deliberate,
   reviewable change, not a configuration default.
3. A guardian-first approach flow: guardian consent before any contact, with the
   guardian's own authority verified.
4. Accreditation of the **individual** agent for minors in that member association,
   verified against a real register rather than a declaration.
5. A safeguarding review of the resulting surface, and an age-oracle audit of every
   refusal path the new routes introduce.

None of the five exists today. P5.6C encodes (1) partially, for England only, and
leaves (2)–(5) untouched.

## Verification

`m23AgentComplianceE2E` groups U/V/W and adversarial cases #19, #20: the timing
encoding, the closed pathway with and without the agent's authorisation, minors
invisible to the lookup whatever the accreditation, the uniform 404 for a minor
party (including when the party role is already filled, so neither fact leaks), the
forged dob and guardian flag, and the absence of any minor approach or
subject-evaluation route.
