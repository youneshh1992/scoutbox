# Decisions

The product and process decisions in force, distilled from about 290 milestone documents in the
November 2026 cleanup. One line each, newest first within each section. Details live in the linked docs.

- **For the Founder:** please read this and say if anything is wrong or missing. Entries marked ⚠ are
  where the old documents contradicted each other or the code, and the cleanup had to pick. Check those first.
- **For agents:** these are settled. Don't ask the Founder again; propose a change only with a reason.
- Originals: `git show docs-archive-2026-11:<FILE>.md`. Sources are given as (FILE) or (FILE §section).
- All dates are 2026.

---

## 1. How we work (process and data)

| Date | Decision | Who |
|---|---|---|
| 3 Nov | The repo was cleaned up. Milestone documents were removed from the root and distilled into `docs/`. The rule is now: **no new Markdown at the root; design notes and test evidence go in PR descriptions; `docs/` is updated in place.** This replaces the "milestone gates" documentation-housekeeping policy of 14 Oct. | Tom (cleanup), for the Founder to review |
| 3 Nov | **No passwordless logins in production.** Dev logins are on only in development; a production boot with `ALLOW_DEV_LOGINS` set is refused. A hosted demo gives its accounts real passwords. (The demos inside Claude are the self-contained builds and need no server.) | Tom |
| 3 Nov | `render.yaml`, `fly.toml` and `Dockerfile` are kept, though neither deploy target is live, because they may be used to serve the demo. | Tom |
| 3 Nov | The feature freeze (below) stays until the SQLite migration is done. | Tom, confirming the Founder's 9 Oct rule |
| 30 Oct | **There is no production data and no deployment.** Every database is seed or test data. Rollback means "re-seed". No rollback tools, historical-build boots, compatibility with old dev-build files, or operator warnings for deployments that don't exist. (CLAUDE_old "Facts about the data") | Founder |
| 30 Oct | **Fidelity rule from S8d on.** Preserve API behaviour for *valid* input only. Typed columns; no `absent_keys_json`/`offtype_json`/`extra_json`. The route rejects junk; the data import reports what it dropped. S0–S8c tables keep their lossless columns as accepted. (CLAUDE_old) | Founder |
| 30 Oct | **Review scope.** One review per step, on the implementation. A blocking finding must be reachable through a real route with data the current build can produce, and a real user could lose or corrupt data. Everything else is a note. Questions to the Founder lead with the product consequence. (CLAUDE_old) | Founder |
| 30 Oct | **Explicit writes.** S8d adopted explicit repository writes, not in-place edits detected by fingerprinting at save. This is the model for the remaining steps. (s8d-design-note §4) | Founder (the recommended option) |
| 30 Oct | Unit-test gate applies only when a package changes. (Now folded into CLAUDE.md.) | Founder |
| 9 Oct | **Feature freeze** until the data-layer rebuild is complete. In scope: defects, security, the rebuild, tests, and design changes the Founder explicitly asks for. (CLAUDE_old) | Founder |
| 9 Oct | `main` is the trunk. Short-lived branches merge through PRs with green CI. Push, merge, tag and deploy only on the Founder's explicit instruction, never force-push. (CLAUDE_old) | Founder |

## 2. Data, privacy and deletion

These came up during the storage migration. They are recorded in the migration's step reviews (now archived)
and summarised in [`architecture/migration.md`](architecture/migration.md).

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
| before 19 Oct | An under-18 player with no valid guardian link is invalid data: it stops a data migration. | — |

## 3. UI approvals

The approved designs and all their rules are in [`design.md`](design.md). In short:

| Date | Decision |
|---|---|
| 6 Oct | **Agent** approved: black/violet business workspace, stacked Agent identity. "This is good to go and ready to push for github and ready for claude to use as an artifact." (AGENT_FINANCE) |
| 6 Oct | **Pro** approved as the permanent Pro UI: a luxury flagship distinct from Grassroots, with football identity, a new entry screen and a correspondence desk (no bubble chat). (PRO_EXECUTIVE) |
| 6 Oct | **Grassroots** approved as the artifact UI going forward: the forest Clubhouse, with a traditional search bar and bell, a smaller account panel and a subtle embossed pitch on the banner. Auth screens unchanged. (GRASSROOTS_CLUBHOUSE) |
| 5 Oct | **Player** approved as permanent, then: "Get rid of light mode. Dark is PERFECT and will remain the main theme." Player is dark-only. (BRAND_RULES) |
| 5 Oct | The vivid Player direction approved ("OH YES APPLY THIS IMMEDIATELY NOW WE ARE TALKING"); Phosphor icons; Instagram-style inbox; SF Pro (system font) for Player. (BRAND_RULES) |
| 5 Oct | The logo and `#00e676` green are permanent. (BRAND_RULES) |
| 5 Oct | Grassroots makeover: full creative control except the logo and colours; auth stays as it is. (CLAUDE_old) |
| 4 Oct | "Explore is good": the Player board and fit views kept. (M24F5_KEPT_SCREEN_REVIEW) |
| 3 Oct | Grassroots entry: no grass photograph, no centre-circle motif; the M24E green panel restored. (M24F2_DEFECT_REGISTER) |

## 4. Product choices recorded in the milestone docs

None of these is explicitly attributed to the Founder in the documents. They were made inside milestones and are
treated as settled unless he says otherwise.

- **Recruitment.** An external contact can be recorded up to 180 days after it happened and stays valid indefinitely. There is no Offer delete route, and offer events stay private to the org. A Trial's Box Cam footage is referenced by the trial, not promoted to the Passport. ([`product/recruitment.md`](product/recruitment.md), [`product/offers-signings.md`](product/offers-signings.md))
- **Navigation (16 Sep, 2 Oct).** Analytics sits inside Recruitment, not as its own section. Grassroots "Team" became "Players", and Network folded into Club. Contact and Offers are Room tabs, not destinations. At most five items per nav bar in every app. Category headings with nothing behind them are not invented. ([`product/navigation.md`](product/navigation.md))
- **Agents (18 Sep).** The product policy P-1…P-8 and the decision register DR-1…DR-54 of M23 P5.6A. ([`product/agents.md`](product/agents.md))
- **Development and Box Cam.**
  - No health or injury data model: no availability or rehabilitation category, and no injury block reason.
  - Computer vision is deterministic and server-side. No third-party model (AGPL YOLO excluded). Web only for version 1. Synthetic evaluation only.
  - "Combine Verified" stays disabled until real-world validation.

  ([`product/passport-development.md`](product/passport-development.md))
- **Discovery.**
  - Ordered by profile completeness, with player id as the tie-break, and the ordering is stated on screen. It is never a ranking.
  - "Profile completeness" and "Trust Score" are different things. Trust is evidence confidence only.

  ([`product/safeguarding.md`](product/safeguarding.md))
- **Finance (3 Nov, Tom).** Deal amounts (Pro's Finance page) are visible to every lead role and to finance roles (role names containing "finance" or "treasurer"). One definition, `isFinanceRole` in `scoutbox-server/roles.mjs`, used by both the server and the sidebar. ([`product/navigation.md`](product/navigation.md))
- **Platform.** Unreadable legacy dates are not migrated. ([`product/platform.md`](product/platform.md))

## 5. Open questions

| Question | Why it matters | Area |
|---|---|---|
| Should there be a pathway for **minors** to get offers, signings or agent representation at all? Today it is closed in every jurisdiction. | It was left to "the mandate's owner". The guardian routes exist but refuse everything. | agents, offers |
| May **agencies self-register**? | Left to "the mandate's owner". | agents |
| When is the **legacy signing route** retired? | Recorded as an open product decision. | offers |
| **Organisation deletion** (O2): what happens to an org and its open cases? | Organisations can't be deleted today; `suspended` is the only state. | platform |
| **Retention** (S4b, Q6): how long are messages, health data, audit free text, commercial records, and a guardian's data after a child's deletion kept? Who may delete a child? Should deletion also remove push tokens, verification tokens and passport shares, and write a deletion ledger row? | Needs qualified privacy/legal review before real users. | safeguarding |
| **Child-status stamping** (Q2): should safeguarding rows record that the subject was treated as a child? | Today a reviewer works it out from the retained birth date. | safeguarding |
| **Legal review**: consent for trial footage and observation of minors; whether event consent should name Box Cam. | Needed before Box Cam is used at trials with minors. | recruitment |
| **Grassroots auth photo**: the Founder asked for a real grass photo on the Grassroots sign-in panel (4 Oct). It was never supplied or approved. | Open design item. | design |
| *(Nearly moot)* Q3 (ids of players deleted before S4b) and A0–A3 (real foreign keys for player/guardian through whole-snapshot rewrites) | Q3 goes away with re-seeding. A0–A3 go away once identity writes become explicit. | migration |

## 6. Contradictions resolved in the cleanup ⚠

Where the old documents disagreed with each other or with the code, the cleanup picked one. The default was **the code
wins**, then **the later document wins**.

- ⚠ **Recruitment.** The legacy stage route is *refused* for cases with a Room (M17 said it still worked). There are 18 lifecycle statuses (not M17's 13), with optimistic concurrency. Trial and offer evidence are implemented (M23_RECRUITMENT_WORKFLOW said they weren't). Code wins.
- ⚠ **Signing completion** is one unit of work, and the success-fee invoice is issued *after* commit (P7 described a hand-written rollback with the invoice inside it). Code wins.
- ⚠ **Opening a Room** for a player the org can't see answers 403 `NOT_VISIBLE`, not 404. Code wins; the docs had already been corrected.
- ⚠ **Agents.** The representation route checks visibility and blocks *before* scope (P5.6C), unlike the general authorisation order in the contract. FIFA-RSTP-2027 is a rule inside `jp-fifa-2025-1`, not its own policy version. Transactions and opportunity sharing exist, though P5.6C said there were none. Later doc and code win.
- ⚠ **Computer vision** is `configured` for observation (presence, ball, motion, duration, rep count) but certifies nothing; no Combine protocol is enabled (M16 docs said `not_configured`). Code and M22 win.
- **Finance visibility** (resolved 3 Nov). The docs said Finance was lead-only. The server also let `finance`/`treasurer` roles in, but the sidebar hid the page from them. Settled in the server's favour: see §4.
- ⚠ **Decision reason codes.** There are 20 (the data), though a comment in `m23/lifecycle.mjs:64` says 19.
- ⚠ **Pro entry photo.** The approved AI-generated stadium image wins over M24F.4's "no stock images" rule; "no fake photo for missing media" still holds.
- ⚠ **Trial accent colour** is `#f6c376` (code), not `#e9c46a` (M24F3_INBOX_DESIGN). The Grassroots serif was reverted (M24F5 reports still mention it). Code wins.
- **Dev login in production** (resolved 3 Nov). M18.1 said production boot refuses dev login, but the check read the wrong variable and `ALLOW_DEV_LOGINS=1` was an escape hatch. Settled as refused: see §1.
