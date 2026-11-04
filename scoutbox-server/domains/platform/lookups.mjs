/**
 * Lookups by id through the repositories' indexes (migration.md §4.3.1): a player, guardian, staff member or
 * organisation is found by its id in constant time, never by scanning the whole collection. Every route module
 * receives these as `byId` in its context.
 *
 * Each lookup answers the record view, or null when there is none. The optional `where` is a further condition
 * the record must meet (`byId.user(id, (u) => u.orgId === org.id && !u.removedAt)`); when it does not, the answer
 * is null too.
 */
const matching = (rec, where) => (rec && (!where || where(rec)) ? rec : null);

export function createLookups({ players, guardians, users, orgs }) {
  for (const [name, repo] of Object.entries({ players, guardians, users, orgs })) {
    if (typeof repo?.byId !== 'function') throw new TypeError(`createLookups needs the ${name} repository (with byId)`);
  }
  return Object.freeze({
    player: (id, where) => matching(players.byId(id), where),
    guardian: (id, where) => matching(guardians.byId(id), where),
    user: (id, where) => matching(users.byId(id), where),
    org: (id, where) => matching(orgs.byId(id), where),
    /** The player whose media list holds this clip (a clip id is unique across players). */
    mediaOwner: (mediaId) => players.byMediaId(mediaId),
  });
}
