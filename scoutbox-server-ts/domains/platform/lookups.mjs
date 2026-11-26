/**
 * `byId` in every route context. The optional `where` is a further condition
 * the record must meet, e.g. `byId.user(id, (u) => u.orgId === org.id)`; a
 * record that fails it is null.
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
    /** Clip ids are unique across players. */
    mediaOwner: (mediaId) => players.byMediaId(mediaId),
  });
}
