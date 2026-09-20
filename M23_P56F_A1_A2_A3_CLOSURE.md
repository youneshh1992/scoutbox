# M23 P5.6F — A1, A2 and A3 (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

Three observations carried from P5.6E, closed three different ways because they
are three different kinds of thing.

---

## A1 — an agency organisation reaches generic `/org` list infrastructure

**Classification: intentionally generic org infrastructure (A) plus shared
infrastructure with role-specific behaviour (D). Not a data leak.**

### The finding, stated accurately

`/org` is one Express router, and an agency **is** an org. So an agency session
reaches club *list* surfaces and is answered — about itself, which is empty.

### Why a blanket gate is the wrong answer

P5.6E built one (a fail-closed org-kind allowlist), and it broke six frozen
suites — decisively `m23TrialE2E` W3, *"an agency may invite an adult (the wall is
about minors)"*. An agency running club tooling on adults inside its own org is
deliberate, tested, frozen P4B/M19 product shape. §8 of this mandate says not to
repeat that gate unless new evidence proves the architecture changed. It has not:
`m23TrialE2E` is green at this tip with its W3 case intact.

### The classification, measured at this tip

| Category | Surfaces | Evidence |
| --- | --- | --- |
| **A — generic org infrastructure** | `/org/notifications`, `/org/staff`, `/org/audit` | answered (200), and each returns the agency's OWN rows. An agency has staff, notifications and an audit trail; these are organisation features, not club features. |
| **B — club-only domain surface** | `/org/rooms/:id` and its `/decision`, `/contacts`, `/trials` | **refused by concealment.** A club opened a real case; the club reads it 200 with full content; an agency asking for that same real id gets **byte-identical** bytes to `case-never-existed` — 404 `ROOM_NOT_FOUND` — on all four routes. |
| **C — agency-only domain surface** | everything under `/org/agent/*` | refused to a club session: five routes, all 403 (hardening group T). |
| **D — shared infrastructure, role-specific behaviour** | `/org/rooms`, `/org/second-look`, `/org/watchlists`, `/org/recruitment-briefs`, `/org/assessments`, `/org/shortlist`, `/org/transactions` | answered, scoped to the caller's own org, which for an agency is **empty**. |

### What category D actually returns — the part worth measuring

`/org/rooms` returns 1,452 bytes to an agency, which looks alarming until you
read them. They are:

```
{"items":[],"total":0,"limit":50,"offset":0,
 "funnel":{"total":0,"active":0,...every count 0...},
 "statuses":[...the product's own status vocabulary...]}
```

**Schema and zero counts, not data.** Twelve `/org` surfaces were probed with an
agency token and grep'd for another org's identifiers (`org-eastport`,
`org-harbour`, `Maria Keane`, `Rita Vale`): **zero foreign references on all
twelve.** `total` is 0 and `items` is empty, so there is no count leak and no
pagination leak.

A note on that vocabulary: the funnel dictionary contains the strings
`offer_made`, `offer_accepted`, `offer_declined`. Those are the **pre-existing
club-side M23 P4/P5 lifecycle**, not an Agent writer, and §15 is explicit that
pre-existing non-Agent occurrences are not a P5.6F violation. Checking this
mattered — it is exactly the kind of grep hit that could be misfiled as a breach
of the Offer prohibition.

### What was NOT tested, and why

No timing-channel test. On a single-process in-memory store, the time to filter
an empty list is not a measurement anyone could act on; a test for it would be
measuring this machine.

**Closed as:** a product-shape question, not a data leak. The residual statement
is "an agency organisation has club tooling it has no use for", which belongs to a
product milestone.

---

## A2 — a transaction DRAFT may name an adult who is not yet a client

**Classification: an architectural property of a frozen contract, re-proved
rather than changed.**

P5.6D's frozen model separates **naming** a party from **representing** one:
`resolveParty` admits any adult, visible, unblocked player, while the separate
`POST …/representations` binding requires the agent's own active agreement with
that exact client.

### Re-proved at this tip

Naming an adult non-client grants **none** of:

| Grants? | What |
| --- | --- |
| no | private player read |
| no | Passport read |
| no | Trust beyond the public/shared projection |
| no | Contact authority |
| no | Inbox authority |
| no | Trial access |
| no | transaction progression |
| no | consent authority |
| no | document access |
| no | representation authority |
| no | regulated agent authority |
| no | notification access beyond the one factual "you have been named" |

And the mitigations that bound it: adults only, visibility honoured, blocks
honoured, rate limited, no PII about the named person disclosed to the agent,
confirming agrees to nothing, and nothing advances without a representation
binding. `m23AgentTransactionE2E` (404 checks / 215 negative) and
`m23AgentIntegrationE2E` (535 / 281) are both green at this tip and carry these.

### Why it was not narrowed

Narrowing it means changing P5.6D's frozen party model and breaking its own AD5
assertion. §29 forbids altering valid frozen semantics to satisfy a stale test,
and the converse holds: do not change a frozen contract to satisfy a preference.

**Closed as:** accepted, with the mitigations re-proved. This is the one item
accepted rather than repaired, and the release-readiness checklist says so.

---

## A3 — the Grassroots journey had never been observed

**Classification: a real gap in evidence. Closed by observation.**

`e2e/m23AgentGrassrootsLive.test.mjs` — **48 checks, 27 negative (56%)** — drives
the real Grassroots app and the real player app in Chromium against a live
server.

**PRESENT.** A grassroots club is a club: it signs in on its own platform with a
real session token, the workspace renders, its player list answers.

**ABSENT.** And it is not an agency:

- seven agency terms (*My Clients*, *Agency*, *Licensed agent*, *Representation
  agreement*, *Mandate*, *Conflict of interest*, *Compliance*) appear nowhere in
  the navigation, and four nowhere in the rendered shell;
- five agent-lane routes are refused **403** to a grassroots session — hiding a
  control is not a boundary, this is;
- the grassroots player projection carries **no agent field at all**;
- the club chooser offers no agency: an agency has no account on this platform.

**And the safeguards, measured rather than asserted.** No date of birth in the
player list. The 50km radius still operating — proved by **comparison**: the
grassroots club sees **2** of the **14** players a professional club sees, its
list is a strict subset, and reaching for each of six withheld ids directly
returns **403, identically** — so the radius is a boundary, not a list filter,
and not an existence oracle either. A grassroots session cannot open an agent
mandate on a minor (403).

**Responsive** at 1440, 1280, 1024, 768, 390 and 360, where each width asserts
the page still *has* its content as well as not overflowing, and **zero page
errors** in either client.

**Closed as:** observed. The sentence "confidence came partly from shared code
and inference" is no longer true of the Grassroots side.

---

## One thing this document should also say

The frozen P5.6E integration suite contains this line:

```js
} else neg(true, 'N1 (the grassroots app has no seeded club for this fixture; …)');
```

`neg(true, …)` is an **unconditional pass** that counts toward that suite's
negative total. §7 of this mandate forbids exactly this shape. It is recorded in
the defect register (F-9) rather than imitated here, and rather than rewritten
inside a frozen suite — the new Grassroots suite supersedes it by doing the work
properly.
