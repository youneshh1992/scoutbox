# M24F.3 — Player Inbox design

The Player's Messages tab is a conversation list first, a request desk second, and
never a wall of policy. This document records what was built, where it lives and the
rules the live suite (`e2e/m24f3InboxLive.test.mjs`) enforces.

## 1. Structure

```
Messages                                   ← PageHeader (title only)
You control who can contact you.  ›        ← one line; the full safeguarding text opens behind it
All · Unread 1 · Requests                  ← PageTabs, never more than three
┌ ▌HC  Harbour City FC        Request  1h ● ┐  ← PreviewRow (avatar · name · label · time · unread dot)
│      Would like to contact you            │  ← one preview line (numberOfLines=1)
├ ▌EF  Eastport FC            Trial    2h ● ┤  ← trial accent (warm gold edge) + the word "Trial"
│      Trial invitation · 7 Oct             │
├  RF  Riverline FC                   Yest. ┤  ← conversation
│      Thanks — see you Thursday            │
└ ▌HC  Offer received         Offer   3d   ┘  ← event row → Opportunities › Offer
```

- **Row primitive** — `PreviewRow` in `scoutbox-player/src/components/ui.tsx`: a 3 px
  accent edge (`testID row-accent-<kind>`), initials avatar, bold name, label chip,
  relative time (`relTime`: Now / 2m / 1h / Yesterday / Mon / 3 Oct), unread dot
  (`row-unread`), one-line preview. The accessibility label joins name, line, label,
  unread state and time, so a screen reader hears the whole row once.
- **Entries** — `scoutbox-player/src/app/(tabs)/inbox.tsx` merges four sources into one
  list, newest first: requests (`/player/inbox`), conversations (`/player/channels`),
  guardian-held children's items (minor accounts), and events (notifications whose
  target is an Offer or a Signing).
- **Tabs** — All, Unread *N* (unread conversations + pending requests + unread events),
  Requests (pending requests only). A minor's own device shows no tabs: it sees the
  guardian-managed outcome line only.

## 2. Message categories and their treatment

| Category | Row accent | Label | Preview line | Opens |
| --- | --- | --- | --- | --- |
| Normal conversation | none | — | last message, one line | Thread view |
| Contact request | `request` (neutral ink) | **Request** | "Would like to contact you" | Request detail (contact card) |
| Trial invitation | `trial` (warm gold / amber) | **Trial** | "Trial invitation · date" | Request detail (trial card) |
| Offer | `offer` (teal) | **Offer** | "View offer" | Opportunities › Offer › Offer terms |
| Signing | `signing` (green) | **Signing** | "View signing" | Opportunities › Signing › Status |

Colour is never the only signal: every accented row also carries its word, and the
`PreviewRow` accessibility label repeats it.

### Trial accent

| Theme | Edge / chip ink | Chip background | Contrast |
| --- | --- | --- | --- |
| Light (paper `#f4f6f3`) | `#b08a1c` / ink `#6e5410` | `#fbf4dc` | ink on chip 6.5 : 1 — AA |
| Dark (panel `#141a16`) | `#e9c46a` / ink `#f3dca3` | `#3a3527` | ink on chip 9.1 : 1 — AA |

Tokens live in `scoutbox-player/src/theme.ts` (`trial`, `trialBg`, `trialInk`, plus
`offer*` and `signing*`) and `design-system/tokens.css` (`--sb-trial`, `--sb-trial-bg`,
`--sb-trial-ink`). The static gate computes the WCAG ratios from the source values.

## 3. Thread view (`components/Threads.tsx`)

- Header: back chevron, avatar, organisation name, scout name and role — one line.
- One safety line under the header ("Conversations stay in ScoutBox. Report anything
  that worries you."), no paragraph.
- Bubbles: mine right / theirs left; the meta line is the time only, with "Read" or
  "Sent" on my last bubble.
- Composer: a single input with the placeholder **Message…** and a **Send** button.
- A trial that belongs to the conversation shows as a compact `TrialCard` above the
  first bubble (`testID thread-trial-card`): date, venue, status — the rest behind
  "View trial".

## 4. Request detail (`RequestDetail` in `inbox.tsx`)

Level 1 (visible without a tap):

- Kicker **TRIAL INVITATION** / **CONTACT REQUEST**, the club, "From *scout* · *role*".
- For a trial: date · venue line, slot chips (`trial-slot-*`) when more than one date is
  offered, alternative-slot buttons.
- **Accept** and **Decline** (`req-accept-*`, `req-decline-*`), or the status word once
  answered (`req-status-*`: Accepted / Declined / With guardian / Suspended).
- Two detail links where they apply: "View trial", "Open conversation".

Level 2 (behind **View full message**, `req-details-*`): the subject, the full message
body, notes / instructions, the verified-club or trusted-partner line with the time
(`fmtDayTime`, "3 Oct · 20:45"), the reporting note, and the optional reply field.

Level 3: the Report sheet, the thread, the Opportunities pages the links open.

Authorization is unchanged: the server decides who may contact whom. Accepting a
request from an organisation the player has blocked is refused (403) and the screen
says so; nothing flips to Accepted on the client.

## 5. Guardian view (`app/guardian.tsx`)

The guardian's request cards follow the same levels: scout · club · date line, Accept /
Decline visible, message and notes behind "View full message", the reply field inside.
The co-guardian, notification and data sections are one line each with their
controls; log dates use `fmtDay`.

## 6. What the live suite proves

`m24f3InboxLive` seeds, over the public API as the clubs would: an Eastport contact
request and a two-slot trial invitation for Kola; a Harbour offer (issued), accepted
over the API so a signing can be opened, attached and presented; an Eastport request
for Elias, who then blocks the organisation. At 390 / 430 / 1024 it checks: zero page
errors, three tabs, compact rows (≤ 96 px), no message body on the list, no seconds /
ISO dates, exactly one trial row with the gold accent and the word "Trial", the trial
card with Accept / Decline and slot chips, the hidden message that "View full message"
reveals, Offer and Signing rows with their accents, the Offer row landing on
Opportunities › Offer, Requests tab holding requests only, the accepted contact
becoming a conversation with a "Message…" composer and a sent bubble, the unread dot
clearing, and the blocked player's acceptance refused by both the screen and the API.
It also writes the after captures `m24f3-after-trial-invite-390.png`,
`m24f3-after-contact-request-390.png`, `m24f3-after-inbox-live-390.png` and
`m24f3-after-inbox-desktop-1024.png` into `design-system/screenshots/`.
