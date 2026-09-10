# Browser end-to-end suite

Playwright checks over the **self-contained demo bundles** — the same single
HTML files that get published as the app tabs. (The live API has its own
suite: `scoutbox-server/scripts/apiE2E.mjs`, run by CI.)

```bash
node e2e/buildDemos.mjs        # build the three demo bundles into e2e/dist/
node e2e/serve.mjs &           # host them on :8099 (one origin for the bus)
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
