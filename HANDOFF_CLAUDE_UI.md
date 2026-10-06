# Approved ScoutBox Player UI handoff

The Founder approved the complete Player design on 5 October 2026 and asked
for it to be made permanent. The implementation is saved in application
source on `handoff/codex-player-vivid-ui`; it is not a browser-only override.
This final approval supersedes earlier exploratory design directions.

## Approved baseline

Read the final approval section in `BRAND_RULES.md`. Preserve the exact
ScoutBox logo and #00e676 green. Player uses system UI typography (SF Pro
on Apple), semantic icons, the approved dark canvas and translucent
gradient controls. Player is now dark-only: the latest Founder instruction in
BRAND_RULES.md supersedes all older light/dark requirements. Keep the Instagram-style inbox, connected green timelines,
structured invitations, goals and reviews, and flat agent/club/consent records.

Location precedes the bordered position badge on the same row; availability
keeps its bordered pill beneath. Profile and Football centre this group below
the name. Home retains its original metadata placement. The blue verification
seal follows the name at 20.9px, with a 6px gap and 1px optical downward offset;
it only appears for an identity verified by the existing data.

Current reference captures and their scope are documented in
`design-system/approved-player-ui/README.md`. Do not reconstruct the design
from old screenshots or reuse a cached demo bundle.

## Rebuild from source

Install dependencies with each application's existing lockfile (`npm ci`,
Node 22+), plus `e2e/`. Build the self-contained demo artifacts with:

```sh
node e2e/buildDemos.mjs
node e2e/demoFreshness.test.mjs
```

Use `e2e/dist/scoutbox-player-demo.html` over HTTP(S). The canonical build
includes the history shim, guarded storage, an explicit sample-data badge,
a source fingerprint and the build commit. A published artifact only changes
when its contents are explicitly replaced. No push, merge or deployment is
authorized by this handoff.

For the real Player app, build without the demo environment flag:

```sh
cd scoutbox-player
npx tsc --noEmit -p .
npx expo export --platform web --output-dir dist-ci
```

## Validation and boundaries

The final source passed Player TypeScript, production web export, theme
checks, season-chart checks, icon parity and semantic-icon audits. An AST
comparison confirmed 235 existing client calls unchanged across 38 modified
Player components. Light/dark previews and the final badge geometry were
checked in the local browser. Earlier interaction checks exercised inbox,
goal completion/reopening and the two independent consent acknowledgements.

Native device features, all role/state permutations and the external artifact
host have not been retested. Historical M24 live visual suites include old
minimalism and profile-layout expectations; they are not acceptance evidence
for this approved redesign. They remain historical rather than being silently
weakened. The CI Player checks are TypeScript and a production web export.

Preserve safeguarding, guardian-managed minor contact, authentication,
tenant isolation, lifecycle rules, Offer acceptance versus signing, Box Cam
versus assessment, evidence-confidence semantics, five-category navigation,
and zero authored emoji. Do not expose internal club notes or infer presence,
verification or success from decorative icons. No backend changes are part
of this design checkpoint.

## Open the local project in Claude Desktop

On macOS, double-click `Open ScoutBox in Claude.command`. It opens the Code
composer with this checkout selected and a prompt to read the persistent
project instructions. It does not submit the prompt. Claude requires folder
confirmation for every folder supplied by a deep link; confirm it in Claude.
No permissions are bypassed and no web-app filesystem bridge is installed.
The shortcut requires Node.js and Claude Desktop. Its folder resolves relative
to the checkout, so it continues to work when the repository is moved.


## Dark-only update and the cloud badge fix

The latest Player change removes light mode, theme controls and the Account
Appearance category, ignores stored light preferences, and sets native UI to
dark. The approved dark colours and gradient strengths remain unchanged.
Theme regression tests cover web/iOS/Android providers, saved preferences,
OS appearance and inaccessible storage. Other portals are unchanged.

The reported badge correction `9c6249f0ec2a3aba4e51a03e75328168488bf0a1`
existed only in Claude’s cloud checkout when this update was prepared. The
GitHub branch still ended at `7638a3d`. This update deliberately leaves
PlayerIdentity.tsx and profile.tsx unchanged. In that cloud checkout, fetch
and merge the new remote branch into the branch carrying the badge fix;
do not reset it to the remote tip and lose the unpushed correction. Rebuild
the existing artifact from the combined source. Mac launchers are unnecessary
in the cloud. Updating GitHub or the local preview does not update that artifact.
