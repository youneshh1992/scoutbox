# Decisions

The product and process decisions in force, one line each, newest first within each section. Details live in the
linked docs. These are settled: don't ask the Founder again, and propose a change only with a reason. All dates are
2026.

---

## 1. How we work

| Date | Decision | Who |
|---|---|---|
| 9 Nov | **Schema changes amend the creating migration in place** (then re-seed) for now, rather than adding altering migrations: there is no production data, and each table's definition stays in one file ([`architecture.md`](architecture.md)). | Tom |
| 9 Nov | **The SQLite migration is complete; the feature freeze stays** while the codebase is cleaned up and its architecture tightened. In scope: clean-ups and architecture work, defects, security, tests, and design changes the Founder explicitly asks for. Tom lifts it. | Tom |
| 4 Nov | **A club's shadow list is not its squad.** Shadowing a player (the Pro squad planner) puts them on the club's watch list for a role and nowhere else: not in the grassroots squad, not in match-day attendance or release, and not as a club relationship on the passport or the Trust score (`product/recruitment.md`). | Tom |
| 4 Nov | **Assessment templates stay shared by every club for now.** One club's new template version changing it for all clubs is a known defect (`known-issues.md`). | Tom |
| 3 Nov | **Docs are updated in place.** No new Markdown at the repo root and no docs for a milestone, review or test run; design notes and test evidence go in PR descriptions. | Tom |
| 3 Nov | **No passwordless logins in production.** Dev logins are on only in development; a production boot with `ALLOW_DEV_LOGINS` set is refused. A hosted demo gives its accounts real passwords. (The demos inside Claude are the self-contained builds and need no server.) | Tom |
| 3 Nov | `render.yaml`, `fly.toml` and `Dockerfile` are kept, though neither deploy target is live, because they may be used to serve the demo. | Tom |
| 3 Nov | **Valid input only, everywhere.** Typed columns, no lossless side columns (`extra_json`, `absent_keys_json`, `offtype_json`); routes reject junk ([`architecture.md`](architecture.md)). | Tom |
| 30 Oct | **There is no production data and no deployment.** Every database is seed or test data. Rollback means "re-seed". No rollback tools, historical-build boots, compatibility with old dev-build files, or operator warnings for deployments that don't exist. | Founder |
| 30 Oct | **Review scope.** One review per change, on the implementation. A blocking finding must be reachable through a real route with data the current build can produce, and a real user could lose or corrupt data. Everything else is a note. Questions to the Founder lead with the product consequence. | Founder |
| 30 Oct | **Explicit writes.** Routes change data through repository operations, never by editing records in place for a save to detect. | Founder |
| 9 Oct | **Feature freeze** during the data-layer rebuild (extended on 9 Nov, above). | Founder |
| 9 Oct | `main` is the trunk. Short-lived branches merge through PRs with green CI. Push, merge, tag and deploy only on the Founder's explicit instruction, never force-push. | Founder |

## 2. Data, privacy and deletion

The ids are handles that code comments cite.

| Date | Decision | Id |
|---|---|---|
| 24 Oct | Contacts and offers keep the player id after the player is deleted ("tolerant"): the club keeps that history. Guardian references on them are checked strictly. | Q8c-a, Q8c-b |
| 23 Oct | Recruitment cases, room snapshots and decisions keep the player id tolerantly. | Q8a |
| 22 Oct | Requests and trials keep the player id tolerantly. A request or trial naming a missing case or guardian is refused. | Q7a, Q7b, Q7c |
| 21 Oct | A deleted player's retained record keeps the **country** (so the country's adult age can still be applied), as well as the birth date. | S4b-R |
| 19 Oct | Audit rows (blocks, reports, org notes, ledger, source changes) keep player ids after deletion. They are counted, never refused or deleted. | Q4 |
| 19 Oct | An ID-verification queue entry must name an existing guardian. | Q4b |
| 19 Oct | Lifting a block deletes it. No history of the block is kept. | Q5 |
| 18 Oct | One message thread per recruitment request. | D-A |
| 18 Oct | Deleting a player deletes their message threads, guardian–club threads included. (This settled scope, not retention.) | D-B |
| 12 Oct | A deleted player's retained record keeps the **full birth date**. | S4b O1 |
| — | An under-18 player with no valid guardian link is invalid data. | — |

## 3. UI approvals

The approved designs and all their rules are in [`design.md`](design.md). In short:

| Date | Decision |
|---|---|
| 6 Oct | **Agent** approved: black/violet business workspace, stacked Agent identity. "This is good to go and ready to push for github and ready for claude to use as an artifact." |
| 6 Oct | **Pro** approved as the permanent Pro UI: a luxury flagship distinct from Grassroots, with football identity, a new entry screen and a correspondence desk (no bubble chat). |
| 6 Oct | **Grassroots** approved as the artifact UI going forward: the forest Clubhouse, with a traditional search bar and bell, a smaller account panel and a subtle embossed pitch on the banner. Auth screens unchanged. |
| 5 Oct | **Player** approved as permanent, then: "Get rid of light mode. Dark is PERFECT and will remain the main theme." Player is dark-only. |
| 5 Oct | The vivid Player direction approved ("OH YES APPLY THIS IMMEDIATELY NOW WE ARE TALKING"); Phosphor icons; Instagram-style inbox; SF Pro (system font) for Player. |
| 5 Oct | The logo and `#00e676` green are permanent. |
| 5 Oct | Grassroots makeover: full creative control except the logo and colours; auth stays as it is. |
| 4 Oct | "Explore is good": the Player board and fit views kept. |
| 3 Oct | Grassroots entry: no grass photograph, no centre-circle motif; the green entry panel restored. |

## 4. Product choices

None of these is explicitly attributed to the Founder. They are treated as settled unless he says otherwise.

- **Recruitment.** An external contact can be recorded up to 180 days after it happened and stays valid indefinitely. There is no Offer delete route, and offer events stay private to the org. A Trial's Box Cam footage is referenced by the trial, not promoted to the Passport. ([`product/recruitment.md`](product/recruitment.md), [`product/offers-signings.md`](product/offers-signings.md))
- **Navigation.** Analytics sits inside Recruitment, not as its own section. Grassroots "Team" became "Players", and Network folded into Club. Contact and Offers are Room tabs, not destinations. At most five items per nav bar in every app. Category headings with nothing behind them are not invented. ([`product/navigation.md`](product/navigation.md))
- **Agents.** The product policy P-1…P-8 and the decision register DR-1…DR-54. ([`product/agents.md`](product/agents.md))
- **Development and Box Cam.**
  - No health or injury data model: no availability or rehabilitation category, and no injury block reason.
  - Computer vision is deterministic and server-side. No third-party model (AGPL YOLO excluded). Web only for version 1. Synthetic evaluation only.
  - "Combine Verified" stays disabled until real-world validation.

  ([`product/passport-development.md`](product/passport-development.md))
- **Discovery.**
  - Ordered by profile completeness, with player id as the tie-break, and the ordering is stated on screen. It is never a ranking.
  - "Profile completeness" and "Trust Score" are different things. Trust is evidence confidence only.
  - Matching, watchlists and Nobody Missed cover every player the club can see, paged 50 at a time; a change that only time makes (evidence expiring, a player turning 18) shows within a minute (Founder, 8 Nov).

  ([`product/journey-analytics.md`](product/journey-analytics.md), [`product/safeguarding.md`](product/safeguarding.md))
- **Staff (Founder, 6 Nov).** A re-invite restores a removed staff account. A staff name already in the organisation is refused (`STAFF_NAME_TAKEN`). ([`product/platform.md`](product/platform.md))
- **Finance (3 Nov, Tom).** Deal amounts (Pro's Finance page) are visible to every lead role and to finance roles (role names containing "finance" or "treasurer"). One definition, `isFinanceRole` in `scoutbox-server/roles.mjs`, used by both the server and the sidebar. ([`product/navigation.md`](product/navigation.md))
- **Platform.** Unreadable legacy dates are not migrated. ([`product/platform.md`](product/platform.md))

## 5. Open questions

| Question | Why it matters | Area |
|---|---|---|
| Should there be a pathway for **minors** to get offers, signings or agent representation at all? Today it is closed in every jurisdiction. | It was left to "the mandate's owner". The guardian routes exist but refuse everything. | agents, offers |
| May **agencies self-register**? | Left to "the mandate's owner". | agents |
| When is the **legacy signing route** retired? | Recorded as an open product decision. | offers |
| **Organisation deletion** (O2): what happens to an org and its open cases? | Organisations can't be deleted today; `suspended` is the only state, and every `org_id` key is RESTRICT. | platform |
| **Retention** (S4b, Q6): how long are messages, health data, audit free text, commercial records, and a guardian's data after a child's deletion kept? Who may delete a child? Should deletion also remove push tokens, verification tokens and passport shares, and write a deletion ledger row? | Needs qualified privacy/legal review before real users. Until then an account deletion keeps the player's records under the old id. | safeguarding |
| **Child-status stamping** (Q2): should safeguarding rows record that the subject was treated as a child? | Today a reviewer works it out from the retained birth date. A yes means new columns. | safeguarding |
| **Legal review**: consent for trial footage and observation of minors; whether event consent should name Box Cam. | Needed before Box Cam is used at trials with minors. | recruitment |
| **Changing plan prices**: should staff be able to change a plan's monthly price, seats or attribution window (how long after first contact a signing owes ScoutBox a fee) without a software release? | Today these are fixed in the code (`catalogue.mjs`), so any change means a new release. A yes adds an admin screen and a change history; a no keeps them simple. | billing |
| **Grassroots auth photo**: the Founder asked for a real grass photo on the Grassroots sign-in panel (4 Oct). It was never supplied or approved. | Open design item. | design |
