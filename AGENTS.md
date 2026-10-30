# ScoutBox project instructions

Read `CLAUDE.md` first: it holds the rules. The status of every storage-migration step, the
acceptances and the Founder's decisions in force are the table in
`docs/architecture/sqlite-migration-plan.md` §E. Read `CLAUDE.md` before changing UI. It contains the persistent Founder approvals
for Pro, Player and Grassroots; preserve subsequent explicitly authorized changes.

After every milestone, apply the two gates in `CLAUDE.md` → "Milestone gates —
documentation housekeeping and unit tests": clean up genuinely obsolete Markdown
(consolidating still-relevant content first) and run both the backend
(`cd scoutbox-server && npm test`) and the Player app (`cd scoutbox-player &&
npm test`) unit-test suites against the final tree, recording commands, versions,
exit codes and totals in the handoff. That section is the authoritative policy;
it is not restated here.

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

For Pro, read `PRO_EXECUTIVE.md` first. The Founder approved `f87f61d` on
`design/pro-executive` on 6 October 2026 and requested this as the permanent Pro
UI. Preserve the implementation, bright aligned Pro lockup, correspondence desk,
player dossiers, football entry and workspace tools. New features must fit it;
redesign only on explicit Founder request. The Pro artifact is
`e2e/dist/scoutbox-club-demo.html`, rebuilt and freshness-checked as above.
This does not reopen the approved Player or Grassroots designs.

For Agent, read `AGENT_FINANCE.md` and `HANDOFF_CLAUDE_AGENT.md`. The Founder
approved the finished UI at `7ee9ecb` on `design/agent-finance` on 6 October 2026
and requested a GitHub push and an artifact ready for Claude. Preserve this
approved black/violet business workspace, stacked Agent identity, ScoutBox
wordmark and green brand accents. Use the implementation as the source of truth.
