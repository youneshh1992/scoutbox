// M19 demo mirror (org side) — a SELF-CONTAINED Explainable Matching and
// Dynamic Watchlists fixture.
//
// ⚠ Circular-import discipline (the exact bug that crashed the M16.1 bundle):
// m19Api imports this module, so this module takes only TYPES from m19Api
// (`import type`, erased at build time). It never reads a runtime binding from
// m19Api and never calls an imported value at module-load time.
//
// Same honesty rules as live:
//   • No score. Preferred criteria are counted, never graded, ordered or
//     turned into a percentage.
//   • No recommendation. The demo never says a player should be signed.
//   • Nothing player-facing: a demo player is never told a club watches them.
//   • The Trust Score is EVIDENCE CONFIDENCE and travels with its note.
//   • A simulated Combine result never satisfies a production threshold —
//     the one fixture that has one is labelled and excluded, exactly as the
//     server excludes test providers.
import type {
  M19Api, MatchCard, MatchResult, MatchVocabulary, Watchlist, WatchlistDetail,
  WatchlistHistoryEntry, CriteriaInput, CriteriaSaveOutcome, WatchlistMode,
} from './m19Api';

const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 120));
const now = () => Date.now();
const DAY = 86_400_000;

// ------------------------------------------------------------- fixture facts
// Synthetic people. Only the fields a criterion can legitimately test.
interface Facts {
  playerId: string; name: string; position: string; secondary: string[];
  age: number; level: string; foot: string | null; distanceKm: number;
  trustBand: string; combine: Record<string, number>; simulatedCombine?: Record<string, number>;
  lastFootageAt: number | null; coachReference: boolean;
}

const FACTS: Facts[] = [
  {
    playerId: 'pl-alonso', name: 'Alonso Mbuguni', position: 'CDM', secondary: ['CM'],
    age: 17, level: 'semi_pro', foot: 'Left', distanceKm: 22, trustBand: 'strong_evidence',
    combine: { 'combine-box-touch-60': 172 }, lastFootageAt: now() - 12 * DAY, coachReference: true,
  },
  {
    playerId: 'pl-kola', name: 'Kola Adeyemi', position: 'CM', secondary: ['CAM'],
    age: 19, level: 'semi_pro', foot: 'Right', distanceKm: 31, trustBand: 'established_evidence',
    combine: {}, lastFootageAt: now() - 40 * DAY, coachReference: true,
  },
  {
    playerId: 'pl-danji', name: 'Danji Oyelaran', position: 'CDM', secondary: [],
    age: 16, level: 'amateur', foot: 'Right', distanceKm: 14, trustBand: 'developing_evidence',
    // A simulated Combine result: present in the demo, and deliberately NOT
    // counted, because a test-provider result is not production evidence.
    combine: {}, simulatedCombine: { 'combine-box-touch-60': 190 },
    lastFootageAt: now() - 5 * DAY, coachReference: false,
  },
  {
    playerId: 'pl-ferreira', name: 'Rui Ferreira', position: 'CB', secondary: ['RB'],
    age: 18, level: 'semi_pro', foot: 'Right', distanceKm: 44, trustBand: 'strong_evidence',
    combine: { 'combine-box-touch-60': 151 }, lastFootageAt: now() - 60 * DAY, coachReference: true,
  },
];

const BANDS = ['limited_evidence', 'developing_evidence', 'established_evidence', 'strong_evidence', 'very_strong_evidence'];
const bandIndex = (b: string | null) => BANDS.indexOf(String(b));
const LEVEL_RANK: Record<string, number> = { amateur: 0, semi_pro: 1, pro: 2 };

const EVIDENCE_LABELS: Record<string, string> = {
  recent_full_match: 'Recent full match available',
  coach_reference: 'Coach reference available',
  confirmed_current_club: 'Confirmed current club',
  combine_verified: 'Combine Verified result available',
};

// --------------------------------------------------------- the demo engine
// A faithful mirror of m19/match.mjs: same fail-closed rules, same words.
type Crit = CriteriaInput['required'][number];

function criterionId(c: Crit): string {
  const body: Record<string, unknown> = {};
  if (c.values !== undefined) body.values = [...c.values].sort().join('|');
  if (c.value !== undefined && c.value !== null) body.value = c.value;
  if (c.protocol) body.protocol = c.protocol;
  if (c.primaryOnly) body.primaryOnly = true;
  if (c.evidenceKind) body.evidenceKind = c.evidenceKind;
  const parts = Object.keys(body).sort().map((k) => `${k}=${body[k]}`);
  return `${c.type}:${c.operator}${parts.length ? `:${parts.join(',')}` : ''}`;
}

function evaluate(c: Crit, f: Facts): { met: boolean; text: string } {
  switch (c.type) {
    case 'position': {
      const has = c.primaryOnly ? [f.position] : [f.position, ...f.secondary];
      const hit = has.filter((p) => (c.values ?? []).includes(p));
      return hit.length
        ? { met: true, text: `Matches position criteria (${hit.join(', ')})` }
        : { met: false, text: 'Does not match the position criteria' };
    }
    case 'age': {
      const lo = c.operator === 'between' ? Number(c.values?.[0]) : (c.operator === 'gte' ? Number(c.value) : null);
      const hi = c.operator === 'between' ? Number(c.values?.[1]) : (c.operator === 'lte' ? Number(c.value) : null);
      if (lo != null && f.age < lo) return { met: false, text: `Age ${f.age} is below the criteria` };
      if (hi != null && f.age > hi) return { met: false, text: `Age ${f.age} is above the criteria` };
      return { met: true, text: `Matches age criteria (${f.age})` };
    }
    case 'geography':
      return f.distanceKm <= Number(c.value)
        ? { met: true, text: 'Within the club’s permitted search area' }
        : { met: false, text: 'Outside the permitted search area' };
    case 'level':
      return LEVEL_RANK[f.level] <= LEVEL_RANK[String(c.value)]
        ? { met: true, text: 'Within the level criteria' }
        : { met: false, text: 'Plays at a level above the criteria' };
    case 'foot': {
      if (!f.foot) return { met: false, text: 'Preferred foot is not on record' };
      return (c.values ?? []).includes(f.foot) || f.foot === 'Both'
        ? { met: true, text: `Matches foot criteria (${f.foot})` }
        : { met: false, text: 'Does not match the foot criteria' };
    }
    case 'evidence': {
      const label = EVIDENCE_LABELS[String(c.value)] ?? String(c.value);
      const has = String(c.value) === 'recent_full_match'
        ? !!f.lastFootageAt && f.lastFootageAt > now() - 180 * DAY
        : String(c.value) === 'coach_reference' ? f.coachReference
          : String(c.value) === 'combine_verified' ? Object.keys(f.combine).length > 0 : false;
      return has ? { met: true, text: label } : { met: false, text: `${label} — not on record` };
    }
    case 'evidence_recency': {
      if (!f.lastFootageAt) return { met: false, text: 'No dated evidence on record' };
      const days = Math.floor((now() - f.lastFootageAt) / DAY);
      return days <= Number(c.value)
        ? { met: true, text: `Evidence within the last ${c.value} days` }
        : { met: false, text: `Most recent evidence is older than ${c.value} days` };
    }
    case 'trust_band': {
      const have = bandIndex(f.trustBand);
      const need = bandIndex(String(c.value));
      return have >= need
        ? { met: true, text: `Evidence confidence meets the criteria (${f.trustBand})` }
        : { met: false, text: `Evidence confidence is below the criteria (${f.trustBand})` };
    }
    case 'combine_result':
      return f.combine[String(c.value)] != null
        ? { met: true, text: `${c.value} Combine Verified result available` }
        : { met: false, text: `No ${c.value} Combine Verified result` };
    case 'combine_measurement': {
      // The simulated result is deliberately not consulted.
      const v = f.combine[String(c.protocol)];
      if (v == null) return { met: false, text: `No ${c.protocol} Combine Verified measurement` };
      const met = c.operator === 'gte' ? v >= Number(c.value) : v <= Number(c.value);
      const cmp = c.operator === 'gte' ? '≥' : '≤';
      return met
        ? { met: true, text: `${c.protocol} ${v} meets the club’s threshold (${cmp} ${c.value})` }
        : { met: false, text: `${c.protocol} ${v} does not meet the club’s threshold (${cmp} ${c.value})` };
    }
    default:
      return { met: false, text: 'This criterion cannot be evaluated' };
  }
}

function card(f: Facts, criteria: CriteriaInput): MatchCard {
  const line = (c: Crit) => ({ criterionId: criterionId(c), ...evaluate(c, f) });
  const required = (criteria.required ?? []).map(line);
  const preferred = (criteria.preferred ?? []).map(line);
  return {
    playerId: f.playerId,
    name: f.name,
    position: f.position,
    secondaryPositions: f.secondary,
    age: f.age,
    trustBand: f.trustBand,
    trustNote: 'Evidence confidence — not football ability.',
    distanceKm: null,
    required,
    preferred,
    preferredMet: preferred.filter((r) => r.met).length,
    preferredTotal: preferred.length,
    policyVersion: 1,
    note: 'Matches the criteria your organisation wrote. ScoutBox does not rank or score these players.',
  };
}

const describe = (criteria: CriteriaInput) => ({
  required: (criteria.required ?? []).map(summarise),
  preferred: (criteria.preferred ?? []).map(summarise),
});
function summarise(c: Crit): string {
  switch (c.type) {
    case 'position': return (c.values ?? []).join(' / ');
    case 'age': return c.operator === 'between' ? `${c.values?.[0]}–${c.values?.[1]}` : `age ${c.operator === 'gte' ? '≥' : '≤'} ${c.value}`;
    case 'geography': return `within ${c.value} km`;
    case 'level': return `up to ${c.value}`;
    case 'foot': return (c.values ?? []).join(' / ');
    case 'evidence': return EVIDENCE_LABELS[String(c.value)] ?? String(c.value);
    case 'evidence_recency': return `evidence within ${c.value} days`;
    case 'trust_band': return `${String(c.value).replace(/_/g, ' ')} or higher`;
    case 'combine_result': return `${c.value} result available`;
    case 'combine_measurement': return `${c.protocol} ${c.operator === 'gte' ? '≥' : '≤'} ${c.value}`;
    default: return c.type;
  }
}

const criteriaVersion = (criteria: CriteriaInput) => {
  const ids = [...(criteria.required ?? []), ...(criteria.preferred ?? [])].map(criterionId).sort().join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < ids.length; i++) { h ^= ids.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `cv1:${h.toString(16).padStart(8, '0')}`;
};

const PROHIBITED = ['race', 'ethnicity', 'religion', 'disability', 'family_income', 'school_type', 'sexual_orientation', 'socioeconomic'];
const KNOWN_TYPES = ['position', 'age', 'geography', 'level', 'foot', 'availability', 'evidence', 'evidence_recency', 'trust_band', 'combine_result', 'combine_measurement'];

function validate(criteria: CriteriaInput): CriteriaSaveOutcome<CriteriaInput> {
  const all = [...(criteria.required ?? []).map((c) => ({ c, cls: 'required' })), ...(criteria.preferred ?? []).map((c) => ({ c, cls: 'preferred' }))];
  const bad = all.find(({ c }) => PROHIBITED.some((p) => String(c.type).toLowerCase().includes(p)));
  if (bad) return { ok: false, error: 'CRITERION_PROHIBITED', prohibited: [String(bad.c.type)], message: 'Players can never be matched on a protected characteristic.' };
  // The same refusals the server makes, in the same shape. A demo that
  // quietly matches everyone on a half-written criterion teaches the wrong
  // thing about the product.
  const problem = ({ c }: { c: Crit }): string | null => {
    if (!KNOWN_TYPES.includes(c.type)) return 'CRITERION_TYPE_UNKNOWN';
    if (c.operator === 'in' && !(c.values ?? []).length) return 'CRITERION_VALUES_REQUIRED';
    if (c.operator === 'between') {
      const [lo, hi] = (c.values ?? []) as (number | string)[];
      if (lo === undefined || hi === undefined || lo === '' || hi === '') return 'CRITERION_VALUES_REQUIRED';
      if (Number(lo) > Number(hi)) return 'CRITERION_RANGE_INVALID';
    }
    if (['equals', 'gte', 'lte', 'exists', 'within_radius', 'within_days'].includes(c.operator)
      && (c.value === null || c.value === undefined || c.value === '')) return 'CRITERION_VALUES_REQUIRED';
    if (c.type === 'combine_measurement' && !c.protocol) return 'CRITERION_VALUES_REQUIRED';
    return null;
  };
  const details = all
    .map(({ c, cls }, index) => { const e = problem({ c }); return e ? { index, class: cls, type: c.type ?? null, error: e } : null; })
    .filter(Boolean) as { index: number; class: string; type: string | null; error: string }[];
  if (details.length) return { ok: false, error: 'CRITERIA_INVALID', details, message: 'These criteria cannot be saved as written.' };
  return { ok: true, value: criteria };
}

// ------------------------------------------------------------ demo storage
const DEMO_CRITERIA: CriteriaInput = {
  required: [
    { type: 'position', operator: 'in', values: ['CDM', 'CM'] },
    { type: 'age', operator: 'between', values: [16, 18] },
    { type: 'evidence', operator: 'exists', value: 'recent_full_match' },
    { type: 'geography', operator: 'within_radius', value: 50 },
  ],
  preferred: [
    { type: 'trust_band', operator: 'gte', value: 'strong_evidence' },
    { type: 'foot', operator: 'in', values: ['Left'] },
    { type: 'combine_result', operator: 'exists', value: 'combine-box-touch-60' },
  ],
};

let seq = 1;
const store: (Watchlist & { criteriaInput: CriteriaInput; members: string[] })[] = [];
const history: (WatchlistHistoryEntry & { watchlistId: string })[] = [];

function makeWatchlist(name: string, mode: WatchlistMode, criteria: CriteriaInput): Watchlist & { criteriaInput: CriteriaInput; members: string[] } {
  const at = now();
  return {
    id: `wl-demo-${seq++}`,
    name,
    mode,
    status: 'active',
    sourceType: mode === 'live_linked' ? 'brief' : 'criteria',
    sourceId: mode === 'live_linked' ? 'brief-demo-1' : null,
    criteria: describe(criteria),
    criteriaVersion: criteriaVersion(criteria),
    policyVersion: 1,
    notify: true,
    createdBy: 'Maria Keane',
    createdAt: at,
    updatedAt: at,
    lastReconciledAt: at,
    rev: 1,
    criteriaInput: criteria,
    members: [],
  };
}

// One watchlist already exists so the demo opens on something real, with a
// membership change already in its history.
{
  const w = makeWatchlist('2027 Defensive Midfielders', 'snapshot', DEMO_CRITERIA);
  w.members = FACTS.filter((f) => card(f, DEMO_CRITERIA).required.every((r) => r.met)).map((f) => f.playerId);
  store.push(w);
  history.push({
    id: 'wlh-demo-1', watchlistId: w.id, at: now() - 2 * DAY, transition: 'entered',
    reason: 'criterion_now_met', text: 'Recent full match available',
    criterionId: 'evidence:exists:value=recent_full_match', criteriaVersion: w.criteriaVersion,
    briefVersion: null, playerId: 'pl-danji', playerName: 'Danji Oyelaran',
  });
  history.push({
    id: 'wlh-demo-2', watchlistId: w.id, at: now() - 9 * DAY, transition: 'left',
    reason: 'criterion_no_longer_met', text: 'Age 19 is above the criteria',
    criterionId: 'age:between:values=16|18', criteriaVersion: w.criteriaVersion,
    briefVersion: null, playerId: 'pl-kola', playerName: 'Kola Adeyemi',
  });
}

const matchesFor = (criteria: CriteriaInput): MatchCard[] =>
  FACTS.map((f) => card(f, criteria))
    .filter((c) => c.required.every((r) => r.met))
    // Deterministic: newest evidence first, player id as the stable tie-break.
    .sort((a, b) => {
      const fa = FACTS.find((f) => f.playerId === a.playerId)?.lastFootageAt ?? 0;
      const fb = FACTS.find((f) => f.playerId === b.playerId)?.lastFootageAt ?? 0;
      return (fb - fa) || a.playerId.localeCompare(b.playerId);
    });

const lastChangeAt = (id: string) => history.filter((h) => h.watchlistId === id).reduce((m, h) => Math.max(m, h.at), 0);

const detailFor = (w: (typeof store)[number], sort = 'recent_evidence'): WatchlistDetail => {
  const items = matchesFor(w.criteriaInput);
  const ordered = items.slice().sort((a, b) => {
    if (sort === 'name') return String(a.name).localeCompare(String(b.name)) || a.playerId.localeCompare(b.playerId);
    if (sort === 'age') return (a.age ?? 999) - (b.age ?? 999) || a.playerId.localeCompare(b.playerId);
    if (sort === 'evidence_confidence') return bandIndex(b.trustBand) - bandIndex(a.trustBand) || a.playerId.localeCompare(b.playerId);
    return 0;
  });
  return {
    watchlist: { ...w },
    items: ordered,
    total: ordered.length,
    offset: 0,
    limit: 25,
    sort,
    summary: {
      // Mirrors the server: the summary is the last RECORDED change, not this
      // read's diff, so two reads in a row tell the same story.
      newlyMatched: history.filter((h) => h.watchlistId === w.id && h.at === lastChangeAt(w.id) && h.transition === 'entered').length,
      noLongerMatches: history.filter((h) => h.watchlistId === w.id && h.at === lastChangeAt(w.id) && h.transition === 'left').length,
      unchanged: ordered.length,
      current: ordered.length,
      changedAt: lastChangeAt(w.id) || null,
      note: 'Counts of players against criteria your organisation wrote. Entering a watchlist is not an improvement in a player, and leaving one is not a decline.',
    },
    evaluatedAt: now(),
    refreshNote: 'Membership is derived when this page is read. ScoutBox does not recompute watchlists in the background in this build.',
  };
};

export const demoM19: M19Api = {
  vocabulary: () => delay<MatchVocabulary>({
    criterionTypes: [
      { type: 'position', label: 'Position', operators: ['in'] },
      { type: 'age', label: 'Age', operators: ['between', 'gte', 'lte'] },
      { type: 'geography', label: 'Recruitment area', operators: ['within_radius'] },
      { type: 'level', label: 'Level', operators: ['lte', 'in'] },
      { type: 'foot', label: 'Preferred foot', operators: ['in'] },
      { type: 'availability', label: 'Availability', operators: ['equals'] },
      { type: 'evidence', label: 'Evidence', operators: ['exists'] },
      { type: 'evidence_recency', label: 'Evidence recency', operators: ['within_days'] },
      { type: 'trust_band', label: 'Evidence confidence', operators: ['gte'] },
      { type: 'combine_result', label: 'Combine result', operators: ['exists'] },
      { type: 'combine_measurement', label: 'Combine measurement', operators: ['gte', 'lte'] },
    ],
    operators: [
      { id: 'in', arity: 'list', note: 'the fact is one of the listed values' },
      { id: 'equals', arity: 'scalar', note: 'the fact equals the value' },
      { id: 'between', arity: 'range', note: 'the fact is within the inclusive range' },
      { id: 'gte', arity: 'scalar', note: 'the fact is at least the value' },
      { id: 'lte', arity: 'scalar', note: 'the fact is at most the value' },
      { id: 'within_radius', arity: 'scalar', note: 'the player is inside the permitted area at this radius' },
      { id: 'within_days', arity: 'scalar', note: 'the fact is dated within this many days' },
      { id: 'exists', arity: 'key', note: 'the named fact is present and current' },
    ],
    sorts: ['recent_evidence', 'name', 'age', 'evidence_confidence'],
    defaultSort: 'recent_evidence',
    limits: { maxCriteria: 24, watchlistsPerOrg: 60 },
    policyVersion: 1,
    schemaVersion: 1,
    combineProtocols: ['combine-box-touch-60'],
    availabilityValues: ['available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking'],
    note: 'Every criterion is a fact test your club writes. There is no hidden criterion, no weighting and no overall match score.',
  }),

  match: (_s, input) => {
    const criteria = input.criteria ?? DEMO_CRITERIA;
    const v = validate(criteria);
    if (!v.ok) return delay(v);
    const items = matchesFor(criteria);
    return delay<CriteriaSaveOutcome<MatchResult>>({
      ok: true,
      value: {
        items,
        total: items.length,
        offset: 0,
        limit: 25,
        sort: input.sort ?? 'recent_evidence',
        ordering: `${input.sort ?? 'recent_evidence'},player_id`,
        criteria: describe(criteria),
        criteriaVersion: criteriaVersion(criteria),
        policyVersion: 1,
        briefId: input.briefId ?? null,
        evaluatedAt: now(),
        truncated: false,
        note: 'Every player your organisation can currently see was evaluated against these criteria.',
        scoreNote: 'There is no match score. Required criteria decide the set; preferred criteria are counted, not scored.',
      },
    });
  },

  watchlists: () => delay({
    items: store.map((w) => ({ ...w })),
    total: store.length,
    note: 'A Dynamic Watchlist is saved criteria. Membership is derived when it is read.',
  }),

  createWatchlist: (_s, input) => {
    const criteria = input.criteria ?? DEMO_CRITERIA;
    const v = validate(criteria);
    if (!v.ok) return delay(v);
    const w = makeWatchlist(input.name, input.mode, criteria);
    w.notify = input.notify !== false;
    w.members = matchesFor(criteria).map((c) => c.playerId);
    store.push(w);
    return delay<CriteriaSaveOutcome<Watchlist>>({ ok: true, value: { ...w } });
  },

  watchlist: (_s, id, params = {}) => {
    const w = store.find((x) => x.id === id);
    if (!w) return Promise.reject(new Error('WATCHLIST_NOT_FOUND'));
    return delay(detailFor(w, params.sort));
  },

  patchWatchlist: (_s, id, input) => {
    const w = store.find((x) => x.id === id);
    if (!w) return Promise.reject(new Error('WATCHLIST_NOT_FOUND'));
    if (typeof input.name === 'string') w.name = input.name;
    if (typeof input.status === 'string') w.status = input.status as Watchlist['status'];
    if (typeof input.notify === 'boolean') w.notify = input.notify;
    w.updatedAt = now();
    w.rev += 1;
    return delay<CriteriaSaveOutcome<Watchlist>>({ ok: true, value: { ...w } });
  },

  history: (_s, id) => delay({
    items: history.filter((h) => h.watchlistId === id).sort((a, b) => b.at - a.at),
    nextCursor: null,
    total: history.filter((h) => h.watchlistId === id).length,
    note: 'Why membership changed, in the club’s own criteria. Entering a watchlist is not an improvement in a player.',
  }),

  addToRoom: (_s, _id, playerId) => delay({
    roomId: `case-demo-${playerId}`,
    existed: false,
    note: 'A Recruitment Room was opened. This player stays on the watchlist while they still match your criteria.',
  }),
};
