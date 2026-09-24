# M23 P8 — Journey authorization matrix

Who may read which journey projection, and who may take which next action
(§46–§51). Every read is scoped to the case AND the org (or the recipient);
a foreign real id and a fabricated id answer identically.

## 1. Reads

| Reader | Route | Viewer kind | Sees | Does not see |
| --- | --- | --- | --- | --- |
| club staff (any room role, incl. viewer) | `GET /org/rooms/:id/journey` | `org_staff` / `grassroots_staff` | the full club projection: stage, completed stages, resources, next action (with `permitted` for THEIR role), classification, timeline with colleagues' names | another org's case (404, same body as a fabricated id); a restricted room outside their role (403 `ROOM_RESTRICTED`) |
| player (adult, own record) | `GET /player/journeys` | `player_self` | per club that reached them: `shared[]`, player stage word, their next act, their request / trial / Offer / package ids, the milestones they were party to | a case id, a lifecycle word (other than signed), priority, decisions, assessments, drafts, Contact record ids, colleagues' names, a club that shared nothing |
| minor (own device) | same | `player_self` | only what was routed to them directly (a minor's records go to the guardian) | Offers and signings (the pathways are closed) |
| guardian | `GET /guardian/children/:id/journeys` | `guardian` | the child's journeys as above, for the records addressed to this guardian | another player (404 `CHILD_NOT_FOUND`); club internals |
| agent with a basis | `GET /org/agent/clients/:rel/journey` | `agent` (`authorized: true`, `grants[]`) | per club that shared something: player-vocabulary stage, resource ids of the granted kinds, timeline filtered to `agent`; `grants` = `contacts` (client_private), `trials` (the client's disclosure), `offers` + `signings` (employment/transfer scope AND current licence), each over records the client shared or the routing named the agent on | the club's decisions, assessments, priority, drafts, case ids, digests, notes; a club that shared nothing |
| same-agency colleague | same | — | nothing: 404 `REPRESENTATION_NOT_FOUND` (not their agreement) | |
| agency admin (summary row) | same | — | nothing: 403 `AGENT_ACTION_NOT_PERMITTED` or 404 (no summary opens a journey) | |
| assistant / analyst | same | — | only through the frozen P5.6 delegation: their own agreement or nothing | |
| agent after termination / lapsed licence / scope loss | same | — | 403 from the policy engine or `SCOPE_INSUFFICIENT` / `LICENCE_NOT_CURRENT`; re-derived on every read | |
| Trust & Safety | in-process only (`trust_safety`, `authorized: true` required) | | the club projection for moderation | no HTTP route exposes it |
| unknown viewer word | — | — | `JOURNEY_VIEWER_UNKNOWN` (fails closed); a `?viewer=` query is ignored | |

## 2. Next-action permission (club)

`nextAction.permitted` follows the room-role ladder viewer < contributor <
room_lead < recruitment_admin (`roomRole`, M17) — the lifecycle action's own
`roles` where the act is one, else the domain's minimum role:

| Act | Minimum role | The route that re-checks |
| --- | --- | --- |
| REVIEW_PLAYER, CONTINUE_EVALUATION (shortlist) | contributor | `POST /rooms/:id/lifecycle` |
| DECIDE_APPROACH (plan contact), RESUME_CASE, REVIEW_DECLINED_OFFER | room_lead | lifecycle |
| SEND_CONTACT | room_lead (`contact_write`) | Contact routes |
| CONDUCT_TRIAL, COMPLETE_TRIAL | room_lead (`trial_write`) | Trial routes |
| COMPLETE_ASSESSMENT | contributor | assessment routes |
| RECORD_DECISION | room_lead | decision routes |
| PREPARE_OFFER, ISSUE_OFFER, REVISE_OR_WITHDRAW_OFFER | room_lead | Offer routes |
| START_SIGNING, PRESENT_SIGNING | room_lead | signing routes |
| SIGN_FOR_CLUB, COMPLETE_SIGNING | recruitment lead (`isLead`) | signing routes |
| awaits, RECRUITMENT_COMPLETE, CASE_ENDED | — | — |

`permitted` is advice for the interface; **the domain route is the authority**
and re-derives the role from the session on every request. A person whose
role changed (§50) sees the control withdrawn on the next read (focus,
visibility, server event, or after any act); a click that lands before then
meets the route's 403 and the Room says "This recruitment has changed. We
refreshed the latest status." The legacy status route now applies the same
role rule as the semantic action for every state an action names.

## 3. Tenant and case isolation (§51, §52)

| Attempt | Answer |
| --- | --- |
| another club's case id on any room route | 404, the same body as a fabricated id |
| case A's route with Contact / Trial / Offer / package B | 404 (`…_NOT_FOUND`); `POST /rooms/A/link {trialId: B}` refused; the journey's `foreign` check names `PLAYER_MISMATCH` / `CLUB_MISMATCH` on any record that points at case A with another player or org |
| a package of another case proving `signed` | refused: `signingSupports` requires `pkg.caseId === kase.id` |
| a player's journey for a case nothing was shared from | `CASE_NOT_FOUND` inside the projector, so the club's interest is never disclosed |

## 4. Minors (§48)

No new pathway: the Offer and signing minor pathways stay closed in every
jurisdiction (`MINOR_OFFER_PATHWAY_ENABLED`, `MINOR_SIGNING_PATHWAY_ENABLED`);
the player projection for a minor's own device carries only records routed to
them (none of the Offer / signing kind can exist); the guardian projection
carries what was addressed to the guardian; the agent projection cannot name
a minor because no agency may represent one. The journey routes add no minor
discovery: a club sees its own case, which it could open only under the
verified-club rule.

## 5. Proof

`m23RecruitmentJourneyE2E` C6–C12, F1–F8, H1–H5; `m23RecruitmentJourneyLive`
C (role loss), D3 (foreign room), G (agent, same-agency colleague, ended
representation).
