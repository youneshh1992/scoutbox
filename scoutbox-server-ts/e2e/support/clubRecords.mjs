// A club's recruitment records as the club reads them: every case with its status and revision, and every signing.
// A battery whose acts belong to another domain takes this before and after, and expects it unchanged.
export async function clubRecords(j, token) {
  const rooms = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
    const r = await j('GET', `/org/rooms${q}`, undefined, token);
    if (r.status !== 200) throw new Error(`GET /org/rooms answered ${r.status}`);
    for (const c of r.body.items ?? []) rooms.push({ id: c.roomId ?? c.id, status: c.status, rev: c.rev ?? null });
    cursor = r.body.nextCursor ?? null;
    if (!cursor) break;
  }
  const signings = (await j('GET', '/org/signings', undefined, token)).body?.items ?? [];
  return {
    rooms: rooms.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    signings: signings.map((s) => s.id).sort(),
  };
}
