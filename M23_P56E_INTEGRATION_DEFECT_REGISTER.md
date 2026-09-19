# M23 P5.6E — the defect register

Eleven defects were found during this milestone. Nine were in P5.6E's own new
code; two were pre-existing gaps the new suite reached. Every one is fixed at the
root, with a regression that would catch it again.

Four of them were caught by **pre-existing P5.6C/P5.6D assertions rather than by
reading the code** — which is the argument for running the whole battery rather
than only the new suite.

---

## E-4 — a routing snapshot that recorded no agent

**Severity: high. Found by: the new suite's own group B/H.**

`agentClientBasis` returned the agreement's scope, agency and status but **not
`agentUserId`**. Every contact routing snapshot therefore recorded
`agent: { agentUserId: null }`, the agent-side filter on
`GET /org/agent/clients/:id/contacts` matched nothing, and **no agent was ever
notified of a contact routed to them**. The feature looked like it worked from the
club's side and did nothing on the agent's.

**Root cause fix.** `agentClientBasis` now returns the individual it authorises.
Beside it, `contactRouting` fails closed:

```js
const agentUserId = agentDecision.basis?.agentUserId ?? null;
if (typeof agentUserId !== 'string' || !agentUserId) {
  return { ok: true, mode: 'player_only', targets: [recipient], agent: null,
           agentRefusal: 'NO_REPRESENTATION' };
}
```

A basis that names nobody routes nobody, rather than writing a record that claims
an agent with no agent in it.

**Regression:** B-p2 (the basis names the individual), H-p7 (a nameless basis
routes no agent).

---

## E-5 — an idempotency upgrade that would have created a second draft

**Severity: medium. Found by: `m23ContactPersistence` (pre-existing).**

Adding `contactMode` to the contact create fingerprint changed the hash of every
key minted before P5.6E. A client replaying a pre-upgrade `clientKey` would have
been treated as sending something new and would have created a **second draft**.

**Root cause fix.** The route accepts a legacy fingerprint — the pre-P5.6E shape —
when the stored record's own mode agrees with the request's. A replay is a replay
across the upgrade; a genuinely different mode is still a conflict.

**Regression:** `m23ContactPersistence`'s existing replay assertions, which now
cross the version boundary.

---

## E-6 — a case id projected to everyone

**Severity: high (cross-party privacy). Found by: P5.6D's own R1 privacy sweep.**

`transaction.links.recruitmentCaseId` was projected to every viewer of a
transaction. The **player**, **Trust & Safety** and a **releasing club** would each
have learned the engaging club's internal recruitment case id — a club-private
reference none of them is party to.

**Root cause fix.** Scoped to the representing agent and to the club that is both
the engaging party and the owner of that case. Everyone else sees the key
**absent**, not redacted, so its existence is not disclosed either.

**Regression:** R1–R4 in the new suite, four parties, one fact.

---

## E-7 — the first fix broke a module boundary

**Severity: medium (architecture). Found by: `m23AgentTransactionE2E` §3 (pre-existing).**

The first E-6 fix read `db.recruitmentCases` from inside `m26`, and P5.6D's own
suite asserts that the transaction module never touches the recruitment domain.

**Root cause fix.** The question moved to the seam:
`integration.caseBelongsTo(caseId, orgId)`. `m26` asks; `m27` answers; no seam
registered → `false`, so the reference fails closed in a build without the
integration layer.

**Regression:** `m23AgentTransactionE2E` §3, unchanged and still green.

---

## E-8 — the club presence badge leaked the agent's jurisdictions

**Severity: high (privacy). Found by: the new suite's own E-p3.**

`clubAgentPresence` projected the nested per-jurisdiction facet map whole. A club
looking at one player would have learned **which member associations the agent is
registered in** — a fact about the agent's business, not about this player.

**Root cause fix.** `stateWord()` + `flatFacets(states, jurisdiction)` flatten to
the single jurisdiction being asked about, and a facet ScoutBox has not checked
reads `unknown` rather than being omitted (an omission would read as "fine").

**Regression:** E-p3 (facet by facet), E-p6 (the projection is exactly six
fields).

---

## E-9 — an opportunity share list that outlived the mandate

**Severity: medium (privacy). Found by: the new suite's own AR5.**

`GET /org/agent/clients/:id/opportunities/shares` checked only that the agreement
was **this agent's**, not that it was **active**. An agent kept reading what they
had shared with a client whose mandate had ended, while the other two
client-scoped reads correctly closed.

**Root cause fix.** The route now takes the same `client_private` decision the
other two take. `client_private` and not `opportunity_share`: this is a read of
the relationship, not the regulated act of making a suggestion.

**Regression:** AR5 (`shares`), asserted alongside `trials` and `contacts` so the
three cannot drift apart again.

---

## E-10 — a malformed disclosure answered 500

**Severity: medium. Found by: the new suite's own AD2.**

`REPRESENTATION_INPUT_INVALID` was not declared in `m24/errors.mjs`. The
catalogue has no default branch by design, so an undeclared code answers **500
about our own state** for what is a plain 400 about the caller's request.

**Root cause fix.** Declared as 400, with a comment saying why it exists.

**Regression:** AD2, plus the HY4 sweep (no refusal anywhere in the suite is a
5xx).

---

## E-11 — a truthy string silently turned a privacy choice OFF

**Severity: high (a person's intention inverted). Found by: the new suite's own #32c.**

The disclosure writer read `body.disclosure[k] === true` and coerced everything
else to `false`. A client sending `'yes'`, or `1`, from a mistyped integration or
an older client, would have had a choice they were trying to turn **on** silently
turned **off** — and the response would have looked like success.

**Root cause fix.** A key present with a non-boolean value refuses the **whole**
request:

> "Each disclosure is true or false. Send the choice as a boolean; nothing is
> assumed from another kind of value."

A privacy setting is the last place to guess at an intention.

**Regression:** #32b (refused, not coerced), #32c (not one of the three choices
moved — including the one field that **was** a valid boolean).

---

## E-12 — a lapsed licence answered 500 from the transaction lane

**Severity: medium. Pre-existing in P5.6D. Found by: the new suite's own #12.**

`m26` calls `compliance.facetGateProblem`, which can return any of P5.6C's five
objective licence refusals. Only `AGENT_VERIFICATION_REQUIRED` was declared in
`m26/errors.mjs`, so an agent whose FIFA licence went **inactive** got a 500
instead of a named 403 when they tried to open a transaction.

**Root cause fix.** All five declared as 403:
`AGENT_LICENCE_INACTIVE`, `AGENT_VERIFICATION_STALE`,
`AGENT_NATIONAL_REGISTRATION_REQUIRED`, `AGENT_DOMESTIC_AUTHORISATION_REQUIRED`,
`AGENT_MINOR_AUTHORISATION_REQUIRED`.

**Regression:** #12 asserts the exact code and status, so a future refusal added
to the policy layer without a catalogue entry fails loudly.

---

## E-13 — `CONTACT_MODE_INVALID` undeclared

**Severity: low. Found by: `m23ContactE2E`'s E8 rule (pre-existing).**

The same class as E-10, in the Contact catalogue: a new code with no entry
answered 500. Declared as 400.

**Regression:** `m23ContactE2E` E8 requires every non-internal `CONTACT_` code to
be provoked over HTTP, so the rule that caught it stays in force.

---

## E-14 — a stale P4A assertion about mandatory notification categories

**Severity: low (a red suite in the battery). Pre-existing since P5.6C.**

`m23P4AClosureE2E` C0e pinned `security_account` as the **only** mandatory
notification category. P5.6C added `compliance` as a second one — correctly, since
muting a regulatory obligation is not a preference — and the P4A assertion was
never updated. **Verified failing before this milestone's work** by stashing every
P5.6E change and re-running.

**Fix.** Re-pinned as the exact set of two, with the reasoning inline, so the next
milestone that wants a third has to come and change that line.

---

## Accepted behaviours, recorded rather than changed

Two things the new suite examined and deliberately did **not** change. Recording
them is part of the audit: a register that lists only what was fixed does not say
what was weighed.

### A1 — an agency org reaches club **list** surfaces, scoped to itself

`GET /org/second-look` and `GET /org/watchlists` are `orgRouter` routes and an
agency organisation is an `org`, so an agency session is answered — about
**itself**, which is empty. No other org's case, player or club appears
(#18, #20 assert exactly that with a content sweep). The club's own case, decision
and contact thread are shut outright (404).

Whether an agency should have club scouting tooling at all is a product-shape
question that predates P5.6E and would mean introducing an org-kind gate across
the whole `/org` router. That is a foundational change, and §106 says P5.6E is an
integration milestone. Recorded here as a shape observation, not a privacy defect.

### A2 — a transaction draft may name an adult who is not yet a client

P5.6D's frozen contract separates **naming** a party from **representing** one:
`resolveParty` admits any adult, visible, unblocked player, and the separate
`POST …/representations` binding requires the agent's own active agreement with
that exact client (its E1–E4 assert this hard). Creating a draft notifies the named
individual to confirm their participation.

So a licensed agent can send one factual "you have been named; confirm or ignore"
notification to an adult they do not represent. The mitigations that exist: adults
only, visibility rules, blocks honoured, rate limited, no data about the player
disclosed to the agent, confirming agrees to nothing, and **nothing advances**
without a representation binding — asserted freshly by #25b, #25c and #25d.

Narrowing it would mean changing P5.6D's frozen party model and breaking its own
AD5 assertion. It is therefore stated as a known property of the frozen contract
and a candidate for a future milestone, not quietly altered here.
