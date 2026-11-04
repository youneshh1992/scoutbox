# Recruitment: cases, Rooms, contact, trials and decisions

How a club takes a player from "watching" to a decision. The case lifecycle, the Room, and the three things a club does with a player in it: contact, trial and formal decision. Offers and signings are in [`offers-signings.md`](offers-signings.md); the journey, next actions and analytics are in [`journey-analytics.md`](journey-analytics.md).

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## How it works

**Governing rule.** The lifecycle describes only what has actually happened and never more than the records can prove. Distinct facts, each with its own owner and none derived from another: evidence ≠ observation ≠ assessment ≠ discussion ≠ decision ≠ offer ≠ signing; invitation ≠ accepted ≠ scheduled ≠ attended ≠ completed. (M23_RECRUITMENT_WORKFLOW, M23_P5_DECISION_CONTRACT, M23_P4B_TRIAL_CONTRACT)

**Case, Room and lifecycle authority**
- One object (the recruitment case), one canonical status (`case.room.status`), one writer (`applyLifecycleTransition`/`applyStatus`), one direction: status → derived `stage`. Nothing else writes status. The legacy stage route refuses cases that have a Room (`STAGE_NOT_SETTABLE_ON_ROOM`). Room PATCH cannot set status or stage. (M23_RECRUITMENT_WORKFLOW)
- A Room is a facet of the case, not a second pipeline. Creating a Room adopts the org's existing open case for that player and may not start at an evidence-bearing status. (M17_RECRUITMENT_ROOMS, M23_RECRUITMENT_WORKFLOW)
- 18 statuses: watching, under_review, contact_planned, contacted, shortlisted, priority, trial_requested, trial_scheduled, trial_completed, offer_consideration, offer_made, offer_accepted ("Accepted in ScoutBox", not a signing), offer_declined, signed, on_hold, withdrawn, archived, closed. Terminal: signed, withdrawn, archived, closed. Reopenable: withdrawn, archived, closed. `on_hold` is open. signed may only go to closed. withdrawn/archived/closed need ≥1 structured reason. (M23_RECRUITMENT_WORKFLOW, M17)
- Evidence preconditions are keyed by **target** status, so every inbound edge carries the same burden. The provider fails closed (a missing store means "unavailable", never "none"): contacted ← contact_delivered; trial_requested ← trial_invited; trial_scheduled ← trial_confirmed; trial_completed ← trial_completed; offer_consideration ← decision_progress; offer_made ← offer_sent; offer_accepted/declined ← recipient's own response; signed ← confirmed_join (a non-cancelled signing for this org and player). No precondition on on_hold/archived: a manual hold or archive is allowed. (M23_RECRUITMENT_WORKFLOW, M23_P4B_TRIAL_IMPLEMENTATION, M23_P5_DECISION_CONTRACT)
- Clients name semantic **actions** (startReview, planContact, recordContact, …, confirmSignedOutcome, reopenCase), never a stage. Posting `stage`/`status` is refused by name. Each action declares `applicableFrom`: resumeCase only from on_hold, reopenCase only from a reopenable terminal state. A room lead cannot confirm a signing (admin only). No action is performable by a player or guardian; their response moves the case through the precondition. (M23_RECRUITMENT_WORKFLOW)
- Decision reasons and lifecycle reasons are separate taxonomies. Protected characteristics are refused (`ROOM_REASON_PROHIBITED`) in both and in tags. (M23_RECRUITMENT_WORKFLOW, M17)
- One append-only `case.history`; each transition appends `room_status_changed` (the funnel reads it). No rewrites, no backfilled transitions. Unknown status or malformed history is a 500, never coerced, and checked after concealment. (M23_RECRUITMENT_WORKFLOW)
- Every mutation: integer `expectedRev` (never coerced); `clientKey` + payload fingerprint stored on the record (replays survive restart; permission re-checked on replay). (M23_RECRUITMENT_WORKFLOW)
- Funnel excludes on_hold, offer_declined, withdrawn, archived, closed; counts unique cases. (M23_RECRUITMENT_WORKFLOW)

**Room roles and visibility**
- `recruitment_admin` (org lead) manages any room. `room_lead` (case owner or lead scout) can change status, decide, archive and reopen. `contributor` (any colleague on an open, unrestricted room) can read, comment, do tasks and assess. `viewer` (colleague on a filed-away room) can only read. A restricted room is 403 to non-owners and non-assignees. Roles come from the DB on every request, never from the token. (M17, M23_RECRUITMENT_WORKFLOW)
- The player and guardian never see inside a Room: discussion, ratings, status, rejection reasons or decisions. They are never told a Room exists. No lifecycle status is player-visible; they see only shared objects (contact, trial, offer). A player asking about a case with no shared record gets a `CASE_NOT_FOUND` byte-identical to a non-existent case. (M17, M23_RECRUITMENT_WORKFLOW)
- Every lookup is id AND orgId; a foreign room's 404 equals a missing one. Rooms are not federation-shareable. (M17)
- Joining a Room widens nothing: `visibleToOrg` (no minors for agencies or unverified clubs; grassroots 50 km radius, fail closed on missing location) plus blocks re-run on every read. When a player is blocked or removed, player data stops flowing but the club's own notes stay. (M17)
- Decision notes are never projected (only `hasNote`). Room tasks and mentions stay in the org. Room activity never goes to the global ledger with a playerId (the guardian log would expose it). (M17, M23_RECRUITMENT_WORKFLOW)
- Decision-time snapshots hold Trust levels and references, never player data. Blind-until-submit: withheld peer assessments are counted, not shown. No AI recruiter or player score. (M17)

**Contact** (table `recruitment_contacts`, read through SQL)
- `contacted` means a communication was **delivered** in-app or a legitimate external contact was **recorded** by a named person. A draft, a plan, a queue or a failure is not contact. (M23_P3_CONTACT_CONTRACT)
- Contact states: draft → delivered | failed | cancelled; failed → delivered | failed | cancelled; delivered → responded; responded, recorded and cancelled are final. These are never case statuses. Evidence comes only from delivered, responded or recorded. Case moves contact_planned → contacted once; later contacts record `LIFECYCLE_NO_CHANGE`. A failure, response or block never moves the case back. (M23_P3_CONTACT_CONTRACT)
- The server derives the recipient on every create, send and record: adult (GB 18, KR 19) → player; minor → exactly one verified, non-removed guardian (the designated one if several); otherwise refuse (`CONTACT_GUARDIAN_REQUIRED`), never fall back to the child. A draft for someone the club cannot contact is refused at compose time. A block refuses compose, send and accept (decline still works). (M23_P3_CONTACT_CONTRACT)
- Room lead+ writes; room members read; case must be at contact_planned or contacted. Cooldown: one unanswered in-app contact per org+player per 72 h. External records: occurred ≤180 days ago, valid indefinitely. Email is a courtesy copy, never "delivered". Recipient sees the message, never the case or drafts; a minor sees only the outcome line. (M23_P3_CONTACT_CONTRACT, M23_P3_CONTACT_IMPLEMENTATION)

**Trial**
- A Trial row exists only after the routed recipient accepts an invitation (a `db.requests` row of type trial). Workflow states, derived from fields: legacy_accepted, accepted, scheduled (confirmed revision with ≥1 session), completed, cancelled. `trial_in_progress` is not a status. Accepting a concrete slot creates the trial already scheduled and confirmed. (M23_P4B_TRIAL_CONTRACT)
- Invitations: 1–3 slots on distinct days, IANA zone; one pending invitation and one open trial per case; cooldown after decline; the club cannot withdraw a pending invitation. (M23_P4B_TRIAL_IMPLEMENTATION)
- Each schedule change is a retained revision (1–20 sessions). Changing zone, session count, times or venue name/town needs re-confirmation; kind, instructions or address line do not. Ended or attended sessions cannot change. (M23_P4B_TRIAL_CONTRACT)
- Attendance (attended, partial, no_show, club_cancelled, player_withdrew) is append-only, after session start, never a judgement or Trust input. Completion is club-only: confirmed schedule, ≥1 attended/partial session, last session ended → case trial_completed. Anyone party may cancel; cancelling never moves the case. (M23_P4B_TRIAL_CONTRACT)
- Recipient routing as for Contact, re-derived at every step. The child's own device sees a five-field outcome line and cannot act. Before acceptance the family sees day, times, venue name and town; the exact address and instructions only after acceptance (for a minor, guardian only). They never see attendance notes, evidence links, assessments or the case id. When the family has blocked the club, the club may only cancel (a safety notice), and report notifications are suppressed. (M23_P4B_TRIAL_CONTRACT, M23_P4A_DECISION_REGISTER D-16, D-23)
- Box Cam: a link is a reference to a finalised session of the same player, allowed under the Combine consent rule at link time ("a trial is not consent"). Wrong player, unknown id and test-only provider all return one 404. Linking writes nothing to Box Cam or the Passport and is not read by Trust. A CV refusal shows as "No reliable observation available", never as poor performance. No confidence numbers, traces or frames are shown; Combine Verified stays false. (M23_P4B_TRIAL_CONTRACT, D-14, D-17)
- Trial assessments are ordinary blind assessments; the trial lists existence only; no aggregate number. Passport `trial_attended` keys on recorded attendance. (M23_P4B_TRIAL_IMPLEMENTATION)

**Formal decision**
- A formal decision is a `roomDecisions` row (`kind: formal`, `state: final`) typed by a room lead or recruitment lead from the case's single draft. Outcomes: progress → offer_consideration; hold → on_hold; reject (≥1 reason) → archived. It never reaches offer_made, never creates an offer and never notifies the player or guardian. Drafts move nothing. Final rows are never edited; supersession must name the head and its rev and give a reason. Lifecycle refusal rolls back the row. (M23_P5_DECISION_CONTRACT)
- Never produced from assessments, trials, Box Cam or Trust; assessment summary is verdict counts, never an average. Cited evidence must belong to this case. Blocked family: progress refused, hold/reject allowed. Legacy rows read as advisory. (M23_P5_DECISION_CONTRACT)
- Contact, Trial and Decision are Room tabs in Pro and Grassroots, no top-level nav. (M23_P3/P4B/P5 implementations)

## Server contracts (from the old operations runbook)

- One message thread per recruitment request. A thread opens only when a request is
  accepted.
  - The org must exist.
  - A guardian named on the thread must exist.
  - Messages are acknowledged (201) only after they are durable.
- Deleting a player deletes their threads.
- Request/trial rules:
  - At most one trial per request.
  - At most one open trial per case. "Open" means any state other than completed or
    cancelled.
  - The direct invite route keeps its `REQUEST_PENDING` rule. The open-day outcome route
    may create several pending invitations.
- Player ids on requests, trials, cases, rooms, contacts, offers and signings are
  tolerant: live, retained and missing ids are all kept and counted.
- These ids are strict and the write is refused if they don't exist:
  - guardian ids (invitation recipient, contact/offer recipients, actors and viewers);
  - case ids;
  - org and staff ids.
- A case cannot be removed while requests, trials, room rows, contacts or offers still
  name it.
- One open Room per player per org (`ROOM_EXISTS`). Decision chains (`supersedes`) and a
  decision's snapshot must stay within the same Room. A decision's snapshot is the Room
  snapshot it names, not a copy.
- A case deadline and an assignment or task due date are a calendar day or an instant;
  anything else is refused (`DATE_INVALID`). A change to a Room, a task or a case's links
  is checked whole before anything is written: a refused field leaves the rest unchanged.
- A case's history has one entry shape, so the Room activity feed shows who invited,
  withdrew or accepted a transaction handoff.
- A contact and its request must agree. An offer's revision and response pointers must
  not point into another offer; unresolved historical pointers are kept.
- `EXPIRED` offer status is computed when read, never stored.
- Idempotency keys on requests, trials, drafts, handoffs, decisions, contacts and offers
  are persisted and owned per record (draft and handoff keys per owning case), so a
  replayed act returns the same result.
- Signing completion is one unit: package, ledger row, signing row, player columns and
  case lifecycle together. The success-fee invoice is issued only after commit. A failure
  issues no invoice.
- Rate limits (per hour unless noted):
  - Rooms: 60 per org.
  - Room comments: 20 per minute per user.
  - Contacts: 30 sent per org; 30 responses per actor.
  - Trial invites: 30 per org. Schedules: 60 per org.
  - Offers: 30 issued and 30 withdrawn per org; 30 responses per actor.
  - Signings: 30 completions per org.
  - Safety closures have a separate budget of 60.
  - Source: `RATE_LIMIT_POLICY`.
- Organisations cannot be deleted. `suspended` is the only lifecycle flag. Policy for an
  org with open cases is undecided.

## Open questions and deferred work

- Legal review is needed: Trial-specific footage/observation consent for minors, and whether event consent should name Box Cam (D-15, P4A architecture §6).
- D-24 recommendation not done: Nobody Missed/Second Look should key on trial completion so "completed but not evaluated" shows.
- Deferred: Box Cam 2.0 (multi-player, pose, tactics, auto clips; Combine Verified awaits real-world validation); opt-in Passport line "captured during a trial at Club X"; cross-room comparison; Room export; T&S room access; lifecycle-transition events; minor→adult birthday test.

## Also worth knowing

- M23_P4A_DECISION_REGISTER D-30: glossary ("recommendation" = opinion, "decision" = recruitment act, "outcome" reserved for signings/outcome reports).
- M23_P4A_BOXCAM_CHANGE_CLASSIFICATION §3: rejected designs (no `trialId` on Box Cam sessions, no rating from observations, no frame retention).

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

- ✓ Target-keyed evidence gates incl. trial, decision and signed: `scoutbox-server/m17/shared.mjs:273-290`.
- ✓ Stage route refused on Room cases: `m12/scouting.mjs:535-537`. ✓ `stage`/`status` key refused: `m23/index.mjs:89`.
- ✓ Minor without guardian route fails closed: `m23/contact.mjs:278`. ✓ 180-day / 72 h constants: `m23/contact.mjs:109,111`.
- ✓ Recipient view strips caseId, orgId, keys and private trial address/instructions: `server.mjs:2355-2366`.
- ✓ Minor wall and grassroots radius: `domain.mjs:110-120`. ✓ Completion gate: `m23/trial.mjs:323-338`. ✓ Child device cannot act: `m23/trialRoutes.mjs:892`.
- ✓ Progress decision refused while blocked: `m23/decisionRoutes.mjs:351`. ✓ Protected reasons refused: `m17/shared.mjs:447`.
- ✓ Decision note never projected (`hasNote` only), hidden interest returns `CASE_NOT_FOUND`: `m23/journey.mjs:176-214,257-259`.
- ≠ `confirmed_join` now also checks `signingPackages` (`m23/evidence.mjs:106-115`); offer evidence implemented (`m23/evidence.mjs:191-201`).
