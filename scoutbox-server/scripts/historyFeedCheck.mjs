// A test helper (§4.3 step 4): check a repository's history feed (`feed(orgId, actions, atMost, n)` →
// `[{ …owner ids, entry }]`) against the records' own histories. For every organisation, action set, cut-off and size,
// the feed is the matching entries at or before the cut-off, newest first, down to the instant of the (n + ties)th one
// and including every entry at that instant; its count is every matching entry.
import assert from 'node:assert/strict';

const plain = (v) => JSON.parse(JSON.stringify(v));

export function checkHistoryFeed(label, { feed, count, records, ownerKey }) {
  const orgs = [...new Set(records.map((r) => r.orgId)), 'nobody'];
  const actionsSeen = [...new Set(records.flatMap((r) => r.history.map((h) => h.action)))];
  assert.ok(actionsSeen.length >= 2, `${label}: the fixture has history to feed`);
  let rows = 0;
  for (const orgId of orgs) {
    for (const actions of [actionsSeen, actionsSeen.slice(1), []]) {
      const all = records.filter((r) => r.orgId === orgId).flatMap((r) => r.history.filter((h) => actions.includes(h.action)).map((entry) => ({ owner: r.id, entry })));
      assert.equal(count(orgId, actions), all.length, `${label}: count ${orgId}`);
      for (const atMost of [null, ...new Set(all.map((x) => x.entry.at))]) {
        const pool = all.filter((x) => atMost === null || x.entry.at <= atMost).sort((a, b) => b.entry.at - a.entry.at);
        const tied = atMost === null ? 0 : pool.filter((x) => x.entry.at === atMost).length;
        for (const n of [1, 2, 100]) {
          const edge = pool.length > n - 1 + tied ? pool[n - 1 + tied].entry.at : -Infinity;
          const want = pool.filter((x) => x.entry.at >= edge);
          const got = feed(orgId, actions, atMost, n);
          for (let i = 1; i < got.length; i += 1) assert.ok(got[i - 1].entry.at >= got[i].entry.at, `${label}: newest first`);
          const key = (x) => `${x.owner}|${x.entry.id}`;
          assert.deepEqual(got.map((x) => `${x[ownerKey]}|${x.entry.id}`).sort(), want.map(key).sort(), `${label}: ${orgId} atMost=${atMost} n=${n}`);
          for (const x of got) assert.deepEqual(plain(x.entry), plain(want.find((w) => w.owner === x[ownerKey] && w.entry.id === x.entry.id).entry), `${label}: the entry as the record holds it`);
          rows += got.length;
        }
      }
    }
  }
  assert.ok(rows > 0, `${label}: some feed rows were checked`);
}
