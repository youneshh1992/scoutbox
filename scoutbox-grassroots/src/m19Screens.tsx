// M19 org screens — Player Matching and Dynamic Watchlists.
//
// The three rules this file keeps visible, because they are the product:
//
//   • Explainable. Every player on screen is there because they satisfy every
//     REQUIRED criterion this club wrote, and each card names those criteria
//     one by one. Nothing matches for a reason ScoutBox will not print.
//
//   • Not a score, not a ranking, not a recommendation. Preferred criteria are
//     COUNTED ("2 of 3 met") and never divided, normalised or sorted against
//     another player. The ordering control says what it orders by, and no
//     option is "best match". ScoutBox never says who to sign.
//
//   • Not player-facing. A player is never told that a club is matching on
//     them, that they entered a watchlist, or that they left one. These are
//     the club's own working surfaces, exactly like Briefs and Rooms.
//
// Membership is derived when a watchlist is READ. There is no scheduler in
// this build, so the screen says when it was last derived instead of implying
// a background process that does not exist.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Session } from './api';
import {
  m19, encodeCriteria, decodeCriteria,
  type CriteriaInput, type CriterionInput, type MatchCard, type MatchResult,
  type MatchVocabulary, type Watchlist, type WatchlistDetail, type WatchlistHistoryEntry,
  type WatchlistMode,
} from './m19Api';
import {
  m18, BRIEF_EVIDENCE_REQUIREMENTS, BRIEF_FEET, BRIEF_LEVELS, BRIEF_POSITIONS, BRIEF_TRUST_BANDS,
  type BriefListResult,
} from './m18Api';
import { t, fmtDate, fmtDateTime } from './i18n';
import { ConflictNotice, conflictOf, type Conflict } from './conflict';
import { registerDirtyGuard } from './dirtyGuard';
import { confirmDestructive, DESTRUCTIVE_ACTIONS } from './confirmAction';

// Two per-app switches, set the same way M18 sets its brief vocabulary.
//
//   ALLOW_COMBINE_CRITERIA  Pro clubs may require a standardized Combine
//                           Verified result; Grassroots keeps a simpler set.
//   ALLOW_DISTANCE_SORT     Distance ordering exists only where the server
//                           authorises the organisation to SEE distance, so
//                           offering it to a Pro club would be a control that
//                           can only ever answer 400.
const ALLOW_COMBINE_CRITERIA = false;
const ALLOW_DISTANCE_SORT = true;

export interface M19ScreenProps {
  session: Session;
  tick: number;
  notify: (text: string, error?: boolean) => void;
  openPlayer: (id: string) => void;
}

// ------------------------------------------------------------ small helpers

const typeLabel = (type: string) => t(`m19.type.${type}`, type.replace(/_/g, ' '));
const opLabel = (op: string) => t(`m19.op.${op}`, op.replace(/_/g, ' '));
const bandLabel = (code?: string | null) => (code ? t(`m18.band.${code}`, code.replace(/_/g, ' ')) : t('m18.none'));
const levelLabel = (code: string) => t(`m18.br.level.${code}`, code.replace(/_/g, ' '));
const sortLabel = (code: string) => t(`m19.sort.${code}`, code.replace(/_/g, ' '));
const modeLabel = (code: string) => t(`m19.mode.${code}`, code.replace(/_/g, ' '));
const wlStatusLabel = (code: string) => t(`m19.wl.status.${code}`, code);
const reasonLabel = (code: string) => t(`m19.reason.${code}`, code.replace(/_/g, ' '));

function errMessage(e: unknown): string {
  const byCode: Record<string, string> = {
    WATCHLIST_NOT_FOUND: t('m19.err.notFound'),
    WATCHLIST_LIMIT_REACHED: t('m19.err.limit'),
    WATCHLIST_NAME_REQUIRED: t('m19.err.nameRequired'),
    WATCHLIST_MODE_REQUIRED: t('m19.err.modeRequired'),
    WATCHLIST_MODE_INVALID: t('m19.err.modeInvalid'),
    WATCHLIST_LIVE_LINKED: t('m19.err.liveLinked'),
    WATCHLIST_ARCHIVED: t('m19.err.archived'),
    WATCHLIST_VERSION_CONFLICT: t('common.conflict'),
    CRITERIA_REQUIRED_EMPTY: t('m19.err.requiredEmpty'),
    CRITERIA_TOO_MANY: t('m19.err.tooMany'),
    HISTORY_CURSOR_INVALID: t('m19.err.cursor'),
    SORT_NOT_AVAILABLE: t('m19.err.sortUnavailable'),
    BRIEF_NOT_FOUND: t('m18.err.briefNotFound'),
    NOT_VISIBLE: t('m18.err.notVisible'),
    PLAYER_NOT_FOUND: t('m19.err.playerNotFound'),
    ROOM_BRIDGE_UNAVAILABLE: t('m18.err.roomEngine'),
    RATE_LIMITED: t('m18.err.rateLimited'),
  };
  if (e instanceof ApiError) return byCode[e.code ?? ''] ?? e.message;
  // The demo mirror throws the same codes as bare Errors.
  if (e instanceof Error) return byCode[e.message] ?? e.message;
  return 'failed';
}

/** A criterion's outcome is never colour alone — always a word too. */
function Mark({ met }: { met: boolean }) {
  return <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>{met ? '✓' : '○'}</span>;
}

function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice block" role="alert">
      {message}
      {onRetry && <> <button onClick={onRetry} style={{ marginInlineStart: 8 }}>{t('common.retry')}</button></>}
    </div>
  );
}

// ------------------------------------------------------------ criteria rows

/** The blank row for each criterion type: the operator the type is usually
 *  written with, and an empty value of the right shape. */
const BLANK: Record<string, CriterionInput> = {
  position: { type: 'position', operator: 'in', values: [] },
  age: { type: 'age', operator: 'between', values: [] },
  geography: { type: 'geography', operator: 'within_radius', value: null },
  level: { type: 'level', operator: 'lte', value: null },
  foot: { type: 'foot', operator: 'in', values: [] },
  availability: { type: 'availability', operator: 'equals', value: '' },
  evidence: { type: 'evidence', operator: 'exists', value: '' },
  evidence_recency: { type: 'evidence_recency', operator: 'within_days', value: null, evidenceKind: 'footage' },
  trust_band: { type: 'trust_band', operator: 'gte', value: '' },
  combine_result: { type: 'combine_result', operator: 'exists', value: '' },
  combine_measurement: { type: 'combine_measurement', operator: 'gte', protocol: '', value: null },
};

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/**
 * One criterion row. Every control is TYPED — there is no free-text JSON box,
 * because a criteria editor that accepts arbitrary structure is an editor
 * nobody can read back six weeks later.
 */
function CriterionRow({
  criterion, vocab, error, onChange, onRemove,
}: {
  criterion: CriterionInput;
  vocab: MatchVocabulary | null;
  error?: string;
  onChange: (c: CriterionInput) => void;
  onRemove: () => void;
}) {
  const def = vocab?.criterionTypes.find((x) => x.type === criterion.type);
  const operators = def?.operators ?? [criterion.operator];
  const set = (patch: Partial<CriterionInput>) => onChange({ ...criterion, ...patch });
  const toggleValue = (v: string) => {
    const cur = (criterion.values ?? []).map(String);
    set({ values: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const protocols = vocab?.combineProtocols ?? [];

  return (
    <div className="list-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start', paddingBlock: 8 }}>
      <label style={{ fontSize: 13 }}>
        <span className="dim" style={{ display: 'block', fontSize: 11 }}>{t('m19.cr.type')}</span>
        <select
          aria-label={t('m19.cr.type')}
          value={criterion.type}
          onChange={(e) => onChange({ ...BLANK[e.target.value] ?? { type: e.target.value, operator: 'equals' } })}
        >
          {(vocab?.criterionTypes ?? [])
            .filter((x) => ALLOW_COMBINE_CRITERIA || !x.type.startsWith('combine_'))
            .map((x) => <option key={x.type} value={x.type}>{typeLabel(x.type)}</option>)}
        </select>
      </label>

      <label style={{ fontSize: 13 }}>
        <span className="dim" style={{ display: 'block', fontSize: 11 }}>{t('m19.cr.test')}</span>
        <select aria-label={t('m19.cr.test')} value={criterion.operator} onChange={(e) => set({ operator: e.target.value })}>
          {operators.map((o) => <option key={o} value={o}>{opLabel(o)}</option>)}
        </select>
      </label>

      <div style={{ flex: '1 1 240px', minWidth: 200 }}>
        <span className="dim" style={{ display: 'block', fontSize: 11 }}>{t('m19.cr.value')}</span>

        {criterion.type === 'position' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {BRIEF_POSITIONS.map((p) => (
              <label key={p} style={{ fontSize: 13 }}>
                <input type="checkbox" checked={(criterion.values ?? []).map(String).includes(p)} onChange={() => toggleValue(p)} /> {p}
              </label>
            ))}
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={criterion.primaryOnly === true} onChange={(e) => set({ primaryOnly: e.target.checked })} /> {t('m19.cr.primaryOnly')}
            </label>
          </div>
        )}

        {criterion.type === 'age' && (criterion.operator === 'between' ? (
          <span>
            <input
              type="number" style={{ width: 80 }} aria-label={t('m19.cr.ageFrom')}
              value={criterion.values?.[0] ?? ''}
              onChange={(e) => set({ values: [num(e.target.value) ?? '', criterion.values?.[1] ?? ''].map((x) => x as string | number) })}
            />
            {' – '}
            <input
              type="number" style={{ width: 80 }} aria-label={t('m19.cr.ageTo')}
              value={criterion.values?.[1] ?? ''}
              onChange={(e) => set({ values: [criterion.values?.[0] ?? '', num(e.target.value) ?? ''].map((x) => x as string | number) })}
            />
          </span>
        ) : (
          <input type="number" style={{ width: 100 }} aria-label={t('m19.cr.value')} value={criterion.value ?? ''} onChange={(e) => set({ value: num(e.target.value) })} />
        ))}

        {criterion.type === 'geography' && (
          <span>
            <input type="number" style={{ width: 110 }} aria-label={t('m19.cr.radiusKm')} value={criterion.value ?? ''} onChange={(e) => set({ value: num(e.target.value) })} /> km
          </span>
        )}

        {criterion.type === 'level' && (criterion.operator === 'in' ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {BRIEF_LEVELS.map((l) => (
              <label key={l} style={{ fontSize: 13 }}>
                <input type="checkbox" checked={(criterion.values ?? []).map(String).includes(l)} onChange={() => toggleValue(l)} /> {levelLabel(l)}
              </label>
            ))}
          </div>
        ) : (
          <select aria-label={t('m19.cr.value')} value={String(criterion.value ?? '')} onChange={(e) => set({ value: e.target.value })}>
            <option value="">{t('m19.cr.choose')}</option>
            {BRIEF_LEVELS.map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
          </select>
        ))}

        {criterion.type === 'foot' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {BRIEF_FEET.map((f) => (
              <label key={f} style={{ fontSize: 13 }}>
                <input type="checkbox" checked={(criterion.values ?? []).map(String).includes(f)} onChange={() => toggleValue(f)} /> {t(`m18.br.foot.${f}`, f)}
              </label>
            ))}
          </div>
        )}

        {criterion.type === 'availability' && (
          <span>
            {/* A datalist, not a select: ScoutBox suggests the values it
                records without refusing one a deployment legitimately has. */}
            <input
              style={{ width: '100%', maxWidth: 220 }}
              aria-label={t('m19.cr.value')}
              list="m19-availability"
              value={String(criterion.value ?? '')}
              onChange={(e) => set({ value: e.target.value })}
            />
            <datalist id="m19-availability">
              {(vocab?.availabilityValues ?? []).map((v) => <option key={v} value={v}>{t(`m19.av.${v}`, v.replace(/_/g, ' '))}</option>)}
            </datalist>
          </span>
        )}

        {criterion.type === 'evidence' && (
          <select aria-label={t('m19.cr.value')} value={String(criterion.value ?? '')} onChange={(e) => set({ value: e.target.value })}>
            <option value="">{t('m19.cr.choose')}</option>
            {BRIEF_EVIDENCE_REQUIREMENTS.map((r) => <option key={r.key} value={r.key}>{t(`m18.br.ev.${r.key}`, r.label)}</option>)}
          </select>
        )}

        {criterion.type === 'evidence_recency' && (
          <span>
            <input type="number" style={{ width: 90 }} aria-label={t('m19.cr.days')} value={criterion.value ?? ''} onChange={(e) => set({ value: num(e.target.value) })} /> {t('m19.cr.days')}
            {' '}
            <select aria-label={t('m19.cr.evidenceKind')} value={criterion.evidenceKind ?? 'footage'} onChange={(e) => set({ evidenceKind: e.target.value })}>
              <option value="footage">{t('m19.cr.kindFootage')}</option>
              <option value="any">{t('m19.cr.kindAny')}</option>
            </select>
          </span>
        )}

        {criterion.type === 'trust_band' && (
          <span>
            <select aria-label={t('m19.cr.value')} value={String(criterion.value ?? '')} onChange={(e) => set({ value: e.target.value })}>
              <option value="">{t('m19.cr.choose')}</option>
              {BRIEF_TRUST_BANDS.map((b) => <option key={b} value={b}>{bandLabel(b)}</option>)}
            </select>
            <span className="dim" style={{ display: 'block', fontSize: 11 }}>{t('m18.trustNote')}</span>
          </span>
        )}

        {criterion.type === 'combine_result' && (
          <select aria-label={t('m19.cr.value')} value={String(criterion.value ?? '')} onChange={(e) => set({ value: e.target.value })}>
            <option value="">{t('m19.cr.choose')}</option>
            {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}

        {criterion.type === 'combine_measurement' && (
          <span>
            <select aria-label={t('m19.cr.protocol')} value={criterion.protocol ?? ''} onChange={(e) => set({ protocol: e.target.value })}>
              <option value="">{t('m19.cr.choose')}</option>
              {protocols.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {' '}
            <input type="number" style={{ width: 100 }} aria-label={t('m19.cr.value')} value={criterion.value ?? ''} onChange={(e) => set({ value: num(e.target.value) })} />
            <span className="dim" style={{ display: 'block', fontSize: 11 }}>{t('m19.cr.combineNote')}</span>
          </span>
        )}

        {error && <div className="notice" style={{ marginTop: 4, fontSize: 12.5 }} role="alert">{t(`m19.crErr.${error}`, error.replace(/_/g, ' ').toLowerCase())}</div>}
      </div>

      <button onClick={onRemove} aria-label={`${t('m19.cr.remove')} — ${typeLabel(criterion.type)}`}>{t('m19.cr.remove')}</button>
    </div>
  );
}

/** One class of criteria — Required decides the set, Preferred adds context. */
function CriteriaClassEditor({
  cls, rows, vocab, errors, disabled, onChange,
}: {
  cls: 'required' | 'preferred';
  rows: CriterionInput[];
  vocab: MatchVocabulary | null;
  errors: { index: number; class: string; error: string }[];
  disabled?: boolean;
  onChange: (rows: CriterionInput[]) => void;
}) {
  const errFor = (i: number) => errors.find((e) => e.class === cls && e.index === i)?.error;
  return (
    <fieldset
      disabled={disabled}
      style={{ border: '1px solid var(--line, #ccc)', borderRadius: 6, marginBottom: 10 }}
      data-criteria-class={cls}
    >
      <legend style={{ fontSize: 13 }}>
        <b>{cls === 'required' ? t('m19.cr.required') : t('m19.cr.preferred')}</b>
      </legend>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>
        {cls === 'required' ? t('m19.cr.requiredNote') : t('m19.cr.preferredNote')}
      </div>
      {rows.length === 0 && <div className="dim" style={{ fontSize: 13 }}>{t('m19.cr.none')}</div>}
      {rows.map((c, i) => (
        <CriterionRow
          key={`${cls}-${i}`}
          criterion={c}
          vocab={vocab}
          error={errFor(i)}
          onChange={(next) => onChange(rows.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(rows.filter((_, j) => j !== i))}
        />
      ))}
      <button style={{ marginTop: 6 }} onClick={() => onChange([...rows, { ...BLANK.position }])}>
        {cls === 'required' ? t('m19.cr.addRequired') : t('m19.cr.addPreferred')}
      </button>
    </fieldset>
  );
}

// ------------------------------------------------------------- match cards

/**
 * Why this player matches. Required lines are the reason they are here at all;
 * preferred lines are counted, never scored, and an unmet preferred criterion
 * is shown as plainly as a met one.
 */
function WhyPanel({ card, compact }: { card: MatchCard; compact?: boolean }) {
  return (
    <div>
      <b style={{ fontSize: 13 }}>{t('m19.why')}</b>
      <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
        {card.required.map((r) => (
          <li key={r.criterionId} style={{ fontSize: 13 }}>
            <Mark met={r.met} />
            <span className="sr-only">{r.met ? t('m19.met') : t('m19.notMet')} — </span>
            {r.text}
          </li>
        ))}
      </ul>
      {card.preferredTotal > 0 && (
        <div style={{ marginTop: 6 }}>
          <b style={{ fontSize: 13 }}>
            {t('m19.preferredCount')
              .replace('{met}', String(card.preferredMet))
              .replace('{total}', String(card.preferredTotal))}
          </b>
          <div className="dim" style={{ fontSize: 12 }}>{t('m19.preferredCountNote')}</div>
          {!compact && (
            <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
              {card.preferred.map((r) => (
                <li key={r.criterionId} style={{ fontSize: 13 }}>
                  <Mark met={r.met} />
                  <span className="sr-only">{r.met ? t('m19.met') : t('m19.notMet')} — </span>
                  {r.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{card.note}</div>
    </div>
  );
}

function MatchCardView({
  card, openPlayer, onAddToRoom, busyRoom,
}: {
  card: MatchCard;
  openPlayer: (id: string) => void;
  onAddToRoom?: (playerId: string) => void;
  busyRoom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section" data-match-card={card.playerId} style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <b style={{ fontSize: 15 }}>{card.name}</b>
        {card.position && <span className="pill blue">{card.position}</span>}
        {card.secondaryPositions.map((p) => <span key={p} className="pill">{p}</span>)}
        {card.age !== null && <span className="pill">{t('m19.age')} {card.age}</span>}
        {card.trustBand && <span className="pill">{bandLabel(card.trustBand)}</span>}
        {card.distanceKm !== null && <span className="pill">{Math.round(card.distanceKm)} km</span>}
        <span className="grow" />
        <button onClick={() => openPlayer(card.playerId)}>{t('m19.openPlayer')}</button>
        {onAddToRoom && (
          <button disabled={busyRoom} onClick={() => onAddToRoom(card.playerId)}>{t('m19.addToRoom')}</button>
        )}
      </div>
      {card.trustBand && <div className="dim" style={{ fontSize: 12 }}>{card.trustNote}</div>}

      <div style={{ marginTop: 8 }}>
        <WhyPanel card={card} compact={!open} />
      </div>
      {card.preferredTotal > 0 && (
        <button
          style={{ marginTop: 6, padding: 0, color: 'var(--muted)', fontSize: 12.5 }}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t('m19.hideDetail') : t('m19.showDetail')}
        </button>
      )}
    </div>
  );
}

/** The orderings this app may actually ask for. */
const permittedSorts = (sorts: string[]) =>
  sorts.filter((s) => ALLOW_DISTANCE_SORT || s !== 'distance');

/** The ordering control. Every option names what it orders by, and none of
 *  them is "best match" — there is nothing to be best at. */
function SortPicker({ sorts, value, onChange }: { sorts: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ fontSize: 13 }}>
      {t('m19.orderBy')}{' '}
      <select aria-label={t('m19.orderBy')} value={value} onChange={(e) => onChange(e.target.value)}>
        {permittedSorts(sorts).map((s) => <option key={s} value={s}>{sortLabel(s)}</option>)}
      </select>
      <span className="dim" style={{ display: 'block', fontSize: 11 }}>{t('m19.orderNote')}</span>
    </label>
  );
}

// ------------------------------------------------------------- the screens

export interface MatchingScreenProps extends M19ScreenProps {
  /** The opaque criteria state carried by the deep link, if any. */
  encodedCriteria: string | null;
  onCriteriaState: (encoded: string | null) => void;
  onOpenWatchlist: (id: string) => void;
}

const EMPTY_CRITERIA: CriteriaInput = { required: [], preferred: [] };

export function MatchingScreen({
  session, tick, notify, openPlayer, encodedCriteria, onCriteriaState, onOpenWatchlist,
}: MatchingScreenProps) {
  const [vocab, setVocab] = useState<MatchVocabulary | null>(null);
  const [briefs, setBriefs] = useState<BriefListResult['items']>([]);
  const [source, setSource] = useState<'criteria' | 'brief'>('criteria');
  const [briefId, setBriefId] = useState<string>('');
  const [criteria, setCriteria] = useState<CriteriaInput>(() => decodeCriteria(encodedCriteria ?? '') ?? EMPTY_CRITERIA);
  const [sort, setSort] = useState<string>('recent_evidence');
  const [result, setResult] = useState<MatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<{ index: number; class: string; error: string }[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  // The criteria in the editor are unsaved work: leaving with them half-built
  // and unmatched is the same loss as an abandoned Brief form.
  const ranRef = useRef<string>(JSON.stringify(EMPTY_CRITERIA));
  const isDirty = useCallback(() => JSON.stringify(criteria) !== ranRef.current, [criteria]);
  useEffect(() => registerDirtyGuard(isDirty), [isDirty]);

  useEffect(() => {
    let live = true;
    setLoadErr(null);
    m19.vocabulary(session)
      .then((v) => { if (live) { setVocab(v); setSort((s) => (v.sorts.includes(s) ? s : v.defaultSort)); } })
      .catch((e) => { if (live) setLoadErr(errMessage(e)); });
    m18.briefs(session).then((d) => { if (live) setBriefs(d.items); }).catch(() => { /* brief source degrades to criteria */ });
    return () => { live = false; };
  }, [session, tick, bump]);

  // A shared link reproduces the search it was copied from.
  useEffect(() => {
    const decoded = decodeCriteria(encodedCriteria ?? '');
    if (!decoded) return;
    setCriteria(decoded);
    setSource('criteria');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodedCriteria]);

  const run = async (nextSort = sort) => {
    setBusy(true);
    setMessage(null);
    setDetails([]);
    try {
      const out = await m19.match(session, source === 'brief'
        ? { briefId, sort: nextSort }
        : { criteria, sort: nextSort });
      if (out.ok) {
        setResult(out.value);
        ranRef.current = JSON.stringify(criteria);
        onCriteriaState(source === 'criteria' && (criteria.required.length || criteria.preferred.length)
          ? encodeCriteria(criteria)
          : null);
      } else {
        setResult(null);
        setMessage(out.message);
        if (out.error === 'CRITERIA_INVALID') setDetails(out.details);
        if (out.error === 'CRITERION_PROHIBITED') {
          setMessage(`${out.message} — ${out.prohibited.join(', ')}`);
        }
      }
    } catch (e) {
      setResult(null);
      setMessage(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canRun = source === 'brief' ? !!briefId : criteria.required.length > 0;

  return (
    <div>
      <h2>{t('m19.title')}</h2>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('m19.intro')}</div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>{t('m19.noScore')}</div>

      {loadErr && <LoadError message={loadErr} onRetry={() => setBump((b) => b + 1)} />}

      <div className="section" aria-label={t('m19.criteriaLabel')}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <label style={{ fontSize: 13 }}>
            <input type="radio" name="m19-source" checked={source === 'criteria'} onChange={() => setSource('criteria')} /> {t('m19.srcCriteria')}
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="radio" name="m19-source" checked={source === 'brief'} onChange={() => setSource('brief')} /> {t('m19.srcBrief')}
          </label>
        </div>

        {source === 'brief' ? (
          <div>
            <label style={{ fontSize: 13 }}>
              {t('m19.pickBrief')}{' '}
              <select aria-label={t('m19.pickBrief')} value={briefId} onChange={(e) => setBriefId(e.target.value)}>
                <option value="">{t('m19.cr.choose')}</option>
                {briefs.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
            </label>
            <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m19.briefAllRequired')}</div>
          </div>
        ) : (
          <>
            <CriteriaClassEditor
              cls="required"
              rows={criteria.required}
              vocab={vocab}
              errors={details}
              onChange={(rows) => setCriteria((c) => ({ ...c, required: rows }))}
            />
            <CriteriaClassEditor
              cls="preferred"
              rows={criteria.preferred}
              vocab={vocab}
              errors={details}
              onChange={(rows) => setCriteria((c) => ({ ...c, preferred: rows }))}
            />
          </>
        )}

        {message && <div className="notice block" role="alert">{message}</div>}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <button className="primary" disabled={busy || !canRun} onClick={() => run()}>{t('m19.run')}</button>
          {vocab && <SortPicker sorts={vocab.sorts} value={sort} onChange={(s) => { setSort(s); if (result) void run(s); }} />}
        </div>
        {!canRun && source === 'criteria' && (
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m19.needRequired')}</div>
        )}
      </div>

      {result && (
        <MatchResults
          session={session}
          result={result}
          criteria={criteria}
          source={source}
          briefId={briefId}
          openPlayer={openPlayer}
          notify={notify}
          onOpenWatchlist={onOpenWatchlist}
        />
      )}
    </div>
  );
}

function MatchResults({
  session, result, criteria, source, briefId, openPlayer, notify, onOpenWatchlist,
}: {
  session: Session;
  result: MatchResult;
  criteria: CriteriaInput;
  source: 'criteria' | 'brief';
  briefId: string;
  openPlayer: (id: string) => void;
  notify: (text: string, error?: boolean) => void;
  onOpenWatchlist: (id: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  // The mode is CHOSEN, never inferred: a live-linked list follows the brief
  // wherever it goes, a saved-criteria list does not. Getting that wrong is
  // the difference between a list that updates and one that quietly does not.
  const [mode, setMode] = useState<WatchlistMode>(source === 'brief' ? 'live_linked' : 'snapshot');
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const out = await m19.createWatchlist(session, source === 'brief'
        ? { name, mode, briefId, sourceType: 'brief' }
        : { name, mode: 'snapshot', criteria });
      if (out.ok) {
        notify(t('m19.wl.created'));
        setSaving(false);
        setName('');
        onOpenWatchlist(out.value.id);
      } else {
        setSaveErr(out.message);
      }
    } catch (e) {
      setSaveErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div className="section" aria-label={t('m19.resultsLabel')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <b data-match-total={result.total}>
            {result.total === 1
              ? t('m19.countOne')
              : t('m19.countMany').replace('{n}', String(result.total))}
          </b>
          <span className="pill">{sortLabel(result.sort)}</span>
        </div>
        <div className="dim" style={{ fontSize: 12.5 }}>
          {t('m19.criteriaRun')}: {[...result.criteria.required, ...result.criteria.preferred].join(' · ') || t('m19.cr.none')}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>{result.note}</div>
        <div className="dim" style={{ fontSize: 12 }}>{result.scoreNote}</div>
        <div className="dim" style={{ fontSize: 12 }}>{t('m19.evaluatedAt')}: {fmtDateTime(result.evaluatedAt)}</div>
        {result.truncated && <div className="notice block">{result.note}</div>}

        <div style={{ marginTop: 10 }}>
          {!saving ? (
            <button className="primary" onClick={() => setSaving(true)}>{t('m19.saveAsWatchlist')}</button>
          ) : (
            <div>
              <label style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
                {t('m19.wl.name')}{' '}
                <input aria-label={t('m19.wl.name')} value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
              </label>
              <fieldset style={{ border: '1px solid var(--line, #ccc)', borderRadius: 6, marginBottom: 8 }}>
                <legend style={{ fontSize: 13 }}>{t('m19.wl.modeLegend')}</legend>
                {source === 'brief' && (
                  <label style={{ fontSize: 13, display: 'block' }}>
                    <input type="radio" name="m19-mode" checked={mode === 'live_linked'} onChange={() => setMode('live_linked')} />{' '}
                    <b>{modeLabel('live_linked')}</b> — {t('m19.wl.modeLiveNote')}
                  </label>
                )}
                <label style={{ fontSize: 13, display: 'block' }}>
                  <input type="radio" name="m19-mode" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} />{' '}
                  <b>{modeLabel('snapshot')}</b> — {t('m19.wl.modeSnapshotNote')}
                </label>
              </fieldset>
              {saveErr && <div className="notice block" role="alert">{saveErr}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="primary" disabled={busy || !name.trim()} onClick={save}>{t('common.save')}</button>
                <button onClick={() => { setSaving(false); setSaveErr(null); }}>{t('common.cancel')}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {result.items.length === 0 && (
        <div className="notice block">{t('m19.emptyMatches')}</div>
      )}
      {result.items.map((c) => <MatchCardView key={c.playerId} card={c} openPlayer={openPlayer} />)}
    </div>
  );
}

// ------------------------------------------------------- Dynamic Watchlists

export interface WatchlistsScreenProps extends M19ScreenProps {
  watchlistId: string | null;
  onOpenWatchlist: (id: string) => void;
  onCloseWatchlist: () => void;
  onOpenRoom: (roomId: string) => void;
  onNewWatchlist: () => void;
}

export function WatchlistsScreen(props: WatchlistsScreenProps) {
  return props.watchlistId
    ? <WatchlistDetailView {...props} watchlistId={props.watchlistId} />
    : <WatchlistList {...props} />;
}

function WatchlistList({ session, tick, onOpenWatchlist, onNewWatchlist }: WatchlistsScreenProps) {
  const [items, setItems] = useState<Watchlist[] | null>(null);
  const [note, setNote] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    let live = true;
    setErr(null);
    m19.watchlists(session, status || undefined)
      .then((d) => { if (live) { setItems(d.items); setNote(d.note); } })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, tick, bump, status]);

  return (
    <div>
      <h2>{t('m19.wl.title')}</h2>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 4 }}>{t('m19.wl.intro')}</div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>{t('m19.wl.derivedNote')}</div>

      {err && <LoadError message={err} onRetry={() => setBump((b) => b + 1)} />}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <button className="primary" onClick={onNewWatchlist}>{t('m19.wl.new')}</button>
        <label style={{ fontSize: 13 }}>
          {t('common.status')}{' '}
          <select aria-label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('m19.wl.allStatuses')}</option>
            <option value="active">{wlStatusLabel('active')}</option>
            <option value="paused">{wlStatusLabel('paused')}</option>
            <option value="archived">{wlStatusLabel('archived')}</option>
          </select>
        </label>
      </div>

      <div className="section" aria-label={t('m19.wl.listLabel')}>
        {!items && !err && <div className="dim">{t('m18.loading')}</div>}
        {items && items.length === 0 && <div className="dim">{t('m19.wl.empty')}</div>}
        {items && items.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t('m19.wl.name')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('m19.wl.mode')}</th>
                  <th>{t('m19.wl.criteria')}</th>
                  <th>{t('m19.wl.lastDerived')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((w) => (
                  <tr key={w.id}>
                    <td><b>{w.name}</b></td>
                    <td><span className="pill">{wlStatusLabel(w.status)}</span></td>
                    <td><span className="pill">{modeLabel(w.mode)}</span></td>
                    <td style={{ fontSize: 12.5 }}>
                      {[...w.criteria.required, ...w.criteria.preferred].join(' · ') || <span className="dim">{t('m19.cr.none')}</span>}
                    </td>
                    <td>{w.lastReconciledAt ? fmtDate(w.lastReconciledAt) : <span className="dim">{t('m19.wl.neverDerived')}</span>}</td>
                    <td>
                      <button onClick={() => onOpenWatchlist(w.id)} aria-label={`${t('m19.wl.open')} ${w.name}`}>{t('m19.wl.open')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {note && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{note}</div>}
      </div>
    </div>
  );
}

function WatchlistDetailView({
  session, tick, notify, openPlayer, watchlistId, onCloseWatchlist, onOpenRoom,
}: WatchlistsScreenProps & { watchlistId: string }) {
  const [data, setData] = useState<WatchlistDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [sort, setSort] = useState('recent_evidence');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [roomBusy, setRoomBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  // The revision the RENAME will be written against, frozen when the edit
  // began. Live sync keeps the rest of the page current, but a draft must not
  // silently adopt a colleague's newer revision: that would turn a conflict
  // into a last-write-wins overwrite of their change without anyone seeing it.
  const editRevRef = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    m19.watchlist(session, watchlistId, { sort })
      // A refetch never overwrites a name the person is in the middle of typing.
      .then((d) => { if (live) { setData(d); if (!renaming) setName(d.watchlist.name); } })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
    // `renaming` is deliberately not a dependency: it only guards the name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, watchlistId, tick, bump, sort]);

  const w = data?.watchlist ?? null;

  /** Returns true when the write landed. `atRev` lets a draft pin the revision
   *  it was started from; everything else writes against what is on screen. */
  const patch = async (input: Record<string, unknown>, okText: string, atRev?: number): Promise<boolean> => {
    if (!w) return false;
    setConflict(null);
    try {
      const out = await m19.patchWatchlist(session, w.id, { ...input, expectedRev: atRev ?? w.rev });
      if (out.ok) { notify(okText); setBump((b) => b + 1); return true; }
      notify(out.message, true);
      return false;
    } catch (e) {
      const c = conflictOf(e);
      if (c) setConflict(c); else notify(errMessage(e), true);
      return false;
    }
  };

  const setStatus = async (status: string) => {
    const action = status === 'archived'
      ? DESTRUCTIVE_ACTIONS.archiveWatchlist
      : status === 'paused' ? DESTRUCTIVE_ACTIONS.pauseWatchlist : null;
    if (action && !confirmDestructive({ ...action, name: w?.name ?? null })) return;
    await patch({ status }, t('m19.wl.statusChanged'));
  };

  const addToRoom = async (playerId: string) => {
    if (!w) return;
    setRoomBusy(playerId);
    try {
      const out = await m19.addToRoom(session, w.id, playerId);
      notify(out.existed ? t('m19.wl.roomExisted') : t('m19.wl.roomCreated'));
      onOpenRoom(out.roomId);
    } catch (e) {
      notify(errMessage(e), true);
    } finally {
      setRoomBusy(null);
    }
  };

  if (err) {
    return (
      <div>
        <button onClick={onCloseWatchlist}>← {t('m19.wl.back')}</button>
        <div className="notice block" style={{ marginTop: 10 }} role="alert">{err}</div>
      </div>
    );
  }
  if (!data || !w) return <div className="dim">{t('m18.loading')}</div>;

  const blocked = w.blocked ?? {};

  return (
    <div>
      <button onClick={onCloseWatchlist}>← {t('m19.wl.back')}</button>

      {conflict && (
        <ConflictNotice
          conflict={conflict}
          onReload={() => { setConflict(null); setRenaming(false); editRevRef.current = null; setBump((b) => b + 1); }}
          onKeepChanges={() => setConflict(null)}
        />
      )}

      <div className="section" style={{ marginTop: 10 }} aria-label={t('m19.wl.detailLabel')}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>{w.name}</h3>
          <span className="pill blue">{wlStatusLabel(w.status)}</span>
          <span className="pill">{modeLabel(w.mode)}</span>
          {w.notify ? <span className="pill outline-green">{t('m19.wl.notifyOn')}</span> : <span className="pill">{t('m19.wl.notifyOff')}</span>}
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          {t('m19.wl.criteria')}: {[...w.criteria.required, ...w.criteria.preferred].join(' · ') || t('m19.cr.none')}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          {w.createdBy && <>{t('m19.wl.createdBy')}: {w.createdBy} · </>}
          {t('m19.wl.lastDerived')}: {data.evaluatedAt ? fmtDateTime(data.evaluatedAt) : t('m19.wl.neverDerived')}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>{data.refreshNote}</div>

        {(blocked.blocked || blocked.paused) && (
          <div className="notice block" role="status" style={{ marginTop: 8 }}>{blocked.message}</div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {!renaming && <button onClick={() => { editRevRef.current = w.rev; setName(w.name); setRenaming(true); }}>{t('m19.wl.rename')}</button>}
          {w.status === 'active' && <button onClick={() => setStatus('paused')}>{t('m19.wl.pause')}</button>}
          {w.status === 'paused' && <button onClick={() => setStatus('active')}>{t('m19.wl.resume')}</button>}
          {w.status !== 'archived' && <button onClick={() => setStatus('archived')}>{t('m19.wl.archive')}</button>}
          <button onClick={() => patch({ notify: !w.notify }, t('m19.wl.notifyChanged'))}>
            {w.notify ? t('m19.wl.turnNotifyOff') : t('m19.wl.turnNotifyOn')}
          </button>
          <button onClick={() => setBump((b) => b + 1)}>{t('m19.wl.refresh')}</button>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('m19.wl.notifyNote')}</div>

        {renaming && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label={t('m19.wl.name')} value={name} onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
            <button
              className="primary"
              disabled={!name.trim()}
              onClick={async () => {
                const ok = await patch({ name: name.trim() }, t('m19.wl.renamed'), editRevRef.current ?? w.rev);
                if (ok) { setRenaming(false); editRevRef.current = null; }
              }}
            >{t('common.save')}</button>
            <button onClick={() => { setRenaming(false); editRevRef.current = null; setName(w.name); }}>{t('common.cancel')}</button>
          </div>
        )}
      </div>

      <div className="section" aria-label={t('m19.wl.summaryLabel')}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span data-wl-count="current"><b>{data.summary.current}</b> {t('m19.wl.currentlyMatching')}</span>
          <span data-wl-count="newly-matched"><b>{data.summary.newlyMatched}</b> {t('m19.wl.newlyMatched')}</span>
          <span data-wl-count="no-longer-matches"><b>{data.summary.noLongerMatches}</b> {t('m19.wl.noLongerMatches')}</span>
        </div>
        {data.summary.changedAt
          ? <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('m19.wl.changedAt')}: {fmtDateTime(data.summary.changedAt)}</div>
          : <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{t('m19.wl.noChangeYet')}</div>}
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{data.summary.note}</div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '10px 0' }}>
        <SortPicker sorts={['recent_evidence', 'name', 'age', 'evidence_confidence', 'distance']} value={sort} onChange={setSort} />
      </div>

      {data.items.length === 0 && !blocked.blocked && <div className="notice block">{t('m19.emptyMatches')}</div>}
      {data.items.map((c) => (
        <MatchCardView
          key={c.playerId}
          card={c}
          openPlayer={openPlayer}
          onAddToRoom={w.status === 'archived' ? undefined : addToRoom}
          busyRoom={roomBusy === c.playerId}
        />
      ))}

      <WatchlistHistory session={session} watchlistId={w.id} tick={tick + bump} />
    </div>
  );
}

/** Why membership changed, newest first. A player who has since become
 *  invisible keeps their transition here without their name coming back out. */
function WatchlistHistory({ session, watchlistId, tick }: { session: Session; watchlistId: string; tick: number }) {
  const [items, setItems] = useState<WatchlistHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    m19.history(session, watchlistId, cursor ? { cursor } : {})
      .then((d) => {
        if (!live) return;
        setItems((prev) => (cursor ? [...prev, ...d.items] : d.items));
        setNext(d.nextCursor);
        setNote(d.note);
        setTotal(d.total);
      })
      .catch((e) => { if (live) setErr(errMessage(e)); });
    return () => { live = false; };
  }, [session, watchlistId, tick, cursor]);

  return (
    <div className="section" aria-label={t('m19.hist.label')}>
      <h4 style={{ marginTop: 0 }}>{t('m19.hist.title')} {total > 0 && <span className="pill">{total}</span>}</h4>
      {err && <LoadError message={err} />}
      {items.length === 0 && !err && <div className="dim" style={{ fontSize: 13 }}>{t('m19.hist.empty')}</div>}
      <ul style={{ margin: 0, paddingInlineStart: 20 }}>
        {items.map((h) => (
          <li key={h.id} style={{ fontSize: 13, marginBottom: 4 }}>
            <span className={`pill ${h.transition === 'entered' ? 'outline-green' : ''}`}>
              {h.transition === 'entered' ? t('m19.hist.entered') : t('m19.hist.left')}
            </span>{' '}
            <b>{h.playerName ?? t('m19.hist.playerUnavailable')}</b>{' '}
            <span className="dim">{fmtDateTime(h.at)}</span>
            <div className="dim" style={{ fontSize: 12.5 }}>{h.text || reasonLabel(h.reason)}</div>
          </li>
        ))}
      </ul>
      {next && <button style={{ marginTop: 8 }} onClick={() => setCursor(next)}>{t('m19.hist.more')}</button>}
      {note && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{note}</div>}
    </div>
  );
}
