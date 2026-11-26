// Which rate budget a request draws on, read from the development server's limiter (GET /__rate-limits).
//
// `j(method, url)` is the battery's own request helper. The answer is the buckets the request spent, as
// `action:key` (e.g. `offer_draft_write:org-eastport`), so a check can name both the budget and whose it is.
const spent = async (j) => {
  const r = await j('GET', '/__rate-limits');
  if (r.status !== 200) throw new Error(`GET /__rate-limits answered ${r.status}: is this a development server?`);
  return new Map(r.body.buckets.map((b) => [`${b.action}:${b.key}`, b.spent]));
};

export async function budgetsDrawn(j, request) {
  const before = await spent(j);
  const response = await request();
  const after = await spent(j);
  const drawn = [...after].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k);
  return { response, drawn };
}
