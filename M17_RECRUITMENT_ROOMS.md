# M17 — Recruitment Rooms

> **Football Passport = the player's truth layer. Recruitment Room = the club's
> decision layer.** The player owns and controls the Passport. The club owns its
> Room. The player never sees inside it.

## 1. Philosophy

Clubs already had the information. What they did not have was a place to think
together about one player and keep what they concluded. A Recruitment Room is
the operating workspace around a recruitment decision: who reviewed what, what
we are waiting on, who is doing it next, what we decided and why.

It answers a question no other ScoutBox system answers, and it answers it for
the club alone. It does not make the decision. There is no AI recruiter, no
signing probability, no player score — M17 is decision *infrastructure* for
human recruiters.

## 2. The Passport / Room boundary

| | Football Passport | Recruitment Room |
|---|---|---|
| Owned by | the player | the organisation |
| Visible to | the player, their guardian, and orgs under the standing rules | authorised staff of that one organisation |
| Contains | evidenced facts with provenance | opinions, discussion, tasks, decisions |
| Written by | the player, verified orgs, ScoutBox | club staff |

The player must never see private scout discussion, internal ratings, hidden
recruitment status, internal rejection reasoning, private staff assignments,
comparison notes, internal decision history, private tactical evaluation or any
other club's activity. This separation is a core ScoutBox invariant and is
enforced by construction: the Room lives entirely behind `/org`, and no
player-, guardian- or public-facing projection reads any Room store.

## 3. Architecture

`scoutbox-server/m17/` — `shared.mjs` (the pure engine), `rooms.mjs` (stores,
the projector, the org routes) and `index.mjs` (migration, boot assertions,
metrics). Registered **last** in `server.mjs`, after M16.2, because a Room
composes every layer beneath it.

Every route registers on the **existing** authenticated `orgRouter`, so bearer
sessions, removed users, organisation suspension, `visibleToOrg`, blocks and
moderation all run before any M17 handler. A Room is a workspace, never an
authorization surface.

## 4. Data model

**A Room is a facet of the M12 recruitment case, not a second pipeline.**
`db.recruitmentCases` was already "the workspace layer OVER existing requests,
trials and signings". A case with a `room` object is a Room:

```
case.room = {
  status, priority, tags[], leadScoutUserId, sourceContext,
  openedBy, updatedAt, archivedAt, closedAt, reopened?
}
```

The case keeps owning `ownerUserId`, `restricted`, `assignments[]`, `tasks[]`,
`approvals[]`, `decision`, `links{requestIds, trialIds, signingId}` and the
append-only `history[]`. Creating a Room **adopts** the organisation's existing
open case for that player when there is one, so a club never ends up with a
case and a room that disagree about where the player stands.

Four new stores, for the four things nothing existing covered:

| Store | Why it could not be reused |
|---|---|
| `db.roomComments` | `db.orgNotes` has no replies, mentions, edit metadata or tombstones. It is left untouched. |
| `db.roomDecisions` | `case.decision` is M12's single sign-off artefact (last write wins). Decision memory must be append-only with structured reasons. |
| `db.roomSnapshots` | Nothing recorded what evidence confidence a club could see at the moment it decided. |
| `db.roomEvidenceState` | The Room's private review state over evidence it does not own. |

**Deliberately not created:** `roomPassport`, `roomCombine`, `roomTrustScore`,
`roomAssessments`, `roomMembers`, a second activity log, a second task store, a
second pipeline. Player truth is referenced, never copied.

## 5. State machine

Thirteen statuses, one canonical field, a full transition table:

`watching · under_review · shortlisted · priority · trial_requested ·
trial_scheduled · trial_completed · offer_consideration · offer_made · signed ·
withdrawn · archived · closed`

`room.status` is canonical. `case.stage` is a **pure derivation** of it
(`stageForRoomStatus`), written by `applyStatus` and nowhere else, so the two
representations cannot drift. The legacy `POST /org/cases/:id/stage` route
still works and maps back through the same table.

Nothing outside the table is reachable: a room cannot jump from watching to
signed, an archived room cannot be signed without being reopened, and a signed
room may only be filed away as closed. `withdrawn`, `archived` and `closed`
each require at least one structured reason. Reopening is a first-class,
recorded move — never a delete-and-recreate.

`superseded` is not a room status: a *decision* is superseded by a later
decision, which the append-only decision memory already models.

## 6. Access and RBAC

Mapped onto the existing org model — **no parallel RBAC was invented**.

| Room role | Who | Can |
|---|---|---|
| `recruitment_admin` | `isLead(user)` (the existing role regex) | manage any room in the organisation |
| `room_lead` | the case owner or the room's lead scout | status, assignments, decisions, archive, reopen, requests |
| `contributor` | any other colleague on an open, unrestricted room | read, comment, create and complete tasks |
| `viewer` | any colleague on a **filed-away** room | read only — a closed room's discussion is institutional memory |
| *(none)* | a colleague on a `restricted` room who is neither owner nor assignee | nothing; 403 `ROOM_RESTRICTED` |

ScoutBox has no read-only staff tier, so an ordinary colleague on an open room
is a contributor rather than a spectator. That is a deliberate reading of the
existing permission architecture, not a gap.

## 7. Tenant isolation

Every lookup is `id AND orgId`. A room belonging to another club returns
**exactly** the same 404 body as a room that does not exist, so a guessed id
leaks nothing. Room search, the batch summaries, the list, the funnel and the
needs-attention feed are all org-scoped. Rooms are **not** a federation
`RESOURCE_KIND`, so a group grant can never share one; the M13 case grant
projection remains field-listed (`id, playerName, stage, priority, decision`)
and carries no room discussion, decision or status.

Two clubs evaluating the same player have completely isolated rooms and neither
knows the other exists.

## 8. Player visibility

Adding a player to a Room widens **nothing**. `orgCanSee` — `visibleToOrg`
(agency/minor wall, unverified-club wall, grassroots 50 km radius, fail-closed
on missing location) plus `isBlocked` — re-runs on **every** read, on the list
path as well as the detail path. A Room cannot be used to bookmark a player the
organisation is forbidden from seeing.

## 9. Overview

A summary, not a second copy: status, lead, Trust Score, decision readiness and
its blockers, room health, open tasks, missing evidence, trial state and the
latest internal activity.

## 10. Passport tab

The authorised M15 projection, via `buildFootballPassport(player, viewerKind,
{orgId})`. The Room reconstructs nothing and can reach no field the
organisation could not already read: no gaps, no source ids, no conflicts, no
guardian identity, no other club's assessments or trials.

## 11. Trust Score

`safeTrustProjection(buildTrustProfile(player, {full}), viewerKind)` — score,
band, component *levels* and safe signals, with **"Evidence confidence — not
football ability."** attached wherever it appears. Never per-component
coverage, never gaps, never a source id.

The Room strips the legacy safeguarding `trustScore` from its player header:
two different numbers both called "trust" in one header is exactly how an
evidence-confidence score gets read as a player rating.

## 12. Decision-time snapshots

At every meaningful decision point — shortlist, priority, trial, offer, signing,
withdrawal, archive, close, and every recorded decision — the Room stores a
compact immutable snapshot: score, band, policy version, component **levels**,
a hash, and minimal source references (passport version, evidence ids,
assessment ids, protocol coverage, trial ids). Bounded, never a frozen copy of
the Passport.

So a Room shows *Trust at decision: 78* beside *Current: 86*, and the first
number never changes. A frozen copy of restricted player data would be exactly
the stale-cache authorization bypass this milestone must not create — which is
why the snapshot holds references and levels, not content.

## 13. Evidence

The organisation-visible evidence list with its provenance tiers intact —
never flattened into a generic green tick — plus the Room's own private review
state (`not_reviewed · reviewing · reviewed · needs_follow_up`) and internal
timestamped notes. The evidence record itself belongs to the player and is
never touched.

## 14. Assessments

The existing M12/M13 assessments, surfaced through the existing
`assessmentAccessList` rule. The **blind-until-submit** calibration policy is
not bypassed: a scout who has not submitted their own assessment sees a count
of withheld peer assessments, never their content — not even a room lead's
convenience overrides it below lead level.

## 15. Combine

M16.1 results behind M16.1's own dual consent rule: the standing gates **and**
(the player's recruitment opt-in **or** this organisation's own request). A
Room is not consent. Protocols are selected from the standardized registry via
`GET /org/combine/protocols`; a Room can never mint a protocol or alter one's
rules. Requests go through the one canonical creator.

No overall Combine rating is computed. A Combine number is performance data; a
Trust Score is evidence confidence; they are shown separately and the Room
never implies one moved the other.

## 16. Development

The recruitment-safe M16 development summary, only behind the player's own
`shareDevelopmentActivity === 'recruitment'` preference, carrying *"Box Cam
activity shows verified training evidence. It does not independently establish
football ability."* No raw home footage exists server-side to expose.

## 17. Discussion

Organisation-private threaded comments with replies, @mentions of colleagues,
edit metadata and tombstoned deletion. Markup is stripped on write so no
renderer can be talked into executing it. A mention notifies a colleague in
that organisation and nobody else — never a player, guardian, coach, other club
or email. A comment id from another room is a 404, not a cross-room reply.

## 18. Tasks

Lightweight staff work on the existing `case.tasks[]`: title, description,
assignee, due date, linked resource, and `open · in_progress · done ·
cancelled` with a transition table. A task can only be assigned to someone in
the organisation. **A room task is staff work and is never sent to the player** —
a player-facing ask must go through the evidence-request or Combine-request
workflow.

## 19. Trials

Surfaced and linked, never duplicated. A trial is created by its own workflow,
because requesting one is a *contact* with a player or guardian that must pass
its own consent and safeguarding path — a private room must not shortcut it.
The Room records `links.trialIds` exactly as M12 cases already do.

## 20. Decision memory

Append-only. A decision carries a recommendation, structured reason codes, an
optional internal note, its author, and its snapshot. A revision **supersedes**
its predecessor (`supersededById`) and never rewrites it. Submits are
idempotent on a client key. The reason taxonomy has four categories —
football, evidence, process, outcome — and the server refuses any code outside
it.

**Protected characteristics are refused by their own error code**
(`ROOM_REASON_PROHIBITED`), not silently dropped and not treated as a typo, so
the refusal is unambiguous in an audit. A club may decline a player; it may not
record a protected trait as the reason, and ScoutBox will not carry one into
its analytics. Internal tags are checked the same way.

## 21. Archive and reopen

Archiving requires a reason and records a decision, so the reason survives as
machine-readable memory rather than a status flag. Reopening records who, when,
from where and why; the archive decision stays in the history.

## 22. Source integrations

| Concern | Reused entry point |
|---|---|
| Passport | `ctx.buildFootballPassport` / `ctx.assemblePassport` |
| Trust | `ctx.buildTrustProfile` + `safeTrustProjection` + `trustSnapshotOf` |
| Combine | `ctx.combineProjection`, `ctx.combineOrgMaySeeResults`, `ctx.createCombineRequests` |
| Development | the M16 development summary behind the share pref |
| Missing evidence | `ctx.requestEvidenceGap`, `ctx.computeEvidenceGaps` |
| Assessments, evidence, trials, signings, transitions | read from their canonical stores |

Two small extractions made the bridges honest: M16.1's Club Combine creator and
M13's evidence-gap request were pulled out of their route bodies so the Room
calls the *same* code — same anti-pestering window, same guardian routing, same
whitelisted player-safe wording — instead of growing a second copy. Both
extractions are behaviour-neutral and their owning suites confirm it.

## 23. Blocks, removal and suspension

A Room must never become a stale-data authorization bypass.

- **Block** — the next read reports `playerAvailable: false` and returns
  nothing about the player: no name, no Trust Score, no Passport, no evidence,
  no Combine. The club's own comments, tasks, decisions and activity remain.
- **Suspension** — 403 `ORG_SUSPENDED` before any handler, list included.
- **Staff removal** — the session stops reaching the room; their comments,
  assessments and activity keep their attribution. Their work is not erased.
- **Player removal / invisibility** — the same honest unavailable state, with
  an explanation rather than a blank or a fabrication.

## 24. Minors and guardians

Every standing rule applies unchanged: the agency wall, the verified-club
requirement, guardian routing on every player-facing request. A guardian sees
legitimate child-facing requests, trials, Combine asks and evidence asks
through their existing flows and **never** the Room. Neither the player nor the
guardian is told a Room exists.

## 25. Grassroots

Rooms work for grassroots clubs with the radius and level rules intact, applied
at creation and re-applied on every read. The client surface is simpler; the
gates are identical.

## 26. Audit

Sensitive actions append to the existing per-record `case.history` via M12's
`audit()` helper — one append-only log, not a second one. Room activity is a
typed projection of it with total, deterministic ordering (timestamp, then the
monotonic id as a tiebreak), so two events in the same millisecond never swap
places between reads. Ordinary reads are not audited, matching existing policy.

Room events are deliberately **not** written to the global ledger with a
`playerId`: `GET /guardian/log` returns every ledger row for a guardian's child
with no type filter, so a ledger row is the wrong place for org-private
recruitment activity.

## 27. Metrics

`metrics.rooms` — counters only: created, status changed, archived, reopened,
signed, assessment assigned, task created, decision recorded, trial requested,
combine requested, evidence requested, comment added. No player ids, no player
names, no organisation names. The per-organisation funnel is private to that
organisation; ScoutBox publishes no cross-club table.

## 28. Second Look foundation

Archiving emits a typed domain event:

```
recruitment_room_archived { roomId, orgId, playerId, status,
  reasonCodes[], revisitable, decisionAt, sourceVersionRefs }
```

Reason **codes** and no private free text, so a future Second Look can ask "has
the reason this player was archived stopped applying?" without reading anyone's
notes. Evidence-shaped reasons are flagged `revisitable`; a squad-space
decision is not. The Second Look product itself is **not** built here.

## 29. Known limitations

- **Trial and contact requests are linked, not raised from the Room.** Creating
  one is a contact with a player or guardian and must pass its own consent path.
  This is a deliberate safeguarding choice, not an omission.
- **Transitions are surfaced as status only.** A transition pack requires an
  active consent grant; a Room never confers one.
- **No cross-room player comparison view** is built. The foundation exists
  (batch summaries, safe projections); the mandate allows deferring it, and
  building a comparison table is the easiest place to accidentally create a
  ranking.
- **No export.** A Room export would leak decision content; deferred on purpose.
- **T&S has no routine read access** to room contents and no support-grant
  surface is built for it here. The admin route reports platform-level counts
  only.
- **No optimistic concurrency.** ScoutBox has none anywhere; M17 follows the
  existing convention of explicit state guards returning 409, which protects
  status and decision writes but not simultaneous metadata edits.
- **Production Combine capability remains absent** (M16.1), so a Room honestly
  reports "No production-supported Combine Verified result is currently
  available" rather than implying one could exist.
- Rate limits and cooldowns are in-memory, matching the existing codebase; they
  are abuse speed-bumps, not a distributed quota system.
