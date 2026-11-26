// Every seeded player's contract status and Trust Profile, as each given club reads them: a battery takes this once
// at the start and once at the end, and checks that only the acts it allows moved anything.
export const SEED_PLAYERS = Object.freeze([
  'pl-adeyemi',
  'pl-alvarez',
  'pl-carvalho',
  'pl-guni',
  'pl-imani',
  'pl-kim',
  'pl-martin',
  'pl-mensah',
  'pl-nowak',
  'pl-okafor',
  'pl-osei',
  'pl-svensson',
  'pl-tanaka',
  'pl-tomasz',
]);

/** `{ [playerId]: [facts per token] }`; null where that club cannot read the player (not visible, or blocked). */
export async function playerFacts(j, tokens) {
  const facts = {};
  for (const id of SEED_PLAYERS) {
    const seen = [];
    for (const token of tokens) {
      const p = await j('GET', `/org/players/${id}`, undefined, token);
      const t = await j('GET', `/org/players/${id}/trust-profile`, undefined, token);
      seen.push(
        p.status === 200 && t.status === 200
          ? { contractStatus: (p.body.player ?? p.body).contractStatus ?? null, trust: t.body.trust }
          : null,
      );
    }
    facts[id] = seen;
  }
  return facts;
}

// A completed signing puts the player in the club's squad and on its Passport as their confirmed current club. Trust
// reads both, as a relationship and as football history, and a signing reaches it no other way.
const JOINING_A_CLUB = new Set(['footballHistory', 'relationships']);

/** A Trust Profile without the components joining a club moves, and the totals and signals they move. */
const otherThanJoining = (trust) => ({
  ...trust,
  score: undefined,
  band: undefined,
  bandLabel: undefined,
  signals: undefined,
  explanations: trust.explanations.filter((e) => !JOINING_A_CLUB.has(e.component)),
});

/**
 * What moved between two readings, comparing only what the same club could read both times. For a signed player only
 * the components that joining a club moves may change; for everyone else, nothing.
 */
export function factsMoved(was, now, signed) {
  const pairs = (id) => now[id].map((n, i) => [was[id][i], n]).filter(([a, b]) => a !== null && b !== null);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    contract: SEED_PLAYERS.filter((id) => pairs(id).some(([a, b]) => a.contractStatus !== b.contractStatus)),
    trust: SEED_PLAYERS.filter((id) =>
      pairs(id).some(([a, b]) =>
        signed.has(id) ? !same(otherThanJoining(a.trust), otherThanJoining(b.trust)) : !same(a.trust, b.trust),
      ),
    ),
    underContract: (id) => now[id].some((f) => f?.contractStatus === 'under_contract'),
  };
}
