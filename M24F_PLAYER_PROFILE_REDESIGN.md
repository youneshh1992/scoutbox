# M24F.1 — The Player profile, simplified

The profile under **You › Profile** (and `/profile`) is no longer the
player's database record. It opens on the player — a plain avatar, the name
as the strongest element, position · place, the availability word, Verified,
View Passport — and then four local sections: **Overview**, **Performance**,
**Evidence**, **Journey**. Important information first; everything else one
tap deeper in the section it belongs to; the controls in You › Account.

The supplied professional-profile reference was used for one principle
only (important information first, secondary information in separate
sections). Nothing of its layout, type, colour, navigation, cards or imagery
was copied: the profile is Inter, the ScoutBox green `#33EE7C` on the
avatar, the active tab, the Verified marker and the one primary action, an
off-white canvas, hairline rows and whitespace.

## Routing

The sections are a local `?section=` parameter on the routes the profile
already had: `/you?tab=profile&section=overview|performance|evidence|journey`
and `/profile?section=…` (the hidden route with the back control). The page
tabs call `router.setParams`, like Explore's `?cat=&tab=` (M24B), so links,
deep links and the browser's back / forward keep working; the bottom
navigation is unchanged (five destinations).

## Header

| Line | What it is |
|---|---|
| avatar | 72px disc, initials; a photograph when the model carries one (it does not today), initials on error — never a broken image |
| **Kola Adeyemi** | 28px / 700, wraps at any width (tested with a 51-character name at 320px) |
| ST · Manchester | the stored position code and the place (a minor sees the country only) |
| Open to trials | the server's availability state, in the existing words |
| ■ Verified · View Passport → | the identity state as one word with the green square; the Passport stays its own deeper destination |

No card, no number, no badge, no flag, no height / weight, no pills.

## Overview

1. **NEXT** — one item, on the one contained surface of the page: the
   server's next action for a club (journey projection), else the pending
   invitation or request (a trial invitation before a contact request, then
   the newest), else a scheduled trial with its date and venue, else the
   account handover for a player turning 18. One CTA: View trial / View
   invitation / View request / View offer / View signing / Complete the
   handover. Nothing pending: **"You're up to date."** — no fabricated action.
2. **Essentials** — Age, Position, Preferred foot, Location, Current club
   (when the Football Passport has one): five rows at most, no box, no icon,
   no pill.
3. **Recent activity** — four rows at most (the scouting feed and the
   journeys' events, newest first) and "View activity →".

## Performance

Combine results as rows (value right, metric and Verified / Self-reported
under the name) with "View Combine →"; the season as rows (appearances,
goals, assists or clean sheets, top speed, pass accuracy, duels won) and
"Season by season"; physical rows; "Where you stand — your cohort, not the
pros" with the percentile as text; club-filed trial reports as rows with
the coach's rating on the right. Empty: "No performance results yet. Add
Combine results when you're ready." No tile grid, no chart, no overall
score of any kind.

## Evidence

Footage first (the video, then title · date · Verified clip · views, what
scouts noticed as one line) and "Add evidence →"; verified attendance rows
(provenance in the sub-line, Verified on the right); coach references as
rows with the state as a word and "Request a coach reference" as a
disclosure; the M12 **Evidence passport** unchanged (it is the evidence
record); Box Cam as a row into Football; the verified sports CV and the
profile-completeness breakdown as disclosures. Completeness says what it
is: "Profile 59% complete … not a rating of you as a player".

## Journey

A chronological list, newest first, each day a small uppercase date, the
club, the event in the existing journey words — the server's projection
(contact, invitation, schedule, Offer, signing: only what reached this
person) plus the invitations and requests in the Inbox, received and
answered. Then "Earlier": the player's own history (year on the right).
Empty: "No current recruitment activity." No club watchlist, priority,
shortlist, assessment, decision rationale, Room discussion, Second Look or
private note is read or shown; the live suite asserts those words never
appear.

## Moved to You › Account

"Availability and status" (the five availability states, first-team
seeker, contract status, Academy+, the contract facts) and "Medical
sharing" (the switch and the records) are disclosures on the Account page
— the same calls, the same rules (a signing-recorded "Under contract" is
still read-only). Nothing was deleted.

## Loading and error

Loading is the composition's own shapes (a disc, a name bar, two lines);
after six seconds without a profile the same place says "Your profile could
not be loaded." with Retry. A phone is never blank.

## Before / after (Kola Adeyemi, 390px)

Captures: `design-system/screenshots/m24f1-before-profile-overview-390.png`
and `-430.png` against `m24f1-after-profile-overview-390.png`, `-430.png`,
`m24f1-after-profile-performance-390.png`, `-evidence-390.png`,
`-journey-390.png`, `m24f1-after-overview-with-trial-390.png`, `-430.png`,
`m24f1-after-overview-no-action-390.png` (live), and the live sections
`m24f1-after-live-*-390.png`.

| Measure | Old profile (one scroll) | New Overview |
|---|---|---|
| Visible sections | 16 | 3 (Next, essentials, recent activity) |
| Cards / bordered surfaces | 25 (17 cards, 5 stat tiles, avatar card, jersey tile, boxed sub-row) | 1 (the NEXT surface, only when an action exists) — 0 otherwise |
| Pills | 24 | 0 (the live suite asserts it) |
| Borders | every section boxed | hairline row dividers only |
| Primary (green) actions | 9 (+4 contract buttons) | 1 |
| Visible prose | ≈ 330 words of helper copy | ≈ 1 line ("You're up to date.") |
| Metadata points on the first screen | 12 | 5 (name, position, place, availability, verified) |
| Hierarchy | a 54px completeness number larger than the name | the name is the largest element; one kicker; rows |
| Emoji | 1 (the country flag) | 0 |

Overview visible information reduced: YES — roughly a fifth of the old
profile's visible items remain on the first screen; the rest is one tap
deeper (Performance 5 blocks, Evidence 6, Journey 3, Account 2). Nothing
is gone.

## What the pass does not do

No News, no Matches (ScoutBox stores no match data); no overall rating,
potential or star score; no change to lifecycle, authorization, Trial /
Offer / Signing / Trust Score semantics or the schema; no new endpoint.
