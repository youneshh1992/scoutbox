# M23 P8 — Journey timeline privacy matrix

Which audience may see each timeline event (§14, §15). The table is the
code: `TIMELINE_VISIBILITY` in `scoutbox-server/m23/journeyModel.mjs`, applied
by `timelineVisibleTo(kind, audience)` in the player, guardian and agent
projections. The club sees every event on its own case. Every entry carries
ids, a status word and an instant; the club's entries also carry the acting
colleague's name. **No entry, for any audience, carries a note, a rationale,
a reason's text, a term, a digest, an assessment rating or a Trust Score** —
the derivations strip them (`offerTimelineEntry`, `signingTimelineEntry`,
`contactMilestone`, `decisionMilestone`) and the suites assert the sentinels
never appear.

Audiences: **Club** (org staff on their own case), **Player** (the adult
recipient), **Guardian** (the recipient for a minor), **Agent** (an
authorized agent, over the records the client shared or that were routed to
them), **T&S** (Trust & Safety, in-process, moderation), **Foreign club**
(another org: nothing, ever — the case does not exist for them).

| Event kind | Club | Player | Guardian | Agent | T&S | Foreign club | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| room_created | ✓ | — | — | — | ✓ | — | a club's own act |
| room_status_changed, room_reopened | ✓ | — | — | — | ✓ | — | the lifecycle word; never shown to a recipient (§16) |
| case_created, case_stage_changed | ✓ | — | — | — | — | — | M12 legacy |
| decision (advisory), decision_recorded, decision_superseded | ✓ | — | — | — | — | — | outcome word to the club only; rationale to nobody (§80) |
| trial_assessment_recorded | ✓ | — | — | — | — | — | that an assessment exists; never its content |
| transaction_handoff_invited / _withdrawn | ✓ | — | — | — | — | — | whether the player was represented, never who by |
| contact_initiated, contact_response_received | ✓ | ✓ | ✓ | ✓ (routed to them) | ✓ | — | the player/guardian entry carries no Contact record id, no colleague's name |
| trial_invited, trial_declined, trial_accepted | ✓ | ✓ | ✓ | ✓ (disclosed) | ✓ | — | |
| trial_schedule_proposed, trial_rescheduled, trial_schedule_confirmed, trial_schedule_declined | ✓ | ✓ | ✓ | ✓ (disclosed) | confirmed only | — | |
| trial_attendance_recorded | ✓ | ✓ | ✓ | — | — | — | the state word (attended / partial…), never a note |
| trial_cancelled, trial_completed | ✓ | ✓ | ✓ | ✓ | ✓ | — | |
| trial_evidence_linked | ✓ | — | — | — | — | — | evidence is club material |
| offer_draft_created | ✓ | — | — | — | — | — | a draft never reached anyone |
| offer_issued, offer_superseded, offer_withdrawn, offer_accepted, offer_declined, offer_expired | ✓ | ✓ | ✓ | ✓ (shared) | issued / withdrawn / answered | — | revision numbers, never terms |
| signing_created | ✓ | — | — | — | — | — | a DRAFT package never reached anyone |
| signing_ready, signing_completed, signing_cancelled, signing_voided | ✓ | ✓ | ✓ | ✓ (shared Offer) | ✓ | — | never a digest |
| signing_party_completed, signing_superseded | ✓ | ✓ | ✓ | ✓ (shared Offer) | — | — | the party TYPE, never the actor's name to a recipient |

Rules that sit above the table:

- A **Player**, **Guardian** or **Agent** entry never carries `by` (a
  colleague's name) — the projections strip it — nor a Contact record id.
- The **Agent** column applies only to events on records the client shared
  with that agent (`agentShare`), that were routed to that agent (the
  Contact's `routingSnapshot`), or that the client's disclosure opened
  (trials). Another club's events, a colleague's client, an agency admin's
  summary: nothing.
- The **T&S** column is moderation visibility for ids-only milestones; no
  HTTP route exposes it, and it never includes decisions or assessments.
- **Internal rejection deliberation** (a `reject` decision, its reason codes,
  its note) is Club only, always.
- A **Foreign club** never sees the case exist.

Proof: `m23RecruitmentJourneyE2E` A34 (the table's club-only kinds), B43–B44
(the player's timeline and sentinels), F4–F5 (the agent's), and the live
suite's P2 / G4 page sweeps.
