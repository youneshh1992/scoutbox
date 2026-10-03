# M24F.2 — Player › You › Account: the information architecture

Baseline `e5fe716` (M24F.1). Account was a scroll of disclosures — Profile,
availability, medical sharing, privacy and data, notifications, appearance,
access and language, safety centre, season, invite code, the rules — each
with a sub-note, 1 280 px tall at 390 px wide. It is now a clean root list
and four category pages.

## The root

`/you?tab=account` — the player's name and one line, then four rows with no
sub-note:

| Row | Opens |
|---|---|
| Profile | `?section=profile` |
| Privacy | `?section=privacy` |
| Preferences | `?section=preferences` |
| Appearance | `?section=appearance` (the switch sits inline on the row) |

Beneath the list: **Switch account** and **Sign out** (their M24E test ids
and behaviour unchanged), then the environment line ("Demo — sample data")
as a quiet footer. There is no Security row because there is nothing real
behind one yet; it will appear when there is.

The root fits one screen at 390 px (844 px scroll height, 34 % shorter).

## The category pages

Each page has a back control ("Account", chevron) and the page tabs across
the four categories, so a person can move sideways without returning.

| Page | Holds |
|---|---|
| **Profile** | Open your profile (→ the M24F.1 profile), Availability and status, Your season, Join a club squad (invitation code) |
| **Privacy** | one section-level line ("What you share, and with whom"), Medical sharing, Your data (export, delete), Safety centre (when reports exist), The rules that protect you |
| **Preferences** | Suitability preferences (moved here from Clubs), Notifications (quiet hours, school-hours mute — the hint shows only when quiet hours are set), Access & language |
| **Appearance** | the theme switch |

Safeguarding content was moved, never dropped: the rules, the safety centre
and medical sharing sit under Privacy with their full text one tap away.

## Routing

`?section=` is derived from the URL, not stored; back and forward move
between root and category; a refresh on `/you?tab=account&section=privacy`
opens Privacy.

## Tests

`m24f2DensityAudit` (four categories, Sign out present, no "Manage
your…"-style copy) and `m24f2DensityLive` (root rows, each category opens
and returns, deep link, back / forward, root shorter than before, no
overflow, zero page errors). `uiSpotcheck`, `m12DemoSpotcheck`,
`m13DemoSpotcheck`, `m13Live` and `m24fVisualLive` were re-pointed at the
category pages.
