# M23 P5.6E — the Trial projection contract

An agent may read their client's trial **schedule**. They may not run it, and they
may not read what the club thought of it.

## 1. One viewer added to one projection

`m23/trial.mjs` already had `scheduleView(t, viewer)`. P5.6E adds a third viewer
and nothing else:

```js
TRIAL_SCHEDULE_VIEWERS = ['club', 'family_accepted', 'agent'];
```

No new store, no new route on the Trial domain, no second Trial workflow. The
agent's route is a **read** in the agent lane that calls this projection:

```
GET /org/agent/clients/:id/trials     →  trialScheduleView(t, 'agent')
```

## 2. What the `agent` viewer gets

| Field | Agent | Why |
| --- | --- | --- |
| trial id, club id and name | yes | so a human can tell which trial this is |
| `workflowState` | yes | coordinating needs the state |
| session times, timezone | yes | coordinating needs the times |
| venue **name**, town | yes | enough to plan travel |
| venue **address** | **no** | held for the family since P4B (D-23) |
| joining `instructions` | **no** | the club's words to the family |
| `evidence[]` | **no** | there is no field for a Box Cam payload to arrive in |
| assessment, rating, report content | **no** | the club's opinion is the club's |
| `reportObligation` | yes, as a state | that a report is **owed** is a fact about process |

The last row is the distinction the whole document turns on: *whether* a report is
owed is a state an agent may hold a club to. *What it says* is a club's private
assessment of a person. The projection carries the first and has no field for the
second.

## 3. The gate

`trial_projection` is an unregulated surface that needs the client's
`trialVisibility` disclosure. Before the client turns it on, the route refuses:

```
403 DISCLOSURE_WITHHELD
"Your client has not chosen to share their trial schedule with you. That choice
 is theirs and they can change it at any time in My Agent."
```

The message says **whose** choice it was, without blaming anyone and without
quoting the client (K1, #33, #33b). Turning it off again closes the route on the
very next read (AR5) — nothing is cached from the moment of the grant.

## 4. No coordination, by construction

There is no route through which an agent confirms, reschedules, cancels, records
attendance at, or completes a trial. Not a refused route — **no route**:

```
POST /org/agent/clients/:id/trials/:tid/confirm   → 404 (nothing is there)
GET  /org/rooms/:id/trials/:tid                   → 404 with an agency session
```

Asserted by L3 and #15b, and in a real browser by D7, which sweeps the agent's
whole trial screen for a Confirm, Reschedule, Cancel or Record-attendance control
and finds none.

`trial_coordination` is nevertheless a **declared surface** in the decision layer.
That is deliberate: the answer to "may an agent confirm a trial for their client?"
should be a decision the system can state and a test can assert, rather than a
silence. The decision is recorded; the route does not exist.

## 5. What the family and the club keep

The family keeps the address, the instructions, the choice of slot and the
acceptance. The club keeps the assessment, the report's content, the evidence
links and the internal notes. The agent's arrival changes neither side: the family
route is still the family's (H-p6: no agent is ever substituted for a guardian),
and the club's own trial detail is unreachable with an agency session.

## 6. The sweep

L1 serialises the entire agent payload, strips the sentences whose job is to deny
something, and asserts that no `assessment`, `report`, `scorecard`, `boxCam`,
`address` or `instructions` appears anywhere in it. M1 asserts the same of a
single session object, field by field. D3–D5 repeat all of it through a real
browser, in English and then in French — because a translation is a second place
for a leak to hide (N6c).
