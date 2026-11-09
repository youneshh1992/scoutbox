/**
 * S14j — the match reads shared by matching, the Dynamic Watchlists and Nobody Missed: one SQL query over the players
 * an organisation may see (identity's visibleWhere, the whole visibility rule, first) joined to their stored facts
 * (repositories/matchFacts.mjs), each required criterion a condition beside its JS test (match.mjs criterionSql).
 * Pages are keyset pages (§4.3 paging); only a page's players are decoded into the engine's facts.
 */
import { criterionSql, factsOfRow, BAND_RANK_SQL, AGE_SQL } from './match.mjs';
import { readPage } from '../../platform/paging.mjs';

export function createMatchReads({ players, matchFacts }) {
  const EMPTY_QUERY = Object.freeze({ count: () => 0, ids: () => [], page: () => [] });
  /**
   * The match query: the players this organisation may currently see (the whole visibility rule, first), joined to
   * their facts, with every required criterion and any `extra` condition. Nothing about anyone else, not even a count.
   */
  function matchQuery(org, required, at, extra = []) {
    const visible = players.visibleWhere(org, at);
    if (!visible) return EMPTY_QUERY; // a Grassroots club without a ground sees nobody
    return matchFacts.query(visible, [...required.map((c) => criterionSql(c, { now: at, org })), ...extra]);
  }
  /** The engine's facts for a page's rows: the child rows in one query each. */
  function factsOfRows(rows, org, at) {
    const children = matchFacts.childrenOf(rows.map((r) => r.id));
    return rows.map((r) => factsOfRow(r, children.get(r.id), { org, now: at }));
  }
  /** The players among `ids` the organisation may still see, as facts (a watchlist's leavers, to say why). */
  function visibleFactsOf(org, ids, at) {
    if (!ids.length) return [];
    const rows = matchQuery(org, [], at, [{ sql: 'p.id IN (SELECT value FROM json_each(?))', args: [JSON.stringify(ids)] }]).page([['p.id', 'ASC']], { limit: ids.length });
    return factsOfRows(rows, org, at);
  }

  /** The keyset order of a sort (every one ends on the player id, so two reads return the same order, M18.2) and its cursor shape. */
  const NO_DISTANCE = 10_000_000_000;
  function matchOrder(sort, org, at, extra = {}) {
    // The distance exists only where the club may see it (a Grassroots club's, the org view's rule): elsewhere every
    // player ties on it, so neither the order nor a cursor can carry a distance the club is not shown.
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
    // The tie-break is the facts' player id (the same value as p.id), so an order the facts index serves walks it.
    return { order: [lead, ['f.player_id', 'ASC']], shape: [sort === 'name' ? 'string' : 'number', 'string'] };
  }
  const keyOfRow = (r) => [r.k0, r.k1];
  /**
   * `limit` and `cursor` from a body or a query (§4.3 paging; junk refused with 400). An `offset` is refused: these
   * lists page by cursor since S14j, so a client cannot walk a large result by position.
   */
  function readMatchPage(input, shape) {
    if (input?.offset !== undefined) throw Object.assign(new Error('PAGE_OFFSET_UNSUPPORTED: page with cursor, the previous response\'s nextCursor'), { code: 'PAGE_OFFSET_UNSUPPORTED', status: 400, pageError: true });
    return readPage({ limit: input?.limit === undefined || input?.limit === null ? undefined : String(input.limit), cursor: input?.cursor ?? undefined }, shape);
  }

  return { EMPTY_QUERY, matchQuery, factsOfRows, visibleFactsOf, matchOrder, keyOfRow, readMatchPage };
}
