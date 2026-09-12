# M18.2 — Player ordering and sorting audit

Every surface that presents players (or player-shaped records) in an order,
with the rule it uses, whether the order is deterministic, and whether it could
be read as a quality judgement. The rule M18.2 enforces:

> Every list is ordered by a **declared, deterministic** rule that ends on a
> stable tie-break, and no default ordering is a ranking of player quality.

"Deterministic" means two reads of the same data return the same order. A sort
that ends on a value two players can share (a completeness figure, a timestamp
that can tie) without a tie-break is not deterministic, because JavaScript's
sort is stable only relative to the input order, and the input order is
whatever the snapshot store happened to load.

The Discover ordering was deliberately **not** replaced (mandate: "do NOT
casually replace it with a new algorithm"). It was kept, made deterministic,
declared on the wire and stated to the person. That is option A of the three
the mandate allowed.

## Legend

- **Default sort** — what the person sees with no selection.
- **Secondary / tie-break** — what decides between equal primaries.
- **User-selectable** — sorts the person can choose.
- **Numeric?** — is any sort key a number that could be read as a score.
- **Quality implication** — could the order be mistaken for "better players
  first"? The honest answer, and what prevents the misreading.
- **Auth changes set?** — does the visible set (not the order) depend on who
  is asking. Ordering is never a substitute for visibility rules.

## Server surfaces

| # | Surface (route) | Default sort | Secondary / tie-break | User-selectable | Numeric? | Quality implication | Auth changes set? | M18.2 change |
|---|---|---|---|---|---|---|---|---|
| S1 | Discover, Pro (`GET /org/players`) | Academy+ opt-in first | profile completeness desc → **player id** | none | completeness (0–100) | **Could be misread.** Completeness is how much of a profile is filled, not ability or the Trust Score. Declared as `X-ScoutBox-Ordering: academy_plus,profile_completeness,player_id` and stated in the UI (`data-ordering`). | yes — visibility, blocks, radius, verification | id tie-break; header; UI sentence |
| S2 | Discover, Grassroots (`GET /org/players`, grassroots org) | First Team Seekers first | distance asc → completeness desc → **player id** | none | distance km, completeness | Distance is geography. Completeness as S1. Declared as `first_team_seeker,distance,profile_completeness,player_id`. | yes — 50 km platform rule | id tie-break; header; UI sentence |
| S3 | Discover "similar players" (`/org/players/:id/similar`) | similarity desc | none | none | similarity | A similarity figure between two profiles, not a rank of either. Displayed as "similar", never "better". Set is capped. | yes | none — the figure is pairwise, and ties are shown as equals |
| S4 | Legacy score sorts (`server.mjs` ~1700, `.sort((a,b) => b.score - a.score)`) | score desc | none | none | score | **Internal to a pre-M12 endpoint** (opportunity fit). Not exposed on any M15+ surface; kept for the old contract. Documented, not extended. | yes | documented as legacy |
| S5 | Film Room deck (`/org/deck`) | verified clip first | views desc | none | views | Popularity of a clip, not quality of a player. Label says "views". | yes | none |
| S6 | Ledger / activity (`items.sort(b.ts - a.ts)`) | newest first | none (ids monotonic) | none | time | none | yes | none — ids are monotonic so a ms tie keeps insertion order |
| S7 | Nearby / grassroots distance (`~3145`) | distance asc | none | none | km | none | yes (radius) | none |
| S8 | Recruitment Rooms list (`GET /org/rooms`) | last activity desc | **room id** | view filters (mine, assigned, shortlisted, trials, offers, archived), text | time | none — activity, not merit | yes | already deterministic since M17 |
| S9 | Room comments | newest first | **comment id** | none | time | none | yes | already deterministic |
| S10 | Room decisions | oldest first (append-only history) | id sequence | none | time | none | yes | already deterministic |
| S11 | Room needs-attention (`/rooms/needs-attention`) | rule order | rule id | none | none | Signals are workflow facts ("no decision in 14 days"); the response says "ScoutBox does not rank or score these for you". | yes | none |
| S12 | Second Look (`GET /org/second-look`) | relevance kind (direct reason → new evidence → removed → general) | newest material change → item id | none | none | Kinds are *why it resurfaced*, never *how good the player is*. The disclaimer is on every item. | yes | none |
| S13 | Nobody Missed (`GET /org/nobody-missed`) | newest evidence | **player id** | newest_evidence, last_reviewed, name, distance, evidence_confidence | distance, Trust Score band | `evidence_confidence` sorts by the Trust Score band — this IS a quality-adjacent figure, but it is the person's explicit choice, it is labelled "evidence confidence", and it is never the default. | yes (brief criteria + visibility) | already deterministic since M18 |
| S14 | Recruitment Briefs list | last updated desc | none | none | time | none | yes | timestamps from one clock; ties resolve by store order — acceptable for a small per-org list, noted |
| S15 | Evaluation coverage | brief order (S14) | — | none | counts | Counts are coverage, and are suppressed below the minimum so they cannot single anyone out. | yes | none |
| S16 | Assessments / cases (M12 `scouting.mjs`) | newest first | none | none | time | none | yes | none |
| S17 | Tactical fit (M12 `scouting.mjs:663`) | required criteria met desc | unknowns asc | none | counts | **Could be misread.** These are counts of the club's own stated requirements that a profile satisfies, not a rating. The screen names them "required met / unknown". Pre-M15 surface; unchanged, documented. | yes | documented |
| S18 | Trust & Safety reports (`db.reports`) | severity rank, then oldest open first | time | none | rank | Reports, not players. | admin only | none |
| S19 | Combine attempts / Box sessions (M16) | newest first | none | none | time | Measurements are shown with their protocol; ordering is by time only. | yes | none |
| S20 | Passport rows (M15 `shared.mjs:414`) | most recent period first | **key** | none | time | none | yes | already deterministic |
| S21 | Audit log (`GET /org/audit`, new) | newest first | **row id** | none | time | none — operational history | lead only | new, deterministic by design |
| S22 | Planning / insight (M13) | fixture date, target count | — | none | counts | Counts of targets near a fixture; a planning aid, not a player ranking. | yes | none |

## Client surfaces (web apps, live mode)

The web apps do not re-sort what the server sends, with three exceptions, all
by time:

| # | Surface | Sort | Tie-break | Quality implication |
|---|---|---|---|---|
| C1 | Room comment thread (`roomsScreens.tsx`) | roots newest first, replies oldest first | server order (ids) | none |
| C2 | Room decision history (`roomsScreens.tsx`) | newest first | server order | none |
| C3 | Command palette (`nav.ts`) | match score asc, then label | label | Destinations, not players |

Everything else renders in server order, which is why the server order had to
be deterministic and declared.

## Client surfaces (demo mode)

The demo stores (`demo.ts`, `m12demo.ts`, `m18Demo.ts`, `roomsDemo.ts`) mirror
the server rules with the same tie-breaks (`m18Demo.ts:692` and
`roomsDemo.ts:605` end on ids). `demo.ts:367` mirrors the Pro Discover sort
using the demo's `trustScore` field as the completeness stand-in — that field
is the demo's *completeness* figure and the Discover screen labels it "Profile
completeness" (M18.1). No demo sort claims to be a quality rank.

## What is deliberately unchanged

- **Discover** keeps Academy+ → completeness (Pro) and Seekers → distance →
  completeness (Grassroots). The alternatives the mandate allowed (alphabetical
  default, or a "recently updated" default) were not taken: the person now
  reads exactly what the order is and what it is not, and a change to the
  order itself is a product decision for M19 with Explainable Matching, not a
  cleanup.
- **`evidence_confidence`** stays a selectable Nobody Missed sort. It is
  explicit, labelled, and never the default.
- **Tactical fit** and the legacy score sort stay as they are, documented above.

## What M18.2 verified

- `m182E2E §7` — both Discover sorts end on the player id; the ordering header
  names no score; Nobody Missed and Second Look tie-break rules exist; both
  Discover screens state their ordering.
- `m182E2E §27` — two reads return the same order; the body follows the
  declared rule exactly; the Pro and Grassroots headers differ as declared.
- `m182Live J9` — the statement is on screen and says "not ability"; the order
  is identical across a reload.
