# M24F.2 — Defect register

Baseline `e5fe716`. Everything found during the pass, with its state at the
end of the pass.

| # | Severity | Where | Defect | State |
|---|---|---|---|---|
| 1 | medium | Player › You | A category or tab change used `router.setParams`, which replaces the history entry: the browser's back left the You tab instead of returning to the previous category. | **Fixed** — on the web a tab or category change first pushes its URL onto the browser history (the router's own navigation to the same tab screen only replaces the entry), then updates the params; `m24f2DensityLive` proves back → Development, forward → History at four viewports. |
| 2 | medium | Agent light sidebar | A later `platform.css` rule for the light Agent active destination still painted the inset bar in `var(--sb-green)`, so the Home destination showed a green bar beside gold text. | **Fixed** — the rule reads `--sb-nav-active-icon`; the live suite reads the bar colour on Home in both themes. |
| 3 | low | Grassroots light sidebar | Sign out inherited the light theme's red ink, 2.6 : 1 on the navy column. | **Fixed** — the sidebar declares `--sb-urgent-ink: #FFB4A8` (7.2 : 1). |
| 4 | low | Player lint | The `useLoad` helper copied into `ClubsSections.tsx` carried the baseline's synchronous `setErr(null)` inside its effect (one new lint error over the 36 baseline). | **Fixed** — the error clears with the result; lint is back to the 36 / 15 baseline. |
| 5 | low | Grassroots entry | The M24E suite required the desktop introduction to show its bullet points; Grassroots now has none by design. | **Fixed** — `m24dAuthLive` exempts Grassroots; the M24F visual gates and the live suite assert the new state (photograph, no bands, no points). |
| 6 | low | Pro, Grassroots | One error string opened with "Choose whether…". | **Fixed** — rewritten as the condition it states. |

Open critical: 0. Open high: 0. Open medium: 0. Open low: 0.

## Not defects, noted

- The Agent light active **icon** (`#A67C2E` on `#F7F1E3`) measures 3.4 : 1.
  It is a non-text graphic beside gold text (5.6 : 1), a gold inset bar and
  `aria-current`; the active state is never carried by the icon alone.
- Server-authored sentences (`honest`, `note`, `offerBoundary.honest`) were
  left as sent; the sub-note rule governs client copy.
