# M24F.4 — All-app screen audit (five applications)

Baseline `d1fc3f1` (M24F.3 bundles, "before") against the M24F.4 tree ("after").
Every row is a screen the route-driven crawler reached in the demo bundle of its
application: Pro, Grassroots and Agent through every screen id of their navigation
model (by hash) plus each screen's top-level tabs; Trust & Safety through every
sidebar group and subnav page; the Player at 390 × 844 through every tab, category,
sub-tab and profile section plus the Activity page and the guardian dashboard.

**Measures.** *Words* = visible UI words (closed disclosures, inactive tabs and hidden
content excluded). *Paragraphs* = rendered text runs over 140 characters. *Cards* =
filled or fully bordered rounded containers over 180 × 56 px. *Bordered* = elements
with a border on all four sides (inputs excluded). *Pills*, *sub-notes*, the
computed primary font, emoji and seconds are counted too (raw JSON in the session
scratchpad: `m24f4-routes-{before,after}-*.json`, `m24f4-density-{before,after}-player.json`).

**Classification.** TOO TEXT HEAVY = any paragraph on the root, or over 260 (Player) /
420 (portal) words. TOO BOXED = 4+ (Player) / 6+ (portal) cards. TOO BORDERED = 8+ /
16+ bordered elements. NEEDS SIMPLIFICATION = no hard failure but over 180 / 300
words or more than six sub-notes. GOOD = the rest. "→ ACCEPTED" marks a screen whose
remaining failure is consent, safeguarding or legal wording, a test-protected
governing sentence, a search grid, a list of people, or the detail a contract
requires — the change column says which. TOO GENERIC was judged by eye on the
captures and is recorded in the change column where it applied.

## Totals

| | Before | After |
| --- | --- | --- |
| Screens crawled | 179 | 179 |
| Visible words (sum) | 26931 | 23910 (−11 %) |
| Paragraphs > 140 chars | 98 | 89 |
| Bordered elements | 1405 | 1160 |
| Cards | 27 | 25 |
| Failing (not GOOD) | 68 | 0 open + 50 accepted |
| GOOD | — | 129 |
| Screens whose computed primary font is not Inter | — | 0 |
| Emoji / seconds found | — | 0 / 0 |

Per application (after): Pro 34 / 53 GOOD · Grassroots 32 / 49 GOOD · Agent 8 / 11 GOOD · Trust & Safety 26 / 29 GOOD · Player 29 / 37 GOOD.

## Screens

| App | Route | Screen | Status before | Text issue | Visual issue | Change | Status after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pro | `#/feed` | feed (Home) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/search` | search (Recruitment / Players) | TOO BOXED + TOO BORDERED | 346 words → 346 words | 12 cards; 69 bordered; 67 pills → 12 cards; 36 bordered; 67 pills | Player cards now carry at most three pills; the remaining borders are the 12 result cards of a search grid (a legitimate grid), their checkboxes and the filter controls | TOO BOXED + TOO BORDERED → ACCEPTED |
| Pro | `#/shortlist` | shortlist (Recruitment / Shortlist) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/filmroom` | filmroom (Recruitment / Film Room) | TOO BORDERED | — → — | 16 bordered → 16 bordered | Kept — the Film Room is a grid of clip tiles (each a bordered video frame with its title) and the filter row; a tile is the clip | TOO BORDERED → ACCEPTED |
| Pro | `#/insight` | insight (Recruitment / Scouting Insight) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/recruitment` | recruitment (Recruitment / Cases) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/rooms` | rooms (Recruitment / Recruitment Rooms) | TOO BORDERED | 7 sub-notes → — | 32 bordered; 17 pills → 25 bordered; 17 pills | Open room is a text action; the intro goes through Hint; the duplicate ordering note is gone. The remaining borders are the seven filter chips and the table rules | TOO BORDERED → ACCEPTED |
| Pro | `#/rooms` | rooms › Mine (Recruitment / Recruitment Rooms) | TOO BORDERED | 7 sub-notes → — | 16 bordered → — | Same list, filtered | GOOD |
| Pro | `#/rooms` | rooms › Assigned to me (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Pro | `#/rooms` | rooms › Shortlisted (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Pro | `#/rooms` | rooms › Trials (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Pro | `#/rooms` | rooms › Offers (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Pro | `#/rooms` | rooms › Archived (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Pro | `#/requests` | requests (Recruitment / Player Requests) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/opportunities` | opportunities (Recruitment / Opportunities) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/campaigns` | campaigns (Recruitment / Campaigns) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/outcomes` | outcomes (Recruitment / Signings & Outcomes) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/assessments` | assessments (Recruitment / Assessments) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/video` | video (Recruitment / Evidence & Video) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/trials` | trials (Recruitment / Trials & Reports) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/trialdays` | trialdays (Recruitment / Trial Days) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/briefs` | briefs (Recruitment / Recruitment Briefs) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — a brief row prints the club's own criteria in one line (its content, not an explanation) | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/matching` | matching (Recruitment / Player Matching) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — "There is no match score and no ranking" is the M19 honesty statement; the how-to sentence is one line of instruction on an empty criteria form | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/watchlists` | watchlists (Recruitment / Dynamic Watchlists) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — the derived-on-open statement is the M19 honesty line | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/second-look` | secondlook (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars; 7 sub-notes → 1 paragraph(s) > 140 chars; 7 sub-notes | — → — | Kept — the governing sentence ("does not judge that decision") is a tested M18 contract; the item is one intelligence card | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/second-look` | secondlook › Evidence Changed (1) (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — the same tested governing sentence, filtered tab | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/second-look` | secondlook › Reviewed (1) (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — same, filtered tab | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/second-look` | secondlook › Dismissed (1) (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars; 8 sub-notes → 1 paragraph(s) > 140 chars; 8 sub-notes | — → — | Kept — same, filtered tab; the eight notes are the server's own reasons on one dismissed item | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/nobody-missed` | nobodymissed (Recruitment / Nobody Missed) | TOO TEXT HEAVY + TOO BORDERED | 4 paragraph(s) > 140 chars; 515 words; 12 sub-notes → 1 paragraph(s) > 140 chars | 18 bordered → — | Rebuilt as a coverage tool; the one remaining long line is the tested "not a measure of scouting quality" sentence | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/recruitment/dashboard` | dashboard (Recruitment / Director Dashboard) | TOO TEXT HEAVY | 19 paragraph(s) > 140 chars; 2514 words → 18 paragraph(s) > 140 chars; 2600 words | — → — | Executive layer added (4 counts, funnel bars, time bars, coverage ring, needs attention); the 2 500 words below it are the 30 panels' own limitation sentences, a tested M20 contract (every panel prints its limitation, never inside a disclosure) | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/funnel` | funnel (Recruitment / Funnel) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/ledger` | ledger (Recruitment / Discovery Ledger) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/planner` | planner (Squad & Planning / Squad Planner) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/coverage` | coverage (Squad & Planning / Coverage) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/calibration` | calibration (Squad & Planning / Calibration) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/fixtures` | fixtures (Squad & Planning / Fixtures) | TOO BORDERED | — → — | 22 bordered; 22 pills → — | GPS, the player count and the date are one quiet line per row (was two pills per row) | GOOD |
| Pro | `#/network` | network (Network / Clubs & Groups) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/representation` | representation (Network / Representation) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/organisation` | organisation (Organisation / Staff & Security) | NEEDS SIMPLIFICATION | 382 words; 10 sub-notes → 382 words; 10 sub-notes | — → — | Kept — the staff list is 26 rows of people with their roles; each row is one line (M24F.3) | NEEDS SIMPLIFICATION → ACCEPTED |
| Pro | `#/verification` | verification (Organisation / Verification) | TOO BORDERED | 7 sub-notes → 7 sub-notes | 26 bordered → 26 bordered | Kept — the verification steps are the five state chips of a checklist; dispute inputs are forms | TOO BORDERED → ACCEPTED |
| Pro | `#/verification` | verification › Requests (Organisation / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/verification` | verification › Staff (Organisation / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/verification` | verification › Domains (Organisation / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/verification` | verification › Administrators (Organisation / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/verification` | verification › Agent consents (Organisation / Verification) | TOO TEXT HEAVY | 3 paragraph(s) > 140 chars → 3 paragraph(s) > 140 chars | — → — | Kept — consent wording must be read in full before it is given | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/verification` | verification › Transactions (Organisation / Verification) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — the party statement is a legal line | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/verification` | verification › References & more (Organisation / Verification) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — the under-18 invitation rule is safeguarding wording | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/imports` | imports (Organisation / Integrations) | NEEDS SIMPLIFICATION | 7 sub-notes → 7 sub-notes | — → — | Kept — an integrations settings page (L2): seven providers, each one row with its connection state as the sub-note | NEEDS SIMPLIFICATION → ACCEPTED |
| Pro | `#/budgets` | budgets (Organisation / Finance) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/plan` | plan (Organisation / Plan & Compliance) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — the attribution window clause is contract wording | TOO TEXT HEAVY → ACCEPTED |
| Pro | `#/reputation` | reputation (Organisation / Reputation) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/operations` | operations (Organisation / Reputation) | GOOD | — → — | — → — | No change needed | GOOD |
| Pro | `#/messages` | messages (Messages) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/feed` | feed (Home) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/squad` | squad (Players / Squad & Match Days) | GOOD | — → — | — → — | Flat rows: initials, name, position; text Release; no name chip, no state pills | GOOD |
| Grassroots | `#/coaches` | coaches (Players / Coaches) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/friendlies` | friendlies (Players / Friendlies) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/fixtures` | fixtures (Players / Fixtures) | GOOD | — → — | — → — | Same | GOOD |
| Grassroots | `#/search` | search (Recruitment / Players) | TOO BORDERED | — → — | 32 bordered; 31 pills → 31 pills | Same — four result cards | GOOD |
| Grassroots | `#/shortlist` | shortlist (Recruitment / Shortlist) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/filmroom` | filmroom (Recruitment / Film Room) | TOO BORDERED | — → — | 16 bordered → 16 bordered | Kept — same clip grid | TOO BORDERED → ACCEPTED |
| Grassroots | `#/insight` | insight (Recruitment / Scouting Insight) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/recruitment` | recruitment (Recruitment / Cases) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/rooms` | rooms (Recruitment / Recruitment Rooms) | TOO BORDERED | 7 sub-notes → — | 31 bordered; 17 pills → 24 bordered; 17 pills | Same | TOO BORDERED → ACCEPTED |
| Grassroots | `#/rooms` | rooms › Mine (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Grassroots | `#/rooms` | rooms › Assigned to me (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Grassroots | `#/rooms` | rooms › Shortlisted (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Grassroots | `#/rooms` | rooms › Trials (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Grassroots | `#/rooms` | rooms › Archived (Recruitment / Recruitment Rooms) | NEEDS SIMPLIFICATION | 7 sub-notes → — | — → — | Same list, filtered | GOOD |
| Grassroots | `#/requests` | requests (Recruitment / Player Requests) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/opportunities` | opportunities (Recruitment / Opportunities) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/campaigns` | campaigns (Recruitment / Campaigns) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/opendays` | opendays (Recruitment / Open Days) | TOO BORDERED | — → — | 18 bordered → 17 bordered | The radar is a read line with Edit (no input border); the registrations keep their Invite / Kind no actions and the no-ghosting rule (a safeguarding rule) | TOO BORDERED → ACCEPTED |
| Grassroots | `#/outcomes` | outcomes (Recruitment / Signings & Outcomes) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/assessments` | assessments (Recruitment / Assessments) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/video` | video (Recruitment / Evidence & Video) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/trials` | trials (Recruitment / Trials & Reports) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/trialdays` | trialdays (Recruitment / Trial Days) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/briefs` | briefs (Recruitment / Recruitment Briefs) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — same | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/matching` | matching (Recruitment / Player Matching) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — same | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/watchlists` | watchlists (Recruitment / Dynamic Watchlists) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — same | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/second-look` | secondlook (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars; 7 sub-notes → 1 paragraph(s) > 140 chars; 7 sub-notes | — → — | Kept — same contract | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/second-look` | secondlook › Evidence Changed (1) (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — same, filtered tab | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/second-look` | secondlook › Reviewed (1) (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — same, filtered tab | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/second-look` | secondlook › Dismissed (1) (Recruitment / Second Look) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars; 8 sub-notes → 1 paragraph(s) > 140 chars; 8 sub-notes | — → — | Kept — same, filtered tab | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/nobody-missed` | nobodymissed (Recruitment / Nobody Missed) | TOO TEXT HEAVY + TOO BORDERED | 4 paragraph(s) > 140 chars; 515 words; 12 sub-notes → 1 paragraph(s) > 140 chars | 18 bordered → — | Rebuilt as a coverage tool; the one remaining long line is the tested honesty sentence | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/recruitment/dashboard` | dashboard (Recruitment / Director Dashboard) | TOO TEXT HEAVY | 19 paragraph(s) > 140 chars; 2514 words → 18 paragraph(s) > 140 chars; 2600 words | — → — | Same as Pro — the detail is the contract | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/funnel` | funnel (Recruitment / Funnel) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/ledger` | ledger (Recruitment / Discovery Ledger) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/coverage` | coverage (Recruitment / Coverage) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/calibration` | calibration (Recruitment / Calibration) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/network` | network (Club / Clubs & Groups) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/organisation` | organisation (Club / Staff & Security) | NEEDS SIMPLIFICATION | 382 words; 10 sub-notes → 382 words; 10 sub-notes | — → — | Kept — same | NEEDS SIMPLIFICATION → ACCEPTED |
| Grassroots | `#/verification` | verification (Club / Verification) | TOO BORDERED | 7 sub-notes → 7 sub-notes | 24 bordered → 24 bordered | Kept — same | TOO BORDERED → ACCEPTED |
| Grassroots | `#/verification` | verification › Requests (Club / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/verification` | verification › Staff (Club / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/verification` | verification › Domains (Club / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/verification` | verification › Administrators (Club / Verification) | GOOD | — → — | — → — | No change needed | GOOD |
| Grassroots | `#/verification` | verification › References & more (Club / Verification) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — same safeguarding wording | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/imports` | imports (Club / Integrations) | NEEDS SIMPLIFICATION | 7 sub-notes → 7 sub-notes | — → — | Kept — same settings page | NEEDS SIMPLIFICATION → ACCEPTED |
| Grassroots | `#/plan` | plan (Club / Plan & Compliance) | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — contract wording; the fee protection sits behind About | TOO TEXT HEAVY → ACCEPTED |
| Grassroots | `#/messages` | messages (Messages) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/home` | home (Home / Overview) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/profile` | profile (Home / My profile & verification) | TOO TEXT HEAVY | 3 paragraph(s) > 140 chars; 7 sub-notes → 3 paragraph(s) > 140 chars; 7 sub-notes | — → — | Kept — the development-build provider notice is a dev-only safety statement (m23AgentLive B8 contract) | TOO TEXT HEAVY → ACCEPTED |
| Agent | `#/compliance` | compliance (Home / Conflicts & compliance) | TOO TEXT HEAVY | 5 paragraph(s) > 140 chars; 7 sub-notes → 5 paragraph(s) > 140 chars; 7 sub-notes | — → — | Kept — policy results are the content of the screen (rule text and status) | TOO TEXT HEAVY → ACCEPTED |
| Agent | `#/clients` | clients (Clients) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/transactions` | transactions (Transactions) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/opportunities` | opportunities (Opportunities) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/agency` | agency (Agency) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/agency` | agency › Team (Agency) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/agency` | agency › Compliance (Agency) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/agency` | agency › Settings (Agency) | GOOD | — → — | — → — | No change needed | GOOD |
| Agent | `#/inbox` | inbox (Inbox) | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars → 1 paragraph(s) > 140 chars | — → — | Kept — a notification body is content, one row | TOO TEXT HEAVY → ACCEPTED |
| Trust & Safety | `Home` | Home | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Cases2 › Report queue` | Cases2 / Report queue | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Cases2 › Evidence disputes` | Cases2 / Evidence disputes | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Cases2 › Ver. disputes` | Cases2 / Ver. disputes | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Cases2 › Support desk` | Cases2 / Support desk | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Evidence › Passport` | Evidence / Passport | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Evidence › Box Cam` | Evidence / Box Cam | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Evidence › Trust` | Evidence / Trust | TOO TEXT HEAVY | 2 paragraph(s) > 140 chars → 2 paragraph(s) > 140 chars | — → — | Kept — the policy statement is the content of the console page | TOO TEXT HEAVY → ACCEPTED |
| Trust & Safety | `Verification › Verification` | Verification / Verification | TOO BORDERED | 7 sub-notes → 7 sub-notes | 16 bordered → 16 bordered | Kept — a review queue: every bordered element is an Approve / Reject control or a reason input on a case row (an operations console) | TOO BORDERED → ACCEPTED |
| Trust & Safety | `Verification › Club verification` | Verification / Club verification | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Verification › Guardian IDV` | Verification / Guardian IDV | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Verification › Staff checks` | Verification / Staff checks | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Verification › Coach affiliations` | Verification / Coach affiliations | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Safety › Suspensions` | Safety / Suspensions | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Safety › Moderation log` | Safety / Moderation log | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Safety › Thread audit` | Safety / Thread audit | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Safety › Drill guidance` | Safety / Drill guidance | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Operations › Outcome tracking` | Operations / Outcome tracking | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Operations › Representation` | Operations / Representation | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Operations › Federation groups` | Operations / Federation groups | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Delivery & Billing › Delivery centre` | Delivery & Billing / Delivery centre | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Delivery & Billing › Mail outbox` | Delivery & Billing / Mail outbox | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Delivery & Billing › Billing` | Delivery & Billing / Billing | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Agents › Agent compliance review` | Agents / Agent compliance review | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Agents › Jurisdiction policy` | Agents / Jurisdiction policy | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Agents › Reviewer identities` | Agents / Reviewer identities | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `Agents › Agent transactions` | Agents / Agent transactions | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars; 413 words; 20 sub-notes → 1 paragraph(s) > 140 chars; 413 words; 20 sub-notes | — → — | Kept — an audit console listing 20 state words on 6 rows; every note is a server reason | TOO TEXT HEAVY → ACCEPTED |
| Trust & Safety | `System › Service health` | System / Service health | GOOD | — → — | — → — | No change needed | GOOD |
| Trust & Safety | `System › Backups` | System / Backups | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/discover` | Home | TOO TEXT HEAVY | 1 paragraph(s) > 140 chars; 261 words → — | — → — | Simplified — 261 → 82 words, 2 → 1 bordered | GOOD |
| Player | `/activity` | Activity | — | — → — | — → — | No change needed | GOOD |
| Player | `/football?tab=passport` | Football / Passport | GOOD | — → — | — → — | Simplified — 160 → 89 words, 2 → 1 bordered | GOOD |
| Player | `/football?tab=development` | Football / Development | TOO TEXT HEAVY + TOO BORDERED | 535 words; 9 sub-notes → — | 21 bordered → — | Simplified — 535 → 62 words, 21 → 1 bordered | GOOD |
| Player | `/football?tab=boxcam` | Football / Box Cam | TOO TEXT HEAVY + TOO BORDERED | 329 words → — | 8 bordered → — | Simplified — 329 → 76 words, 8 → 2 bordered | GOOD |
| Player | `/football?tab=combine` | Football / Combine | TOO TEXT HEAVY + TOO BORDERED | 335 words; 11 sub-notes → — | 11 bordered → — | Simplified — 335 → 58 words, 11 → 1 bordered | GOOD |
| Player | `/inbox` | Messages / All | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/inbox` | Messages / Unread | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/inbox` | Messages / Requests | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities` | Opportunities / Journey / Overview | TOO BORDERED | — → — | 11 bordered → 11 bordered | Kept at the Founder's direction (Explore is good); the 11 borders are the five category chips, the three Check fit / Accept / Dispute actions and the tab bar | TOO BORDERED → ACCEPTED |
| Player | `/opportunities?cat=journey` | Opportunities / My journey / Overview | TOO BORDERED | — → — | 11 bordered → 11 bordered | Same screen | TOO BORDERED → ACCEPTED |
| Player | `/opportunities?cat=journey` | Opportunities / My journey / Activity | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=journey` | Opportunities / My journey / Board | TOO BORDERED | — → — | 11 bordered → 11 bordered | Kept — one-line rows (M24F.3) | TOO BORDERED → ACCEPTED |
| Player | `/opportunities?cat=contact` | Opportunities / Club contact / Messages | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=trial` | Opportunities / Trial / Invitation | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=trial` | Opportunities / Trial / Schedule | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=trial` | Opportunities / Trial / Details | TOO BORDERED | — → — | 8 bordered → 8 bordered | Kept — the trial detail is an action screen (Confirm the schedule, Cancel, the alternative-day chips); the eight borders are its controls | TOO BORDERED → ACCEPTED |
| Player | `/opportunities?cat=offer` | Opportunities / Offer / Offer | GOOD | — → — | — → — | Simplified — 102 → 69 words, 7 → 7 bordered | GOOD |
| Player | `/opportunities?cat=offer` | Opportunities / Offer / Documents | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=offer` | Opportunities / Offer / Response | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=signing` | Opportunities / Signing / Signing | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=signing` | Opportunities / Signing / Documents | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/opportunities?cat=signing` | Opportunities / Signing / Contract | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=profile` | You / Profile | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=profile&section=performance` | You / Profile / Performance | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=profile&section=evidence` | You / Profile / Evidence | NEEDS SIMPLIFICATION | 231 words → — | — → — | Simplified — 231 → 58 words, 1 → 0 bordered | GOOD |
| Player | `/you?tab=profile&section=journey` | You / Profile / Journey | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=account` | You / Account | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=account&section=profile` | You / Account / profile | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=account&section=privacy` | You / Account / privacy | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=account&section=preferences` | You / Account / preferences | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=account&section=appearance` | You / Account / appearance | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=clubs&section=current` | You / Clubs / Current | TOO BORDERED | 230 words; 7 sub-notes → 230 words; 7 sub-notes | 12 bordered → 12 bordered | Kept — agent and representation relationships carry Confirm / Decline / Dispute (consent actions); each is one line plus its action row | TOO BORDERED → ACCEPTED |
| Player | `/you?tab=clubs&section=requests` | You / Clubs / Requests | TOO TEXT HEAVY | 7 paragraph(s) > 140 chars; 392 words; 10 sub-notes → 7 paragraph(s) > 140 chars; 392 words; 10 sub-notes | — → — | Kept — dual-representation consent must be read in full before it is given (legal flow) | TOO TEXT HEAVY → ACCEPTED |
| Player | `/you?tab=clubs&section=development` | You / Clubs / Development | GOOD | — → — | — → — | No change needed | GOOD |
| Player | `/you?tab=clubs&section=history` | You / Clubs / History | TOO TEXT HEAVY | 3 paragraph(s) > 140 chars; 416 words → 3 paragraph(s) > 140 chars; 416 words | — → — | Kept — the confirmation wording of a transaction party is a consent statement | TOO TEXT HEAVY → ACCEPTED |
| Guardian | `/guardian` | Guardian dashboard | TOO TEXT HEAVY + TOO BORDERED | 1748 words; 31 sub-notes → 869 words; 13 sub-notes | 60 bordered → 28 bordered | Management forms behind "Manage …'s profile", Co-guardian, Notifications and Your family's data rows (−45 % words); the M12–M23 child sections below stay visible for the live-test contracts | TOO TEXT HEAVY + TOO BORDERED → ACCEPTED |

## How the fixes were applied

- **Player.** Home, Activity, Passport, Development, Box Cam, Combine, Evidence and the
  Offer were rebuilt on the three-level rule (`M24F4_PLAYER_VISUAL_RESET.md`). The
  guardian dashboard folds its management forms behind rows.
- **Pro and Grassroots.** Nobody Missed is a coverage tool (ring, counts, compact rows
  grouped by state); the Director Dashboard carries an executive layer above the
  seven families (`M24F4_DIRECTOR_DASHBOARD.md`); the Grassroots radar reads as a
  line and the squad as flat rows; player cards carry at most three pills; the
  rooms list uses text actions and one ordering note; fixtures are one quiet line.
- **Agent and Trust & Safety.** No root failed the hard rules beyond the accepted
  content screens (policy results, audit consoles, a notification body); their
  remaining long lines are named above.

The rules every row was judged against are in `M24F4_MINIMAL_PRODUCT_RULES.md`;
the gates that keep them are `e2e/m24f4MinimalismAudit.test.mjs`,
`e2e/m24f4PlayerMinimalLive.test.mjs` and `e2e/m24f4PortalMinimalLive.test.mjs`.
