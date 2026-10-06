import { RecordFacts, DetailItems } from './RecordDetails';
import { sentenceCase } from './presentation';
import { CountChart, countBy } from './ScoutVisuals';
// M13 org screens: Imports & Integrations, Coverage, Calibration, Scouting
// Insight (exposure + review queue + evidence gaps), Club Network (groups +
// transition packs), Deal Budgets, Representation (agency lane) and
// Organisation (onboarding, MFA, SSO, sessions, support, delivery).
// Same conventions as m12screens: labelled controls, honest empty/error
// states, live/demo through the m13 client.
import { Hint } from '../../design-system/About';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../design-system/icons';
import type { Session } from './api';
import {
  m13, type CalibrationSession, type CoverageAssignment, type EvidenceGap,
  type ImportBatch, type Scenario, type SharedResource,
} from './m13api';
import { m12, type CaseRec } from './m12api';
import { fmtDate, fmtDateTime, t } from './i18n';
import { AuditLogPanel, NotificationPreferencesPanel } from './orgPanels';

type ScreenProps = { session: Session; tick: number; notify: (text: string, error?: boolean) => void; openPlayer: (id: string) => void };

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let live = true;
    setErr(null);
    fn().then((x) => live && setV(x)).catch((e) => live && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bump]);
  return [v, () => setBump((b) => b + 1), err];
}

const money = (minor: number, cur: string) => `${cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : cur === 'USD' ? '$' : `${cur} `}${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const verdictPill = (v: string) => (v === 'compatible' || v === 'delivered' || v === 'aligned' ? 'green' : v === 'conflict' || v === 'high' || v === 'failed' ? 'red' : '');

// ================================================ F1 Imports & Integrations
export function ImportsScreen({ session, notify }: ScreenProps) {
  const [csv, setCsv] = useState('');
  const [importTab,setImportTab] = useState('imports');
  const [batches, reload] = useAsync<ImportBatch[]>(() => m13.listImports(session), [session]);
  const [reviews, reloadReviews] = useAsync(() => m13.listIdentityReviews(session), [session]);
  const [keys, reloadKeys] = useAsync(() => m13.listApiKeys(session), [session]);
  const [webhooks, reloadHooks] = useAsync(() => m13.listWebhooks(session), [session]);
  const [connectors] = useAsync(() => m13.listConnectors(session), [session]);
  const [dryRun, setDryRun] = useState<{ batch: ImportBatch; note: string } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [hookUrl, setHookUrl] = useState('');
  const [hookSecret, setHookSecret] = useState<string | null>(null);

  return (
    <div className="integration-suite">
      <header className="integration-hero"><div><span className="suite-eyebrow">ScoutBox connections</span><h2>Your club. Connected.</h2><p>Bring records in, resolve identities and control what leaves your workspace.</p></div><div className="connection-map" aria-label="Data flow"><span><Icon name="upload" size={23}/>Import</span><i/><b><Icon name="building-2" size={27}/>Your club</b><i/><span><Icon name="network" size={23}/>Export</span></div></header>
      <div className="integration-shell"><nav className="integration-nav" aria-label="Integration tools">{[['imports','Import records','upload',batches?.length],['identity','Identity reviews','scan-line',reviews?.length],['keys','Export access','key-round',keys?.items.filter(k=>!k.revokedAt).length],['hooks','Event delivery','network',webhooks?.items.filter(w=>w.active).length],['connectors','Provider directory','globe',connectors?.length]].map(([id,label,icon,count])=><button key={String(id)} aria-pressed={importTab===id} onClick={()=>setImportTab(String(id))}><Icon name={String(icon)} size={18}/><span>{label}</span><b>{count??'—'}</b></button>)}<p>Manage each connection independently. Access and delivery status come from your club’s records.</p></nav><div className="integration-content">
      <div className="section" hidden={importTab!=='imports'}>
        <h3>{t('m13.import.title')}</h3>
        <div className="notice" style={{ fontSize: 12.5 }}>{t('m13.import.note')} <a href={m13.importTemplateUrl()} download="scoutbox-prospects-template.csv">{t('m13.import.template')}</a></div>
        <div className="import-steps"><span><b>01</b> Prepare your file</span><span><b>02</b> Check the records</span><span><b>03</b> Confirm the import</span></div>
        <label className="suite-field">Paste CSV records<textarea aria-label="CSV content" rows={5} style={{ width: '100%' }} placeholder="name,dob,position,foot,heightCm,provider,externalId,notes" value={csv} onChange={(e) => setCsv(e.target.value)} /></label>
        <button onClick={async () => {
          try { const r = await m13.createImport(session, csv); setDryRun(r); reload(); notify('Dry run complete — nothing written yet.'); }
          catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
        }}>{t('m13.import.dryRun')}</button>
        {dryRun && (
          <div className="notice block" aria-live="polite">
            <b>{t('m13.import.dryRunResult')}</b><RecordFacts items={[{label: t('m13.import.creatable'), value: dryRun.batch.summary.creatable}, {label: t('m13.import.errors'), value: dryRun.batch.summary.errors}, {label: t('m13.import.duplicates'), value: dryRun.batch.summary.duplicatesInFile + dryRun.batch.summary.alreadyImported}, {label: t('m13.import.ambiguous'), value: dryRun.batch.summary.ambiguous}]} />
            {dryRun.batch.rows?.filter((r) => r.errors.length).slice(0, 3).map((r) => <div key={r.row} className="dim">Row {r.row}: {r.errors.join('; ')}</div>)}
            <div><button onClick={async () => {
              try { const c = await m13.commitImport(session, dryRun.batch.id); notify(`Imported ${c.created} prospects · ${c.reviewsQueued} identity review(s) queued.`); setDryRun(null); reload(); reloadReviews(); }
              catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
            }}>{t('m13.import.commit')}</button></div>
          </div>
        )}
        <div className="list-rows">
          {(batches ?? []).map((b) => (
            <div key={b.id} className="list-row">
              <span className="grow"><b>{b.id}</b> <span className={`pill ${b.status === 'committed' ? 'green' : b.status === 'reversed' ? 'red' : 'blue'}`}>{sentenceCase(b.status)}</span> <span className="dim"><RecordFacts items={[{label: 'Rows', value: b.summary.total}, {label: 'Imported by', value: b.createdByName}, {label: 'Created', value: fmtDate(b.createdAt)}]} /></span></span>
              {b.status === 'committed' && <button onClick={async () => { const r = await m13.reverseImport(session, b.id); notify(`Reversed ${r.removed}; kept ${r.kept.length} changed record(s).`); reload(); }}>{t('m13.import.reverse')}</button>}
            </div>
          ))}
        </div>
      </div>

      <div className="section" hidden={importTab!=='identity'}>
        <h3>{t('m13.identity.title')} {reviews?.length ? <span className="pill red">{reviews.length}</span> : <span className="pill green">0 open</span>}</h3>
        <details className="f-about"><summary>About</summary><div className="notice" style={{ fontSize: 12.5 }}>{t('m13.identity.note')}</div></details>
        {(reviews ?? []).map((r) => (
          <div key={r.id} className="list-row">
            <span className="grow"><b>{r.record.name}</b> <span className="dim"><RecordFacts items={[{label: 'Provider', value: r.record.provider}, {label: 'External ID', value: r.record.externalId}, {label: 'Date of birth', value: /^\d{4}-\d{2}-\d{2}$/.test(r.record.dob ?? '') ? fmtDate(r.record.dob as string) : r.record.dob}, {label: 'Import row', value: r.row}]} /><span className="record-note">May be the same player as one on ScoutBox</span></span></span>
            <button onClick={async () => { await m13.resolveIdentity(session, r.id, 'link'); notify('Linked.'); reloadReviews(); }}>{t('m13.identity.link')}</button>
            <button onClick={async () => { await m13.resolveIdentity(session, r.id, 'separate'); notify('Kept separate.'); reloadReviews(); }}>{t('m13.identity.separate')}</button>
          </div>
        ))}
      </div>

      <div className="section" hidden={importTab!=='keys'}>
        <h3>{t('m13.keys.title')}</h3>
        <div className="dim" style={{ fontSize: 12.5 }}>Export contract: {keys?.contractVersion}</div>
        {newKey && <div className="notice block"><code>{newKey}</code> — {t('m13.keys.once')}</div>}
        {(keys?.items ?? []).map((k) => (
          <div key={k.id} className="list-row">
            <span className="grow"><b>{k.label}</b> <span className="dim">{k.scopes.join(', ')}</span> {k.revokedAt ? <span className="pill red">Revoked</span> : <span className="pill green">Active</span>}</span>
            {!k.revokedAt && <button onClick={async () => { await m13.revokeApiKey(session, k.id); notify('Key revoked.'); reloadKeys(); }}>{t('m13.keys.revoke')}</button>}
          </div>
        ))}
        <button onClick={async () => { const r = await m13.createApiKey(session, ['export:shortlist'], 'Shortlist export'); setNewKey(r.plaintext); reloadKeys(); }}>{t('m13.keys.new')}</button>
      </div>

      <div className="section" hidden={importTab!=='hooks'}>
        <h3>{t('m13.hooks.title')}</h3>
        <details className="f-about"><summary>How to verify deliveries</summary><div className="notice" style={{ fontSize: 12.5 }}>{webhooks?.guidance}</div></details>
        {hookSecret && <div className="notice block">{t('m13.hooks.secret')}: <code>{hookSecret}</code></div>}
        {(webhooks?.items ?? []).map((w) => (
          <div key={w.id} className="list-row">
            <span className="grow"><b>{w.url}</b> <span className="dim">{w.events.join(', ')}</span> <span className={`pill ${w.active ? 'green' : 'red'}`}>{w.active ? 'active' : 'off'}</span></span>
            <button onClick={async () => { const e2 = await m13.rotateWebhook(session, w.id); setHookSecret(e2.secret ?? null); notify('Secret rotated (old one valid 24h).'); }}>{t('m13.hooks.rotate')}</button>
          </div>
        ))}
        <div className="enter-row">
          <input aria-label="Webhook URL" placeholder="https://your-endpoint.example/hook" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
          <button onClick={async () => {
            try { const r = await m13.createWebhook(session, hookUrl, ['import.committed', 'identity.resolved', 'transition.granted', 'transition.revoked']); setHookSecret(r.endpoint.secret ?? null); setHookUrl(''); reloadHooks(); notify('Endpoint registered.'); }
            catch (e) { notify(e instanceof Error ? e.message : 'rejected', true); }
          }}>{t('m13.hooks.add')}</button>
        </div>
      </div>

      <div className="section" hidden={importTab!=='connectors'}>
        <h3>{t('m13.connectors.title')}</h3>
        {(connectors ?? []).map((c) => (
          <div key={c.id} className="list-row">
            <span className="grow"><b>{c.name}</b> <span className="pill">{c.status.replace('_', ' ')}</span><div className="dim" style={{ fontSize: 12 }}>{c.note}</div></span>
          </div>
        ))}
      </div>
      </div></div>
    </div>
  );
}

// ======================================================== F7 Coverage
export function CoverageScreen({ session, notify }: ScreenProps) {
  const [fixtures, reloadFx] = useAsync(() => m13.listFixtures(session), [session]);
  const [plans, reloadPlans] = useAsync(() => m13.listPlans(session), [session]);
  const [assignments, reloadAsg] = useAsync<CoverageAssignment[]>(() => m13.listAssignments(session), [session]);
  const [suggestions] = useAsync(() => m13.visitSuggestions(session), [session]);
  const [staff] = useAsync(() => m12.listStaff(session), [session]);
  const [form, setForm] = useState({ home: '', away: '', date: '', competition: '' });
  const [asgFixture, setAsgFixture] = useState('');
  const [asgScout, setAsgScout] = useState('');

  return (
    <div>
      <CountChart title="Scout assignments" note="Recorded assignments, split by whether a scouting observation has been logged." unit="assignments" distribution items={assignments ? countBy(assignments, a => a.observedAt ? 'Observed' : 'Assigned') : null} />
      <div className="section">
        <h3>{t('m13.cov.plans')}</h3>
        {(plans ?? []).map((p) => (
          <div key={p.id} className="list-row"><span className="grow"><b>{p.label}</b> <span className="dim">{p.competition ?? 'all'} · {p.windowDays}d window</span></span>
            <span className={`pill ${p.progress?.complete ? 'green' : 'blue'}`}>{p.progress?.done ?? 0}/{p.goalObservations}</span></div>
        ))}
        <button onClick={async () => { await m13.createPlan(session, { label: 'New coverage plan', goalObservations: 5, windowDays: 60 }); reloadPlans(); notify('Plan created.'); }}>{t('m13.cov.newPlan')}</button>
      </div>
      <div className="section">
        <h3>{t('m13.cov.fixtures')}</h3>
        <div className="list-rows">
          {(fixtures ?? []).map((f) => (
            <div key={f.id} className="list-row"><span className="grow"><b>{f.home} v {f.away}</b> <span className="dim"><RecordFacts items={[{label: 'Date', value: f.date}, {label: 'Competition', value: f.competition}, {label: 'Location', value: f.location?.city ?? 'Not recorded'}]} /></span> <span className="pill">{f.source.replace('_', ' ')}</span></span></div>
          ))}
        </div>
        <div className="enter-row">
          <input aria-label="Home" placeholder="Home" value={form.home} onChange={(e) => setForm({ ...form, home: e.target.value })} />
          <input aria-label="Away" placeholder="Away" value={form.away} onChange={(e) => setForm({ ...form, away: e.target.value })} />
          <input aria-label="Date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <button onClick={async () => {
            try { await m13.createFixture(session, form); setForm({ home: '', away: '', date: '', competition: '' }); reloadFx(); notify('Fixture added.'); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('common.create')}</button>
        </div>
      </div>
      <div className="section">
        <h3>{t('m13.cov.assignments')}</h3>
        {(assignments ?? []).map((a) => (
          <div key={a.id} className="list-row coverage-mission">
            <span className="mission-date"><Icon name="calendar-days" size={20}/><b>{fmtDate(a.fixtureDate)}</b></span><span className="grow">
              <b>{a.fixtureLabel}</b><span className="mission-facts"><span><small>Assigned scout</small>{a.scoutName}</span><span><small>Players to observe</small>{a.targetPlayerIds.length}</span>{a.travelBudget && <span><small>Entered budget</small>{money(a.travelBudget.amountMinor,a.travelBudget.currency)}</span>}</span>
              {a.warnings.map((w) => <div key={w} className="pill red" style={{ marginTop: 4 }}><Icon name="triangle-alert" size={14} /> {w}</div>)}
              <div className="dim" style={{ fontSize: 11.5 }}>{a.travelNote}</div>
            </span>
            {a.observedAt
              ? <span className="pill green">Observed {fmtDate(a.observedAt)}</span>
              : <button onClick={async () => { await m13.completeAssignment(session, a.id); reloadAsg(); reloadPlans(); notify('Observation recorded — coverage updated.'); }}>{t('m13.cov.complete')}</button>}
          </div>
        ))}
        <div className="enter-row">
          <select aria-label="Fixture" value={asgFixture} onChange={(e) => setAsgFixture(e.target.value)}>
            <option value="">{t('m13.cov.pickFixture')}</option>
            {(fixtures ?? []).map((f) => <option key={f.id} value={f.id}>{f.home} v {f.away} ({f.date})</option>)}
          </select>
          <select aria-label="Scout" value={asgScout} onChange={(e) => setAsgScout(e.target.value)}>
            <option value="">{t('m13.cov.pickScout')}</option>
            {(staff ?? []).filter((u) => !u.removedAt).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button onClick={async () => {
            try {
              const r = await m13.createAssignment(session, { fixtureId: asgFixture, scoutUserId: asgScout });
              notify(r.warnings.length ? `${r.warnings[0]}` : 'Assigned.'); reloadAsg();
            } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m13.cov.assign')}</button>
        </div>
      </div>
      <div className="section">
        <h3>{t('m13.cov.suggestions')}</h3>
        <Hint className="notice" style={{ fontSize: 12.5 }}>{suggestions?.note}</Hint>
        {(suggestions?.items ?? []).map((sg) => (
          <div key={sg.fixture.id} className="list-row"><span className="grow"><b>{sg.fixture.home} v {sg.fixture.away}</b> <span className="dim">{sg.fixture.date} — {sg.rationale}: {sg.nearbyTargets.map((p) => p.name).join(', ')}</span></span>{sg.alreadyCovered && <span className="pill">Covered</span>}</div>
        ))}
        {suggestions?.items.length === 0 && <div className="dim">{t('common.none')}</div>}
      </div>
    </div>
  );
}

// ======================================================== F5 Calibration
export function CalibrationScreen({ session, notify }: ScreenProps) {
  const [list, reloadList] = useAsync(() => m13.listCalibrations(session), [session]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sess, reloadSess] = useAsync<CalibrationSession | null>(() => (openId ? m13.getCalibration(session, openId) : Promise.resolve(null)), [openId]);
  const [ratings, setRatings] = useState<Record<string, { value?: number; notObserved?: boolean }>>({});
  const [review] = useAsync(() => m13.decisionReview(session).catch(() => null), [session]);
  const [staff] = useAsync(() => m12.listStaff(session), [session]);
  const [templates] = useAsync(() => m12.listTemplates(session), [session]);

  return (
    <div>
      <div className="section">
        <h3>{t('m13.cal.sessions')}</h3>
        {(list ?? []).map((c) => (
          <div key={c.id} className="list-row">
            <span className="grow"><b>{c.title}</b> <span className="dim">{c.submitted}/{c.participants} submitted</span> <span className={`pill ${c.status === 'open' ? 'blue' : ''}`}>{sentenceCase(c.status)}</span></span>
            <button onClick={() => { setOpenId(c.id); setRatings({}); }}>{t('common.close') === 'Close' ? 'Open' : 'Ouvrir'}</button>
          </div>
        ))}
        <button onClick={async () => {
          const tpl = ((templates as { templates?: { id: string }[] })?.templates ?? [])[0];
          const two = (staff ?? []).filter((u) => !u.removedAt).slice(0, 3).map((u) => u.id);
          if (!tpl || two.length < 2) return notify('Need a template + two staff.', true);
          try { await m13.createCalibration(session, { templateId: tpl.id, title: `Calibration ${new Date().toISOString().slice(0, 10)}`, participantUserIds: two }); reloadList(); notify('Session created — participants notified.'); }
          catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
        }}>{t('m13.cal.new')}</button>
      </div>
      {sess && (
        <div className="section" aria-live="polite">
          <h3>{sess.title} <span className="pill">Rubric v{sess.templateVersion} (pinned)</span></h3>
          {sess.blind && <div className="notice block">{t('m13.cal.blindNote')}</div>}
          {sess.footageNote && <div className="notice block"><Icon name="triangle-alert" size={14} /> {sess.footageNote}</div>}
          {sess.blind ? (
            <div>
              {sess.attributesSnapshot.map((a) => (
                <div key={a.id} className="list-row">
                  <span className="grow">{a.label}</span>
                  {[1, 2, 3, 4, 5].map((v) => (
                    <button key={v} aria-label={`${a.label} ${v}`} className={ratings[a.id]?.value === v ? 'active' : ''} onClick={() => setRatings({ ...ratings, [a.id]: { value: v } })}>{v}</button>
                  ))}
                  <button className={ratings[a.id]?.notObserved ? 'active' : ''} onClick={() => setRatings({ ...ratings, [a.id]: { notObserved: true } })}>{t('assess.notObserved')}</button>
                </div>
              ))}
              <button onClick={async () => {
                try {
                  const rs = Object.entries(ratings).map(([attrId, r]) => ({ attrId, ...r }));
                  if (!rs.length) return notify('Rate at least one attribute.', true);
                  await m13.submitCalibration(session, sess.id, rs, 'medium'); reloadSess(); notify('Submitted — comparison unlocked for you.');
                } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
              }}>{t('m13.cal.submit')}</button>
            </div>
          ) : sess.comparison && (
            <div>
              <div className="notice" style={{ fontSize: 12.5 }}>{sess.comparison.confidenceNote}</div>
              {sess.comparison.rows.map((r) => (
                <div key={r.attrId} className="list-row">
                  <span className="grow"><b>{r.label}</b> <span className="dim"><DetailItems items={r.values.map((value, i) => `Observation ${i + 1}: ${value}`)} /><span className="record-note">{r.notObserved} not observed</span></span></span>
                  <span className={`pill ${verdictPill(r.disagreement)}`}>{r.disagreement}{r.range !== null ? ` (range ${r.range})` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {review && (
        <div className="section">
          <h3>{t('m13.cal.review')}</h3>
          <Hint className="notice" style={{ fontSize: 12.5 }}>{review.disclaimer}</Hint>
          {review.items.map((i) => (
            <article key={i.assessmentId} className="decision-review"><header><span className="suite-monogram">{i.playerName.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><div><h4>{i.playerName}</h4><p>Assessment by {i.scoutName}</p></div></header><dl><div><dt>Recorded recommendation</dt><dd>{sentenceCase(i.recommendation.verdict)}</dd></div><div><dt>Signing since assessment</dt><dd>{i.since.signedSomewhere ? 'Signing recorded' : 'No signing recorded'}</dd></div><div><dt>Further assessments</dt><dd>{i.since.furtherAssessments}</dd></div></dl></article>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================ F4+F6 Scouting Insight
export function InsightScreen({ session, notify, openPlayer }: ScreenProps) {
  const [report] = useAsync(() => m13.exposureReport(session).catch(() => null), [session]);
  const [queue, reloadQueue] = useAsync(() => m13.reviewQueue(session), [session]);
  const [rotation] = useAsync(() => m13.discoveryRotation(session), [session]);
  const [gapPlayer, setGapPlayer] = useState('');
  const [insightTab,setInsightTab] = useState('overview');
  const [gaps, reloadGaps] = useAsync<{ items: EvidenceGap[]; engine: { version: number; note: string } } | null>(
    () => (gapPlayer ? m13.evidenceGaps(session, gapPlayer) : Promise.resolve(null)), [gapPlayer]);

  return <div className="insight-desk">
    <header className="insight-hero"><div><span className="suite-eyebrow">ScoutBox intelligence</span><h2>See the whole picture.</h2><p>Your club’s discovery activity, review priorities and evidence in one workspace.</p></div><div className="insight-window"><Icon name="calendar-days" size={20}/><b>{report ? `${report.funnel.windowDays} days` : 'Current view'}</b><span>Reporting window</span></div></header>
    <div className="insight-metrics"><button onClick={()=>setInsightTab('reviews')}><Icon name="eye" size={18}/><span>Awaiting a first assessment</span><b>{queue?.queue.length??'—'}</b><small>Open review queue <Icon name="arrow-up-right" size={13}/></small></button><button onClick={()=>setInsightTab('reviews')}><Icon name="clock" size={18}/><span>Deferred reviews</span><b>{queue?.deferred.length??'—'}</b><small>Scheduled to revisit</small></button><button onClick={()=>setInsightTab('reviews')}><Icon name="refresh-cw" size={18}/><span>Evaluations to revisit</span><b>{queue?.staleEvaluations.length??'—'}</b><small>Existing records flagged as stale</small></button></div>
    <nav className="suite-tabs" aria-label="Scouting Insight views">{[['overview','Discovery overview'],['reviews','Review queue'],['gaps','Evidence gaps']].map(([id,label])=><button key={id} aria-pressed={insightTab===id} onClick={()=>setInsightTab(id)}>{label}</button>)}</nav>
    {insightTab==='overview' && <div className="insight-overview">
      {report ? <><section className="insight-flow"><div className="suite-section-heading"><div><span className="suite-eyebrow">Discovery activity</span><h3>From visibility to evaluation</h3></div><span>{report.funnel.windowDays}-day window</span></div><div className="insight-stage-chart">{report.funnel.stages.map((st,i)=><div key={st.key}><div className="insight-stage-number"><small>{String(i+1).padStart(2,'0')}</small><b>{st.players}</b></div><div className="insight-stage-track"><span style={{height:`${st.players/Math.max(1,...report.funnel.stages.map(x=>x.players))*100}%`}}/></div><h4>{sentenceCase(st.key)}</h4>{st.of!==undefined&&<small>Of {st.of} players</small>}</div>)}</div><p className="suite-caption">{report.funnel.definition}</p></section>
      <section className="insight-distribution"><div className="suite-section-heading"><div><span className="suite-eyebrow">Who receives attention</span><h3>Birth-quarter distribution</h3></div><Icon name="users" size={21}/></div>{report.birthQuarter.suppressed ? <div className="suite-protected"><Icon name="lock-keyhole" size={25}/><h4>Breakdown protected</h4><p>{t('m13.exp.suppressed')}</p></div>:<CountChart title="Players by birth quarter" note={report.birthQuarter.note??'Recorded birth quarters in this reporting window.'} unit="players" distribution items={Object.entries(report.birthQuarter.quarters??{}).map(([label,value])=>({label,value}))}/>}<p className="suite-caption">{report.absentEvidence.note}</p></section></>:<div className="suite-protected"><Icon name="shield" size={28}/><p>{t('m13.exp.leadOnly')}</p></div>}
      <section className="insight-rotation"><div className="suite-section-heading"><div><span className="suite-eyebrow">Expand your view</span><h3>Discovery rotation</h3></div><Icon name="compass" size={22}/></div><p className="suite-caption">{rotation?.note}</p><div className="insight-player-grid">{(rotation?.items??[]).map(p=><button key={p.id} onClick={()=>openPlayer(p.id)}><span className="suite-monogram">{p.name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><b>{p.name}</b><small>{p.position??'Position not recorded'}</small><Icon name="arrow-up-right" size={16}/></button>)}</div></section>
    </div>}
    {insightTab==='reviews' && <section className="insight-reviews"><div className="suite-section-heading"><div><span className="suite-eyebrow">Your next observations</span><h3>First assessments</h3></div><span>{queue?.queue.length??'—'} players</span></div><div className="insight-player-grid">{(queue?.queue??[]).map(q=><article key={q.player.id}><span className="suite-monogram">{q.player.position??'—'}</span><div><h4>{q.player.name}</h4><p>First seen {q.firstSeenDaysAgo} days ago</p><small>No assessment recorded</small></div><footer><button className="primary" onClick={()=>openPlayer(q.player.id)}>{t('m13.exp.open')}</button><button onClick={async()=>{await m13.deferReview(session,q.player.id,7);reloadQueue();notify('Deferred 7 days — you will be reminded.');}}>{t('m13.exp.later')}</button></footer></article>)}</div>{queue?.queue.length===0&&<p className="suite-empty">No first assessments waiting.</p>}<div className="insight-review-lanes"><section><h3>Scheduled to revisit</h3>{(queue?.deferred??[]).map(q=><div className="suite-record" key={q.player.id}><Icon name="clock" size={18}/><div><b>{q.player.name}</b><p>Deferred until {fmtDate(q.deferredUntil)}</p></div></div>)}{queue?.deferred.length===0&&<p className="suite-empty">No deferred reviews.</p>}</section><section><h3>Evaluations to refresh</h3>{(queue?.staleEvaluations??[]).map(sEv=><div className="suite-record" key={sEv.playerId}><Icon name="refresh-cw" size={18}/><div><b>{sEv.playerName}</b><p>{sEv.note}</p></div></div>)}{queue?.staleEvaluations.length===0&&<p className="suite-empty">No stale evaluations reported.</p>}</section></div></section>}
    {insightTab==='gaps' && <section className="insight-gap-panel"><div className="suite-section-heading"><div><span className="suite-eyebrow">Complete the evidence</span><h3>{t('m13.gaps.title')}</h3></div><Icon name="file-check-2" size={23}/></div><p className="suite-caption">Look up a player to review the evidence still needed. Requests retain the existing player and guardian permissions.</p><label className="suite-field">Player ID<input aria-label="Player id" placeholder={t('m13.gaps.playerId')} value={gapPlayer} onChange={e=>setGapPlayer(e.target.value)}/></label>
        {gaps && (
          <div>
            <div className="dim" style={{ fontSize: 12 }}>{gaps.engine.note} (rules v{gaps.engine.version})</div>
            {gaps.items.map((g) => (
              <div key={g.id} className="list-row">
                <span className="grow">
                  <b>{g.explanation}</b>
                  <div className="dim" style={{ fontSize: 12 }}><RecordFacts items={[{label: 'Rule', value: `${g.ruleId} v${g.ruleVersion}`}, {label: 'Supporting records', value: g.records.length}, {label: 'Action', value: sentenceCase(g.action)}]} /></div>
                </span>
                <span className={`pill ${g.status === 'supplied' ? 'green' : g.status === 'requested' ? 'blue' : ''}`}>{sentenceCase(g.status)}</span>
                {g.status === 'suggested' && <button onClick={async () => {
                  try { await m13.requestGap(session, g.id); reloadGaps(); notify('Requested — routed through the guardian for under-18s.'); }
                  catch (e) { notify(e instanceof Error ? e.message : 'rate-limited', true); }
                }}>{t('m13.gaps.request')}</button>}
                {g.status === 'suggested' && <button onClick={async () => { await m13.dismissGap(session, g.id); reloadGaps(); }}>{t('m13.gaps.dismiss')}</button>}
              </div>
            ))}
            {gaps.items.length === 0 && <div className="dim">{t('m13.gaps.none')}</div>}
          </div>
        )}
    </section>}
  </div>;
}

// ======================================== F8+F2 Club network
export function NetworkScreen({ session, notify }: ScreenProps) {
  const [groups, reloadGroups] = useAsync(() => m13.listGroups(session), [session]);
  const [grants, reloadGrants] = useAsync(() => m13.listGrants(session), [session]);
  const [transitions] = useAsync(() => m13.listTransitions(session), [session]);
  const [pack, setPack] = useState<Awaited<ReturnType<typeof m13.transitionPack>> | null>(null);
  const [shared, setShared] = useState<{ from: string; resource: SharedResource } | null>(null);

  return (
    <div>
      <CountChart title="Your club network" note="Member organisations in each workspace you belong to. A club may belong to several workspaces." unit="clubs" items={groups ? groups.items.map(g => ({ label: g.name, value: g.members.length })) : null} />
      <div className="section">
        <h3>{t('m13.grp.title')}</h3>
        {(groups?.invites ?? []).map((iv) => (
          <div key={iv.groupId} className="list-row"><span className="grow">{t('m13.grp.invitedTo')} <b>{iv.name}</b></span>
            <button onClick={async () => { await m13.acceptGroup(session, iv.groupId); reloadGroups(); notify('Joined — nothing is shared until a specific grant.'); }}>{t('m13.grp.accept')}</button></div>
        ))}
        {(groups?.items ?? []).map((g) => (
          <div key={g.id} className="section" style={{ marginTop: 8 }}>
            <b>{g.name}</b> {g.youAdmin && <span className="pill gold">Admin</span>}
            <div className="dim" style={{ fontSize: 12.5 }}><DetailItems items={g.members.map(mm => mm.name)} /></div>
            {g.programmes.map((p) => <div key={p.id} className="dim" style={{ fontSize: 12.5 }}>{p.name} {p.region ? `(${p.region})` : ''}</div>)}
            <Hint className="notice" style={{ fontSize: 12, marginTop: 6 }}>{t('m13.grp.isolatedNote')}</Hint>
            <div style={{ marginTop: 6 }}>
              <button onClick={async () => {
                try {
                  const others = g.members.filter((mm) => mm.id !== session.org.id).map((mm) => mm.id);
                  const pv = await m13.previewGrant(session, g.id, { resourceKind: 'shortlist', resourceId: '*', toOrgIds: others });
                  const first = pv.recipients[0];
                  notify(`${first?.orgName} would see ${first?.wouldSee.players?.length ?? 0} player(s); ${first?.wouldSee.withheld ?? 0} withheld by their own rules.`);
                } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
              }}>{t('m13.grp.preview')}</button>{' '}
              <button onClick={async () => {
                try {
                  const others = g.members.filter((mm) => mm.id !== session.org.id).map((mm) => mm.id);
                  await m13.createGrant(session, g.id, { resourceKind: 'shortlist', resourceId: '*', toOrgIds: others, expiresDays: 30 });
                  reloadGrants(); notify('Shortlist shared (30 days, revocable).');
                } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
              }}>{t('m13.grp.shareShortlist')}</button>{' '}
              {g.youAdmin && <button onClick={async () => {
                try { const rep = await m13.groupReport(session, g.id); notify(`${rep.group.name}: ${rep.activity.map((a) => `${a.orgName} ${a.assessments} assessments`).join(' · ')} (small counts suppressed)`); }
                catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
              }}>{t('m13.grp.report')}</button>}{' '}
              <button onClick={async () => { const r = await m13.leaveGroup(session, g.id); reloadGroups(); reloadGrants(); notify(`Left — ${r.grantsEnded} dependent grant(s) ended, your records stay yours.`); }}>{t('m13.grp.leave')}</button>
            </div>
          </div>
        ))}
        {groups?.items.length === 0 && <div className="dim">{t('m13.grp.none')}</div>}
      </div>
      <div className="section">
        <h3>{t('m13.grp.grants')}</h3>
        {(grants?.given ?? []).map((g) => (
          <div key={g.id} className="list-row">
            <span className="share-direction"><Icon name="arrow-up-right" size={20}/></span><span className="grow"><b>{sentenceCase(g.resourceKind)} shared by your club</b><span className="dim">Recipient: {g.toOrgIds?.map(id=>groups?.items.flatMap(group=>group.members).find(org=>org.id===id)?.name??id).join(', ')}</span><small className="share-expiry">Access until {fmtDate(g.expiresAt)}</small> {g.revokedAt ? <span className="pill red">Revoked</span> : <span className="pill green">Live</span>}</span>
            {!g.revokedAt && <button onClick={async () => { await m13.revokeGrant(session, g.id); reloadGrants(); notify('Revoked — effective on the very next read.'); }}>{t('m13.grp.revoke')}</button>}
          </div>
        ))}
        {(grants?.received ?? []).map((g) => (
          <div key={g.id} className="list-row">
            <span className="share-direction"><Icon name="folder-open" size={20}/></span><span className="grow"><b>{sentenceCase(g.resourceKind)} shared with your club</b><span className="dim">From {g.fromOrgName}</span><small className="share-expiry">Access until {fmtDate(g.expiresAt)}</small></span>
            <button onClick={async () => {
              try { setShared(await m13.readShared(session, g.id)); }
              catch { notify('This share was revoked or expired.', true); }
            }}>{t('m13.grp.open')}</button>
          </div>
        ))}
        {shared && (
          <div className="notice block">
            <b>{shared.from}</b> — {shared.resource.kind}
            {shared.resource.players?.map((p) => <div key={p.id}><b>{p.name}</b><RecordFacts items={[{label: 'Position', value: p.position}, {label: 'Level', value: sentenceCase(p.level)}]} /></div>)}
            {shared.resource.withheldNote && <div className="dim" style={{ fontSize: 12 }}>{shared.resource.withheldNote}</div>}
            {!!shared.resource.assessment && <div className="dim">{JSON.stringify(shared.resource.assessment)}</div>}
          </div>
        )}
      </div>
      <div className="section">
        <h3>{t('m13.trn.title')}</h3>
        <Hint className="notice" style={{ fontSize: 12.5 }}>{transitions?.note}</Hint>
        {(transitions?.items ?? []).map((tr) => (
          <div key={tr.id} className="list-row">
            <span className="share-direction"><Icon name="files" size={22}/></span><span className="grow"><b>{tr.playerName}</b><p className="dim">{tr.note ?? 'Player transition pack'}</p><small className="share-expiry">Access until {fmtDate(tr.expiresAt)}</small></span>
            <button onClick={async () => {
              try { setPack(await m13.transitionPack(session, tr.id)); }
              catch { notify('Access to this pack was withdrawn.', true); }
            }}>{t('m13.trn.openPack')}</button>
          </div>
        ))}
        {transitions?.items.length === 0 && <div className="dim">{t('m13.trn.none')}</div>}
        {pack && (
          <div className="notice block">
            <b>{pack.playerName}</b> — {pack.note}
            {pack.pack.media.map((mm) => <div key={mm.id}>{mm.title}</div>)}
            {pack.pack.evidence.map((ev) => <div key={ev.id}>{ev.summary ?? ev.id} <span className="pill">{ev.tier.replace('_', ' ')}</span></div>)}
            {pack.pack.publishedFeedback.map((f, i) => <div key={i}>“{f.text}” — {f.orgName}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ======================================================== F9 Budgets
export function BudgetsScreen({ session, notify }: ScreenProps) {
  const [cases] = useAsync<CaseRec[]>(() => m12.listCases(session).then((r) => (Array.isArray(r) ? r : (r as { items: CaseRec[] }).items)), [session]);
  const [caseId, setCaseId] = useState('');
  const [budget, reloadBudget, budgetErr] = useAsync(() => (caseId ? m13.caseBudget(session, caseId) : Promise.resolve(null)), [caseId]);

  return (
    <div>
      <Hint>{t('m13.bud.note')}</Hint>
      <div className="enter-row">
        <select aria-label="Case" value={caseId} onChange={(e) => setCaseId(e.target.value)}>
          <option value="">{t('m13.bud.pickCase')}</option>
          {(cases ?? []).map((c) => <option key={c.id} value={c.id}>{c.playerName} ({sentenceCase(c.stage)})</option>)}
        </select>
        {caseId && <button onClick={async () => {
          try {
            await m13.createScenario(session, caseId, {
              label: 'New scenario', currency: 'GBP', termMonths: 12,
              lines: [{ kind: 'wage', label: 'Weekly wage', amountMinor: 80000, currency: 'GBP', schedule: 'weekly', confirmed: false, conditional: null }],
            });
            reloadBudget(); notify('Scenario created with a starter wage line — edit the figures.');
          } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
        }}>{t('m13.bud.new')}</button>}
      </div>
      {budgetErr && <div className="notice block"><Icon name="lock-keyhole" size={13} /> {budgetErr}</div>}
      {(budget?.scenarios ?? []).map((scn: Scenario) => (
        <div key={scn.id} className="section">
          <h3>{scn.label} <span className="pill">v{scn.version}</span> <span className="dim" style={{ fontWeight: 400 }}>{scn.termMonths} months · {scn.currency}</span></h3>
          {scn.lines.map((l) => (
            <div key={l.id ?? l.label} className="list-row">
              <span className="grow">{l.label} <span className="pill">{l.kind}</span> <span className="dim">{l.schedule.replace('_', ' ')}</span>{l.conditional && <span className="pill" style={{ marginLeft: 4 }}>Conditional: {l.conditional.assumption}</span>}</span>
              <b>{money(l.amountMinor, l.currency)}</b>
              <span className={`pill ${l.confirmed ? 'green' : ''}`}>{l.confirmed ? t('m13.bud.confirmed') : t('m13.bud.estimated')}</span>
            </div>
          ))}
          {scn.totals && (
            <div className="notice block">
              {Object.entries(scn.totals.perCurrency).map(([cur, tt]) => (
                <div key={cur}><b>{cur}</b><RecordFacts items={[{label: t('m13.bud.confirmed'), value: money(tt.confirmedMinor, cur)}, {label: t('m13.bud.estimated'), value: money(tt.estimatedMinor, cur)}, ...(tt.conditionalCount > 0 ? [{label: 'Conditional excluded', value: tt.conditionalCount}] : [])]} /></div>
              ))}
              {scn.totals.combined && 'unavailable' in (scn.totals.combined) && scn.totals.combined.unavailable && <div className="dim">{scn.totals.combined.reason}</div>}
              <div className="dim" style={{ fontSize: 12 }}>{scn.totals.conditionalNote}</div>
            </div>
          )}
          <div>
            {scn.approval
              ? <span className={`pill ${scn.approval.superseded ? 'red' : 'green'}`}>{scn.approval.superseded ? t('m13.bud.superseded') : `${t('m13.bud.approvedBy')} ${scn.approval.by} (v${scn.approval.version})`}</span>
              : <button onClick={async () => { try { await m13.approveScenario(session, caseId, scn.id); reloadBudget(); notify('Approved — attributable to you, for this version only.'); } catch (e) { notify(e instanceof Error ? e.message : 'lead required', true); } }}>{t('m13.bud.approve')}</button>}
            {scn.actuals.length > 0 && <span className="dim" style={{ marginLeft: 8 }}>{scn.actuals.length} actual(s) recorded</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================================================== F10 Representation
export function RepresentationScreen({ session, notify }: ScreenProps) {
  const [data, reload, err] = useAsync(() => m13.listRepresentations(session), [session]);
  const [playerId, setPlayerId] = useState('');
  if (session.org.type !== 'agency') {
    return <div><div className="notice block">{t('m13.rep.agencyOnly')}</div></div>;
  }
  return (
    <div>
      <div className="notice" style={{ fontSize: 12.5 }}>{data?.note ?? err}</div>
      {(data?.items ?? []).map((r) => (
        <div key={r.id} className="section">
          <b>{r.playerName}</b> <span className={`pill ${r.status === 'active' ? 'green' : r.status === 'withdrawn' || r.status === 'disputed' ? 'red' : 'blue'}`}>{sentenceCase(r.status)}</span>
          <div className="dim" style={{ fontSize: 12.5 }}><RecordFacts items={[{label: 'Representative', value: r.representativeName}, {label: 'Scope', value: sentenceCase(r.scope)}, {label: 'Ends', value: r.endAt ? fmtDate(r.endAt) : 'Open-ended'}]} /></div>
          {r.credential && <div className="notice" style={{ fontSize: 12 }}>{r.credential.note} — <b>{r.credential.reviewStatus.replace(/_/g, ' ')}</b>. {r.credential.honest}</div>}
          <div className="dim" style={{ fontSize: 11.5 }}>{r.history.map((h) => `${h.action} (${h.byName})`).join(' → ')}</div>
        </div>
      ))}
      <div className="enter-row">
        <input aria-label="Adult player id" placeholder={t('m13.rep.playerId')} value={playerId} onChange={(e) => setPlayerId(e.target.value)} />
        <button onClick={async () => {
          try { await m13.proposeRepresentation(session, { playerId, representativeName: session.scoutName, scope: 'full', endMonths: 12 }); reload(); notify('Proposed — nothing is active until the PLAYER confirms.'); }
          catch (e) { notify(e instanceof Error ? e.message : 'Adults only — the wall is DOB-evaluated live.', true); }
        }}>{t('m13.rep.propose')}</button>
      </div>
      <div className="notice block" style={{ fontSize: 12.5 }}>{t('m13.rep.wallNote')}</div>
    </div>
  );
}

// ==================================================== F12+F11 Organisation
/** M24F.5 — a settings section as one row: its name and a short state; the controls are one tap deeper. */
function SettingsRow({ id, title, value, children }: { id: string; title: string; value?: string; children: ReactNode }) {
  return (
    <details className="settings-row" data-testid={`org-row-${id}`}>
      <summary><span className="settings-row-title">{title}</span>{value ? <span className="settings-row-value">{value}</span> : null}</summary>
      <div className="settings-row-body">{children}</div>
    </details>
  );
}

export function OrganisationScreen({ session, notify }: ScreenProps) {
  const [ob] = useAsync(() => m13.onboarding(session), [session]);
  const [invites, reloadInv] = useAsync(() => m13.listInvites(session), [session]);
  const [sessions, reloadSess] = useAsync(() => m13.listSessions(session), [session]);
  const [sso] = useAsync(() => m13.getSso(session), [session]);
  const [tickets, reloadTickets] = useAsync(() => m13.listSupport(session), [session]);
  const [notifs, reloadNotifs] = useAsync(() => m13.orgNotifications(session), [session]);
  const [mfa, setMfa] = useState<{ secret: string; otpauth: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');

  const awaitingAck = (notifs ?? []).filter((nn) => nn.actionRequired && !nn.actionRequired.ackedAt);

  return (
    <div className="settings-list">
      {ob && <CountChart title="Workspace setup" note="Completed setup tasks. This tracks configuration, not a security score." unit="tasks" distribution items={[{label:'Complete',value:ob.tasks.filter(t => t.done).length},{label:'To complete',value:ob.tasks.filter(t => !t.done).length}]} />}
      {awaitingAck.length > 0 && (
        <div className="section" style={{ borderColor: 'var(--red, #c33)' }}>
          <h3><Icon name="triangle-alert" size={14} /> {t('m13.org.needsAck')}</h3>
          {awaitingAck.map((nn) => (
            <div key={nn.id} className="list-row">
              <span className="grow">{nn.text}{nn.actionRequired?.deadline && <div className="dim" style={{ fontSize: 12 }}>{t('m13.org.ackBy')} {fmtDateTime(nn.actionRequired.deadline)}</div>}</span>
              <button onClick={async () => { await m13.ackNotification(session, nn.id); reloadNotifs(); notify('Acknowledged.'); }}>{t('m13.org.ack')}</button>
            </div>
          ))}
        </div>
      )}
      <SettingsRow id="notifications" title={t('m13.org.notifications')}>
        <NotificationPreferencesPanel session={session} notify={notify} />
      </SettingsRow>
      <SettingsRow id="activity" title={t('m13.org.activity')}>
        <AuditLogPanel session={session} />
      </SettingsRow>
      <SettingsRow id="onboarding" title={t('m13.org.onboarding')} value={ob ? `${(ob.tasks ?? []).filter((x) => x.done).length} of ${(ob.tasks ?? []).length} done` : undefined}>
        <div className="dim" style={{ fontSize: 12.5 }}>{ob?.roleHelp}</div>
        {(ob?.tasks ?? []).map((task) => (
          <div key={task.id} className="list-row">
            <span className="grow"><Icon name={task.done ? 'circle-check' : 'clock'} size={13} label={task.done ? 'done' : 'to do'} /> {task.label}<div className="dim" style={{ fontSize: 12 }}>{task.help}</div></span>
          </div>
        ))}
      </SettingsRow>
      <SettingsRow id="staff" title={t('m13.org.staff')} value={invites ? String(invites.length) : undefined}>
        {(invites ?? []).map((iv) => <div key={iv.id} className="list-row"><span className="grow">{iv.name} <span className="dim">{iv.email} · {iv.role}</span></span><span className={`pill ${iv.status === 'accepted' ? 'green' : ''}`}>{sentenceCase(iv.status)}</span></div>)}
        <div className="enter-row">
          <input aria-label="Email" placeholder="email@club.example" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <input aria-label="Name" placeholder={t('m13.org.name')} value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
          <button onClick={async () => {
            try { await m13.createInvite(session, inviteEmail, inviteName, 'Scout'); setInviteEmail(''); setInviteName(''); reloadInv(); notify('Invite sent (dev outbox in this environment).'); }
            catch (e) { notify(e instanceof Error ? e.message : 'lead required', true); }
          }}>{t('m13.org.invite')}</button>
        </div>
      </SettingsRow>
      <SettingsRow id="mfa" title={t('m13.org.mfa')}>
        {recovery ? (
          <div className="notice block">{t('m13.org.recoveryNote')}<br />{recovery.map((c) => <code key={c} style={{ marginRight: 8 }}>{c}</code>)}</div>
        ) : mfa ? (
          <div>
            <div className="notice block">{t('m13.org.scanNote')}<br /><code>{mfa.secret}</code></div>
            <div className="enter-row">
              <input aria-label="MFA code" placeholder="123456" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} maxLength={6} />
              <button onClick={async () => {
                try { const r = await m13.mfaVerify(session, mfaCode); setRecovery(r.recoveryCodes); notify('MFA enabled.'); }
                catch { notify('That code is not valid.', true); }
              }}>{t('m13.org.verify')}</button>
            </div>
          </div>
        ) : (
          <button onClick={async () => {
            try { setMfa(await m13.mfaSetup(session)); }
            catch (e) { notify(e instanceof Error ? e.message : 'already enabled', true); }
          }}>{t('m13.org.enableMfa')}</button>
        )}
      </SettingsRow>
      <SettingsRow id="sessions" title={t('m13.org.sessions')} value={sessions ? String(sessions.length) : undefined}>
        {(sessions ?? []).map((sr) => (
          <div key={sr.sid} className="list-row">
            <span className="grow"><code>{sr.sid}</code> <span className="dim">Since {fmtDateTime(sr.createdAt)} · via {sr.via}</span> {sr.current && <span className="pill green">This device</span>}</span>
            {!sr.current && <button onClick={async () => { await m13.revokeSession(session, sr.sid); reloadSess(); notify('Session revoked.'); }}>{t('m13.org.revoke')}</button>}
          </div>
        ))}
      </SettingsRow>
      <SettingsRow id="sso" title={t('m13.org.sso')} value={sso?.config ? 'Configured' : undefined}>
        <Hint className="notice" style={{ fontSize: 12.5 }}>{sso?.config ? `Configured: ${sso.config.issuer} (client ${sso.config.clientId})` : sso?.note}</Hint>
        {!sso?.config && sso?.available.includes('local-test-idp') && (
          <button onClick={async () => { try { await m13.setSso(session, 'local-test-idp'); notify('Local TEST IdP configured — this is not a corporate provider.'); } catch (e) { notify(e instanceof Error ? e.message : 'lead required', true); } }}>{t('m13.org.enableTestSso')}</button>
        )}
      </SettingsRow>
      <SettingsRow id="support" title={t('m13.org.support')} value={tickets ? String(tickets.length) : undefined}>
        {(tickets ?? []).map((tk) => (
          <div key={tk.id} className="list-row">
            <span className="grow"><b>{tk.subject}</b> <span className="dim">{tk.refs.map((r) => `${r.kind}:${r.id}`).join(', ')}</span>
              {tk.replies.map((rp, i) => <div key={i} className="dim" style={{ fontSize: 12 }}>↳ {rp.by}: {rp.text}</div>)}
            </span>
            <span className={`pill ${tk.status === 'open' ? 'blue' : ''}`}>{sentenceCase(tk.status)}</span>
            <button onClick={async () => {
              try { await m13.approveSupportAccess(session, tk.id); notify('Time-limited support access approved — every read is logged.'); }
              catch { notify('No pending access request on this ticket.', true); }
            }}>{t('m13.org.approveAccess')}</button>
          </div>
        ))}
        <button onClick={async () => { await m13.createSupport(session, 'Question from the workspace', 'Raised from the Organisation screen.', []); reloadTickets(); notify('Ticket created — records referenced by id only.'); }}>{t('m13.org.newTicket')}</button>
      </SettingsRow>
      <SettingsRow id="delivery" title={t('m13.org.delivery')}>
        <Hint className="notice" style={{ fontSize: 12.5 }}>{t('m13.org.deliveryNote')}</Hint>
        <button onClick={async () => { await m13.setDeliveryPrefs(session, { quietStart: '21:00', quietEnd: '07:30', email: true }); notify('Quiet hours 21:00–07:30 saved.'); }}>{t('m13.org.quietHours')}</button>
      </SettingsRow>
    </div>
  );
}
