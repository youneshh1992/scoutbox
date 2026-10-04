# M24F.3 — Screen density audit (five applications)

Baseline `f221c90` (before) against the M24F.3 working tree (after). Every row is a
screen the crawler reached in the demo bundle of its application: the portals at
1440×900 through every sidebar destination (sections and their pages), the Player at
390×844 through every tab, category and sub-tab plus the guardian dashboard.

**Measures.** *Visible text* = characters of text that is actually rendered (closed
`About` / `View details` disclosures, inactive tab screens and hidden content are
excluded). *Paragraphs* = rendered text runs longer than 140 characters — the M24F.3
one-line rule treats any such run on a root screen as an explanation that belongs
behind a disclosure. *Boxes* = bordered / filled containers; *pills* = chips and
status badges; *sub-notes* = small-print runs over 40 (portals) / 60 (Player)
characters.

**Classification.** TOO DENSE = any long paragraph on the screen, or more visible
text than a phone screen holds comfortably (Player > 2 600 chars, portals > 3 200).
MINIMAL = under 900 / 1 200 characters with at most two sub-notes. ACCEPTABLE =
the rest. "TOO DENSE → ACCEPTED" marks a screen whose remaining long text is
consent wording, a test-protected governing sentence, or notification content —
the fix column says which.

## Totals

| | Before | After |
| --- | --- | --- |
| Screens crawled | 96 | 96 |
| Visible characters (sum) | 107885 | 86657 (−20 %) |
| Paragraphs > 140 chars | 123 | 24 |
| Sub-notes | 418 | 285 |
| Pills / chips | 475 | 479 |
| Boxes | 40 | 40 |
| TOO DENSE (unaccepted) | 53 | 0 |
| MINIMAL | — | 51 |
| ACCEPTABLE | — | 35 |

## Screens

| App | Route | Screen | Visible text (before → after) | Paragraphs > 140 | Cards / boxes | Pills | Sub-notes | Status (before → after) | Fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pro | #/feed | Home | 562 → 562 | 0 → 0 | 1 → 1 | 0 → 0 | 3 → 3 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Pro | #/search | Recruitment | 2220 → 2001 | 2 → 0 | 12 → 12 | 67 → 67 | 2 → 1 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/search | Recruitment / Players | 2220 → 2001 | 2 → 0 | 12 → 12 | 67 → 67 | 2 → 1 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/shortlist | Recruitment / Shortlist | 143 → 143 | 0 → 0 | 0 → 0 | 0 → 0 | 1 → 1 | MINIMAL → MINIMAL | No change needed |
| Pro | #/filmroom | Recruitment / Film Room | 285 → 285 | 0 → 0 | 0 → 0 | 4 → 4 | 1 → 1 | MINIMAL → MINIMAL | No change needed |
| Pro | #/insight | Recruitment / Scouting Insight | 1254 → 808 | 2 → 0 | 0 → 0 | 1 → 1 | 6 → 4 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/planner | Squad & Planning | 373 → 373 | 0 → 0 | 0 → 0 | 6 → 6 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Pro | #/planner | Squad & Planning / Squad Planner | 373 → 373 | 0 → 0 | 0 → 0 | 6 → 6 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Pro | #/coverage | Squad & Planning / Coverage | 1317 → 1140 | 1 → 0 | 0 → 0 | 5 → 5 | 6 → 5 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/calibration | Squad & Planning / Calibration | 537 → 323 | 1 → 0 | 0 → 0 | 1 → 1 | 3 → 2 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Pro | #/fixtures | Squad & Planning / Fixtures | 760 → 760 | 0 → 0 | 0 → 0 | 22 → 22 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Pro | #/network | Network | 750 → 592 | 1 → 0 | 0 → 0 | 2 → 2 | 3 → 2 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Pro | #/network | Network / Clubs & Groups | 750 → 592 | 1 → 0 | 0 → 0 | 2 → 2 | 3 → 2 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Pro | #/representation | Network / Representation | 100 → 100 | 0 → 0 | 0 → 0 | 0 → 0 | 1 → 1 | MINIMAL → MINIMAL | No change needed |
| Pro | #/organisation | Organisation | 2809 → 2464 | 2 → 0 | 0 → 0 | 3 → 3 | 12 → 10 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/organisation | Organisation / Staff & Security | 2809 → 2464 | 2 → 0 | 0 → 0 | 3 → 3 | 12 → 10 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/verification | Organisation / Verification | 1878 → 1269 | 4 → 0 | 0 → 0 | 11 → 11 | 13 → 7 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/reputation | Organisation / Reputation | 368 → 368 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Pro | #/messages | Messages | 226 → 82 | 1 → 0 | 0 → 0 | 0 → 0 | 1 → 1 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Pro | #/organisation | Messages / Staff & Security | 2809 → 2464 | 2 → 0 | 0 → 0 | 3 → 3 | 12 → 10 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/verification | Messages / Verification | 1878 → 1269 | 4 → 0 | 0 → 0 | 11 → 11 | 13 → 7 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Pro | #/reputation | Messages / Reputation | 368 → 368 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/feed | Home | 831 → 831 | 0 → 0 | 1 → 1 | 0 → 0 | 3 → 3 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Grassroots | #/squad | Players | 826 → 826 | 0 → 0 | 0 → 0 | 7 → 7 | 2 → 2 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/squad | Players / Squad & Match Days | 826 → 826 | 0 → 0 | 0 → 0 | 7 → 7 | 2 → 2 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/coaches | Players / Coaches | 556 → 556 | 0 → 0 | 1 → 1 | 1 → 1 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/friendlies | Players / Friendlies | 312 → 312 | 0 → 0 | 0 → 0 | 3 → 3 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/fixtures | Players / Fixtures | 361 → 361 | 0 → 0 | 0 → 0 | 10 → 10 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/search | Recruitment | 1376 → 1203 | 2 → 0 | 4 → 4 | 31 → 31 | 2 → 1 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/search | Recruitment / Players | 1376 → 1203 | 2 → 0 | 4 → 4 | 31 → 31 | 2 → 1 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/shortlist | Recruitment / Shortlist | 143 → 143 | 0 → 0 | 0 → 0 | 0 → 0 | 1 → 1 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/filmroom | Recruitment / Film Room | 285 → 285 | 0 → 0 | 0 → 0 | 4 → 4 | 1 → 1 | MINIMAL → MINIMAL | No change needed |
| Grassroots | #/insight | Recruitment / Scouting Insight | 1254 → 808 | 2 → 0 | 0 → 0 | 1 → 1 | 6 → 4 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/network | Club | 754 → 596 | 1 → 0 | 0 → 0 | 2 → 2 | 4 → 3 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/network | Club / Clubs & Groups | 754 → 596 | 1 → 0 | 0 → 0 | 2 → 2 | 4 → 3 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/organisation | Club / Staff & Security | 2809 → 2464 | 2 → 0 | 0 → 0 | 3 → 3 | 12 → 10 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/verification | Club / Verification | 1856 → 1247 | 4 → 0 | 0 → 0 | 11 → 11 | 13 → 7 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/imports | Club / Integrations | 1250 → 1250 | 0 → 0 | 0 → 0 | 7 → 7 | 7 → 7 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Grassroots | #/plan | Club / Plan & Compliance | 1161 → 757 | 3 → 2 | 0 → 0 | 1 → 1 | 6 → 3 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — the governing sentence above the dashboard numbers (m20 test contract); fee protection folded behind About |
| Grassroots | #/messages | Messages | 226 → 82 | 1 → 0 | 0 → 0 | 0 → 0 | 1 → 1 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/network | Messages / Clubs & Groups | 754 → 596 | 1 → 0 | 0 → 0 | 2 → 2 | 4 → 3 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/organisation | Messages / Staff & Security | 2809 → 2464 | 2 → 0 | 0 → 0 | 3 → 3 | 12 → 10 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/verification | Messages / Verification | 1856 → 1247 | 4 → 0 | 0 → 0 | 11 → 11 | 13 → 7 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Grassroots | #/imports | Messages / Integrations | 1250 → 1250 | 0 → 0 | 0 → 0 | 7 → 7 | 7 → 7 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Grassroots | #/plan | Messages / Plan & Compliance | 1161 → 757 | 3 → 2 | 0 → 0 | 1 → 1 | 6 → 3 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — same screen reached from another section |
| Agent | #/home | Home | 790 → 358 | 2 → 0 | 1 → 1 | 2 → 2 | 1 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Agent | #/home | Home / Overview | 790 → 358 | 2 → 0 | 1 → 1 | 2 → 2 | 1 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Agent | #/profile | Home / My profile & verification | 2125 → 1717 | 5 → 3 | 0 → 0 | 7 → 7 | 8 → 7 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — the development-build provider notice is a dev-only safety statement (m23AgentLive B8 contract); declared-licence and verification notes folded |
| Agent | #/compliance | Home / Conflicts & compliance | 2254 → 1868 | 7 → 5 | 0 → 0 | 4 → 4 | 8 → 7 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — policy results are the content of this screen (rule text and status); the explanatory intro is folded |
| Agent | #/clients | Clients | 520 → 520 | 0 → 0 | 0 → 0 | 5 → 5 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Agent | #/transactions | Transactions | 1419 → 978 | 2 → 0 | 0 → 0 | 8 → 8 | 3 → 1 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Agent | #/opportunities | Opportunities | 521 → 377 | 1 → 0 | 0 → 0 | 1 → 1 | 3 → 3 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Agent | #/agency | Agency | 727 → 569 | 1 → 0 | 0 → 0 | 0 → 0 | 5 → 5 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Agent | #/inbox | Inbox1 | 581 → 581 | 1 → 1 | 0 → 0 | 1 → 1 | 0 → 0 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — a notification body is content, one row |
| Trust & Safety | — | Home | 200 → 200 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Trust & Safety | — | Cases2 | 492 → 466 | 0 → 0 | 0 → 0 | 7 → 7 | 0 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Trust & Safety | — | Evidence | 1209 → 594 | 3 → 0 | 0 → 0 | 5 → 5 | 8 → 5 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Trust & Safety | — | Verification | 1516 → 1118 | 2 → 0 | 0 → 0 | 2 → 2 | 9 → 7 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Trust & Safety | — | Safety | 88 → 79 | 0 → 0 | 0 → 0 | 1 → 1 | 0 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Trust & Safety | — | Operations | 426 → 426 | 0 → 0 | 0 → 0 | 1 → 1 | 3 → 3 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Trust & Safety | — | Delivery & Billing | 621 → 468 | 1 → 0 | 0 → 0 | 3 → 3 | 4 → 3 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Trust & Safety | — | Agents | 1087 → 1061 | 0 → 0 | 0 → 0 | 7 → 7 | 6 → 6 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Trust & Safety | — | System | 294 → 276 | 0 → 0 | 0 → 0 | 0 → 0 | 1 → 1 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /discover | Home | 1434 → 1383 | 1 → 1 | 0 → 0 | 2 → 2 | 3 → 2 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — the weekly digest is one data line (views · clip · streak); no explanation |
| Player | /football?tab=passport | Football / Passport | 2730 → 933 | 2 → 0 | 0 → 0 | 2 → 2 | 9 → 0 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Player | /football?tab=development | Football / Development | 3603 → 2970 | 3 → 0 | 0 → 0 | 2 → 2 | 14 → 9 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — a plan page: each objective and target is one primary + one secondary line; no paragraph remains (2 970 characters over the 2 600 guide, 0 paragraphs) |
| Player | /football?tab=boxcam | Football / Box Cam | 2250 → 1775 | 4 → 0 | 1 → 1 | 2 → 2 | 9 → 6 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Player | /football?tab=combine | Football / Combine | 2232 → 2092 | 1 → 0 | 0 → 0 | 2 → 2 | 12 → 11 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Player | /inbox | Messages / All | 1272 → 303 | 2 → 0 | 0 → 0 | 2 → 2 | 3 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /inbox | Messages / Unread | — → 303 | — → 0 | — → 0 | — → 2 | — → 0 | — → MINIMAL | No change needed |
| Player | /inbox | Messages / Requests | — → 303 | — → 0 | — → 0 | — → 2 | — → 0 | — → MINIMAL | No change needed |
| Player | /opportunities | Opportunities / Journey / Overview | 1206 → 721 | 1 → 0 | 0 → 0 | 2 → 2 | 3 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=journey | Opportunities / My journey / Overview | 1206 → 721 | 1 → 0 | 0 → 0 | 2 → 2 | 3 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=journey | Opportunities / My journey / Activity | 260 → 201 | 0 → 0 | 0 → 0 | 2 → 2 | 1 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=journey | Opportunities / My journey / Board | 1101 → 662 | 1 → 0 | 0 → 0 | 2 → 2 | 3 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=contact | Opportunities / Club contact / Messages | 279 → 220 | 0 → 0 | 0 → 0 | 2 → 2 | 2 → 1 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=trial | Opportunities / Trial / Invitation | 319 → 260 | 0 → 0 | 0 → 0 | 2 → 2 | 2 → 1 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=trial | Opportunities / Trial / Schedule | 515 → 450 | 0 → 0 | 0 → 0 | 2 → 2 | 2 → 1 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=trial | Opportunities / Trial / Details | 401 → 342 | 0 → 0 | 0 → 0 | 2 → 2 | 1 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=offer | Opportunities / Offer / Offer | 756 → 544 | 1 → 0 | 0 → 0 | 2 → 2 | 4 → 2 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=offer | Opportunities / Offer / Documents | 479 → 267 | 1 → 0 | 0 → 0 | 2 → 2 | 2 → 0 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=offer | Opportunities / Offer / Response | 574 → 362 | 1 → 0 | 0 → 0 | 2 → 2 | 3 → 1 | TOO DENSE → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=signing | Opportunities / Signing / Signing | 224 → 165 | 0 → 0 | 0 → 0 | 2 → 2 | 1 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=signing | Opportunities / Signing / Documents | 224 → 165 | 0 → 0 | 0 → 0 | 2 → 2 | 1 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /opportunities?cat=signing | Opportunities / Signing / Contract | 224 → 165 | 0 → 0 | 0 → 0 | 2 → 2 | 1 → 0 | MINIMAL → MINIMAL | Folded — long copy behind About / View details; one-line rows |
| Player | /you?tab=profile | You / Profile | 508 → 514 | 0 → 0 | 1 → 1 | 2 → 2 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Player | /you?tab=account | You / Account | 179 → 185 | 0 → 0 | 0 → 0 | 2 → 2 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Player | /you?tab=account&section=profile | You / Account / profile | 301 → 307 | 0 → 0 | 0 → 0 | 2 → 2 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Player | /you?tab=account&section=privacy | You / Account / privacy | 277 → 283 | 0 → 0 | 0 → 0 | 2 → 2 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Player | /you?tab=account&section=preferences | You / Account / preferences | 499 → 505 | 0 → 0 | 0 → 0 | 2 → 2 | 3 → 3 | ACCEPTABLE → ACCEPTABLE | No change needed |
| Player | /you?tab=account&section=appearance | You / Account / appearance | 143 → 149 | 0 → 0 | 0 → 0 | 2 → 2 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Player | /you?tab=clubs&section=current | You / Clubs / Current | 1456 → 1325 | 1 → 0 | 0 → 0 | 2 → 2 | 8 → 7 | TOO DENSE → ACCEPTABLE | Folded — long copy behind About / View details; one-line rows |
| Player | /you?tab=clubs&section=requests | You / Clubs / Requests | 2331 → 2228 | 8 → 7 | 0 → 0 | 2 → 2 | 11 → 10 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — dual-representation consent must be read in full before it is given (legal flow) |
| Player | /you?tab=clubs&section=development | You / Clubs / Development | 259 → 265 | 0 → 0 | 0 → 0 | 2 → 2 | 0 → 0 | MINIMAL → MINIMAL | No change needed |
| Player | /you?tab=clubs&section=history | You / Clubs / History | 2587 → 2424 | 4 → 3 | 0 → 0 | 2 → 2 | 6 → 5 | TOO DENSE → TOO DENSE → ACCEPTED | Kept — the confirmation wording of a transaction party is a consent statement |
| Guardian | /guardian | Guardian dashboard | 12821 → 9690 | 11 → 0 | 1 → 1 | 0 → 0 | 49 → 31 | TOO DENSE → TOO DENSE → ACCEPTED | Folded — pairing instructions, reminder note and challenge disclaimers behind About; remaining long text is consent wording |

## How the fixes were applied

- **Portals (Pro, Grassroots, Agent, Trust & Safety).** Every page hint renders through
  `design-system/About.tsx` → `Hint`: text up to 140 characters shows in place; anything
  longer folds behind an **About** control (`<details class="f-about">`). Server-provided
  notes and disclaimers go through the same component, so a short note still reads
  inline and a long one folds without the screen knowing which it will get. Static
  multi-line notices in the Trust & Safety console are wrapped in the same control.
  The Discover ordering statement was shortened to one line that still names what the
  order is not (ability, Trust Score).
- **Player.** Root screens keep one line per fact (`FactRow`, `PreviewRow`); explanations
  sit in `Disclosure` rows labelled "About …", "View details", "View breakdown",
  "View evidence", "View full message", "Why". Timeline rows open to show their source
  and provenance. Trust Score root shows the score, the band and "Evidence confidence
  only"; the policy version, strengths, gaps and the demo note sit inside.
- **Times.** Every machine timestamp goes through `scoutbox-player/src/time.ts` or
  `design-system/time.ts` (Now / 2m / 1h / Yesterday / 3 Oct; "3 Oct · 20:45"). Seconds
  never appear.

Raw crawl data: `m24f3-density-{before,after}-{club,grassroots,agent,admin,player}.json`
(session scratchpad; the measuring scripts are `m24f3-portal-density.mjs` and
`m24f3-player-density.mjs`).
