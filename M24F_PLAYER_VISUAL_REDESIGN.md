# M24F — The Player app, recomposed

## What was wrong

Every Player screen was a column of bordered 12px cards: an identity card,
an attention card, a development card with a green button, a weekly-report
card with a streak pill, a pathway card with four pills, a clubs card, a
scouts card, a profile-strength card, a who's-watching card with three stat
tiles, a visibility card, a directory of cards, and the promises as six
more cards. Four equally bright buttons competed on one screen; role names,
counts and ordinary metadata sat in pills; "Log out" was a boxed button in
a stack; the Account tab was eleven cards of prose; the guardian's requests
dumped the whole narrative — three badges, a quoted message, venue text,
instruction text, date pills and two buttons — up front. A faint pitch
drawing sat behind every page. Gutters were 18px with 10px between cards.

## The principles applied

Content first; one dominant action per surface; identity that feels
important; rows and rules instead of boxes; progressive disclosure for
everything secondary; comfortable rhythm (22px gutters, 26–30px between
sections); Inter at four sizes doing the hierarchy; the ScoutBox green for
the primary action and the active state only.

## The primitives (`components/ui.tsx`)

- `Card` is now a **section**: a hairline rule above, breathing room, no
  background and no border. Every M12–M23 section component inherits the
  change at once, so Passport, Development, Box Cam, Combine, Trial, Offer,
  Signing and the clubs sections lost their boxes without a rewrite. A
  genuine object (a sheet) can still ask for `raised`.
- `Pill` is a quiet chip (no border, 11px) for real state only — Verified,
  Pending, Confirmed, Declined, Signed; labels are title-cased for
  presentation (`cap()`), never changing the data value.
- `Button`: `primary` (one per surface), quiet secondary, `tertiary` text
  action, `danger` as a plainly red text action beside a primary.
- New `ListRow` (label, value line, chevron or inline control) and
  `Disclosure` (a row that opens its detail in place) and `Kicker`.
- `SectionTitle` 19px / 600, 26px above; the reference `SectionHead` matches.
- Rows in `Reference.tsx` (attention rows, history, the Box Cam hero) are
  ruled, not boxed; the icon tile lost its coloured square; the pitch drawing
  behind the Box Cam hero and the `PitchBackdrop` behind every screen are
  gone (component deleted).
- The bottom navigation keeps five destinations with lucide icons; the active
  destination is the green icon and label, no filled tile.

## Screen by screen

**Home** (`discover.tsx`, rewritten) — identity hero: 64px avatar, the
player's name at 28px, position · city · availability, a status line
("Verified clubs can see you" / "Guardian-managed · verified clubs only")
and "View your Passport". Then ONE action under a kicker: a pending contact
request or trial invitation ("Waiting on you") with its one bright button,
otherwise the development focus ("Your focus" → Start a practice session);
further waiting items are a text link. "Your journey": the open trials and
the clubs looking for the position as list rows, the pathway level and its
next step as a row. "Activity": the week in one sentence (views, shortlists,
top clip, streak, goal), then a timestamped stream (Mon · Harbour City FC
saved you), the month's totals and what scouts noticed, as text. "Development":
one row and the profile-strength suggestions behind a disclosure. "Clubs
within reach": rows with distance, standing, what they look for and their
open trials (Register is the one small action; a minor sees "Via your
guardian"). "More": "Your visibility right now", the club directory and
"How discovery works" as disclosures — every promise is one tap away, none
is a card.

**Opportunities / Explore** — the overview reads Current (the server's
journey projection, with an honest "No club has put anything in front of
you yet" instead of an empty panel), then the opportunity board, the
opportunity fit, squad invitations and follow-ups as ruled sections, then
a History row to the activity view. The five categories and their pages
are unchanged (M24B/M24D). Status words replace the stage pills; kind
labels are title-cased.

**Trial** — club, sessions (date/time, venue, instructions, attendance) as
ruled blocks instead of grey tiles; the state as a coloured word; Confirm
is the primary, Decline a text action, Cancel a red text action with its
reason field.

**Offer** — the club and status word on one line, the revision (role,
squad, start / end, conditions, message, documents) as a ruled block, the
second-step confirmation as a gold-ruled note with Accept primary and Cancel
text; the "an acceptance is not a signing" line stays.

**Signing** — the same treatment: what is complete, what remains, documents,
parties and the next action in ruled blocks, one primary.

**Passport** — the profile introduction (avatar, name, line, status) leads;
the Trust Profile, evidence and history follow as ruled sections, pills kept
to real state (e.g. "Demo").

**Box Cam** — the next session hero (glyph, title, line on the soft green,
no pitch drawing), the drill, its facts, Start Box Cam as the one primary,
the live observation as a quiet secondary, recent sessions as a ruled list.

**Development** — current focus, recent progress, next objective and history
as ruled sections (the M21 hub, de-boxed).

**Messages** — thread rows on hairlines with a round club avatar, name,
scout · role · Verified · count; the open thread keeps its person header,
a ruled safety line, date dividers, bubbles and the rounded compose; attachments
are text lines, not pills; the request cards above are ruled, Accept primary,
Decline a red text action, kind labels title-cased.

**Account** (`you.tsx`, rewritten tab) — the name and one line; then list
rows: Profile, Clubs, Privacy and your data (export, delete), Notifications
(quiet hours, school-hours mute), Appearance (the switch inline), Access &
language (language, data saver, captions, clip access), Safety centre (when there are reports), Your season, The rules that
protect you — each a disclosure holding exactly what its former card held;
then Switch account and Sign out as rows with their M24E test ids and
behaviour; the environment ("Demo — self-contained sample data") is a quiet
footer line, not an identity badge.

**Guardian** (`guardian.tsx`) — the guardian's name and one line of standing
("ID verified"; anything not in order is said in words, in the danger
colour); "This week" as one sentence per child with a "View activity" text
link that opens the communications log in place; "Club requests": each
request as a ruled record — kicker (Trial invitation / Conversation
request), club, "For Guni Adebayo · Eastport Academy Dome", the date chips,
the club's quoted message, the slot notes and (for a conversation) the
one sentence saying why it reached the guardian and not the child, while
the request is open — what the guardian decides on stays in view — then
Accept trial as the one primary, Decline as a text action, and "View
details" holding the scout's name and role, the timestamp and the reply
note (and, once answered, the message and notes too). The children, co-guardian, reports,
notifications, data and the development loop are ruled sections; the rules
are a disclosure; the exits are rows; the demo indicator is the footer.

## Spacing and type

Gutters 22px on every screen (320–430); sections 26–30px apart; rows 52px
tall with 12px padding; the name 28px / 700, section titles 19px / 600, row
labels 15px / 500, meta 12.5px, kickers 11px uppercase. Inter throughout
(the wordmark keeps the brand face). The accent appears on the one primary
action, the active tab, the identity avatar and the journey's status words.

## Verified

`m24fVisualLive` P: the name is the headline, exactly one bright primary
action, the journey / activity / visibility sections exist, five
destinations, no full-width bordered card, 20px+ gutters, Explore reads
Current then the board, Inbox's Decline is a text action, the Account rows
and the two exits, the guardian's digest / kicker / primary / disclosure.
`m24dAuthLive`, `m24eScrollLive`, `preM24SweepLive` and the M12–M23 Player
journeys keep their coverage of behaviour.

**M24F.1** — the profile under You › Profile was recomposed afterwards into a football-first header and four sections; see `M24F_PLAYER_PROFILE_REDESIGN.md`, `M24F_PLAYER_PROFILE_CONTENT_AUDIT.md` and `M24F_PLAYER_PROFILE_DATA_MAP.md`.
