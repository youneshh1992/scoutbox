# Navigation, information architecture and terminology

Where things live in each app, the rules navigation must follow, and the product vocabulary.

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## How it works

### Hard navigation rules
- **Navigation visibility is never authorisation.** Filtering is a client convenience; the server answers 401/403/404 by its own rules on every route, hidden or not. (NAVIGATION_ARCHITECTURE)
- **No feature loss.** Every legacy screen keeps its id and deep link and appears exactly once in the config per app; no route removed. (NAVIGATION_ARCHITECTURE, M23_P25_FINAL_IA)
- **Sidebar = destinations; page tabs = functions.** Per-case functions (Contact, Offer, Trial) are Room tabs, never destinations. (M23_P25_FINAL_IA, M23_P25_HEADER_CONTRACT)
- **Max five per category, three to four is the target.** Enforced as data by validators in each `nav.ts`, `navGroups.ts` and `design-system/caseNav.ts`. Depth is section → group → page, never deeper. No headings without a screen behind them. (M24D_NAVIGATION_IA, M24_RECRUITMENT_NAVIGATION_IA)
- **Groups are presentation only** (no visibility, routes or permissions); an empty group isn't drawn. One config (`src/nav.ts` per app) drives sidebar, flyouts, phone strip, palette, location resolver and shortcuts. (NAVIGATION_ARCHITECTURE)
- **Case categories are UI labels only**: never persisted or sent to the server; the server's journey projection is canonical. A page an audience may not see is absent from the DOM, never rendered hidden. (M24_RECRUITMENT_NAVIGATION_IA)

### Role-aware visibility (Pro/Grassroots, convenience only)
- Ordinary scout: Home, Recruitment, Squad & Planning, Network, Inbox. Organisation is hidden entirely, never shown empty.
- Lead-pattern role (`/head|director|lead|manager|owner|chief/i`, the same pattern as the server's `isLead`): all of Organisation.
- Verification authority without a lead role (`/org/verification/me`): Staff & Security, Verification, Reputation. Integrations, Finance and Plan stay lead-only.
- Grassroots Clubs & Groups is visible to everyone, so a coach sees a Club section holding only that page.
(NAVIGATION_ARCHITECTURE, M23_P25_FINAL_IA)

### Current per-app structure (confirmed in code)
- **Pro:** Home · **Recruitment** [Discover: Players, Shortlist, Film Room, Scouting Insight | Pipeline: Cases, Recruitment Rooms, Player Requests, Opportunities | Outreach: Campaigns, Recruitment Briefs | Evaluation: Assessments, Evidence & Video, Trials & Reports, Trial Days | Intelligence: Player Matching, Dynamic Watchlists, Second Look, Nobody Missed | Outcomes: Signings & Outcomes | Analytics: Director Dashboard, Funnel, Discovery Ledger] · **Squad & Planning** (Squad Planner, Coverage, Calibration, Fixtures) · **Network** (Clubs & Groups, Representation) · **Organisation** [Administration: Staff & Security, Verification, Reputation | Operations: Integrations, Finance, Plan & Compliance] · **Inbox** utility. Recruitment opens on Players. (M24D_NAVIGATION_IA)
- **Grassroots:** Home · **Players** (Squad & Match Days, Coaches, Friendlies, Fixtures) · **Recruitment** (as Pro, plus Open Days in Outreach and a Planning group with Coverage and Calibration; no Pro-only pages) · **Club** (Clubs & Groups, Staff & Security, Verification, Integrations, Plan & Compliance; ungrouped) · Inbox. (M24D_NAVIGATION_IA, NAVIGATION_ARCHITECTURE)
- **Player (bottom bar, five):** Home `/discover` · Football `/football` (Passport, Development, Box Cam, Combine; "+ Add evidence" → `/upload`) · Opportunities · Inbox (labelled **Updates** for minors) · You. Same tab set for every player kind; minor differences enforced server-side; guardians are redirected before the tabs. (M23_P25_FINAL_IA)
  - **Opportunities categories:** My journey (Overview, Activity, Board) · Club contact (Messages, Contact) · Trial (Invitation, Schedule, Details) · Offer (Offer, Documents, Response) · Signing (Signing, Documents, Contract). Links use `?cat=&tab=`. Legacy links (`?cat=board`, `?tab=board-*`, `?tab=stage`, `?tab=tasks`) still resolve via `PLAYER_LEGACY_SUBS`. Nothing club-private is shown (assessments, decision rationale, Room discussion, shortlist, notes). Replying stays in the Inbox. (M24D_NAVIGATION_IA, M24_RECRUITMENT_NAVIGATION_IA)
  - **You › Clubs** (`?section=`): Current (club, agent, representation, transition, exposure) · Requests · Development (feedback, objectives, progress; full text behind "View details") · History. (M24F2_PLAYER_CLUBS_IA)
  - **You › Account:** a root list of Profile · Privacy · Preferences · Appearance, then Switch account and Sign out. No Security row until something real exists behind one. Suitability preferences live under Preferences, not Clubs. Safeguarding content sits under Privacy, moved, never dropped. Sections come from the URL, never stored. (M24F2_PLAYER_ACCOUNT_IA)
- **Agent:** Home (Home, Profile, Compliance) · Clients · Transactions · Opportunities · Agency, plus Inbox. Every section holds at most three pages. (M24D_NAVIGATION_IA; code `scoutbox-agent/src/nav.ts`)
- **Trust & Safety:** nine groups: Home · Cases · Evidence · Verification (five, the largest) · Safety · Operations · Delivery & Billing · Agents · System. The admin app gets no recruitment case navigation and must not become a recruitment decision-maker. (NAVIGATION_ARCHITECTURE, M24_RECRUITMENT_NAVIGATION_IA)

### Case navigation (category → subcategory)
- **Pro Room:** Overview (Summary, Journey, Tasks, Activity) · Player (Passport, Combine, Development) · Evaluation (Evidence, Assessments, Decision, Second Look) · Engagement (Discussion, Contact, Trial, Inbox) · Deal (Offer, Signing, Documents) · History (Timeline and four read-only "Previous …" lists).
- **Grassroots Room:** Overview · Player review · Recruitment · Agreement · History.
- **Agent client:** Overview · Player · Recruitment · Transaction · History; **transaction:** Workspace · Records.
- Discussion (internal) comes before Contact and never travels. No new document store. Clubs never disclose Offer or signing documents to an agent.
- **Deep links:** `#/recruitment/rooms/:id/<category>/<sub>`; old flat `…/:id/<tab>` forms (emitted by server notifications) still resolve; malformed segments open nothing. Every route re-authorises server-side. (M24_RECRUITMENT_NAVIGATION_IA)

### Sidebar, phone strip, palette, shortcuts
- **Sidebar accordion:** one section and one group open, following the current page; group headings are buttons, never links; state not persisted. Phone shell at ≤ 900px (column drawer), desktop at 901px+. (M24D_NAVIGATION_IA)
- **Phone strip:** shows only the active group's pages. Up to four (Intelligence: 3) shows whole; otherwise `primary` pages plus an explicit **More** menu. Invariant: strip ∪ More = the accordion's pages, in order; nothing clips or scrolls sideways at 360px. (NAVIGATION_ARCHITECTURE §11a)
- **Command palette** (⌘K/Ctrl+K) searches permitted destinations only; aliases can't bypass the filter. **Shortcuts:** up to five pins by item id in localStorage, re-validated on load.
- **Badges:** only Inbox unread and the T&S Cases pending-reports count.

### Page header contract
- The top bar is one row: hamburger (phone only), the **only `h1`** (`<section> / <page>`, text = nav label), live state, bell, Report/Block (never removed; glyph + `aria-label` under 640px).
- Screens draw no `h2` repeating the title and no explanatory prose. A one-line `.pagehint` only for a material constraint; status warnings stay.
- **Room entity header:** one identity row plus one disclosure. The Trust Score disclaimer ("evidence confidence, not football ability") and the "never ranked by Trust Score" line are **never collapsed**. The conflict notice sits above everything.
- **Adding a page:** id in `nav.ts` and a group, EN and FR labels, no title drawn. (M23_P25_HEADER_CONTRACT)

### Glossary: recruitment lifecycle (M23_TERMINOLOGY)

| Term | Meaning | Avoid / it is NOT |
|---|---|---|
| Recruitment Case | One club pursuing one player; one open per org+player | A second pipeline |
| Recruitment Room | Club-private workspace on a case | A separate pipeline |
| Lifecycle status | `case.room.status`, one of 18 values, written by one function | A UI state or a measure of the player |
| Stage | The M12 vocabulary, **derived** from status (status → stage only); not writable on a Room case | Writing a stage back into a status |
| Recruitment Journey | A viewer-safe projection computed on read | Stored (`db.recruitmentJourneys` must never exist) |
| Internal interest | The club has opened a case before any contact; org-private and undetectable (a probe gets a response byte-identical to "no case") | Anything the player could infer |
| Contacted | Contact actually made or recorded (needs `contact_delivered`); "Contact planned" is only an internal decision | A draft or contact object; transport states |
| Invitation → Trial | An invitation becomes a Trial only when accepted; trial states accepted/scheduled/completed/cancelled | `trial_in_progress` as a case status; attendance as judgement |
| Outcome | Reserved for confirmed outcomes (signings, M12 outcome reports) | A Trial state |
| Formal decision | `roomDecisions` row `kind:'formal'` with progress/hold/reject, recorded by a lead person | Derived from evidence, a score or "sign" assessments; told to the player |
| Advisory / draft decision; supersession | Opinion rows / one draft per case; a later decision supersedes, both readable | Evidence for `offer_consideration`; "edit a decision" |
| Decision pending | **Derived** condition (`trial_completed`, no decision) | Stored |
| Offer accepted | Shown as **"Accepted in ScoutBox"** | A contract, registration, transfer, "joined" or a work permit |
| Signed | A confirmed `db.signings` record. Signing drives lifecycle, never the reverse | Caused by moving a case |
| Offer declined vs withdrawn | Player/guardian's act vs the club's | Collapsing the two |
| Hold | A deliberate, non-terminal pause of a live case | A rejection, or progress in the funnel |
| Closed | Filed away, with no reason implied | A rejection (that's `archived`/`withdrawn` + reason code) |
| Lifecycle vs decision reason code | 16 event codes (why a case moved) vs 20 opinion codes (why a club concluded) | A decision code on a transition (refused) |

### Glossary: development (M21_TERMINOLOGY)

| Term | Meaning | Avoid |
|---|---|---|
| Development Plan / Goal / Action / Review | A record of agreed work; reviews are append-only and corrected by supersession | A measurement |
| Reflection; linked evidence | Player/guardian's own words; a live reference, never a copy | Calling a reflection an assessment |
| Target met / not met | The stated measurement reached or not | "Goal achieved" |
| Achieved | The owner marked the objective complete | A ScoutBox finding of permanent ability |
| Overdue / Blocked | A fact about a date / a structural reason | A characterisation of the person |
| Evidence confidence | The Trust Score as context about the evidence | Development progress, football ability |
| **Forbidden names** | Development/Potential/Improvement/Readiness/Growth/Academy Score, Player (Progress) Rating, Development Rating/Ranking, Coach Ranking; identifiers `developmentScore`, `potentialScore`, `progressPercent`, `percentDeveloped`, `ceiling`, `projectedCeiling`, `talentScore` | Use counts instead: "3 of 5 actions completed" |

There are no health categories: `availability/rehabilitation` and `injury_or_unavailable` are deliberately not offered.

## Open questions and deferred work

- Shortcut and rail-collapse preferences are per-browser. A server-side preference store is future work.
- Verification-level visibility refreshes once per session, not live.
- The Player Account "Security" row is deferred until real security settings exist.
- Player "Trial › Evidence" isn't built: there's no player-side trial-evidence record.
- Pro executive and Grassroots clubhouse redesigns (later, approved) may restyle the sidebar. Check against PRO_EXECUTIVE / GRASSROOTS_CLUBHOUSE.

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

- ✓ Lead pattern: `scoutbox-server/roles.mjs:16`.
- ✓ Five-cap constants and validators: `scoutbox-club/src/nav.ts:55,280`, `scoutbox-admin/src/navGroups.ts:10`, `design-system/caseNav.ts:46`. Pro groups and T&S groups match M24D.
- ✓ Player tabs and the "Updates" label: `scoutbox-player/src/app/(tabs)/_layout.tsx:19-25,73`; categories `scoutbox-player/src/caseNav.ts:27-70`; You sections `you.tsx:57-73`.
- ✓ Stage not writable on a Room: `scoutbox-server/m12/scouting.mjs:538`. ✓ Contacted needs `contact_delivered`: `m17/shared.mjs:274`.
- ✓ 16 lifecycle reason codes: `m23/lifecycle.mjs:67`. ✓ Development vocabulary checked at boot: `m21/shared.mjs:448`.
- ≠ Finance access is wider on the server (see §3).
