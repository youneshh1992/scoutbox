// M18.2 — two administrative panels under Organisation.
//
// Notification preferences: every non-critical category can be turned off,
// the mandatory category is shown locked with the reason, and the email row
// says exactly what email is in this build (a local outbox), because a
// preference that implies delivery which does not happen is a lie.
//
// Audit log: operational history for leads. What happened, who did it, to
// which record — never a note, a comment or a decision's text. Cursor-paged.
//
// Both use the shared HTTP state so a 403 here reads the same as a 403
// anywhere, and offer "Try again" only when retrying could help.
import { useCallback, useEffect, useState } from 'react';
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { fmtStamp, t } from './i18n';
import { httpState } from './httpState';

interface PrefCategory { id: string; label: string; enabled: boolean; mandatory: boolean }
interface Prefs { categories: PrefCategory[]; emailIntent: boolean; channels: { inApp: string; email: string; note: string } }

// The self-contained demo has no server: preferences live in the page and the
// audit log shows synthetic operational rows. Both mirror the server's shapes.
const demoPrefs: Prefs = {
  categories: [
    ['mentions', 'Mentions', true], ['assignments', 'Assignments and tasks', true], ['room_changes', 'Recruitment Room changes', true],
    ['evidence_requests', 'Evidence requests and evidence', true], ['combine', 'Combine requests and results', true],
    ['trial_updates', 'Trials and trial days', true], ['second_look', 'Second Look', true], ['brief_updates', 'Recruitment Briefs and coverage', true],
    ['messages', 'Messages and requests', true], ['activity', 'Recruitment outcomes and activity', true],
    ['discovery_nudges', 'Discovery nudges and badges', false], ['security_account', 'Security and account', true],
  ].map(([id, label, enabled]) => ({ id: id as string, label: label as string, enabled: enabled as boolean, mandatory: id === 'security_account' })),
  emailIntent: false,
  channels: { inApp: 'always', email: 'local_outbox', note: 'In-app delivery always keeps the record. There is no external email transport in this build; the email preference records what you would want when one exists.' },
};
const demoAudit = {
  items: [
    { id: 'h-3', at: Date.now() - 3600_000, action: 'room_status_changed', domain: 'recruitment_room', actor: { userId: 'u-demo-2', name: 'Tom Field' }, target: { type: 'room', id: 'case-demo-1', playerName: 'Kola Adeyemi' }, detail: { from: 'under_review', to: 'shortlisted', hadNote: true } },
    { id: 'h-2', at: Date.now() - 26 * 3600_000, action: 'recruitment_brief_activated', domain: 'recruitment_brief', actor: { userId: 'u-demo-1', name: 'Maria Keane' }, target: { type: 'brief', id: 'brief-demo-1', title: '2027 Defensive Midfielder' }, detail: { from: 'draft', to: 'active' } },
    { id: 'h-1', at: Date.now() - 4 * 86_400_000, action: 'room_created', domain: 'recruitment_room', actor: { userId: 'u-demo-1', name: 'Maria Keane' }, target: { type: 'room', id: 'case-demo-1', playerName: 'Kola Adeyemi' }, detail: null },
  ],
  nextCursor: null as string | null,
  total: 3,
};

async function call<T>(s: Session, path: string, init: RequestInit = {}): Promise<T> {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 120));
    if (path.startsWith('/org/notification-preferences')) {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body ?? '{}')) as { categories?: Record<string, boolean> };
        for (const [k, v] of Object.entries(body.categories ?? {})) {
          const c = demoPrefs.categories.find((x) => x.id === k);
          if (c && !c.mandatory) c.enabled = !!v;
        }
      }
      return { preferences: demoPrefs } as T;
    }
    if (path.startsWith('/org/audit')) return demoAudit as T;
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

/** Category labels are server-sent English; the client localises the known ids. */
const catLabel = (id: string, fallback: string) => t(`prefs.cat.${id}`, fallback);

export function NotificationPreferencesPanel({ session, notify }: { session: Session; notify: (text: string, error?: boolean) => void }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [err, setErr] = useState<ReturnType<typeof httpState> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    call<{ preferences: Prefs }>(session, '/org/notification-preferences')
      .then((d) => setPrefs(d.preferences))
      .catch((e) => setErr(httpState(e)));
  }, [session]);
  useEffect(load, [load]);

  const toggle = async (c: PrefCategory) => {
    if (c.mandatory) return;
    setBusy(c.id);
    try {
      const d = await call<{ preferences: Prefs }>(session, '/org/notification-preferences', {
        method: 'PUT', body: JSON.stringify({ categories: { [c.id]: !c.enabled } }),
      });
      setPrefs(d.preferences);
      notify(t('prefs.saved'));
    } catch (e) { notify(httpState(e).message, true); }
    finally { setBusy(null); }
  };

  return (
    <div className="section" aria-label={t('prefs.title')} data-panel="notification-preferences">
      <h3>{t('prefs.title')}</h3>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('prefs.intro')}</div>
      {err && (
        <div className="notice block" role="alert">
          <div>{err.message}</div>
          {err.retryable && <button style={{ marginTop: 6 }} onClick={load}>{t('common.retry')}</button>}
        </div>
      )}
      {!prefs && !err && <div className="dim">{t('common.loading')}</div>}
      {prefs && (
        <>
          <div className="list-rows">
            {prefs.categories.map((c) => (
              <div key={c.id} className="list-row">
                <span className="grow">
                  {catLabel(c.id, c.label)}
                  {c.mandatory && <div className="dim" style={{ fontSize: 12 }}>{t('prefs.mandatoryNote')}</div>}
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    disabled={c.mandatory || busy === c.id}
                    aria-label={`${catLabel(c.id, c.label)}: ${c.enabled ? t('prefs.on') : t('prefs.off')}${c.mandatory ? ` (${t('prefs.mandatory')})` : ''}`}
                    onChange={() => toggle(c)}
                  />
                  {c.mandatory ? t('prefs.mandatory') : c.enabled ? t('prefs.on') : t('prefs.off')}
                </label>
              </div>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>
            <b>{t('prefs.channels')}:</b> {t('prefs.inApp')} · {t('prefs.emailOutbox')}
            <div>{t('prefs.emailNote')}</div>
          </div>
        </>
      )}
    </div>
  );
}

interface AuditEntry {
  id: string; at: number; action: string; domain: string;
  actor: { userId: string; name: string | null } | null;
  target: { type: string; id: string; playerName?: string | null; title?: string | null };
  detail: Record<string, unknown> | null;
}

const actionLabel = (a: string) => t(`audit.action.${a}`, a.replace(/_/g, ' '));

function describe(e: AuditEntry): string {
  const who = e.actor?.name ?? t('audit.system');
  const what = actionLabel(e.action);
  const target = e.target.playerName ? ` — ${e.target.playerName}` : e.target.title ? ` — ${e.target.title}` : '';
  const d = e.detail ?? {};
  const bits: string[] = [];
  if (typeof d.from === 'string' && typeof d.to === 'string') bits.push(`${d.from} → ${d.to}`);
  if (typeof d.recommendation === 'string') bits.push(String(d.recommendation).replace(/_/g, ' '));
  if (Array.isArray(d.reasonCodes) && d.reasonCodes.length) bits.push((d.reasonCodes as string[]).map((c) => c.replace(/_/g, ' ')).join(', '));
  if (typeof d.priority === 'string') bits.push(String(d.priority));
  if (d.hadNote === true) bits.push(t('audit.hadNote'));
  return `${who}: ${what}${target}${bits.length ? ` (${bits.join(' · ')})` : ''}`;
}

export function AuditLogPanel({ session }: { session: Session }) {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState<ReturnType<typeof httpState> | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback((after: string | null) => {
    setErr(null);
    call<{ items: AuditEntry[]; nextCursor: string | null; total: number }>(session, `/org/audit?limit=25${after ? `&cursor=${encodeURIComponent(after)}` : ''}`)
      .then((d) => {
        setItems((prev) => (after ? [...prev, ...d.items] : d.items));
        setCursor(d.nextCursor);
        setTotal(d.total);
        setLoaded(true);
      })
      .catch((e) => { setErr(httpState(e)); setLoaded(true); });
  }, [session]);
  useEffect(() => { load(null); }, [load]);

  return (
    <div className="section" aria-label={t('audit.title')} data-panel="audit-log">
      <h3>{t('audit.title')}</h3>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('audit.intro')}</div>
      {err && (
        <div className="notice block" role="alert">
          <div>{err.message}</div>
          {err.retryable && <button style={{ marginTop: 6 }} onClick={() => load(null)}>{t('common.retry')}</button>}
        </div>
      )}
      {!loaded && !err && <div className="dim">{t('common.loading')}</div>}
      {loaded && !err && items.length === 0 && <div className="dim">{t('audit.empty')}</div>}
      {items.length > 0 && (
        <div className="list-rows">
          {items.map((e) => (
            <div key={e.id} className="list-row">
              <span className="grow" style={{ fontSize: 13 }}>{describe(e)}</span>
              <span className="dim">{fmtStamp(e.at)}</span>
            </div>
          ))}
        </div>
      )}
      {cursor && <button style={{ marginTop: 8 }} onClick={() => load(cursor)}>{t('audit.more')}</button>}
      {total != null && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{t('audit.count').replace('{n}', String(total))}</div>}
    </div>
  );
}
