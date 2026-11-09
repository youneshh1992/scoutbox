/**
 * S14j — the match facts builder and keeper (the tables: repositories/matchFacts.mjs).
 *
 * `build(player)` is the facts projection matching, the watchlists and Nobody Missed test: before S14j it was
 * nobodyMissed.mjs `matchFacts(player, org)`, assembled for every visible player on every read. Nothing in it
 * depends on the organisation reading (the organisation's part, visibility, age, distance, is the query's), so it is
 * derived once per player and stored. The rules are the ones that function had, read through the same repositories:
 *   position, secondaryPositions, availability   the Passport preferences, else the profile
 *   lastEvidenceAt, lastFootageAt                 the current (not superseded) evidence, newest instant
 *   coachReference                                an active reference, or coach-confirmed evidence
 *   clubConfirmed                                 a signing
 *   combine                                       production Combine Verified attempts whose session stands, by
 *                                                 protocol, with the best finite measurement (simulated never)
 *   trustBand                                     the Trust Score's band (verification/trust), unchanged
 *   refreshDueAt                                  the next instant at which time alone changes one of these
 *
 * The keeper: `drain()` re-derives the players the input triggers marked, registered to run before every COMMIT on
 * the connection; `sweep()` marks the rows whose time-only change is due (boot, then every minute); `start()` checks
 * the policy key and rebuilds every row when it changed.
 */
import { PROVIDERS } from '../development/boxcam/drills.mjs';
import { isAdult } from '../../domain.mjs';
import { onBeforeCommit } from '../../repositories/database.mjs';
import { matchFactsPolicyKey } from '../../repositories/matchFacts.mjs';
import { TRUST_SCORE_POLICY_VERSION } from '../verification/trust/shared.mjs';

const DAY = 86_400_000;

/** The first instant at which the player is an adult (domain.mjs isAdult), or null when unknown. */
export function adulthoodAt(player) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(player?.dob ?? ''));
  if (!m) return null;
  // The birthday N years on, where N is the age of majority for the player's country; isAdult decides, a day
  // either side covers 29 February.
  for (let n = 0; n <= 25; n += 1) {
    const at = Date.UTC(Number(m[1]) + n, Number(m[2]) - 1, Number(m[3]));
    if (isAdult(player, at)) {
      let t = at - 2 * DAY;
      while (!isAdult(player, t)) t += DAY;
      // Day steps found the first adult day; the flip is at its start (an age is a whole number of UTC days).
      return t;
    }
  }
  return null;
}

export function createMatchFactsKeeper(ctx) {
  const { matchFacts, players, unit } = ctx;
  if (typeof matchFacts?.write !== 'function' || typeof players?.byIds !== 'function') throw new TypeError('the match facts keeper needs the matchFacts and players repositories');
  const vreads = ctx.verificationReads;
  const sreads = ctx.scoutingReads;
  const breads = ctx.boxCamReads;
  const signings = ctx.recruitmentReads.signings;
  const agreements = ctx.agentReads.agreements;

  function build(player) {
    if (!player) return null;
    const now = Date.now();
    const id = player.id;
    const prefs = vreads.passportPrefs.forPlayer(id); // null until the player saves preferences
    const evidence = sreads.evidence.currentForPlayer(id);
    const newest = (list) => list.reduce((m, e) => Math.max(m, e.recordedAt ?? 0), 0) || null;
    // Production-valid Combine only: a simulated result never becomes recruitment eligibility, and an attempt whose
    // bound session was invalidated stops counting.
    const verified = [...breads.attempts.forPlayer(id)].reverse()
      .filter((a) => a.combineState === 'combine_verified' && !PROVIDERS[a.provider]?.testOnly);
    const sessions = new Map(breads.sessions.byIds(verified.map((a) => a.boxSessionId)).map((s) => [s.id, s]));
    const combine = {};
    for (const a of verified) {
      if (sessions.get(a.boxSessionId)?.verificationState === 'invalidated') continue;
      // A missing measurement is no measurement (Number(null) would read it as 0 and meet a ≤ threshold).
      const v = typeof a.measuredValue === 'number' ? a.measuredValue : (typeof a.measuredValue === 'string' && a.measuredValue.trim() ? Number(a.measuredValue) : NaN);
      const best = combine[a.protocolId] ?? null;
      combine[a.protocolId] = Number.isFinite(v) ? (best === null ? v : Math.max(best, v)) : best;
    }

    // Time-only changes: the next instant one of the band's inputs flips (verification/trust: an evidence item counts
    // until its expiry has passed, a claim until its valid_until, an agreement inside its term, and adulthood decides
    // which components are eligible).
    const due = [];
    const future = (v) => { if (typeof v === 'number' && Number.isFinite(v) && v > now) due.push(Math.ceil(v)); };
    for (const e of evidence) if (typeof e.expiresAt === 'number') future(e.expiresAt + 1);
    for (const c of vreads.claims.forSubjectId(id)) future(c.validUntil);
    for (const a of agreements.forClient(id)) { future(a.startAt); future(a.endAt); }
    future(adulthoodAt(player));

    return {
      name: player.name,
      position: prefs?.positions?.primary ?? player.position ?? null,
      secondaryPositions: prefs?.positions?.secondary ?? [],
      availability: prefs?.availability ?? player.availability ?? null,
      trustBand: ctx.trustSummaryFor(player)?.band ?? null,
      lastEvidenceAt: newest(evidence),
      lastFootageAt: newest(evidence.filter((e) => e.claimType === 'footage')),
      coachReference: vreads.references.hasActive(id) || evidence.some((e) => e.verification?.status === 'coach_confirmed'),
      clubConfirmed: signings.forPlayer(id).length > 0,
      combine,
      refreshDueAt: due.length ? Math.min(...due) : null,
    };
  }

  let draining = false;
  /** Re-derive every marked player (inside the transaction that is about to commit). */
  function drain() {
    if (draining) return 0;
    draining = true;
    let n = 0;
    try {
      for (;;) {
        const ids = matchFacts.dirty(500);
        if (!ids.length) break;
        const byId = new Map(players.byIds(ids).map((p) => [p.id, p]));
        for (const id of ids) matchFacts.write(id, build(byId.get(id) ?? null));
        matchFacts.clearDirty(ids);
        n += ids.length;
      }
    } finally { draining = false; }
    return n;
  }

  /** Mark the rows whose time-only change is due; the unit's COMMIT re-derives them (and any marker left over). */
  const sweep = (at = Date.now()) => unit(() => matchFacts.markDue(at));

  const policyKey = matchFactsPolicyKey({ trustPolicyVersion: TRUST_SCORE_POLICY_VERSION, simulatedEvidence: !!ctx.testProviderEnabled });
  let stop = null;
  /** Register the drain and bring the facts up to date: every row under a new policy, else the marked and due ones. */
  function start() {
    if (stop) return;
    stop = onBeforeCommit(ctx.sqlite, drain);
    unit(() => {
      if (matchFacts.policyKey() !== policyKey) { matchFacts.markAll(); matchFacts.setPolicyKey(policyKey); }
      matchFacts.markDue(Date.now());
    });
  }

  return { build, drain, sweep, start, stopForTests: () => { stop?.(); stop = null; }, policyKey };
}
