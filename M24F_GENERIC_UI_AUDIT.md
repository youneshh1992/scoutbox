# M24F — Generic-UI audit

"Generic AI look", translated into measurable problems: too many cards,
nested cards, grey rectangles, everything bordered, repeated rounded boxes,
too many badges and status pills, text crammed into panels, four-stat
blocks, icon-circle decorations, large paragraphs inside cards, poor
whitespace, weak hierarchy, several equally prominent buttons, unnecessary
helper copy, too much visible at once. Each high-impact screen below records
what it had and what changed. Captures: `design-system/screenshots/
m24f-before-*` and `m24f-after-*` (same script, same routes, same viewports).

## Global rules (every portal, `design-system/platform.css`)

| Pattern | Before | After |
|---|---|---|
| list rows | each row a white 10px-radius bordered card, 8px apart | ruled rows (hairline below, 0 radius, no fill); clickable rows wash on hover and brighten the name |
| the attention block | a bordered 12px card | a ruled section |
| the filter bar | a white bordered card with a shadow | a ruled strip |
| explanatory notes (`.notice`) | a tinted 8px box per paragraph | a quiet ruled paragraph (a 2px left rule); only errors and warnings keep their tint |
| stat tiles | bordered boxes, four or five in a row | ruled figures (a 2px top rule), the Rooms funnel strip included |
| emoji | 169 in UI code | 0 (see `M24F_EMOJI_AUDIT.md`) |
| feed kind labels | coloured pills ("New footage", "New on ScoutBox") | quiet uppercase kickers; "report due" in the urgent ink |
| status labels | lower-case ("awaiting review", "verification pending", "club") | title-cased for presentation; data values untouched |
| entry rows | — | hover is the name and the arrow, never a box |

## Screens

| Screen | Problems found | What changed |
|---|---|---|
| **Grassroots entry** (desktop, 390) | bright-green panel with illustrated blade lines; dark form; lower-case metadata; a theme toggle on the previous version | `Club · Grassroots · Verified`; hover on text + arrow; no toggle. (The photograph, the Sage entry and the serif were reverted at the Founder's direction: the entry is the M24E scheme again — blade-banded introduction, deep-green form, Inter.) |
| **Grassroots club selector** | rows already a list, but grey card hover and lower-case meta | list with hairlines, text / arrow hover, title case |
| **Grassroots light home / dashboard** | pale mint canvas, pitch lines and mowing bands, four boxed feed rows with coloured pills, a boxed attention card | ruled rows, kicker labels, ruled attention block. (The Sage canvas was reverted at the Founder's direction: the M24E mint canvas, turf grain and pitch markings are back.) |
| **Grassroots Coaches ("Dee Mensah")** | six boxes: a notice box, a filter card with three inputs and a bright button, a card per affiliation with a status pill and two equal buttons, a boxed heading, a notice box, a card holding one select | an editorial page: "Coach affiliation" + one sentence (+ "What it does not grant" disclosure), underlined fields in a row with one primary, each affiliation a ruled record — name / role · since / Confirmed · confirmed by / End affiliation · Revoke as text actions — then "Squad invitations" + one sentence + the select |
| **Grassroots Squad** | boxed rows and pills | ruled rows (global) |
| **Agent entry** | dark entry introduced in M24E | the cream light entry: `#F3EEE3` introduction, `#FDFAF4` form, dark type, one dark primary, gold held back for the label and focus; the roster unboxed |
| **Pro Cases** | boxed case rows, staff rows in cards, "lead" pill | ruled rows; the case row reads from the left |
| **Pro Recruitment Rooms** | five bordered stat buttons, a bordered filter row, a boxed attention card, a bordered table | ruled stat figures (the active one underlined in green), a ruled filter strip, a ruled attention block; the ledger keeps its panel (a table is a table) |
| **Trust & Safety report queue** | boxed report rows with three or four pills each (scout / club / player, awaiting review, resolved) | ruled rows; status labels title-cased; the urgent flag keeps its tint |
| **Player Home** | nine cards, four bright buttons, pill rows, a dashboard feel, a pitch drawing behind | identity hero, one primary action, journey rows, an activity stream, disclosures; no card, no pitch (see `M24F_PLAYER_VISUAL_REDESIGN.md`) |
| **Player Explore / Trial / Offer / Signing** | cards inside cards, grey tiles for sessions and revisions, stage pills, two equal buttons | ruled sections and blocks, status words, one primary + text secondary; an honest "Current" empty line |
| **Player Passport / Development / Box Cam / Combine** | every section a card; a pitch drawing in the Box Cam hero | ruled sections; the hero without pitch lines |
| **Player Messages** | thread rows as cards with a Verified pill; attachment pills; the request cards | hairline thread rows, verified as a word, attachments as text; Decline a text action |
| **Player Account** | eleven cards of prose, a "Live sync" pill as identity, two boxed exit buttons | a settings list: rows and disclosures, the switch inline, the exits as rows, the environment as a footer line |
| **Guardian** | a digest card, three equally prominent identity pills ("ID verified", "Disclaimer accepted", "Demo mode"), a huge request card with two badges, a quote, venue text, instruction text, date pills and two buttons; every section a card | one line of standing (problems in words, in red), "This week" as a sentence + "View activity", requests as ruled records with kicker / club / for whom · where / the club's message and slot notes while open / dates / Accept + Decline-as-text / "View details" (scout, time, guardian notes); children, co-guardian, data and the development loop as ruled sections; rules and log as disclosures; demo as a footer |
| **Bottom navigation (Player)** | a filled green tile behind the active tab | the green icon and label only |

## Copy

- "club · Grassroots · verification pending" → "Club · Grassroots ·
  Verification Pending"; "Verified club · Safeguarding Certified" →
  "Verified · Safeguarding Certified"; "· playable" → "· Playable".
- Trust & Safety pills: "awaiting review / resolved / suspended /
  certified / unverified / suspension / block / delivered" and the target,
  severity, transport, status and flag values are presented with a capital
  (the stored enum values are unchanged).
- Player pills: "trial request / contact request / trial invitation /
  conversation request / registered ✓ / via your guardian / goal met ✓ /
  reviewed / in review / co-guardian" and the data-driven kind, tier,
  status and check labels — capitalised; the ✓ marks are gone.
- Toast strings lost their leading emoji ("Corroborated — tier upgraded.").
- Long explanatory paragraphs on the Coaches page, the Player Account and
  Home, and the guardian's requests moved behind a disclosure ("What it does
  not grant", "Privacy and your data", "Your visibility right now", "View
  details") — the words are intact and one tap away.

## What was deliberately kept

- Real surfaces: the recruitment ledger table, the agent workspace panels,
  the chat bubbles, the Box Cam hero, the Pro and Trust & Safety entry
  schemes (M24C, approved).
- Pills that communicate state: Verified, Pending, Confirmed, Declined,
  Signed, Demo.
- Every safeguarding sentence (the promises, the guardian notes, the
  "acceptance is not a signing" line) — relocated, never removed.
