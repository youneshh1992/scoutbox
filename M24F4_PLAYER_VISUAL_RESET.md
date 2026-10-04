# M24F.4 — Player visual reset

Baseline `d1fc3f1` (M24F.3). Every figure below is the demo bundle at 390 × 844
measured by the M24F.4 crawler (`m24f4-player-density.mjs`: visible words,
paragraphs over 140 characters, cards, bordered containers, scroll height).

## 1. Per screen

| Screen | Words before → after | Paragraphs | Bordered | Root height (px) | What changed |
| --- | --- | --- | --- | --- | --- |
| Home | 261 → 82 (−69 %) | 1 → 0 | 2 → 1 | 1696 → 990 | Header = avatar, name, "ST · Manchester", "Open to trials", "Joined Apr 2026". Greeting, day/date, "View your Passport" and "Verified clubs can see you" removed from the header (the visibility sentence lives behind "Your visibility right now"). Then NEXT (one action), RECENT (3 events + "View all activity"), Your journey. |
| Activity (new) | — → 56 | 0 | 0 | 844 | Its own page: the week's figures in one line, every event grouped Today / This week / Earlier, one row each ("Yesterday · Eastport FC shortlisted you"), "Scouts noticed" as one line. No table. |
| Football / Passport | 160 → 89 (−44 %) | 0 | 2 → 1 | 1872 → 1204 | Record line, Current club, Availability, Evidence, then Timeline (n events ›), Club history (n clubs ›), Achievements (n ›), Share, About Passport. The forms sit inside the row they belong to. A conflict reads "Club record needs review ›". |
| Football / Development | 535 → 62 (−88 %) | 0 | 21 → 1 | 3892 → 990 | Current focus › · Latest feedback › · Progress › · History ›. Goal cards, reviews, actions and the plan switcher are one tap deep. |
| Football / Box Cam | 329 → 76 (−77 %) | 0 | 8 → 2 | 2219 → 1048 | The visual, "Box Control · Recorded 2 Oct · Partially verified ›", Start session, the observation row, RECENT (≤ 3 rows), "How Box Cam works ›" (setup, facts, provider note), "Training record ›" (activity, assignments, bests, challenges, sharing). "Unable to verify" kept. |
| Football / Combine | 335 → 58 (−83 %) | 0 | 11 → 1 | 1894 → 990 | Exercise names only. A row opens Latest result, Status, Start, Instructions ›, History ›. Club Combine and Combine Card as rows; "About Combine ›". |
| You / Profile / Evidence | 231 → 58 (−75 %) | 0 | 1 → 0 | 1895 → 1065 | The latest clip as a picture (the first frame when a file exists; a quiet frame with the video mark when not), "Sprint & finishing session · 2 Oct · Verified clip ›", Video 2 ›, Combine 3 ›, Coach references 0 ›, Verified attendance 2 ›, Box Cam ›, Evidence record ›. |
| Explore / Offer / Offer | 102 → 67 (−34 %) | 0 | 7 | 990 | OFFER · Eastport FC · Central midfielder · Under-23s · Starts 1 Jul 2027 · Ends 30 Jun 2029 · Status · Accept / Decline · View terms › · "Offer acceptance is not a signature." |
| Guardian dashboard | 1748 → 967 (−45 %) | 0 | 60 → 34 | 12552 → 7728 | "Manage Guni's profile ›" holds medical sharing, pairing, open days, First Team Seeker, coach reference, deletion; Co-guardian, Notifications and Your family's data are rows. The M12–M23 child sections below are unchanged (live-test contracts). |
| Messages, Explore (board, fit), Profile Overview / Performance / Journey, Account, Clubs | unchanged | | | | kept at the Founder's direction / M24F.3 |

Totals over the 37 crawled Player screens: 7 015 → 4 880 words (−30 %); the eight
reset screens alone 3 701 → 1 449 (−61 %). No information was removed: every item
is one tap deeper, behind a row with the same test id or a new one listed below.

## 2. Structure of the reset roots

```
HOME                                   FOOTBALL › BOX CAM
 [KA]  Kola Adeyemi                      [ visual ]
       ST · Manchester                   Box Control
       Open to trials                    Recorded 2 Oct · Partially verified      ›
       Joined Apr 2026                   [ Start session ]
 NEXT                                    Box Cam observation (live)              ›
 Harbour City FC                         Recent sessions
 Contact request        [ View ]         Box Control   2 Oct · Partially verified ›
 Recent                                  …
 Tue        Harbour City FC saved you    How Box Cam works                       ›
 Tue        Harbour City FC viewed …     Training record  Box Streak · 3 weeks   ›
 Yesterday  Eastport FC shortlisted you
 View all activity ›                   FOOTBALL › COMBINE
 Your journey                            Box Touch 60                            ›
 Moss Side Athletic · Open training ›    Box Juggle                              ›
 Clubs within reach   1 · 50 km      ›   …
```

## 3. Data sources (nothing invented)

| Line | Source |
| --- | --- |
| "Joined Apr 2026" | `me.createdAt` (server `/player/me` spreads the player record; the demo fixtures carry an explicit `createdAt`). When the record has no date the line is absent — never derived from activity. |
| NEXT | the first pending inbox request, else the first unread conversation |
| RECENT | `insights.recent` (the same call Home made before), three newest |
| Activity page | `insights.recent` + the feed's `scouting_event` items, de-duplicated |
| Box Cam latest / recent | `dashboard.recent` (server sessions, verbatim), state word = server `verificationState` |
| Combine rows | the protocol library (players) or the child's attempts (guardians); detail = the server's attempts for that protocol |
| Evidence counts | `me.media.length`, `combine.overview().verifiedResults.length`, `me.vouches.length`, `me.attendance.length` |
| Offer | the issued revision, verbatim; dates through `humanDate`, the expiry through `fmtDayTime` |

## 4. Test ids added

`home-joined`, `home-primary-cta`, `home-activity-all`, `activity-page`,
`activity-group-{today|week|earlier}`, `activity-row`, `dev-root`, `dev-focus`,
`dev-feedback`, `dev-progress`, `dev-history`, `dev-page-*`, `dev-back`,
`boxcam-latest`, `boxcam-start`, `boxcam-observe`, `boxcam-session-*`,
`boxcam-recent-all`, `boxcam-how`, `boxcam-record`, `boxcam-session-detail`,
`boxcam-back`, `combine-section`, `combine-exercises`, `combine-protocol-*`,
`combine-detail`, `combine-latest`, `combine-status`, `combine-start`,
`combine-why`, `combine-instructions`, `combine-history`, `combine-requests-row`,
`combine-card-row`, `combine-about`, `combine-back`, `passport-timeline` (now the
row), `passport-history` (now the row), `passport-history-list`,
`passport-achievements` (now the row), `evidence-root`, `evidence-latest`,
`evidence-latest-thumb`, `evidence-latest-row`, `evidence-video-row`,
`evidence-combine-row`, `evidence-references-row`, `evidence-attendance-row`,
`evidence-record-row`, `evidence-record`, `evidence-back`, `offer-terms-*`,
`offer-not-signature-*`, `guardian-manage-*`, `guardian-coguardian`,
`guardian-notifications`, `guardian-data`.

## 5. Suites re-pointed (none weakened)

| Suite | Change |
| --- | --- |
| m15Live | opens the Achievements / Club history rows before their forms; the Add inside its own row |
| m16Live | waits for `boxcam-start`; clicks "Start session" |
| m21Live | opens the Goals page (`dev-focus`) before goal cards, actions, evidence links, targets and the plan switcher; reads root + goals + history at 390 px |
| m22Live | waits for `boxcam-start` |
| m23OfferLive | opens "View terms" before reading the club's message; accepts the human date |
| m24f3MinimalLive | opens the Timeline row before counting its preview |
| m18Live, m18DemoSpotcheck, m181DemoSpotcheck | open a candidate row before reading "Why shown" / clicking its actions |
| uiSpotcheck | opens "Manage …'s profile" before the pairing code |
| m12Live, m12DemoSpotcheck | open the "Evidence record" row before reading the evidence passport |
| m21DemoSpotcheck | reads the root, the Goals page (with each "About this target" opened) and the Feedback page |
| m23OfferHardeningLive | opens "View terms" before reading the club's message on an expired Offer |
| m24eScrollLive | scrolls to the end when a page needs scrolling and has not moved |
| uiSpotcheck | waits for "Your journey" on Home |

## 6. Captures

`design-system/screenshots/m24f4-before-*-390.png` (M24F.3 bundles) and
`m24f4-after-*-390.png` (this tree): home, home-fold, activity, passport,
development, boxcam, combine, evidence, offer; portals at 1280: grassroots-radar,
grassroots-squad, nobody-missed, director-dashboard (plus `-tall`).
