# Browser end-to-end suite

Playwright checks over the **self-contained demo bundles** — the same single
HTML files that get published as the app tabs. (The live API has its own
suite: `scoutbox-server/e2e/platform/api.mjs`, run by CI.)

```bash
node e2e/buildDemos.mjs        # build the per-app demo bundles into e2e/dist/
node e2e/buildConnectedDemo.mjs   # build scoutbox-connected-demo.html (the tests refuse to start without it)
# Each test starts its own demo host on :8099 (one origin for the bus), or reuses
# one already running with a matching build; `node e2e/serve.mjs &` starts one by hand.
node e2e/demoOffline.test.mjs  # bundles work with zero network
node e2e/crosstab.test.mjs     # club tab ↔ player tab: one real conversation
node e2e/uiSpotcheck.test.mjs  # feature surfaces incl. pairing + email gates
node e2e/m162DemoSpotcheck.test.mjs   # Trust Score story across all four bundles
```

The `*Live.test.mjs` suites are different: each spawns its own backend on its
own port, builds its own bundles and drives several apps at once, so they need
no demo host. `m162Live.test.mjs` covers the M16.2 Trust Profile journeys.

Requires a Chromium binary; set `CHROMIUM` if it is not at
`/opt/pw-browsers/chromium`, and `playwright-core` available (any of the app
node_modules provides it via `NODE_PATH`, or `npm i -D playwright-core` here).

To install the matching Chromium, run `npx playwright-core install chromium` from
`e2e/`; it lands in `~/Library/Caches/ms-playwright/` on macOS. On macOS,
`/opt/pw-browsers/chromium` must be a wrapper script, not a symlink: Chrome finds
its framework relative to the path it was launched from, so a symlink crashes at
launch. For example:

```sh
#!/bin/sh
exec "$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" "$@"
```

The `chromium-NNNN` folder changes when `playwright-core` is upgraded; update the
wrapper to match.
