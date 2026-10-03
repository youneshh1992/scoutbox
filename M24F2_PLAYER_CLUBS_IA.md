# M24F.2 — Player › You › Clubs: the information architecture

Baseline `e5fe716` (M24F.1). The Clubs tab was one scroll of eleven ruled
sections — current club, agent, representation, transitions, exposure,
consent, shared opportunities, acknowledgements, club feedback with every
feedback text and objective open, references, transactions — 4 450 px tall
at 390 px wide before anything was tapped. It is now four categories, each a
page of its own, reached by the page tabs and by a deep link.

## The four categories

| Category | `?section=` | What it holds | Source |
|---|---|---|---|
| **Current** (default) | `current` | the current club (name, since, "Active"), My agent, Representation, Club transition, Your exposure | `ClubsCurrent` in `components/ClubsSections.tsx` |
| **Requests** | `requests` | pending club requests as rows into the Inbox (trial invitation / contact request, club, date), agent consent requests, opportunities an agent shared, acknowledgements | `ClubsRequests` |
| **Development** | `development` | per club: latest feedback (first sentence), current objective, progress entries; "View details" opens the full feedback texts, Log progress (primary), Request reassessment (secondary), Share / Stop sharing (tertiary) | `ClubsDevelopment` |
| **History** | `history` | answered requests, reassessment outcomes, coach references, transactions | `ClubsHistory` |

Four is the count. The rule is at most five; nothing was invented to reach
four — each category is a question a player asks ("where am I", "who wants
me", "how am I doing", "what happened").

## Routing

`/you?tab=clubs` opens Current. `/you?tab=clubs&section=development` opens
Development directly. The section is derived from the URL parameter (no
effect, no server state); choosing a tab calls `router.setParams`, so the
browser's back and forward move between sections and a refresh keeps the
section. Leaving the Clubs tab clears the section.

## What moved

- **Suitability preferences** (position, availability, distance, expenses)
  are not about a club; they are the player's own settings and now live
  under **Account › Preferences**.
- The full feedback texts and the objective controls are behind **View
  details** on Development; the row shows one sentence and the counts.

## Measured

Scroll height at 390 px (the Player column), demo data, same account:

| Page | Before | After |
|---|---|---|
| Clubs root | 4 450 px | 1 675 px (Current) |
| Requests | — | 1 545 px |
| Development | — | 844 px |
| History | — | 1 800 px |

The root is 62 % shorter. Every former row is still reachable in one or two
taps; nothing was removed from the product.

## Tests

`m24f2DensityAudit` (static: four categories, the deep-link parameter,
Suitability absent from Clubs) and `m24f2DensityLive` (browser: the tabs
work at 390 / 640×360 / 1024 / 1440, each category reaches its content,
the root is shorter than the M24F.1 root, no horizontal overflow, zero page
errors). The M12–M15 suites were re-pointed at the new categories
(`m12Live`, `m12DemoSpotcheck`, `m13Live`, `m13DemoSpotcheck`,
`m14DemoSpotcheck`, `m15Live`, `uiSpotcheck`, `m24fVisualLive`).
