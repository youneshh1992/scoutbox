# Approved ScoutBox Player UI handoff

Branch: `handoff/codex-player-vivid-ui`.
Base: `f483b6d5155aab8ff0381b272259c3525eef6202`.

The Founder explicitly approved this vivid Player implementation on 5 October
2026 and authorized pushing this dedicated handoff branch. This supersedes
the older restrained Player direction. Read `BRAND_RULES.md`; retain the exact
ScoutBox logo and #00e676 green. Keep the emerald/cyan/violet/magenta canvas,
gradient sent messages and controls, colourful Phosphor icons, and animated
season charts. Reference captures are in `design-system/approved-player-ui/`.

## Update the existing artifact

Fetch and check out this branch in a clean checkout; preserve unrelated local
work. Verify the checked-out SHA against this branch on GitHub. Rebuild the
artifact from these sources and replace its existing contents. Merely pulling
GitHub does not update an already-created Claude artifact. Do not regenerate
the design from a description or reuse an earlier cached demo bundle.

Install dependencies from each application's existing lockfile with `npm ci`
(Node 22+), plus `e2e/`. The canonical multi-app artifact build is:

```sh
cd e2e
node buildDemos.mjs
node buildConnectedDemo.mjs
node demoFreshness.test.mjs
```

Use the newly generated `e2e/dist/scoutbox-player-demo.html` for the Player
artifact. `buildDemos.mjs` includes bundled fonts, the Expo Router history
shim, sandboxed-storage fallback and build identity. Player needs HTTP(S),
not a file URL. Test in the actual artifact host after replacing its contents;
that host has not been tested by Codex. An old published artifact stays old
until explicitly rebuilt/replaced there.

For a Player-only build/type check:

```sh
cd scoutbox-player
npx tsc --noEmit -p .
EXPO_PUBLIC_DEMO=1 npx expo export --platform web --output-dir dist-demo
```

## Scope and validation

The Player screen canvas and shared controls carry the approved treatment
through Home, Football, Explore, Messages, profile, Account, Development,
Box Cam, Combine, Upload, Activity and shared Guardian surfaces. Charts use
existing records and respect reduced motion. Identity rings do not claim
verification or online presence. Shared portal icons and softer message
bubbles are included. `CaseNavigation.tsx` replaces `CaseNav.tsx` to avoid
colliding with `caseNav.ts` on case-insensitive filesystems.

Player TypeScript and Expo web export passed. Navigation (504), source visual
acceptance (63), chart-data (9) and icon coverage/parity checks passed. Mobile
web was reviewed at 320, 390 and 430px, with dark/light screenshots. Inbox
search, identity shortcuts, synthetic request acceptance, clip selection,
send, reply/read receipt and empty-send disabling were exercised locally.
Native keyboard/camera/GPS, every role/state permutation and the Claude
artifact sandbox were not tested. Historical live visual tests may encode
superseded minimalism; assess failures against current Founder instructions.

Preserve safeguarding, guardian-controlled minor contact, auth, tenant
isolation, lifecycle rules, Offer acceptance versus signing, Box Cam versus
assessment, evidence-confidence semantics, five-category navigation, Inter
UI fonts and zero authored emoji. No backend changes are part of this handoff.
This handoff authorizes no merge, deployment or further push.
