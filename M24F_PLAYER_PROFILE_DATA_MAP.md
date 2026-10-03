# M24F.1 — Player profile: data map

Every item the new profile shows, its canonical source, who sees it and what
happens when it is missing. Nothing on the profile is invented: every value is
read from the session (`useSession().me`, the server's `GET /player/me`
projection, or the demo client's equivalent) or from an existing client call
that the previous profile, Home or Football already made. No new endpoint, no
new domain object, no derived rating.

Audience: **player** = the signed-in adult; **minor** = an under-18 account
(guardian-managed) — the same screen, with the guardian-only controls and the
exact location withheld, exactly as before.

## Header (every section)

| Field | Source | Audience | Fallback |
|---|---|---|---|
| Avatar | initials of `me.name` (`initialsOf`) — the model has no profile photograph field, so there is no photo path to show; if a photograph is added later the component accepts `photoUrl` and falls back to initials on error | player, minor | initials (always, today) |
| Name | `me.name` | player, minor | — (required by signup) |
| Summary line | `me.position` (the stored position code, e.g. "ST") · `me.city` (adult) or `me.country` (minor — exact location never shown, as before) | player, minor | "Position not set" (`fbNoPosition`); city omitted when empty |
| Availability | `me.availability` → the existing `avail_*` label ("Open to trials", "Not looking", …) | player; minor sees the same word | the stored value always exists |
| Verified | `me.identityVerified` → "Verified" with the green square; otherwise "Not verified" in muted ink | player, minor | — |
| Guardian-managed | `me.guardianId` / `isMinor` → one quiet word | minor | hidden for adults |
| View Passport | link to `/football?tab=passport` (the existing Football Passport destination) | player, minor | — |

## Overview

| Item | Source | Audience | Fallback |
|---|---|---|---|
| NEXT — recruitment action | `m12.getJourneys(playerId)` → the first journey whose `journey.nextAction.code !== 'NONE'`; the words are the server's next-action code rendered through the existing `jnNext_*` labels; the link follows `CATEGORY_FOR_ACTION` (M24B) into Explore (`/opportunities?cat=…&tab=…`) | player (a minor's actions are routed to the guardian by the server, so none appear) | none → next rule |
| NEXT — pending request | `inbox` (session) → first `status === 'pending'` request: `orgName`, `type` (trial invitation / contact request), `trialDetails.proposedDate`, `trialDetails.venue`; link `/inbox` | player | none → next rule |
| NEXT — scheduled trial | `m12.getJourneys` stage `trial_scheduled` + `m12.getTrials(playerId)` → the first future session's `startsAt` and `venue.name`; link `/opportunities?cat=trial&tab=schedule` | player | none → next rule |
| NEXT — account handover | `me.agingUp.eligible` → "Complete the handover" (`client.agingUpComplete`, as before) | player turning 18 | none → "You're up to date." |
| Essentials — Age | `me.age` (server-derived from `dob`) | player, minor | row hidden |
| Essentials — Position | `me.position` | player, minor | row hidden when null |
| Essentials — Preferred foot | `me.foot` | player, minor | row hidden when null |
| Essentials — Location | `me.city`, `me.country` (adult); `me.country` (minor) | player, minor | row hidden when both empty |
| Essentials — Current club | `m15.passport(actor).status.currentClub.orgName` (the Football Passport's own canonical club status) | player, minor | row hidden |
| Recent activity (≤ 4 rows) | `client.getFeed(playerId)` `scouting_event` items (org + event type, the same words Home uses) merged with the journeys' `timeline` events (`jnEv_*` labels), newest first | player, minor | "No recent activity." |
| View activity | link `/opportunities?cat=journey&tab=activity` | player, minor | — |

## Performance

| Item | Source | Audience | Fallback |
|---|---|---|---|
| Combine results | `me.drillResults[]` — `drillName`, `metric`, `value`, `unit`, `verified` | player, minor | section empty state |
| View Combine | link `/football?tab=combine` (the At-Home Combine) | player, minor | — |
| Season output | `me.stats` — appearances, goals, assists (clean sheets for a GK), `paceKmh`, `passCompletionPct`, `duelSuccessPct` | player, minor | rows hidden when null |
| Season by season | `me.seasonHistory[]` | player, minor | hidden when empty |
| Physical | `me.heightCm`, `me.weightKg` | player, minor | hidden when null |
| Where you stand | `client.getBenchmarks(playerId)` (only when `me.pathway`) — `stats[]`, `drills[]`, `percentile`, `note` | player, minor | hidden when none |
| Trial reports | `me.trialReports[]` (club-filed, as before) | player, minor | hidden when none |
| Empty state | — | | "No performance results yet. Add Combine results when you're ready." |

No overall rating, potential, talent or star score exists anywhere on the
profile. The Trust Score is not on this section; where it appears (the
Passport, the Combine card) it keeps its "evidence confidence" wording.

## Evidence

| Item | Source | Audience | Fallback |
|---|---|---|---|
| Footage | `me.media[]` — the video (`client.mediaUrl(m.url)`), `title`, `uploadedAt`, `verifiedClip`, `views`, `tags` | player, minor | "No evidence yet." |
| Add evidence | link `/upload` (the existing Upload screen) | player, minor | — |
| Verified match attendance | `me.attendance[]` — `fixture`, `venue`, `date`, `corroboratedBy`, `gps` | player, minor | hidden when none |
| Coach references | `me.vouches[]` — `coachName`, `role`, `status`, `text`, `seasons`; request via `client.requestVouch` (adult) | player (request); minor (read, guardian requests) | hidden when `me.pathway` is absent |
| Evidence passport | `PassportSection` (M12) — `m12.getPassport` records and tiers, unchanged | player, minor | the component's own state |
| Box Cam | link `/football?tab=boxcam` | player, minor | — |
| Verified sports CV | `client.getCv(playerId)` on open | player, minor | the disclosure stays closed |
| Profile completeness | `me.trustScore` (M18.1: completeness, not trust), `me.trust` breakdown, `me.nextActions` suggestions | player, minor | hidden when absent |

## Journey

| Item | Source | Audience | Fallback |
|---|---|---|---|
| Events | `m12.getJourneys(playerId)` → every club's `journey.timeline[]` (`kind`, `at`) merged and sorted newest first, labelled with the existing `jnEv_*` words, grouped by day | player (the server projection only ever contains what reached this person: contact, invitation, schedule, Offer, signing) | "No current recruitment activity." |
| Stage line per club | `journey.stage` → `jnSt_*` | player | — |
| Earlier | `me.timeline[]` (year, event — the player's own history) | player, minor | hidden when empty |
| Open in Explore | link `/opportunities?cat=journey&tab=activity` | player | — |

Never read, never rendered: a club's watchlist, priority, shortlist,
assessment, decision rationale, Recruitment Room discussion, Second Look,
private notes or scouting opinion. None of those fields exist in the player
projections above (`PlayerJourney`, `InboxRequest`, `FamilyTrial`,
`PlayerFeedItem`), and the new live suite asserts their words never appear.

## Moved to Settings (You › Account)

| Item | Source | Audience |
|---|---|---|
| Availability and status | `client.setAvailability` (availability, contract status), `client.setFirstTeamSeeker`, `client.setAcademyPlus`; `me.contractUntil`, `me.marketValueRange`, `me.agentName` read-only | player (adult); a minor reads the guardian note |
| Medical sharing | `client.setMedicalShared`, `me.medical.records[]` | player (adult switch); minor reads the note |
