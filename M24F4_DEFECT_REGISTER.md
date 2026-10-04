# M24F.4 — Defect register

Defects found while implementing and testing M24F.4, with their fix. Severity:
Critical (a user is misled or blocked), High (a root screen breaks a rule the
mandate names), Medium (a detail screen or a capture is wrong), Low (cosmetic).

| # | Severity | Where | Defect | Fix | State |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Player Home (demo) | The "Joined …" line never rendered: the demo player records carried no creation date, and the live `Me` type had none either, so the header could not say when the account opened. | `Me.createdAt` typed (optional); `PlayerProfile.createdAt` documented as "server records carry it; demo fixtures set it explicitly; never derived"; the two demo fixtures carry an explicit date. When no date exists the line is absent — never invented. | Fixed (R1) |
| 2 | Medium | Player Home | The journey row printed a raw ISO date ("2026-10-16"). | Through `humanDate` ("16 Oct"). | Fixed (R1) |
| 3 | Medium | Player Box Cam | The hero repeated the title and date the row beneath it carried. | `TrainingVisual bare` — the visual alone; the row carries the words. | Fixed (R1) |
| 4 | Medium | Player Offer | Start and end dates rendered as ISO strings; the expiry carried the weekday and the year. | `humanDate` for the term dates, `fmtDayTime` for the expiry. m23OfferLive accepts the human date. | Fixed (R2) |
| 5 | Medium | Player Evidence (demo) | The demo's sample clips carry no playable file, so the media-led root had no picture. | A quiet frame with the video mark when no file exists (never a stock image); the first frame when one does. | Fixed (R2) |
| 6 | Medium | Grassroots Open Days (demo) | The radar read line had nothing to read: the demo club had told the radar nothing. | The demo club fixture carries `lookingFor: GK, CDM, CM, ST, CF`. | Fixed (R3) |
| 7 | Low | Pro + Grassroots Recruitment Rooms | Two near-identical ordering notes at the foot of the list ("Rooms are listed by…" / "Rooms are ordered by…"). | One line (the tested sentence). | Fixed (R5) |
| 8 | Low | Pro + Grassroots Fixtures | Two pills per row (GPS, player count) on a list of 11 fixtures. | One quiet line per row. | Fixed (R5) |
| 9 | Medium | Player Guardian dashboard | 1 748 words and 60 bordered elements on the root: every management form open at once. | Forms behind "Manage …'s profile", Co-guardian, Notifications and Your family's data rows (967 words, 34 borders). The M12–M23 child sections stay visible for their live-test contracts. | Fixed (R5) |
| 10 | Medium | Pro + Grassroots Players | 12 result cards with 4–8 pills each (69 bordered elements). | At most three pills per card; the rest one quiet line. | Fixed (R5) |
| 11 | Low | Measuring scripts | The first M24F.4 crawler redeclared a variable inside the page evaluation and the M24F.3 portal crawler reached only 22 of 53 Pro screens (sidebar-driven). | The route-driven crawler (`m24f4-portal-routes.mjs`) visits every nav id by hash plus each screen's tabs; the Player crawler measures the Activity page and the profile sections too. | Fixed (R5) |
| 12 | Low | Captures | The portal capture script could not reach the Grassroots Open Days and Squad pages (the sidebar group expansion differs), so the first "before" shots showed Home. | Hash navigation; the before shots were recaptured from the preserved M24F.3 bundles. | Fixed (R4) |
| 13 | Low | m22Live | One run failed while the Evidence section was mid-edit (a duplicate declaration in the tree at export time). | Re-run on the finished tree: 41 checks green. Not a product defect. | Closed |
| 14 | Low | m24f4PortalMinimalLive | Reading the ring's SVG `<text>` through `innerText` threw ("Node is not an HTMLElement"). | `textContent`; the suite guards each width so a throw reports instead of aborting. | Fixed (R6) |
| 15 | High | Player Home (live) | With nothing waiting, Home had no primary action at all (m24fVisualLive: 0 bright primaries under "Next"). | "Nothing waiting on you" now carries one primary button, "Explore clubs" (FR "Explorer les clubs"), to the opportunity board. | Fixed (R6) |
| 16 | High | Player Updates (minor) | The old Home header said "Guardian-managed · verified clubs only"; the header reset removed it, and the child's Updates rows then said only "Declined" with no sign the club's request went to the guardian (m23ContactLive M6, m23TrialLive N12). | Every settled row on a child's Updates reads "Declined · Guardian-managed" (FR "Géré par votre tuteur"); pending rows keep "With your guardian". | Fixed (R6) |
| 17 | Medium | Pro + Grassroots Discover | Pre-existing since M18.1: the ordering note named the Trust Score without saying it is evidence confidence (m181DemoSpotcheck failed on the M24F.3 bundles too). | "…not ability, not the Trust Score (Evidence confidence)." EN and FR: the Pro and Grassroots ordering sentence and the Grassroots-only First Team Seekers sentence. | Fixed (R6) |
| 18 | Low | Player Activity | `Date.now()` during render raised one new lint error (48 → 49). | The clock is read once in a state initialiser; lint back to the 48 baseline. | Fixed (R6) |
| 19 | Low | m24eScrollLive | The flatter Grassroots squad page at 1440 × 700 left the last control in view, so the "needed scrolling but did not move" heuristic misfired. | The suite scrolls to the end when the page needs it and has not moved; same assertion. | Fixed (R6) |

## Known flakes

- `m23OfferLive` A6 — pre-existing, documented since M24F.2: fails once in roughly
  one battery in three, passes on re-run. Not touched by M24F.4.

## Not defects (recorded so nobody re-opens them)

- The Director Dashboard's detail still holds about 2 500 words: one limitation
  sentence per panel is the M20 contract (every panel prints its limitation, never
  inside a disclosure). The executive layer above it is the director's view.
- Nobody Missed keeps the sentence "Evaluation Coverage is workflow coverage…" on
  screen: the m18 suites assert it on the panel.
- The Second Look "does not judge that decision" line, the Matching "no match score"
  line and the Plan & Compliance attribution clause stay: tested honesty and
  contract wording.
