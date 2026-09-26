# M23 P8.1 — Privacy hardening

The privacy sweep of the whole journey (§21, §22, §23, §24, §62–§64): who
may see what at every stage, through every surface — payloads, timelines,
events, notifications, documents, deep links, logs. Checks:
`m23RecruitmentJourneyHardeningE2E` groups L (same-agency), M (minors), Y
(privacy sweep); the P8 auth and timeline-privacy matrices stand.

## 1. Audiences and what each may see

| Audience | May see | May never see |
| --- | --- | --- |
| Club (own case, by room role) | everything on its own case: lifecycle, stages, resources, assessments, decisions, Offer terms and notes, package documents, the full timeline | another org's case, resource or existence (404 as fabricated); a player who blocked it (404); a minor it may not see (the wall) |
| Player (self, adult) | the Contacts, Trial invitations and Trials, Offers (terms, documents), packages (the presented document) that reached them; their journey line: club, a player stage word, their next action, their resource ids, the visible milestones; their contract status | the case id, any lifecycle word (except `signed`), priority, shortlist, watchlist, assessment, decision, rationale, Second Look, internal Offer notes, signing internal notes, a club member's name on a milestone, a Contact record id, an invoice |
| Guardian (of a minor) | the child's equivalents where the pathway is open (Contacts routed to them, Trials; Offers and signings stay closed while the minor pathways are closed) | everything the player may not, plus another child's records (404 `CHILD_NOT_FOUND`) |
| Authorized agent (live representation, verified, licence current, scope employment / transfer, client shared) | per club: a factual stage word, the Offer the client shared (as issued), the package over it (presented revision), the Trial with the `trials` grant, a Contact routed to them; the visible milestones | assessment, decision, rationale, priority, case id, digests, notes, other players, a club's other cases, a Contact not routed to them, an Offer not shared |
| Same-agency colleague / agency admin / analyst / assistant | a SUMMARY row only when the client chose to share it with the agency (status word); nothing of the journey, Offer, package, Contact, notifications or events | the journey (403 `AGENT_ACTION_NOT_PERMITTED` on a summary row; 404 on an unshared agreement), Offers, signings, documents, notification targets, deep links (hardening L1–L10) |
| Trust & Safety / admin | ids-only milestones for moderation; blocks; verification queues | rationale (no event carries it), terms, notes |
| Foreign club | nothing: a case, a resource or its existence is concealed (404 as fabricated) | everything |

## 2. Surfaces swept (Y group)

| Surface | Sweep |
| --- | --- |
| `GET /player/journeys`, `GET /guardian/children/:id/journeys` | no `case-` id, no lifecycle word but `signed`, no `priority` / `shortlist` / `watching` / `under_review`, no assessment text, no decision reason code or note, no `rct-` id, no digest, no term value, no club member's name |
| `GET /org/agent/clients/:id/journey` | the same, plus no Offer note, no document digest, no other player |
| notifications (`/player/notifications`, `/org/notifications`, agent) | the text carries names of orgs and public acts only; targets carry ids only |
| SSE events | registry-minimized payloads: ids and state words |
| timeline entries (all audiences) | kinds from the visibility table; `by` is a club member's name for the club only; the player's and agent's `by` is null |
| documents | Offer documents to the recipient and a shared agent only; package documents to the parties and a shared agent; the executed document to the parties; never to a colleague |
| error bodies | every refusal is a code and a sentence about the opener's access, never about the resource's content (journey E2E E group; m23E2E E) |
| logs | `console.error` lines carry ids and codes only (R5 sweep of m23 / m28 / m29: `CONTACT integrity <id>: <codes>`, `CONTACT transport_failed <id> attempt=<n>`, `CONTACT lifecycle_not_applied <id> <code>`, `DECISION integrity …`, `DECISION transport_failed finalize case=<id>`, `TRIAL integrity …`, `TRIAL lifecycle_not_applied <case> <action> <code>`, `TRIAL transport_failed invitation case=<id>`, `OFFER side_effect_failed <label>: <message>`, `SIGNING completion_rolled_back <id>: <why>`, `M23/M28 <where> <code> — <the error body sent to the client>`); no request body, no terms, no note, no rationale, no name is ever logged; no journey export route exists (Z21: no journey store) |

## 3. Minors through the whole chain (M group)

| Stage | Rule | Proof |
| --- | --- | --- |
| discovery | agencies never see minors (`UNDER_18_WALL`); unverified clubs neither (`VERIFIED_CLUBS_ONLY`) | M1 |
| Contact | routed to the verified guardian; refused when no guardian route (`CONTACT_GUARDIAN_REQUIRED`) | M2 |
| Trial | the invitation reaches the guardian; the guardian answers; the 50 km grassroots radius and the verified-club rule hold (`GRASSROOTS_RADIUS_KM = 50`) | M3 |
| Offer | `minorOfferPathwayOpen` false: the recipient rule refuses (`OFFER_RECIPIENT_INVALID`, "no jurisdiction policy"); the child's journey carries no Offer | M4 |
| Signing | `minorSigningPathwayOpen` false: `MINOR_PATHWAY_CLOSED` blocker; the guardian signing routes answer not found | M5 |
| Agent | no agency pathway for a minor (`PLAYER_NOT_FOUND` on the approach) | M6 |
| Malformed DOB | `null`, `false`, `0`, a malformed string, an impossible date, a future date → `isAdult` false → the minor rules apply everywhere; an unknown age never grants adult authority | M7–M12 |
| Guardian block | lands on the named child only (D-P81-7) | M13 |

## 4. What P8.1 changed

- Discovery-side reads for a blocked player answer 404 everywhere
  (D-P81-8); the Box Cam link decides consent before existence (D-P81-9).
- A Room's evidence request reaches the room's player only (D-P81-6).
- A guardian block names its child (D-P81-7).
- No new field reaches any audience; no payload key was added to any event;
  no notification text changed.

## 5. Recorded, not changed

- The under-18 wall names its rule to the org that hits it (N-P81-2).
- The club's contact-routing preview may say `DISCLOSURE_WITHHELD`
  (N-P81-4, P5.6E rule); the agent is never identified.
- The rival-exclusivity signal on an agent approach (N-P81-3, FIFA 16.1b).
