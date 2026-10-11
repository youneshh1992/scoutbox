# Decision O1: what ScoutBox keeps about a player after their account is deleted

Written 11 October 2026 on branch `feat/sqlite-schema` at commit `d4ca3f2`, corrected after
review at `0c038ef`, from reading the code as it is today. **O1 is unresolved until the Founder
answers the question in §9.** Nothing in this document is implemented, nothing in it is
approved policy, and nothing in it is legal advice: §8 lists what needs a qualified privacy and
legal review. Paths are relative to `scoutbox-server/`; `S:` is `server.mjs`. Where a statement
was verified by running code on synthetic data it says so; everything else is read from the
code or is a design proposal.

---

## 1. The decision in plain language

When a player (or the guardian of a child) deletes the account, ScoutBox removes the person's
profile. The platform also holds records *about* that person created by other people and kept
for their protection or for accountability: a club's safeguarding report about a conversation,
a block, a moderation decision, the record that a trial took place, a signing, an invoice. Those
records point at the player by an identifier. If the player's row disappears completely, the
pointers point at nothing, and someone reviewing the record later cannot establish even basic
facts about who it concerned — such as whether the person was a child at the time.

A **tombstone** is the smallest record kept in the player's place after deletion: the
identifier, the fact and time of deletion, and nothing else except what is deliberately decided
here. It exists so that the other records keep pointing at something real and so the platform
can answer the few questions those records are kept for.

Two things must be said plainly. First, a tombstone does **not** make the person
unidentifiable: the records that point at it may keep the text of a report, an excerpt of a
message, dates, the clubs involved and the identifier itself, and together those can identify
someone. What exactly is kept in those records is a retention decision (§8), not a consequence
of this one. Second, the only question decided here is the **birth date**: the most useful fact
for a later safeguarding review ("was this person a child when this happened?") and one of the
most identifying facts about a person. This document separates what the software demonstrably
needs (very little) from what a reviewer might want, and recommends an option. The Founder
decides.

## 2. What happens today (facts from the code)

- Only players can be deleted. `DELETE /player/account` (S:4027–4031, adults only; a minor
  gets `GUARDIAN_MANAGED`) and `DELETE /guardian/children/:id` (S:4041–4045, any guardian whose
  `childIds` lists the child, so a co-guardian too) both call `deletePlayerData`
  (S:3978–4023). No route deletes a guardian or an organisation; there is no admin deletion.
- `deletePlayerData` **hard-deletes the player row** (S:3984), deletes the media files
  (S:3982), revokes the player's sessions (S:3983), deletes channels and messages including
  guardian–club threads (S:4014), the player's notifications (S:4015) and pairing codes
  (S:4016), removes the id from every guardian's `childIds` (S:4018), turns `requests` and
  `trials` into id-only tombstones (S:3955–3976, 3902–3952), nulls `playerName` on cases,
  assessments and open-day registrations (S:3993–4002), and calls the m24–m29 hooks (names and
  words removed, ids and states kept). It ends with `persistNow()` (S:4021), so all of this
  lands in one snapshot save.
- **The deletion itself is not recorded**: nothing logs who deleted the profile or when (two
  modules write their own history row, `m25/index.mjs:462`, `m26/index.mjs:1378`).
- **The birth date is stored in one place: the player row (`dob`).** No other record copies it
  (the org-owned import `prospects` rows hold the importer's own dob, `m13/imports.mjs:155–159`).
  Every age or minor decision reads the live row.
- **Where the birth date comes from.** It is typed by the adult at signup (S:1133–1142,
  checked only for shape, plausibility and the adult threshold) or by the guardian creating a
  child (S:1382–1385). No route verifies it against a document: `identityVerified` is written
  only by the seed (`seed.mjs:139, 177, 202, 223, 248`) and by no route. Every age statement in
  the system is therefore **derived from a declared date**.
- Some records store a **status flag taken when they were written** (§3.3). The three
  safeguarding collections — `blocks` (S:1633), `reports` (S:1648–1661), `moderationLog`
  (S:1028–1032) — store **no** age or minor flag.
- Names survive deletion in `signings`, `invoices`, `vouches`, `applications`,
  `campaignSubmissions`, `squadInvites`, `verReferences`, `verPlayerInvites`,
  `transitionCases`, `evidenceSuggestions`, `orgs[].squad[].name`, `recruitmentCases.history`
  (`byName`), guardian responses on offers and packages, non-player notifications, `pushLog`,
  `outbox`, `ledger` message rows (`scoutName` is the player's or guardian's name, S:893), and
  the 140-character excerpts in `moderationLog`/`reports`. `pushTokens`, `verTokens` and
  passport share tokens are not removed. A deleted player's id stays in about forty
  collections (§5).
- **Verified by reproduction** (`scripts/review/reproShortlistAfterDeletion.mjs`, synthetic
  data, review-only): after a shortlisted adult deletes their account, `GET /org/shortlist`
  (S:2011–2013) answers **500** and the server logs `TypeError: Cannot read properties of
  undefined (reading 'id')` from `playerViewForOrg` (S:1054), because the ledger row that
  drives the shortlist survives and `findPlayer` returns `undefined`. Every other reader
  checked treats a missing row as "removed" (`m28/index.mjs:149`, `m29/index.mjs:98`,
  `m23/decisionRoutes.mjs:102`, `m12/operations.mjs:48`, `m26/index.mjs:155`,
  `m27/index.mjs:183`, S:2529, S:4265). This is a defect in a reader today, independent of O1;
  a tombstone row would also make it disappear, but it should be fixed in the route.

## 3. What the code needs the birth date for — demonstrated dependencies versus purposes

### 3.1 The rules

`ageOnMs` (`temporal.mjs:339–347`): completed years in UTC; a person turns N at 00:00 UTC on
the birthday; a 29 February birthday counts on 1 March. `isAdult` (`domain.mjs:76–79`): age
known **and** `>=` the country's threshold (`ADULT_AGE`, `domain.mjs:7–14`: 18 by default,
KR 19, TH 20, EG 21, SG 21; the country is the player's declared `country`). Unknown age is
**not** adult. Two rules use a fixed 18 regardless of country: `isRegulatoryMinor`
(`m25/policy.mjs:272`) and the passport representation display (`m15/shared.mjs:743, 754`).

### 3.2 Demonstrated code dependencies (does any code compute a deleted player's age?)

| Use | Boundary | Needs the live row? | After deletion |
|---|---|---|---|
| Signup refusal (S:1133–1142), child creation (S:1382–1385) | `< T` / `>= T` | yes | never runs |
| `req.playerIsMinor` and ~60 `GUARDIAN_MANAGED` gates | `!isAdult` | yes (authenticated player) | never runs (no session) |
| `visibleToOrg` (`domain.mjs:110–121`) | `!isAdult` | yes | hidden (missing row → not visible), except the unguarded shortlist reader (§2) |
| Org views (S:1052–1081): `age`, `guardianManaged`, blank `city`, `contactPolicy` | derived | yes | never runs |
| Age-group search (S:1907–1910, 2398–2401) | `u16 <16`, `u18 <18`, `18-21`, `senior >=22` | yes | never runs |
| Push mute in school hours (S:745, 753–755); no external e-mail for minors (`m13/delivery.mjs:41–46`) | `!isAdult` | reads the row per notification | a deleted id is treated as not a minor; nothing is addressed to a deleted player anyway |
| Request routing (S:2095–2126, 2729–2744) | `!isAdult` at write time | yes | the stored `routedTo` survives (§3.3) |
| Trial recipient audience (`m23/trialRoutes.mjs:241–249`) | `isAdult` live | reads the row on a historical trial | null; changes to a tombstoned trial refused (186, 878) |
| Contact recipient (`m23/contact.mjs:250–280`) | `isAdult(player, now)` | yes | `CONTACT_RECIPIENT_UNAVAILABLE` |
| Follow-up sweep (`m12/operations.mjs:306–307`) | `p && !isAdult(p)` | reads the row on a surviving follow-up | only the staff notification fires |
| Import dedupe (`m13/imports.mjs:95`) | exact `dob` + name against `db.players` | yes | a tombstone has no name; cannot dedupe |
| Criteria and similarity (`m12/shared.mjs:101–103`, `m12/scouting.mjs:714–716`, `m19/match.mjs:52–57`, `domain.mjs:340`) | `minAge`/`maxAge` | yes | never runs |
| Combine, Box Cam, passport, agents, offers, signing (`m16/*`, `m15/*`, `m24–m29`) | `isAdult` / `>= 18` | yes | skipped with `SUBJECT_REMOVED` / `SUBJECT_GONE` / `PARTY_REMOVED`; `m29/index.mjs:337`, `m29/signing.mjs:53, 159` read the **stored** `recipientSnapshot.type === 'guardian'` |
| Compliance re-evaluation (`m25/index.mjs:447` → `m25/conflict.mjs:139–143`) | `isMinor: pl ? !isAdult(pl) : false` | reads the row on historical contexts | `removed` → fails closed |
| `earliestPermittedApproachAt` (`m25/policy.mjs:296–319`) | exact date | — | **no production caller** |
| Relative-age report (`m13/insight.mjs:86–100`) | **birth quarter** (UTC month of `dob`) of each assessed player in a 90-day window, per org, suppressed under n<3 | reads the row on surviving assessments | the deleted player's assessment stays in `total` and drops out of the quarter counts |

**Finding:** no code path computes a deleted player's age, and none fails because the row is
gone (except the shortlist defect, which fails on any missing row). Every rule either needs an
authenticated player, treats a missing row as removed and fails closed, or reads a flag stored
when the record was written. **There is no demonstrated software dependency on retaining birth
information for a deleted account.**

The relative-age report is the one place that would *use* retained birth information, and it
is a **product/analytics purpose, not a dependency**: it is an aggregate per organisation over
a rolling window, suppressed below three assessments, and it already tolerates a deleted
player by counting the assessment and not its quarter. It does not establish a need to keep
month, year and country on every deleted player; if the Founder wanted the analytic to stay
complete after deletions, the proportionate mechanism would be to record the birth quarter on
the assessment when it is written (a write-time snapshot, §3.4), not to keep birth data on the
tombstone.

### 3.3 Three different questions, and what the stored flags actually answer

"Was the person a child?" is three questions, each with its own timestamp, subject, rule and
provenance. A flag computed when a record is written answers the question **for that record's
own time** and nothing earlier or later.

| Question | Relevant timestamp | Subject | Rule | Records that carry a timestamp of that kind |
|---|---|---|---|---|
| Status **when the incident occurred** | the time of the act (a message `ts`, S:891; a trial `day`; a block's cause) | the person acted upon or who acted | `isAdult(dob, incidentTs)` by country, or the fixed-18 regulatory rule | messages (deleted with the player today), trials (`day`, `history[].at`), ledger rows (`ts`), moderation entries made at send time (`moderateOrRefuse` runs when the text is posted, so `moderationLog.ts` *is* the incident time for the attempted message) |
| Status **when someone reported it** | `reports.ts` (S:1649) | the target (`targetPlayerId`) **or** the reporter (`byId` with `by: 'player'`/`'guardian'`) — a report has no field saying which party is the child | same rules | `reports` — which stores **no incident time**: the incident is described only in the free-text `reason` |
| Status **when moderation acted** | `moderationLog.ts`; `reports.resolvedAt` | the sender of the text (the moderation entry stores `context` — a `kind` plus `channelId` or `playerId` — not the sender's id); for an escalation, the auto-report's target | same rules | `moderationLog`, `reports.outcome` |

What the existing flags are, exactly:

| Flag | How it is computed | Time it describes | Provenance | Is it "verified historical age evidence"? |
|---|---|---|---|---|
| `requests.routedTo = 'guardian'`, `requests.guardianId`, ledger type suffix `_to_guardian` (S:2095, 2120–2121, 2126) | `!isAdult(player)` at request creation | request creation (`createdAt`) | derived from the **declared** dob and declared country at that time | No. It is a derived status at that moment, unverified. It is good evidence that the *system treated* the person as a minor then. |
| `trials.recipient.minor` (S:2155) | `by === 'guardian'` — **who accepted**, not age | acceptance | who held the session | No. A guardian may accept for an adult still linked (the seed's `pl-imani`, 18, is linked to `gd-marek`); a minor never accepts, so `false` does imply "accepted by the player", which implies adult at acceptance by the inbox gates — indirect. |
| `recruitmentOffers.recipientSnapshot.minor` (`m28/index.mjs:463`) | copies `rec.recipient.minor === true` | issue time, copied from the contact's recipient | inherits the contact's provenance | No, inherited. |
| `recruitmentContacts.recipient.minor` (`m23/contactRoutes.mjs:482`, via `m23/contact.mjs:250–280`) | `!isAdult(player, now)` at resolution | contact resolution | declared dob | No; derived, unverified, for that moment. |
| `representationAgreements.isRegulatoryMinor` (`m24/index.mjs:600`) | **constant `false`** (agreements for minors are refused at the route) | — | none | No. It records that the route refused minors, not an age. |

Rule for any later use: a flag answers only for its own record's time; "unknown" is preserved
wherever the record has no timestamp of the right kind, no identified subject, or no flag.
None of these flags is verification: they all descend from the declared birth date.

### 3.4 Could historical status be derived while the live birth date still exists?

Yes, for some records; it is **not implemented and not proposed for implementation here** —
this section only states what would be required and where it is impossible.

- **Requirement:** a record with (a) a timestamp that is the relevant time for the question
  asked, (b) an identified subject whose `dob` and `country` are still present, and (c) a
  stated rule. The derived value would be `isAdult({dob, country}, ts)` at that time, stored
  **with its provenance** ("derived at deletion from a declared birth date; rule: country
  threshold / fixed 18; time: the record's own `ts`"), never as a bare boolean.
- **Derivable before deletion:** `ledger` rows (`ts`, `playerId`) → status at the event;
  `blocks` (`ts`, `playerId`) → status when blocked; `moderationLog` entries whose `context`
  names a `playerId`, or a `channelId` whose channel still exists (resolving the sender) →
  status when the text was attempted; `trials` (`day`, `history[].at`, `playerId`) → status
  on the trial day; `assessments` (`createdAt`, `playerId`) → birth quarter / status when
  assessed; messages (`ts`, sender id) → status when sent.
- **Impossible even before deletion:** `reports` for the **incident** question (no incident
  time is stored; only the report time is); any `moderationLog` entry whose `context` carries
  neither a player id nor a resolvable channel; any record whose subject is a free-text name
  (`targetScoutName`); any question about a date other than the record's own.
- **Impossible after deletion** without a retained birth date: everything above for records
  written before the derivation ran, and every future record (hence the write-time stamp,
  option D2 in §6).
- **Provenance limit for all of it:** the birth date is declared, never verified (§2); any
  derived status is therefore "status according to the date the person or guardian gave", and
  must be labelled so.

## 4. Who is identified by what is kept — proposed, not approved

The tombstone removes the profile's identifying fields. It does **not** remove: the player
identifier (stable across every retained record), the free text of reports and notes, the
140-character moderation excerpts (which may quote the child), the dates, the organisations and
staff involved, the ledger's event sequence, invoice descriptions and signing records that name
the player today, and any name copy the erasure misses. A reviewer with access to those records
may well identify the person. Whether each of those is retained, redacted or deleted is a
retention decision listed in §8; this document does not approve any of it.

## 5. What would be deleted, retained or anonymised

"Today" is verified from the code. "Proposed (S4b, unapproved)" is the plan's tombstone design
(§S4, schema §10) **as a proposal**; every row marked *review* depends on §8.

| Area | Today | Proposed (S4b, unapproved) |
|---|---|---|
| **Profile row** | deleted | kept as `id`, `deleted_at`, `name = 'Deleted player'`, the birth-date option chosen in §9, and `country` **only if the Founder approves keeping it** (needed to apply any threshold; two letters; a retention decision in its own right); every other column NULL; `facets_json` emptied (media, attendance, timeline, badges, drills, drill results, activity log, external ids, season history, trial-report copies) |
| **Guardian links** | removed from every `childIds` (S:4018) | `guardian_children` rows deleted; the guardian row untouched (no guardian deletion exists) |
| **Sessions, pairing codes, push tokens** | sessions revoked (S:3983); pairing codes deleted (S:4016); push tokens, verification tokens and passport share tokens **not removed** | sessions revoked; pairing codes deleted; push tokens, `verTokens` and passport shares for the subject deleted (new) |
| **Media** | files deleted first (S:3982); `boxSessions.clipMediaId` and campaign `mediaId` left dangling | files deleted **after** the database transaction commits, through a queue (readiness review §7.4); dangling media ids nulled in the same transaction |
| **Messages** | channels and messages hard-deleted, guardian–club threads included (S:4014); `moderationLog.context.channelId` left dangling | *review*: the repository's regulatory snapshot records a six-year record-keeping duty for agent communications (`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md:595–596, 657`, L-11 "NO/NO"); deleting conflicts with it, keeping conflicts with erasure |
| **Recruitment records** | id-only tombstones; names and words removed where the hooks reach; names kept on `recruitmentCases.history[].byName`, guardian names on offers/packages, `applications`, `campaignSubmissions`, `squadInvites`, `transitionCases`, `evidenceSuggestions` | same, plus every remaining name copy replaced in the same transaction; ids keep pointing at the tombstone |
| **Audit and safeguarding** (`ledger`, `blocks`, `reports`, `moderationLog`, `orgNotes`, `idvQueue`) | untouched; names survive in `ledger` message rows, excerpts, free text; ids dangle | rows kept (never pruned, schema §10) pointing at the tombstone; player/guardian `scoutName` replaced; **excerpts, reasons and notes kept** — *review* (§8 items 3) |
| **Commercial** (`signings`, `invoices`, `vouches`, `orgs[].squad[].name`) | names kept | names replaced; amounts, dates, org ids kept — *review* (invoices, §8 item 4) |
| **Analytics** (`exposureEvents`, `roomSnapshots`, `watchlistHistory`, `nobodyMissedReviews`, `secondLookItems`) | ids kept, no names | unchanged |
| **Guardian's own data** | untouched | untouched |
| **The deletion event** | not recorded | one ledger row (`player_deleted`, actor kind, actor id, time) — *review* (§8 item 9: recording a guardian's id) |

## 6. The birth-date options, with exact boundaries

Terms: B = birth date; Y_B = birth year; M_B = birth month; T = the threshold that applies (18
unless KR/TH/EG/SG — which requires knowing the country); X = the date of the event under
review; Y_X = its year. "Minor at X" means `ageOn(B, X) < T`: the person is a minor on X exactly
when X is before their T-th birthday. All options describe the *declared* date (§2); none is
verification. Any option other than C also presupposes a decision to keep `country`, or the
fixed-18 rule applies instead (which is wrong for KR/TH/EG/SG players).

### Option A — keep the full birth date

- Supports an **exact** answer to "minor on X" for any X, any T, forever; the relative-age
  quarter; any future age-based retention rule.
- Prevents nothing the code does today.
- Cost: the tombstone keeps a direct identifier of a child; combined with the retained records
  (§4) it narrows to an individual. The highest identifiability of the four. The schema's own
  note (§10) lists it as the "alternative".

### Option B — keep the birth year only

- The age on X is `Y_X − Y_B − 1` or `Y_X − Y_B`. So: `Y_X − Y_B ≤ T − 1` → certainly a minor on
  X; `Y_X − Y_B ≥ T + 1` → certainly an adult on X; `Y_X − Y_B = T` → **unknown** for every
  event in the whole calendar year the person reaches majority — the band a safeguarding
  reviewer most needs (17–18). With T = 18 and B in 2008, every 2026 event is unanswerable.
- Prevents the relative-age quarter and any exact age.
- Cost: low identifiability alone; an age cohort when combined.

### Option C — remove birth-date information entirely

- Supports only what stored flags support (§3.3), for the record's own time, with declared
  provenance: `requests.routedTo`, `recruitmentContacts.recipient.minor`,
  `recruitmentOffers.recipientSnapshot.minor` (inherited), the ledger suffixes; `trials.recipient.minor`
  only indirectly. Nothing for `blocks`, `reports`, `moderationLog`, `orgNotes`, `assessments`,
  `signings`, `invoices`, or any record written before a flag existed.
- Cost: none in identifiability. This is today's state (the row is gone); choosing it is
  choosing the status quo deliberately.

### Option D — a smaller derived value

- **D1 — birth year and month (`YYYY-MM`).** Age on X is unknown only when `Y_X − Y_B = T` **and**
  X falls inside the birth month: at most 31 days per person, against twelve months for B.
  Supports the relative-age quarter exactly. Identifiability: one twelfth of a year's cohort.
- **D2 — a status flag stamped when a record is written** (`blocks`, `reports`, `moderationLog`,
  `orgNotes`, `assessments`: `subjectMinor` plus `subjectMinorRule` and `subjectMinorBasis:
  'declared_dob'`, like `requests.routedTo` already does). Answers "minor **when this record was
  written**" exactly for every record written after the change, with no birth data on the
  tombstone. It does **not** answer the incident question for `reports` (no incident time), says
  nothing about records written before the change, nothing about any other date, and the
  relative-age quarter would need its own write-time snapshot on the assessment. It is a change
  in the safeguarding domain (S6), compatible with every option above.
- Not smaller: "date of majority" (`B + T years`) is B in another form; "age at deletion" is Y_B
  in another form.

## 7. Recommendation and justification

**Recommended: D2 as the durable mechanism (write-time status with rule and basis on safeguarding
rows, from S6), and D1 (birth year and month) on the tombstone only if the privacy/legal review
permits retaining any birth information after an erasure request.** If the review says no birth
information may be kept, Option C with D2 is the fallback, and the design degrades to it by
dropping one column.

- The code has no dependency that needs an exact date for a deleted account (§3.2); exactness
  matters only for human review, and D2 gives it by construction for every future safeguarding
  record while D1 bounds the historical ambiguity to 31 days. Option A's extra precision over
  D1 buys at most 31 days a year at the highest identifiability.
- Option B's ambiguity falls on the year of majority, which is the case a reviewer most needs.
- Option C alone leaves reviewers of `reports`/`blocks`/`moderationLog` about a deleted player
  unable to establish child status for anything written before D2 exists; with D2, C is
  acceptable if the Founder accepts that pre-S6 rows stay "unknown".
- The relative-age analytic is not a reason to keep birth data on tombstones (§3.2).

Implementation notes for S4b, whichever option: the retained value is written only by the
erase method; `isAdult` is never called on a tombstone; the repository exposes
`wasMinorOn(date)` returning `true | false | 'unknown'` with the rule above and the basis
`'declared_dob'`; `country` is retained only if approved; the readiness tests assert the three
answers at the boundaries (the day before the birth month, the first day, the day after).

## 8. Unresolved retention decisions and what needs qualified review

None of these is decided here; none is invented. Each is a statement found in the repository or
a gap in the code.

1. **Erasure versus record-keeping duties.** The agent regulatory snapshot records a duty to
   keep agent messages and call records for at least six years (FA rule 8.7;
   `M23_P56A_AGENT_REGULATORY_SNAPSHOT.md:595–596, 657`) and lists "erasure vs retention (GDPR;
   FA 8.7; FIFA duties)" as unresolved L-11 (`:771`). Today deletion hard-deletes every channel
   and message, including guardian–club threads shown to the admin thread audit (S:4255–4256).
2. **Health information.** `medical.records` and `m21` development data have no retention rule
   (`M21_DEVELOPMENT_HUB.md:189`; `m21/shared.mjs:143`).
3. **Audit free text and excerpts.** `moderationLog` and `reports` keep 140-character excerpts
   and reasons; `orgNotes` free text; `ledger` message rows a name. Whether text that may quote
   or describe a child may be retained indefinitely (`ledger`, `moderation_log`, `reports`,
   `ver_events` are "never pruned", schema §10) is for review. This is where §4's residual
   identifiability lives.
4. **Commercial records.** `signings` and `invoices` keep the name; the invoice `description`
   embeds it (`adapters.mjs:170–171`). Replacing it may conflict with accounting rules.
5. **Guardian data after a child's deletion.** Guardian notifications naming the child, `idvQueue`
   rows, the guardian account itself (no deletion route), co-guardian records (no password, no
   removal route) are untouched. Guardian deletion policy is undecided (schema §10 proposes
   "only when no undeleted child remains").
6. **Open retention windows** (schema O4): `outbox` and `pushLog` carry addresses, subjects and
   bodies with names; `exposureEvents`, `webhookDeliveries`, `dispatches` have no time-based
   retention; `'until_claim_resolution'` (`m14/index.mjs:104`) and `'until_signing_resolution'`
   (`m29/index.mjs:178`) are declared but unenforced (`05_verification_passport.sql:255`).
7. **Deleted-but-referenced media.** `boxSessions.clipMediaId` and campaign attempts keep ids of
   deleted files.
8. **Who may delete a child.** Any guardian listing the child, verified or not, including a
   co-guardian who cannot log in in production (readiness review §5.1).
9. **The unrecorded deletion.** No audit row says who deleted a profile; recording a guardian's
   id in a new ledger row is itself a retention choice.
10. **Country on the tombstone.** Needed to apply the country threshold to any retained birth
    information; a retention decision of its own.

## 9. The question for the Founder

> **After a player's account is deleted, which single piece of birth information may ScoutBox
> keep on the minimal record it retains for that player — the full birth date, the birth month
> and year, the birth year only, or none at all?**
>
> My recommendation is **none on the tombstone unless the privacy/legal review permits it, in
> which case the birth month and year**; in both cases, from the safeguarding step onwards,
> reports, blocks and moderation decisions should record whether the person was treated as a
> child **when that record was written**, with the rule and the fact that it rests on a declared
> birth date, so that future reviews do not depend on the tombstone at all.

The answer should also settle, in the same breath:

- whether the two-letter country code may stay on the retained record (without it no country
  threshold can be applied to whatever birth information is kept; the fixed-18 rule would apply
  instead, which is wrong for KR, TH, EG and SG players);
- whether the write-time status stamp (D2) is wanted from S6.

Until the Founder answers, O1 stays open in `sqlite-schema.md` §12, S4b does not start, and S4a
(the storage cutover in `s4-readiness-review.md`) keeps today's deletion behaviour unchanged.
