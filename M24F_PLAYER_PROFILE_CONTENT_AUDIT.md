# M24F.1 — Player profile: content audit (before)

The profile the player sees under **You › Profile** (and at `/profile`) before
this pass — `scoutbox-player/src/app/(tabs)/profile.tsx`, `ProfileBody` —
rendered, in one scroll, the following. Each element is classified for the
new four-section profile (Overview · Performance · Evidence · Journey).
Nothing is deleted: "move" means one tap deeper, in the section named.

Captures of the old profile: `design-system/screenshots/m24f1-before-profile-overview-390.png`, `-430.png`.

| # | Element (old profile, top to bottom) | Was | Classification |
|---|---|---|---|
| 1 | 128px avatar **card** with a 56px watermark squad number, initials and an empty "camera badge" circle | bordered card with a green shadow | KEEP ON OVERVIEW — as a 72px plain avatar (initials; no card, no number, no badge) |
| 2 | Name | 27px/800 | KEEP ON OVERVIEW — the strongest element (28px/700, wraps) |
| 3 | Sub-line "ST · 22 · Right Foot 🇬🇧" | position, age, foot and a **flag emoji** generated from the country code | KEEP position on the summary line; age and foot MOVE to the essentials list; the flag is REMOVED (the only product-authored emoji the M24F gate did not see: it was built with `String.fromCodePoint`, not a literal) |
| 4 | "Manchester, GB" | muted line | KEEP ON OVERVIEW — the summary line reads "ST · Manchester" |
| 5 | "184 cm · 79 kg" | muted line | MOVE TO PERFORMANCE (physical rows) |
| 6 | Pills: Identity verified, Guardian-managed, Finisher, Pressing Forward, Fresh Start | five pills | Verified → a square marker and the word on the header; Guardian-managed → one quiet word beside it; the three badges MOVE TO PASSPORT (`/football?tab=passport`, where the Football Passport already lists achievements) |
| 7 | "You're 18 — this account can become fully yours" card + Complete the handover | card | KEEP ON OVERVIEW as the one NEXT item when it applies and nothing in recruitment is waiting |
| 8 | **Profile completeness** card: 59 /100 in 54px, track + knob, "Profile coming along", Tier pill, streak pill, the six-part breakdown line, a 60-word explanation | the heaviest block on the page | MOVE TO EVIDENCE — one quiet line ("Profile 59% complete") with the breakdown behind a disclosure; the tier and the streak are on Home already (REMOVE AS DUPLICATE here) |
| 9 | **Season output** card: five stat tiles (Apps, Goals, Assists, Top speed, Pass accuracy), a "This Season ▾" pill, a goals bar chart, season-history rows with season pills | five bordered tiles + chart | MOVE TO PERFORMANCE as rows ("Appearances 31"), season by season as rows; no tiles, no chart, no pills |
| 10 | **Availability** card: five availability buttons, "Looking for my first team" switch + 25-word note, Contract status heading + four buttons | a card of controls | Availability word KEEP ON OVERVIEW (header: "Open to trials"); the controls MOVE TO SETTINGS (You › Account › "Availability and status") |
| 11 | Minor's availability card ("managed by your parent or guardian…") | card | MOVE TO SETTINGS (same disclosure, read-only note) |
| 12 | **Academy+** card: switch, "Player-controlled." boxed sub-row | card inside card | MOVE TO SETTINGS (Availability and status) |
| 13 | **Contract status** card: Contracted until, Market Value, Agent, a jersey number tile | card with a decorative jersey | MOVE TO SETTINGS as three read-only lines; the jersey tile is REMOVED (decorative) |
| 14 | **Where you stand — your cohort, not the pros** card: stat and drill rows with "top 25%" pills | card + pills | MOVE TO PERFORMANCE as rows, the percentile as text |
| 15 | **Coach references** card: rows with "verified ✓" pills, quote, request form (two inputs + button), 40-word pitch | card + form | MOVE TO EVIDENCE — rows with the state as a word; the form behind "Request a coach reference" |
| 16 | **Medical sharing — ON/OFF** card: switch, 30-word note, record rows with type pills | gold-bordered card | MOVE TO SETTINGS (Account › "Medical sharing") — it is a privacy control, not profile reading |
| 17 | **Trial performance reports** card: per report a figures line + notes, 15-word note | card | MOVE TO PERFORMANCE (club-filed measurements) |
| 18 | **Transfer timeline** card: year pills + event | card + pills | MOVE TO JOURNEY ("Earlier", year as text) |
| 19 | **Match footage** card: per clip a kind pill, title, views, tag pills ×n, the video | card, 2–4 pills per clip | MOVE TO EVIDENCE — content first (the video, then title · date · Verified clip · views), tags as one text line |
| 20 | **At-home combine** card: rows with verified / self-reported pills + note | card + pills | MOVE TO PERFORMANCE as rows (the state as a word) |
| 21 | **Your verified sports CV** card: 30-word pitch, View CV button, the CV text block | card | MOVE TO EVIDENCE behind a disclosure ("Verified sports CV"); the pitch copy is REMOVED |
| 22 | **Verified match attendance** card: rows with "coach-signed · club" / "GPS ✓" pills | card + pills | MOVE TO EVIDENCE as rows, the provenance as text |
| 23 | **Evidence passport** (M12 `PassportSection`): tiers, records with status pills, the add-evidence form | ruled section | MOVE TO EVIDENCE (kept as is: it is the evidence record) |

## Counts (old Overview, Kola Adeyemi seed, 390px)

| Measure | Old |
|---|---|
| Visible sections (headings) | 16 (completeness, season output, availability, contract status ×2, Academy+, cohort, references, medical, trial reports, timeline, footage, combine, CV, attendance, passport) |
| Cards / bordered surfaces | 17 cards + 5 stat tiles + 1 avatar card + 1 jersey tile + 1 boxed sub-row = 25 |
| Pills | 24 on the seed (identity, guardian, 3 badges, tier, streak, season ▾, 2 seasons, 3 cohort, 1 reference, 2 medical types, 3 timeline years, 2 clip kinds, 3 clip tags, 1 combine, 2 attendance) |
| Primary (green) actions | 9 (handover, 5 availability states, first-team switch, Academy+ switch, Request reference, View CV, medical switch — plus 4 contract-status buttons) |
| Explanatory prose | ≈ 330 words of helper copy |
| Metadata points on the first screen | 12 (number, initials, name, position, age, foot, flag, city, country, height, weight, 5 pills) |

## Major problems

- A database record: every stored field is on one screen, each in its own
  card, with its own explanation.
- Hierarchy: the completeness number (59) is the largest type on the page,
  larger than the player's name — a number that is explicitly "not a rating".
- Nine controls of equal weight on a presentation surface (availability,
  contract, Academy+, medical, first team, references, CV).
- Pills for ordinary metadata (seasons, years, clip kinds, record types).
- The one product emoji left in ScoutBox (the country flag).
- Nothing says what matters now: no current action, no recent activity.
