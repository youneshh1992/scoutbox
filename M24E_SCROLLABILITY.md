# M24E — Everything can be scrolled to

"I can scroll screens where I need to so I can see everything in all
orientations" is a global invariant, asserted by `m24eScrollLive` at
320×568, 360×640, 390×844, 430×932, 640×360, 844×390, 1024×600, 1280×720 and
1440×700.

## Scroll model

**Portals (Pro, Grassroots, Agent, Trust & Safety)**

```
.shell          height: 100vh grid — sidebar | main
  nav.sidebar   column; brand + organisation fixed at the top,
                .nav-scroll (sections, groups, pages, Inbox) scrolls on its own,
                shortcuts / account block (Sign out, Switch) / collapse at the bottom;
                the sidebar itself scrolls as a last resort (overflow-y: auto)
  .main         column; .topbar fixed, .subnav (phone) fixed, .content scrolls (overflow-y: auto)
.login.auth-page   height: 100dvh; overflow-y: auto; the card centres by auto margins and
                   the page scrolls from the top when the viewport is shorter than the card
drawers (.drawer)  fixed right, overflow-y: auto; the close control at the top
bell panel / thread / palette results  max-height bound to the viewport, overflow-y: auto
tables (.f-ledger) overflow: auto inside their container — the page never widens
≤ 900px          the sidebar is a fixed drawer (its own scroll), the content scrolls;
                 the top bar's menu button opens it, choosing a section or Escape closes it
```

On a landscape phone (viewport ≤ 420px tall) the sidebar tightens its
padding, the wordmark's and organisation's spacing and the navigation
region's minimum height (96px instead of 140px), so the wordmark, the
organisation, a few sections and the account block with the exits all fit
in a 360px-tall drawer without scrolling the sidebar itself (measured on
Trust & Safety at 640×360: 399px of sidebar before, under 360px after).

Trust & Safety had no menu button and no drawer state: at ≤ 900px its
sidebar was translated off screen with nothing to bring it back, so on a
phone or in landscape the console had no navigation and no Sign out
(defect E1 in `M24E_DEFECT_REGISTER.md`). It now has the same hamburger,
veil, `drawer-open` state and `.nav-scroll` region as the other three
portals.

What changed in M24E: the entry page became the scroll container
(`height: 100dvh; overflow-y: auto`, `.auth-card { margin: auto 0 }`) — before
it was `min-height: 100vh` with the card centred, which clipped the first row
behind the top edge at 640×360 and 1024×600; the sidebar's navigation region
is `.nav-scroll` with its own scroll, so the account block with the exits
never leaves the screen; the bell panel, the thread view and the command
palette bound their heights to the viewport instead of fixed 320 / 420px.

**Player**

```
MobileViewport   flex: 1 column of at most 430px; the page body is the frame
  Stack / Tabs   each screen = SafeAreaView > ScrollView (paddingBottom 24) ;
                 the bottom navigation is laid out by the Tabs (75px), never over the content
  /onboarding    SafeAreaView > KeyboardAvoidingView > ScrollView (paddingBottom 36)
  sheets         Modal > maxHeight 80% > ScrollView (NotificationBell, ReportSheet)
```

The screen body scrolls inside the column at every width and in both
orientations; the tab bar sits below the scroll area, so the last control is
never under it.

## Viewport / orientation matrix

| Case | 320×568 | 360×640 | 390×844 | 430×932 | 640×360 | 844×390 | 1024×600 | 1280×720 | 1440×700 |
|---|---|---|---|---|---|---|---|---|---|
| Pro / Grassroots / Agent / T&S entry: last row, submit, credit reachable; no page overflow; container = viewport height | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Agent demo roster (three profile rows) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Player entry: four rows and the credit inside the column | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Long selectors (15 organisations, long names) | ✓ | | | | ✓ | | | | |
| Long pages (Pro Organisation, Grassroots Squad, Agent Clients, T&S Verification) | | | | | ✓ | | ✓ | | ✓ |
| Player pages (You, Home, Passport, Opportunities, Messages) with the tab bar | | ✓ | | ✓ | ✓ | | | | |
| Sidebar overflow with Recruitment open; exits on screen | | | | | | | ✓ | | |
| Palette, Report / Block drawer | | | | | | | ✓ | | |
| Ledger table inside its container | | | | | ✓ | | | | |
| Orientation change on an open screen (portrait ↔ landscape) | | | ✓→ | | ✓ | ✓ | | | |

Each cell asserts: the scroll container is the viewport height, it scrolls
when its content is taller (scrollTop moves), the last meaningful control
scrolls into view, no fixed element covers the final content, and the
document has no horizontal overflow (the only wide thing anywhere is the
pitch drawing behind the entry card, clipped by the page's own
`overflow-x: hidden`).

## Long data

Ten federation clubs with 50–60 character names are registered on the live
server before the suite runs, so the Pro and Grassroots selectors hold
fifteen rows: every row is reachable at 320×568 and 640×360, long names wrap
inside the row, the last row can be chosen and the submit reached after it.
The Agent's demo roster is fixed at three profiles; it is the same row
component, so the long-list proof covers it.
