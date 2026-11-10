/**
 * The match reads shared by matching, the watchlists and Nobody Missed: one SQL query over the players an
 * organisation may see, joined to their stored facts, each required criterion a condition beside its JS test.
 */
import { criterionSql, factsOfRow, BAND_RANK_SQL, AGE_SQL } from './match.mjs';
import { readPage } from '../../platform/paging.mjs';

export function createMatchReads({ players, matchFacts }) {
  const EMPTY_QUERY = Object.freeze({ count: () => 0, ids: () => [], page: () => [] });
  /** Nothing about a player the organisation may not see escapes, not even a count. */
  function matchQuery(org, required, at, extra = []) {
    const visible = players.visibleWhere(org, at);
    if (!visible) return EMPTY_QUERY; // a Grassroots club without a ground sees nobody
    return matchFacts.query(visible, [...required.map((c) => criterionSql(c, { now: at, org })), ...extra]);
  }
  function factsOfRows(rows, org, at) {
    const children = matchFacts.childrenOf(rows.map((r) => r.id));
    return rows.map((r) => factsOfRow(r, children.get(r.id), { org, now: at }));
  }
  /** A watchlist's leavers the organisation may still see, to say why they left. */
  function visibleFactsOf(org, ids, at) {
    if (!ids.length) return [];
    const rows = matchQuery(org, [], at, [{ sql: 'p.id IN (SELECT value FROM json_each(?))', args: [JSON.stringify(ids)] }]).page([['p.id', 'ASC']], { limit: ids.length });
    return factsOfRows(rows, org, at);
  }

  const NO_DISTANCE = 10_000_000_000;
  function matchOrder(sort, org, at, extra = {}) {
    // Only a Grassroots club is shown distance: elsewhere every player ties on it, so neither the order nor a cursor
    // can carry a distance the club is not shown.
    const seesDistance = (org?.level ?? null) === 'grassroots' && !!org.location;
    const lead = {
      recent_evidence: ['COALESCE(f.last_evidence_at, 0)', 'DESC'],
      newest_evidence: ['COALESCE(f.last_evidence_at, 0)', 'DESC'],
      name: ['f.name_key', 'ASC'],
      age: [`COALESCE(${AGE_SQL(at).sql}, 999)`, 'ASC', AGE_SQL(at).args],
      evidence_confidence: [BAND_RANK_SQL(), 'DESC'],
      distance: seesDistance ? [`COALESCE(distance_tenths(?, ?, p.lat, p.lng), ${NO_DISTANCE})`, 'ASC', [org.location.lat, org.location.lng]] : [String(NO_DISTANCE), 'ASC'],
      ...extra,
    }[sort] ?? ['COALESCE(f.last_evidence_at, 0)', 'DESC'];
    // Tie-break on f.player_id (equal to p.id) so the facts index serves the order.
    return { order: [lead, ['f.player_id', 'ASC']], shape: [sort === 'name' ? 'string' : 'number', 'string'] };
  }
  const keyOfRow = (r) => [r.k0, r.k1];
  /** An `offset` is refused: a client cannot walk a large result by position. */
  function readMatchPage(input, shape) {
    if (input?.offset !== undefined) throw Object.assign(new Error('PAGE_OFFSET_UNSUPPORTED: page with cursor, the previous response\'s nextCursor'), { code: 'PAGE_OFFSET_UNSUPPORTED', status: 400, pageError: true });
    return readPage({ limit: input?.limit === undefined || input?.limit === null ? undefined : String(input.limit), cursor: input?.cursor ?? undefined }, shape);
  }

  return { EMPTY_QUERY, matchQuery, factsOfRows, visibleFactsOf, matchOrder, keyOfRow, readMatchPage };
}
