# M24F.2 — Sub-note audit

The rule (now in `design-system/README.md`): supporting copy is
exceptional, not default. A row is a label and a value; a sub-note is
earned only by a safeguarding or privacy fact, a legal boundary, or a state
the person must know before acting. 70–80 % of rows carry none; a repeated
explanation becomes one section-level line; "Manage your…", "Here you
can…", "Use this to…", "Control how…", "Choose whether…" never appear;
safeguarding copy is relocated, never dropped.

## Method

1. A phrase scan of the five applications' UI source and translations for
   the five generic openers. Product UI: 0 hits. Two hits were error
   strings in the Pro and Grassroots dictionaries ("Choose whether this
   watchlist…") — rewritten (see below).
2. Every `hint=` on a Player `Disclosure`, every `<Muted>` intro or note in
   the Player's Clubs and Account components, and every `.notice` / helper
   line in the four portals, read one by one.

## Player — decisions

| Screen · row | Old note | Decision | Reason |
|---|---|---|---|
| Account root · Profile / Privacy / Preferences / Appearance | one sub-note per row ("Position, availability, medical…", "Export, delete…", …) | **Removed** | the row is the label; the category page shows what it holds |
| Account › Privacy (section) | — | **Added one section line**: "What you share, and with whom" | one line for the whole section instead of a note per row |
| Account › Privacy · Your data | "Export or delete" | **Removed** | the disclosure's content says it |
| Account › Preferences · Notifications | "Quiet hours · School-hours mute" | **Kept only when quiet hours are set** (then the hint is the value) | a value, not a note |
| Account › Preferences · Access & language · machine-translation note | shown always | **Shown only when French is chosen** | a fact that matters only in that state |
| Account › Preferences · Suitability preferences | "Private to you — clubs only ever see verdict summaries you explicitly approve" | **Kept** | privacy fact |
| Account › Profile · Join a club squad | "Enter a single-use invitation code from a verified club. Joining is your choice and gives the club no control over your profile." | **Shortened** to the second sentence | the first sentence described the input beside it |
| Profile › Evidence · Request a coach reference | "Your coach confirms by email" | **Removed** | the form inside says it |
| Profile › Evidence · Verified sports CV | "Your whole verified record, portable" | **Removed** | restates the label |
| Profile › Evidence · Profile N % complete | "What would add evidence" | **Removed** | restates the label |
| Home · Club directory | "How clubs actually behave: trials run, reports filed, how fast" | **Removed** | marketing restatement |
| Guardian · The rules that protect your child | "Our promises to every under-18" | **Removed** | restates the label |
| Guardian · Communications log | "Every scouting action around your children, logged and visible to you" | **Kept** | safeguarding fact |
| Clubs › Current · My agent (section intro) | "Nothing is active until you confirm it…" | **Kept** as the one section line | the state the person must know before acting |
| Clubs › Current · My agent · licence line | "FIFA licence: verified — Verified against recorded provenance; check the provenance before relying on it." | **Shortened**: "FIFA licence: verified"; the warning sentence stays only when **unverified** | trust fact only where it bites |
| Clubs › Current · My agent · "A ScoutBox relationship record. It is not a representation contract…" | one per relationship | **Moved** to one section-level line | legal boundary, said once |
| Clubs › Current · My agent · What this agent can see (intro) | "Three separate choices. Each one starts off…" | **Removed** | each row shows its state in words |
| Clubs › Current · My agent · per-disclosure help | what each choice shares | **Kept** | privacy fact per choice |
| Clubs › Current · My agent · "These choices only ever narrow what an agent sees…" | after the three choices | **Removed** | the rows and the section intro already say it |
| Clubs › Current · My agent · share-status note | "Sharing shows agency staff only that a relationship exists and its status — never your profile." | **Kept** | privacy fact |
| Clubs › Requests · Brought to you by your agent (intro) | "Opportunities your agent thought were worth your time." | **Removed** | restates the title |
| Clubs › Requests · Brought to you by your agent · per row | "Applying is your decision. Open the opportunity yourself…" | **Removed per row**; the section keeps "Your agent cannot apply for you…" once | one section line |
| Clubs › Requests · Agent consent | intro, "What this means", "Before you answer", revoke / decline / revoke notes | **Kept** | a written-consent flow; every line is a legal condition |
| Clubs › History · My transactions | intro, confirm note, offer boundary | **Kept** | legal boundary of a transaction workspace |
| Clubs › Current · Club transition (minor) | "Transition cases for under-18s are opened and controlled by the parent/guardian." | **Kept** (minors only) | safeguarding |
| Clubs › History · Coach references (guardian) | "References route to you as the guardian…" | **Kept** (guardians only) | safeguarding |
| Clubs › Development · per club | the full feedback texts, every objective, inputs | **Moved** behind View details; the row shows one sentence and the counts | progressive disclosure |

Rows without a sub-note after the pass, by screen (Player, demo data):
Account root 4 / 4; Account › Profile 3 / 4; Account › Privacy 4 / 5 (one
section line); Account › Preferences 2 / 3; Clubs › Current 7 / 10;
Clubs › Requests 3 / 4 (consent rows excluded as a legal flow); Clubs ›
Development 3 / 3; Clubs › History 4 / 5; Profile › Evidence 5 / 5.

## Portals — decisions

| App · screen | Copy | Decision | Reason |
|---|---|---|---|
| Pro, Grassroots · watchlist error | "Choose whether this watchlist…" | **Rewritten** to state the condition | the generic opener |
| Pro, Grassroots · empty states (Film Room, Shortlist, Messages, Trials, Squad, Friendlies, Invoices, bell) | "No trials yet. Trials begin when a player accepts a trial request." … | **Kept** | an empty state is the one line the screen has |
| Trust & Safety · section intros (Representation, Workspaces, Support tickets, Backups, Verification, Mail, Billing, Communications, Disputes, Affiliations, References, Outcomes, Content) | one `.notice` per section | **Kept** (one section-level line each) | policy facts a reviewer must know; none is per-row |
| Grassroots · Home | — | **Recomposed** (`M24F2_GRASSROOTS_LIGHT_SYSTEM.md`): one quiet sentence under the primary action, no row notes | |
| Grassroots · entry | three bullet points + demo notice | **Removed**; "Demo environment" as a small indicator | restrained copy |
| Agent, Trust & Safety · rows | `.dim` meta under list rows | **Kept** | values (dates, roles, counts), not notes |

## Not touched

Server-authored sentences (`honest`, `note`, `offerBoundary.honest`) are
data the server chose to send; they are displayed as received.
