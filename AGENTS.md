# ScoutBox project instructions

Read `CLAUDE.md` before changing UI. It contains the persistent Founder approvals
for Player and Grassroots; preserve subsequent explicitly authorized changes.

For Grassroots, read `GRASSROOTS_CLUBHOUSE.md` first. The Founder approved the UI
at `5a3e7b0` on `design/grassroots-clubhouse` on 6 October 2026 and requested it be
the Grassroots artifact UI going forward. Use the implemented components/styles,
not earlier screenshots or generated HTML, as the source of truth. Preserve the
approved design unless the Founder explicitly requests a change.

Rebuild artifacts using `node e2e/buildDemos.mjs`, then run
`node e2e/demoFreshness.test.mjs`. The Grassroots deliverable is
`e2e/dist/scoutbox-grassroots-demo.html`. Replacing an external artifact requires
uploading the new bundle there; a source commit or GitHub push alone is not an
external artifact update.

Preserve authentication, permissions, safeguarding, privacy, data provenance,
and working navigation/actions. Do not restyle other apps during Grassroots work.
User authorization in the current session takes precedence over these guidelines.
