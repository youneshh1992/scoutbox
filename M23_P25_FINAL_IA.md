# M23 P2.5 — Final Information Architecture

The structure ScoutBox ships after P2.5, per app, with the rule that put
each destination where it is. **Sidebar = destinations; page tabs =
functions.** Screen ids, hash routes, visibility predicates and the server
are unchanged from the P2 tip; only the arrangement changed.

## 1. ScoutBox Pro (club recruitment)

```
Home                                              #/feed
Recruitment
  Discover      Players · Shortlist · Film Room · Scouting Insight
  Pipeline      Pipeline · Recruitment Rooms · Player Requests · Opportunities · Campaigns · Signings & Outcomes
  Evidence      Assessments · Evidence & Video · Trials & Reports · Trial Days
  Intelligence  Recruitment Briefs · Player Matching · Dynamic Watchlists · Second Look · Nobody Missed
  Analytics     Director Dashboard · Funnel · Discovery Ledger
Squad & Planning   Squad Planner · Coverage · Calibration · Fixtures
Network            Clubs & Groups · Representation
Organisation       Staff & Security · Verification · Integrations · Finance · Plan & Compliance · Reputation   (lead / verification authority)
Inbox              #/messages
```

Five sections (was six), 36 destinations (unchanged), 22 of them under
Recruitment in five groups of 3–6. Recruitment opens on Players.

| decision | rule applied |
|---|---|
| Discover folded into Recruitment as its first group | Players, Shortlist, Film Room and Insight are how a recruiter *finds* — the first step of recruitment, not a separate business. Keeping Players first preserves the most-used path. |
| Analytics inside Recruitment, not a sixth section | Dashboard, Funnel and Ledger are analytics *of recruitment*; a lead reads them beside the pipeline. A section with three read-only pages would be a section for its own sake. |
| Rooms, Briefs, Matching, Watchlists, Second Look, Nobody Missed placed by *what they do* | Rooms is where a case moves (Pipeline); the M18/M19 features generate candidates and judgements (Intelligence); assessments, video and trials are evidence (Evidence). |
| Organisation unchanged | Already a coherent admin section with its own visibility; grouping six pages would add a level without removing clutter. |
| Future Contact Workflow (M23 P3) | Will be a **tab inside a Recruitment Room**, not a destination. Offers (P4) likewise appear inside the Room and the Signings & Outcomes page; nothing is reserved in the sidebar. |

## 2. ScoutBox Grassroots

```
Home                                              #/feed
Players            Squad & Match Days · Coaches · Friendlies · Fixtures
Recruitment
  Discover      Players · Shortlist · Film Room · Scouting Insight
  Pipeline      Pipeline · Recruitment Rooms · Player Requests · Opportunities · Campaigns · Open Days · Signings & Outcomes
  Evidence      Assessments · Evidence & Video · Trials & Reports · Trial Days
  Intelligence  Recruitment Briefs · Player Matching · Dynamic Watchlists · Second Look · Nobody Missed
  Analytics     Director Dashboard · Funnel · Discovery Ledger
  Planning      Coverage · Calibration
Club               Clubs & Groups (everyone) · Staff & Security · Verification · Integrations · Plan & Compliance (lead / verification authority)
Inbox              #/messages
```

Four sections (was six), 35 destinations (unchanged).

| decision | rule applied |
|---|---|
| Team → **Players** | A grassroots club manages players, coaches and Saturday games; "Team" named the org, not the work. |
| Network folded into **Club** | A one-page section is a link, not a category. Clubs & Groups keeps its unconditional visibility, so a coach sees Club with exactly that page — asserted by navConfig ("no admin page leaks"). |
| Coverage & Calibration under Recruitment › Planning | Scout coverage and calibration are recruitment planning; Grassroots has no Squad & Planning section to hold them. |
| Open Days in Pipeline | An open day is a grassroots pipeline event (players register through their app). |

## 3. ScoutBox Player

```
Home            /discover        weekly report · pathway · clubs within reach · noticed · profile strength · watching · visibility · directory · promises
Football        /football        [Passport] [Development] [Box Cam] [Combine]     + Add evidence → /upload
Opportunities   /opportunities   board · opportunity fit · squad invitations · trial day & safety pack · placement check-ins
Inbox           /inbox           requests · threads (adults) · acknowledgements       (minors: "Updates")
You             /you             [Profile] [Account] [Clubs]
                /profile         (route kept; back control; body = You › Profile)
                /upload          (route kept; back control; reached from + Add evidence)
```

Five destinations (was five), two hidden routes, three page-tab sets.

| decision | rule applied |
|---|---|
| Football tab | The five football features shipped since M15 were sections 9–13 of "You". They are one thing — the player's football record — with four functions. |
| Passport tab composes Trust Score + Football Passport | M16.2's rule: the Passport payload carries no numeric score; the Trust Profile is fetched separately and shown at the head of the Passport. Unchanged. |
| Upload → `+ Add evidence` | Uploading is something you do to your football record, not a place. The screen, the campaigns and resumable upload are unchanged. |
| Opportunities tab | The concept had no home: the board and fit sat under Home, invitations and trial days under Inbox, follow-ups under You. |
| Profile → You › Profile | The player's own record and their account are one destination; Profile is its first function. The route stays for deep links. |
| You › Clubs | Everything a club has published to the player or the player shares with clubs: feedback, suitability preferences, transitions, representation, exposure, references. |
| Minors | Same tab set; what differs inside is driven by `isMinor` and enforced by the server, as before. Guardian accounts are redirected before the tabs render. |

## 4. Trust & Safety — unchanged

Home · Cases (4) · Verification (5) · Safety (4) · Operations (6) · System
(2). Flat sidebar, tab row, 66px top bar. See `M23_P25_NAV_PROPOSAL.md` §5
for why it was left alone.

## 5. Permission matrix (unchanged from P2)

| destination set | who sees it (client) | who the server serves |
|---|---|---|
| Home, Recruitment (all groups), Squad & Planning, Network, Inbox | every org member | every org member (per-route rules unchanged) |
| Organisation › Staff & Security, Verification, Reputation | lead-pattern role **or** verification authority | server checks role / verification level on every call |
| Organisation › Integrations, Finance, Plan & Compliance | lead-pattern role | server `isLead` |
| Grassroots Club › Clubs & Groups | everyone | everyone |
| Grassroots Club › admin pages | as Pro Organisation | as Pro |
| Player tabs | every player kind | per-route, minors guardian-routed |

Widening: **0** (navConfig asserts the visible-id sets per role are the
same sets the same predicates produced before). Routes removed: **0**.

## 6. Deep links, unchanged

`#/<screenId>` for every screen; `#/recruitment/rooms/:id`,
`#/recruitment/briefs/:id`, `#/recruitment/second-look`,
`#/recruitment/nobody-missed`, `#/recruitment/matching`,
`#/recruitment/watchlists`, `#/recruitment/dashboard`; notification types
map to screen ids via `NOTIFICATION_SCREEN`. Player: `/football?tab=boxcam`,
`/you?tab=account` etc. are new and additive.

## 7. Measured result

| surface | before | after |
|---|---:|---:|
| Pro phone top bar | 202px | 54px |
| Grassroots phone top bar | 157px | 54px |
| Desktop top bar | 66px | 58px |
| Desktop content start (section pages) | 111px | 58px |
| Desktop first meaningful element | 133px (Inbox 212) | 80px |
| Phone content start (section pages) | 247px | 93px |
| Phone Inbox first meaningful element | 388px | 68px |
| Recruitment strip (phone) | 15–16 tabs, 12–13 off-screen | 4–7 tabs, 0–3 off-screen |
| Room header desktop / phone | 336px / 653px | 141px / 357px |
| Room tabs reached at (desktop / phone) | 533px / 973px | 280px / 523px |
| Pro sections | 6 | 5 |
| Grassroots sections | 6 | 4 |
| Player "You" sections | 14 | 3 page tabs |
| In-content duplicate h2 | 17 per app | 0 |
