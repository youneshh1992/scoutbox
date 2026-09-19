# M23 P5.6E — the defect register

Thirteen defects were found during this milestone. Ten were in P5.6E's own new
code; three were pre-existing gaps the new suites reached. Every one is fixed at
the root, with a regression that would catch it again.

Four of them were caught by **pre-existing P5.6C/P5.6D assertions rather than by
reading the code** — which is the argument for running the whole battery rather
than only the new suite.

**The repair pass (this document's last revision) added two: E-15 and E-16.** It
also replaced the first of the two "accepted behaviours" with the record of a fix
that was written, tested and then rejected on evidence — see A1 below, which is
now a decision with a reason rather than a deferral.

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

## E-15 — a green suite that never exited, and held five ports for ever

**Severity: high (reliability / CI). Found by: the repair pass's own contention
battery, §3.**

`e2e/m23AgentIntegrationLive.test.mjs` printed

```
M23 P5.6E integration live: 98 checks passed …
all M23 P5.6E live journeys passed
```

and then **hung for ever**. The file ends after those two lines. Its teardown is
registered as `process.on('exit', cleanup)` — and that hook cannot fire, because
the spawned backend, the Chromium instance and the four static file servers all
keep the event loop alive, so node never reaches `exit`.

The consequences were not theoretical; all three were observed:

1. The process held `:4040`, `:8740`, `:8840`, `:9040` and `:9140` indefinitely.
2. **Two whole iterations of the four-suite contention battery could not run that
   suite at all** — each died in its own port preflight with "port 4040 is already
   in use", pointing at a stale process that was in fact the *previous run of
   itself*, still alive 13 minutes after reporting success.
3. The run that produced the green summary never recorded an exit line, so the
   battery's own status file silently listed three suites instead of four.

In CI this is a job that hangs until its timeout after the tests have passed.

**Root cause fix.** Exit explicitly, which is what the three sibling agent live
suites already do and what this one was missing:

```js
await browser.close();
process.exit(0);
```

`process.exit` runs the `exit` handler, so the backend is killed, the statics are
closed and the data directory is removed — the cleanup that was written all along
and could never be reached.

**This defect class was already known, and documented, in this repository.** The
comment at the end of `e2e/m23Live.test.mjs` says so in as many words:

> "…handles, so without this the process prints its summary and then hangs
> forever — success to a human reading the tail, a timeout to a harness. This is
> the m22E2E D1 defect, and **every other Live suite ends the same way**."

Every other live suite does. `m23AgentIntegrationLive` was the one that did not —
which makes this an omission against a stated convention, not a novel discovery.
All the sibling endings were checked one by one after the fix, and every one of
them closes the browser and exits.

**Verification:** two consecutive runs under CPU starvation, each **98 checks, 0
failures, exit 0, 54 s**, with all five ports confirmed free afterwards.

**Why no new test:** the regression is the exit code itself. A suite that does not
exit now fails its own battery line, and the four-suite concurrent battery is the
standing check — it is what found this.

---

## E-16 — two writes that reach a person, with no quota

**Severity: medium (abuse / DoS). Found by: the repair pass's §25 performance and
denial-of-service review.**

Neither write P5.6E adds carried a rate-limit policy. Every comparable write in
the codebase does — `contact_send`, `trial_invite`, `decision_finalize`,
`transaction_write`, `agent_representation_request` are five of the 48 — and these
two were simply not added to the catalogue.

Both **end in a notification to a person**, and both can be **repeated after being
taken back**:

- `POST /org/agent/clients/:id/opportunities/:oppId/share` notifies the client.
  `MAX_OPPORTUNITY_SHARES = 200` bounds how many rows one relationship keeps; it
  bounds neither the rate nor the number of relationships.
- `POST /org/rooms/:id/transaction-handoff` notifies **the player and the agent**,
  two notifications and one `persistNow()` per call — and `handoffBlockers` only
  refuses when an existing handoff is `invited` or `accepted`. A **withdrawn** one
  does not block, deliberately, so that a club can re-invite after taking its own
  invitation back. That makes invite → withdraw → invite an unbounded loop.

Measured before the fix: 15 invite/withdraw cycles ran without any refusal, and
nothing in the code would have stopped the 10,000th.

**Root cause fix.** The platform's own M18.1 provider — already present in this
module's context and simply never used — not a second mechanism:

```
opportunity_share    60/h, scope: actor
transaction_handoff  30/h, scope: org
```

Two deliberate choices in where the charge sits:

- **After authorization**, so a refused caller cannot spend the budget of the club
  or the agent it is impersonating, and so a 429 never becomes a softer, more
  informative answer than the real refusal.
- **Both halves of each loop draw on one budget.** Withdrawing is charged as well
  as sharing and inviting, because the loop — not the single act — is what the
  quota exists to close. For sharing the charge is also placed *before* the
  opportunity board is searched, exactly as `agent_representation_request` is
  charged before the player lookup: the uniform 404 hides which answer a probe
  got, not how many times it asked.

**Regression:** new group **AV** in `m23AgentIntegrationE2E` (12 checks) —

| Check | What it pins |
| --- | --- |
| AV1 / AV1b | both writes named in the one policy catalogue, at the right scope |
| AV2 / AV2b / AV2c | a share burst really reaches 429, with the platform's own `RATE_LIMITED` body naming the action and naming no person |
| AV3 / AV3b | the invite → withdraw → invite loop reaches 429 within the named policy |
| AV3b2 | with the budget gone, **the other half is refused too** — so withdrawing is charged, not free |
| AV4 / AV5 | a scout still gets `403 HANDOFF_NOT_PERMITTED` and a foreign club still gets the case's own `404`: an exhausted quota is neither an authorization nor an existence oracle |

---

## Accepted behaviours, recorded rather than changed

Two things the new suite examined and deliberately did **not** change. Recording
them is part of the audit: a register that lists only what was fixed does not say
what was weighed.

### A1 — an agency org reaches club **list** surfaces, scoped to itself

**A fix for this was written, tested, and rejected on the evidence. That is the
disposition, not a deferral.**

`GET /org/second-look`, `GET /org/watchlists` and seven other list surfaces are
`orgRouter` routes and an agency organisation is an `org`, so an agency session is
answered — about **itself**, which is empty. No other org's case, player or club
appears. The club's own case, decision and contact thread are shut outright (404).

**What was attempted.** `scoutbox-server/m27/orgKind.mjs`: a fail-closed
middleware with a 16-prefix allowlist of the paths an agency org may reach
(`agent`, `notifications`, `compliance`, `verification`, `sessions`, `mfa`, `sso`,
`api-keys`, `security`, `staff`, `invites`, `audit`, `support`, `onboarding`,
`report`, `notification-preferences`), refusing everything else with
`403 ORG_KIND_NOT_PERMITTED`, mounted as `app.use('/org', orgAuth, orgKindGate,
orgRouter)`.

It passed all four agent-lane live suites. It then **broke six frozen suites**:

| Suite | What broke |
| --- | --- |
| `m23TrialE2E` | **W3: "an agency may invite an adult (the wall is about minors)"** — plus a hard error in `reviewed()` |
| `m23ContactE2E` | R6, R6b |
| `m23DecisionE2E` | W4 (the agency probes) |
| `m17E2E` | "an agency has no rooms of its own to see" |
| `m18E2E` | [34] |
| `m19E2E` | A27 — `nia`, an `org-northstar` agency user, creates watchlists |

**Why that settles it.** Those assertions are not accidents of a shared router.
An agency running club tooling *on adults, inside its own org* is deliberate,
tested, frozen P4B/M19 product shape. A gate that refuses it is not a repair; it
is a silent product change that breaks explicit contracts, which the repair
mandate forbids. The gate was reverted in full — `m27/orgKind.mjs` deleted, the
mount restored — and all six suites re-verified green.

**What was done instead**, taking the mandate's own stated alternative: prove the
behaviour safe rather than leave it as an ambiguity. New group **AU** in
`m23AgentIntegrationE2E` asserts directly that

- **nine** club list surfaces (`/org/rooms`, `/org/second-look`,
  `/org/nobody-missed`, `/org/watchlists`, `/org/recruitment-briefs`,
  `/org/assessments`, `/org/shortlist`, `/org/analytics/overview`,
  `/org/transactions`) contain none of `case-`, `pl-adeyemi`, `Kola`,
  `org-eastport`, `Eastport` or `Maria Keane`, and answer stably;
- **five** named club resources (`rooms/:id`, `/decision`, `/journey`,
  `/contacts`, `/trials`) are refused **byte-identically** to
  `case-never-existed`, so the router is no existence oracle;
- an agency cannot open a case on the minor `pl-guni` — the safeguarding wall is
  in the player projection, where it belongs, not in the router;
- `total === items.length` on every list, so a count cannot report what a
  projection withheld.

The residual observation is therefore not "an agency might see a club's data" —
that is now asserted false in fifteen places — but "an agency org has club tooling
it has no use for", which is a product-shape question for a product milestone.

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
