# Decision O1: what ScoutBox keeps about a player after their account is deleted

Written 11 October 2026 on branch `feat/sqlite-schema` at commit `d4ca3f2`, from reading the
code as it is today. **O1 is unresolved until the Founder answers the question in §8.** Nothing
in this document is implemented, and nothing here is legal advice: §7 lists what needs a
qualified privacy and legal review. Paths are relative to `scoutbox-server/`; `S:` is
`server.mjs`.

---

## 1. The decision in plain language

When a player (or the guardian of a child) deletes the account, ScoutBox removes the person's
profile. But the platform also holds records *about* that person that were created by other
people and that exist for their protection or for accountability: a club's safeguarding report
about a conversation, a block, a moderation decision, the record that a trial took place, a
signing, an invoice. Those records point at the player by an identifier. If the player's row
disappears completely, those pointers point at nothing, and anyone reviewing the record later
cannot tell even the basic facts about who it concerned — such as whether the person was a
child at the time.

A **tombstone** is the smallest possible record kept in the player's place after deletion: the
identifier, a note that the account was deleted and when, and nothing personal except what is
deliberately decided here. It exists so that the other records keep pointing at something
real, and so the platform can still answer the few questions those records require. Everything
that identifies the person — name, photos and clips, messages, medical notes, location,
preferences, password — is erased.

The one open question is the **birth date**. It is the most useful fact for safeguarding
review ("was this person a child when this happened?") and also one of the most identifying
facts about a person. This document sets out what the code actually needs, what each option
makes possible or impossible, and which option is recommended. The Founder decides.

## 2. What happens today (facts from the code)

- Only players can be deleted. `DELETE /player/account` (S:4027–4031, adults only; a minor
  gets `GUARDIAN_MANAGED`) and `DELETE /guardian/children/:id` (S:4041–4045, any guardian whose
  `childIds` lists the child, so a co-guardian too) both call `deletePlayerData`
  (S:3978–4023). There is no route to delete a guardian or an organisation, and no admin
  deletion.
- `deletePlayerData` **hard-deletes the player row** (S:3984), deletes the media files
  (S:3982), revokes the player's sessions (S:3983), deletes channels and messages including
  guardian–club threads (S:4014), the player's notifications (S:4015) and pairing codes
  (S:4016), removes the id from every guardian's `childIds` (S:4018), turns `requests` and
  `trials` into id-only tombstones (S:3955–3976, 3902–3952), nulls `playerName` on cases,
  assessments and open-day registrations (S:3993–4002), and calls the m24–m29 hooks (agent
  agreements, compliance contexts, transactions, offers, signing packages: names and words
  removed, ids and states kept).
- **The deletion itself is not recorded**: nothing logs who deleted the profile or when (only
  two modules write a history row, `m25/index.mjs:462`, `m26/index.mjs:1378`).
- **The birth date is stored in exactly one place: the player row (`dob`).** No other record
  copies it (the org-owned import `prospects` rows hold the importer's own dob,
  `m13/imports.mjs:155–159`). Every age or "minor" decision reads the live row.
- Some records store a **minor flag taken at the time**: `requests.routedTo` (`'guardian'`,
  S:2095–2126, 2729–2744, also the ledger type suffixes `_to_guardian` / `_by_guardian`),
  `trials.recipient.minor` (S:2155; `m23/trialRoutes.mjs:917` — set from who accepted, not
  from age), `recruitmentOffers.recipientSnapshot.minor` (`m28/index.mjs:463`),
  `representationAgreements.isRegulatoryMinor` (`m24/index.mjs:600`),
  `recruitmentContacts.recipient.minor` (`m23/contactRoutes.mjs:482`). The three safeguarding
  collections — `blocks` (S:617), `reports` (S:1648–1661, `targetPlayerId`), `moderationLog`
  (S:1028–1032) — store **no** minor flag and no age.
- Names survive deletion in `signings`, `invoices`, `vouches`, `applications`,
  `campaignSubmissions`, `squadInvites`, `verReferences`, `verPlayerInvites`,
  `transitionCases`, `evidenceSuggestions`, `orgs[].squad[].name`, `recruitmentCases.history`
  (`byName`), guardian responses on offers and packages, non-player notifications, `pushLog`,
  `outbox`, `ledger` message rows (`scoutName` is the player's or guardian's name, S:893), and
  the 140-character excerpts in `moderationLog`/`reports`. `pushTokens`, `verTokens` and
  passport share tokens are not removed. A deleted player's id stays in about forty
  collections (`s4-readiness-review.md` §2.4; the full list is in §4 below).
- One reader is not guarded against a missing row: `GET /org/shortlist` (S:2011–2013) passes
  `findPlayer(id)` straight into `playerViewForOrg`, which dereferences `player.id` (S:1054)
  — a TypeError after a shortlisted player deletes their account. Found by reading the code,
  not reproduced; every other reader treats a missing row as "removed" (`m28/index.mjs:149`,
  `m29/index.mjs:98`, `m23/decisionRoutes.mjs:102`, `m12/operations.mjs:48`, `m26/index.mjs:155`,
  `m27/index.mjs:183`, S:2529, S:4265).

## 3. What the code needs the birth date for — and whether any of it runs for a deleted account

The age function is `ageOnMs` (`temporal.mjs:339–347`): completed years in UTC, so a person
turns N at 00:00 UTC on their birthday and a 29 February birthday counts on 1 March. `isAdult`
(`domain.mjs:76–79`) is "age known **and** `>=` the country's threshold" (`ADULT_AGE`,
`domain.mjs:7–14`: 18 by default, KR 19, TH 20, EG 21, SG 21; the country is the player's
`country`). An unknown age is **not** adult. Two other rules use a fixed 18 regardless of
country: `isRegulatoryMinor` (`m25/policy.mjs:272`) and the passport representation display
(`m15/shared.mjs:743, 754`).

| Use | Boundary | Needs the live row? | After deletion |
|---|---|---|---|
| Signup refusal (S:1133–1142), child creation (S:1382–1385) | `< threshold` / `>= threshold` | yes (account creation) | never runs |
| `req.playerIsMinor` and ~60 `GUARDIAN_MANAGED` gates | `!isAdult` | yes (authenticated player) | never runs (no session) |
| `visibleToOrg` (`domain.mjs:110–121`): agencies never see a minor, unverified clubs never see a minor | `!isAdult` | yes | a deleted player is hidden (missing row → not visible), except the unguarded shortlist reader |
| Org views: `age`, `guardianManaged`, blank `city`, `contactPolicy` (S:1052–1081) | derived | yes | never runs |
| Age-group search (S:1907–1910, 2398–2401) | `u16 <16`, `u18 <18`, `18-21`, `senior >=22` | yes | never runs |
| Push mute in school hours (S:745, 753–755), no external e-mail for minors (`m13/delivery.mjs:41–46`) | `!isAdult` | reads the row per notification | a deleted id is treated as not a minor; nothing is sent to a deleted player anyway |
| Request routing to the guardian (S:2095–2126, 2729–2744) | `!isAdult` at write time | yes | the stored `routedTo` survives |
| Trial recipient audience (`m23/trialRoutes.mjs:241–249`) | `isAdult` read live | reads the row on a historical trial | returns null; changes to a tombstoned trial are refused (186, 878) |
| Contact recipient (`m23/contact.mjs:250–280`) | `isAdult(player, now)` | yes | `CONTACT_RECIPIENT_UNAVAILABLE` |
| Follow-up sweep (`m12/operations.mjs:306–307`) | `p && !isAdult(p)` | reads the row on a surviving follow-up | only the staff notification fires ("a signed player") |
| **Relative-age report** (`m13/insight.mjs:86–100`) | birth **quarter** (UTC month of `dob`) of each assessed player in the window | reads the row on surviving assessments | the deleted player's assessment stays in `total` but drops out of the quarter counts — the one analytic that would use a retained month |
| Import dedupe (`m13/imports.mjs:95`) | exact `dob` + name against `db.players` | yes | a tombstone has no name; a dob alone cannot dedupe |
| Opportunity/vacancy criteria (`m12/shared.mjs:101–103`, `m12/scouting.mjs:714–716`, `m19/match.mjs:52–57`) | `minAge`/`maxAge`, null fails closed | yes | never runs |
| Combine, Box Cam, passport, agents, offers, signing (`m16/*`, `m15/*`, `m24–m29`) | `isAdult` / `>= 18` | yes | skipped with `SUBJECT_REMOVED` / `SUBJECT_GONE` / `PARTY_REMOVED`; `m29/index.mjs:337` and `m29/signing.mjs:53, 159` use the **stored** `recipientSnapshot.type === 'guardian'` as the minor stand-in |
| Compliance re-evaluation (`m25/index.mjs:447` → `m25/conflict.mjs:139–143`) | `isMinor: pl ? !isAdult(pl) : false` | reads the row on historical contexts | a deleted player is `removed` → fails closed |
| `earliestPermittedApproachAt` (`m25/policy.mjs:296–319`: 1 September of the academic year of the 16th birthday; FIFA six months before first-contract age) | exact date | — | **no production caller** |

**Conclusion from the code:** no code path computes a deleted player's age. Every rule either
needs an authenticated player, treats a missing row as "removed" and fails closed, or reads a
minor flag that was stored when the record was written. The only computation that would
*benefit* from retained birth information is the relative-age report (quarter of birth), and
the only facts no record stores are the minor status at the time of a **block, report or
moderation decision**. The need for a birth date on the tombstone is therefore not a software
dependency today; it is a question of what a human reviewer of a safeguarding or audit record
should be able to establish later. The options below are judged against that.

## 4. What would be deleted, retained or anonymised

"Today" is the current hard delete; "with a tombstone" is the S4b design in the plan (§S4 and
schema §10), independent of the birth-date option.

| Area | Today | With a tombstone (S4b) |
|---|---|---|
| **Profile row** | deleted | kept as `id`, `deleted_at`, `country` (needed by any age rule), the birth-date option chosen here, `name = 'Deleted player'`; every other column NULL (`password_hash`, `city`, `position`, `foot`, height/weight, stats, medical, location, prefs, programme, level, availability, contract, identity flags, `guardian_id`); `facets_json` emptied (media, attendance, timeline, badges, drills, drill results, activity log, external ids, season history, trial-report copies) |
| **Guardian links** | removed from every `childIds` (S:4018) | `guardian_children` rows deleted; the guardian row untouched (no guardian deletion exists; S4b may add one only for guardians with no undeleted child, if the Founder wants it) |
| **Sessions, pairing codes, push tokens** | sessions revoked (S:3983); pairing codes deleted (S:4016); **push tokens, verification tokens and passport share tokens not removed** | sessions revoked; pairing codes deleted; push tokens for the account deleted; `verTokens`/passport shares for the subject deleted (new; each is a one-line filter) |
| **Media** | files deleted (S:3982); `boxSessions.clipMediaId` and campaign `mediaId` left dangling | files deleted; dangling media ids on Box Cam sessions set to null in the same transaction |
| **Messages** | channels and messages hard-deleted, guardian–club threads included (S:4014); `moderationLog.context.channelId` left dangling | **unresolved**: the repository's own regulatory snapshot records a six-year record-keeping duty for agent communications (`M23_P56A_AGENT_REGULATORY_SNAPSHOT.md:595–596, 657`, item L-11 "NO/NO"); deleting the threads may conflict with it, keeping them conflicts with erasure. §7 |
| **Recruitment records** (`requests`, `trials`, `recruitmentCases`, `assessments`, `recruitmentContacts`, `openTrials`, offers, agreements, transactions, signing packages) | id-only tombstones; names and words removed where the hooks reach; `recruitmentCases.history[].byName`, guardian names on offers/packages, `applications`, `campaignSubmissions`, `squadInvites`, `transitionCases`, `evidenceSuggestions` keep names | same, plus every remaining name copy on a record that references the subject replaced in the same transaction (the plan's "explicit erasure of name snapshots"); the id keeps pointing at the tombstone |
| **Audit and safeguarding** (`ledger`, `blocks`, `reports`, `moderationLog`, `orgNotes`, `idvQueue`) | untouched; names survive in `ledger` message rows (`scoutName`), excerpts and free text; the player id dangles | rows kept (never pruned, schema §10); `player_id` references the tombstone (`RESTRICT`); `scoutName` of player/guardian actors replaced; **excerpts and free-text reasons are kept** (they are the evidence the report exists for) — this is a retention decision for review, §7 |
| **Commercial** (`signings`, `invoices`, `vouches`, `orgs[].squad[].name`) | names kept | names replaced by the tombstone name; amounts, dates, org ids kept. `vouches` keep the coach's own data. Whether an invoice may lose the counterparty's name is an accounting/legal question, §7 |
| **Analytics** (`exposureEvents`, `roomSnapshots`, `watchlistHistory`, `nobodyMissedReviews`, `secondLookItems`) | ids kept, no names | unchanged (ids point at the tombstone) |
| **Guardian's own data** | untouched | untouched |
| **The deletion event** | not recorded | one ledger row (`player_deleted`, actor kind `player` or `guardian`, actor id, time) — the audit trail the design otherwise lacks |

## 5. The birth-date options, with exact boundaries

Terms: B = birth date; Y_B = birth year; M_B = birth month; T = the country's majority
threshold (18 unless KR/TH/EG/SG); X = the date of the event being reviewed; Y_X = its year.
"Minor at X" means `ageOn(B, X) < T`. The age on X is the number of completed years, so a
person is a minor on X exactly when X is before their T-th birthday.

### Option A — keep the full birth date (`birth_date` unchanged)

- Supports: an **exact** answer to "was this person a minor on X" for any X and any
  threshold, forever; the relative-age quarter; any future retention rule expressed in age
  ("N years after the subject turned T").
- Prevents: nothing the code does today.
- Cost: the tombstone keeps a direct identifier of a child (date of birth plus country plus
  the set of organisations and dates the surviving records name). A later disclosure of the
  database discloses a deleted child's exact birth date. The schema's own note (§10) says
  this is the "alternative"; it needs the privacy review in §7 regardless.

### Option B — keep the birth year only (`birth_year`, 4 digits)

- Supports: a **bounded** answer. The age on X is either `Y_X − Y_B − 1` (before the birthday
  that year) or `Y_X − Y_B` (on or after it). So:
  - `Y_X − Y_B ≤ T − 1` → **certainly a minor** on X (even after the birthday, age ≤ T − 1);
  - `Y_X − Y_B ≥ T + 1` → **certainly an adult** on X (even before the birthday, age ≥ T);
  - `Y_X − Y_B = T` → **unknown**: the person turned T at some point in year Y_X, before or
    after X. This ambiguity covers a full twelve-month window for every event in the year the
    person reaches majority — exactly the age band safeguarding review cares most about
    (17–18). With T = 18 and B in 2008, every event in 2026 is unanswerable.
- Prevents: the relative-age quarter (needs the month); any exact age; the ambiguous year above.
- Cost: low identifiability on its own (a year is shared by many); combined with surviving
  records it narrows the person to an age cohort.

### Option C — remove birth-date information entirely

- Supports: only what stored snapshots support — `requests.routedTo`, `trials.recipient.minor`,
  `recruitmentOffers.recipientSnapshot.minor`, `representationAgreements.isRegulatoryMinor`,
  `recruitmentContacts.recipient.minor`, and the ledger type suffixes. For those records the
  minor status at the time is known exactly (as recorded then).
- Prevents: any statement about age for `blocks`, `reports`, `moderationLog`, `orgNotes`,
  `assessments`, `signings`, `invoices`, messages (if retained), and every record written
  before a snapshot flag existed — a reviewer of a safeguarding report about a deleted player
  cannot establish whether the subject was a child. Also prevents the relative-age quarter.
- Cost: none in identifiability. This is what happens today (the row is gone), so choosing it
  is choosing the status quo deliberately rather than by accident.

### Option D — a smaller derived value

Two derived values were examined.

- **D1 — birth year and month (`birth_year_month`, `YYYY-MM`).** The age on X is unknown only
  when `Y_X − Y_B = T` **and** X falls inside the birth month (before or after the exact
  birthday within that month): an ambiguity window of at most 31 days per person, against
  twelve months for Option B. Everything outside that window is answered exactly. It also
  supports the relative-age quarter exactly. Identifiability is one twelfth of a year's
  cohort — much lower than a full date, higher than a year.
- **D2 — a minor flag stamped at write time on the records that lack one** (`blocks`,
  `reports`, `moderationLog`, `orgNotes`, `assessments`: `subjectMinor` = `!isAdult(player)`
  when the row is written, as `requests` and `trials` already do). This answers "was the
  subject a minor when this happened" **exactly and without any birth data on the tombstone**,
  for every record written after the change. It cannot answer for records written before it,
  for a date other than the record's own, or for the relative-age quarter. It is a code
  change in the safeguarding domain (S6), not a tombstone column, and it is compatible with
  every option above.
- Values that are not smaller: "the date the person reaches majority" (`B + T years`) is the
  birth date in another form; "age at deletion" is the birth year in another form (less
  useful, since the deletion date is already stored).

## 6. Recommendation and justification

**Recommended: Option D1 (birth year and month) on the tombstone, together with D2 (a minor
flag stamped at write time on safeguarding rows) when S6 touches those tables.**

Why not A: the code has no dependency that requires an exact date for a deleted account
(§3); exactness is wanted only for human review, and D1 delivers it for every day except at
most 31 days per person. Keeping a deleted child's exact birth date for that marginal gain is
the choice with the highest identifiability and the one most likely to be questioned in a
privacy review.

Why not B: the twelve-month ambiguity falls precisely on the year a person turns 18 (or 19–21),
which is the period a safeguarding reviewer most needs to resolve; B gives the appearance of
retained age information while failing the main case.

Why not C alone: it leaves a reviewer of a `reports`/`blocks`/`moderationLog` row about a
deleted player with no way to establish that the subject was a child, which is the fact that
decides how such a report is handled; it also discards the relative-age analytic. C becomes
acceptable only if D2 is implemented first and the Founder accepts that pre-S6 rows stay
unanswerable.

Why D1 + D2: D2 removes the dependency on the tombstone for every future safeguarding record
(exact, by construction); D1 covers the historical rows and the analytic with a bounded, small
ambiguity and a small identifier. The tombstone also keeps `country` (two letters; without it
no threshold can be applied) and `deleted_at`. Implementation note for S4b: the column is a
7-character `TEXT CHECK (length = 7)` replacing `birth_date` on erase (`birth_date` set NULL),
`isAdult` is never called on a tombstone (the repository exposes `wasMinorOn(date)` returning
`true | false | 'unknown'` with the rule in §5 D1), and the readiness tests assert the three
answers at the boundaries: the day before the birth month, the first day of the birth month,
the day after it.

This is a recommendation on technical grounds. Whether any birth information may be retained
after an erasure request, and for how long, is for the privacy/legal review in §7; if that
review says "nothing", Option C with D2 is the fallback and the design above degrades to it by
dropping one column.

## 7. Unresolved retention decisions and what needs qualified review

None of these is decided here; none is invented. Each is a statement found in the repository
or a gap found in the code.

1. **Erasure versus record-keeping duties.** The agent regulatory snapshot records a duty to
   keep agent messages and call records for at least six years (FA rule 8.7;
   `M23_P56A_AGENT_REGULATORY_SNAPSHOT.md:595–596, 657`) and lists "erasure vs retention (GDPR;
   FA 8.7; FIFA duties)" as unresolved item L-11 (`:771`). Today deletion hard-deletes every
   channel and message, including guardian–club threads shown to the admin thread audit
   (S:4255–4256). Which records must survive an erasure request, and for how long, needs legal
   review before S4b decides what `deletePlayerData` keeps.
2. **Health information.** Medical records (`medical.records`, `m21` development data) have no
   retention rule (`M21_DEVELOPMENT_HUB.md:189`; `m21/shared.mjs:143`). The tombstone design
   deletes them with the profile; whether anything about them must be kept is a review item.
3. **Audit free text.** `moderationLog` and `reports` keep 140-character excerpts and reasons,
   `orgNotes` free text about the player, `ledger` message rows a name. The tombstone design
   replaces names and keeps excerpts and reasons as evidence. Review: is an excerpt that
   quotes a child acceptable to retain indefinitely (`ledger`, `moderation_log`, `reports`,
   `ver_events` are "never pruned", schema §10)?
4. **Commercial records.** `signings` and `invoices` keep the player's name; the invoice
   `description` embeds it (`adapters.mjs:170–171`). Replacing the name on an issued invoice
   may conflict with accounting rules; keeping it conflicts with erasure. Review.
5. **Guardian data after a child's deletion.** Guardian notifications naming the child, `idvQueue`
   rows (`guardianName`, last four of a document reference), the guardian account itself (no
   deletion route) and co-guardian records (no password, no removal route) are untouched.
   Whether a guardian may delete their own account, and what then happens to a remaining child,
   is undecided (schema §10 proposes "only when no undeleted child remains").
6. **Open retention windows** (schema O4): `outbox` and `pushLog` carry recipient addresses,
   subjects and bodies with names; `exposureEvents`, `webhookDeliveries`, `dispatches` have no
   time-based retention; the labels `'until_claim_resolution'` (`m14/index.mjs:104`) and
   `'until_signing_resolution'` (`m29/index.mjs:178`) are declared but enforced by nothing
   (`05_verification_passport.sql:255`).
7. **Deleted-but-referenced media.** `boxSessions.clipMediaId` and campaign attempts keep ids
   of deleted files; harmless to the user, but the records claim evidence that no longer exists.
8. **Who may delete a child.** Any guardian listing the child, verified or not, including a
   co-guardian who cannot log in in production (`s4-readiness-review.md` §5.1). Whether deletion
   should require the primary, or a verified guardian, is a product decision.
9. **The unrecorded deletion.** No audit row says who deleted a profile. S4b proposes one
   ledger row; the review should confirm that recording the actor (a guardian's id) is itself
   acceptable.

## 8. The question for the Founder

> **After a player's account is deleted, which single piece of birth information may ScoutBox
> keep on the minimal record it retains for that player — the full birth date, the birth month
> and year, the birth year only, or none at all?**
>
> My recommendation is **the birth month and year**, kept together with the two-letter country
> code and the deletion date, so that a later safeguarding review can tell whether the person
> was a child when a report, block or moderation decision was made (exactly, except for at most
> 31 days a year around the birthday), while the exact birthday itself is no longer stored.

Two follow-up confirmations the answer should include, because the design depends on them:

- Whether the country code may stay on the retained record (without it no age rule can be
  applied to whatever birth information is kept).
- Whether ScoutBox should, from S6 onwards, stamp "the subject was a child at the time" on
  safeguarding reports, blocks and moderation decisions when they are written, so that future
  reviews never depend on the retained birth information at all.

Until the Founder answers, O1 stays open in `sqlite-schema.md` §12, S4b does not start, and
S4a (the storage cutover in `s4-readiness-review.md`) keeps today's deletion behaviour
unchanged behind a repository method.
