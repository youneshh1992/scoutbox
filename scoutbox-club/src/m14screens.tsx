// M14 org screens: the Verification workspace — your own verification, the
// organisation console (requests, staff, domains, administrators), licences,
// references, squad invitations and conflict declarations.
//
// Copy rules (§65): a badge always names the verified FACT ("Role verified:
// Academy Scout"), never a bare "Verified", and never implies endorsement.
// Badge state never relies on colour alone: every pill carries text.
import { useEffect, useState } from 'react';
import type { Session } from './api';
import {
  m14, type MyVerification, type PublicVerProfile, type SubjectClaim, type VerBadge, type ClubConsentRequest,
  type ClubTransaction, type ClubTxTimelineEntry } from './m14api';
import { fmtDate, t } from './i18n';

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

// ------------------------------------------------ central badge component
// The ONE badge renderer for this app (§21/§44). Text-first, keyboard
// accessible; the <details> body explains provenance in plain English.
export function VerificationBadge({ badge }: { badge: VerBadge }) {
  const glyph = badge.historical ? '◷' : '✓';
  return (
    <details className="ver-badge" style={{ display: 'inline-block', margin: '2px 6px 2px 0' }}>
      <summary
        className={`pill ${badge.historical ? '' : 'green'}`}
        style={{ cursor: 'pointer', listStyle: 'none' }}
        aria-label={`${badge.label}. ${badge.provenance}`}
      >
        {glyph} {badge.label}
      </summary>
      <div className="notice" style={{ fontSize: 12, maxWidth: 380 }}>
        {badge.provenance}
        {badge.period?.from ? ` · ${badge.period.from}–${badge.period.to ?? t('m14.badge.present')}` : ''}
        {badge.verifiedAt ? ` · ${t('m14.badge.verifiedOn')} ${fmtDate(badge.verifiedAt)}` : ''}
        <div className="dim">{t('m14.badge.meaningNote')}</div>
      </div>
    </details>
  );
}

export function PublicBadges({ profile }: { profile: PublicVerProfile }) {
  return (
    <span>
      {profile.identityVerified && (
        <span className="pill green" aria-label={t('m14.badge.identity')} style={{ marginRight: 6 }}>✓ {t('m14.badge.identity')}</span>
      )}
      {profile.badges.map((b, i) => <VerificationBadge key={i} badge={b} />)}
      {!profile.identityVerified && profile.badges.length === 0 && <span className="dim">{t('m14.badge.none')}</span>}
    </span>
  );
}

const statusPill = (status: string) => {
  const green = ['verified'];
  const red = ['rejected', 'revoked', 'suspended', 'disputed'];
  return <span className={`pill ${green.includes(status) ? 'green' : red.includes(status) ? 'red' : 'blue'}`}>{t(`m14.status.${status}`, status.replace(/_/g, ' '))}</span>;
};

function ClaimRow({ claim, session, notify, onChange }: { claim: SubjectClaim; session: Session; notify: ScreenProps['notify']; onChange: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="list-row" style={{ flexWrap: 'wrap' }}>
      <span className="grow">
        <b>{t(`m14.claim.${claim.claimType}`, claim.claimType.replace(/_/g, ' ').toLowerCase())}</b>
        {claim.role ? ` — ${claim.role}` : ''} {statusPill(claim.status)}
        {claim.organisation && <span className="dim"> · {claim.organisation.name}</span>}
        {claim.current === false && claim.validUntil && <span className="dim"> · {new Date(claim.validFrom ?? 0).getFullYear()}–{new Date(claim.validUntil).getFullYear()}</span>}
        {claim.provenance && <div className="dim" style={{ fontSize: 12 }}>{claim.provenance}</div>}
        {claim.humanReviewNote && <div className="notice" style={{ fontSize: 12 }}>{claim.humanReviewNote}</div>}
        {claim.revocationReason && <div className="dim" style={{ fontSize: 12 }}>{t('m14.claim.revokedBecause')}: {claim.revocationReason}</div>}
        {claim.evidence.length > 0 && (
          <div className="dim" style={{ fontSize: 12 }}>
            {t('m14.claim.evidence')}: {claim.evidence.map((e) => `${e.filename ?? e.type}${e.checks?.malwareScan === 'not_configured' ? ` (${t('m14.claim.noScan')})` : ''}`).join(', ')}
          </div>
        )}
      </span>
      {['verified', 'suspended', 'revoked', 'expired'].includes(claim.status) && !claim.disputedAt && (
        <span>
          <input aria-label={t('m14.claim.disputeReason')} placeholder={t('m14.claim.disputeReason')} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 170 }} />
          <button onClick={async () => {
            try { const r = await m14.disputeClaim(session, claim.id, reason); notify(`⚖️ ${r.note}`); setReason(''); onChange(); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m14.claim.dispute')}</button>
        </span>
      )}
    </div>
  );
}

// =============================================================== screen
export function VerificationScreen({ session, notify, tick }: ScreenProps) {
  const [tab, setTab] = useState<'me' | 'requests' | 'staff' | 'domains' | 'admins' | 'consents' | 'transactions' | 'more'>('me');
  const [me, reloadMe] = useAsync<MyVerification>(() => m14.me(session), [session, tick]);
  const TABS: [typeof tab, string][] = [
    ['me', t('m14.tab.me')], ['requests', t('m14.tab.requests')], ['staff', t('m14.tab.staff')],
    ['domains', t('m14.tab.domains')], ['admins', t('m14.tab.admins')], ['consents', t('m25.tab.consents')],
    ['transactions', t('m26.tab.transactions')], ['more', t('m14.tab.more')],
  ];
  return (
    <div>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('m14.intro')}</div>
      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'primary' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'me' && <MeTab session={session} notify={notify} me={me} reloadMe={reloadMe} />}
      {tab === 'requests' && <RequestsTab session={session} notify={notify} />}
      {tab === 'staff' && <StaffTab session={session} notify={notify} />}
      {tab === 'domains' && <DomainsTab session={session} notify={notify} />}
      {tab === 'admins' && <AdminsTab session={session} notify={notify} />}
      {tab === 'consents' && <AgentConsentsTab session={session} notify={notify} tick={tick} />}
      {tab === 'transactions' && <AgentTransactionsTab session={session} notify={notify} tick={tick} />}
      {tab === 'more' && <MoreTab session={session} notify={notify} />}
    </div>
  );
}

function MeTab({ session, notify, me, reloadMe }: { session: Session; notify: ScreenProps['notify']; me: MyVerification | null; reloadMe: () => void }) {
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [lic, setLic] = useState({ licenceType: '', issuer: '', identifier: '' });
  const [providers] = useAsync(() => m14.licenceProviders(session), [session]);
  const act = async (fn: () => Promise<{ note?: string } | unknown>, done: string) => {
    try { const r: any = await fn(); notify(`${done}${r?.note ? ` — ${r.note}` : ''}`); reloadMe(); }
    catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
  };
  return (
    <div>
      <div className="section">
        <h3>{t('m14.me.steps')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(me?.steps ?? []).map((s) => (
            <span key={s.id} className={`pill ${s.done ? 'green' : ''}`}>{s.done ? '✓' : '○'} {s.label}</span>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>
          {t('m14.me.orgStatus')}: <b>{me?.organisationStatus}</b>
          {me?.verificationLevel && <> · {t('m14.me.yourAuthority')}: <b>{me.verificationLevel.replace(/_/g, ' ')}</b></>}
        </div>
      </div>

      <div className="section">
        <h3>{t('m14.me.publicPreview')}</h3>
        {me && <PublicBadges profile={me.publicPreview} />}
        <div className="dim" style={{ fontSize: 12 }}>{t('m14.me.publicNote')}</div>
      </div>

      <div className="section">
        <h3>{t('m14.me.claims')}</h3>
        {(me?.claims ?? []).map((c) => <ClaimRow key={c.id} claim={c} session={session} notify={notify} onChange={reloadMe} />)}
        {!me?.claims.length && <div className="dim">{t('m14.me.noClaims')}</div>}
      </div>

      <div className="section">
        <h3>{t('m14.me.start')}</h3>
        <div className="list-row">
          <span className="grow">{t('m14.me.startIdentity')}</span>
          <button onClick={() => act(() => m14.startIdentity(session), '🪪 ' + t('m14.me.identityStarted'))}>{t('m14.me.startBtn')}</button>
        </div>
        <div className="list-row">
          <input aria-label={t('m14.me.role')} placeholder={t('m14.me.role')} value={role} onChange={(e) => setRole(e.target.value)} />
          <button onClick={() => act(() => m14.requestAffiliation(session, role), '📨 ' + t('m14.me.affiliationRequested'))}>{t('m14.me.requestAffiliation')}</button>
        </div>
        <div className="list-row">
          <input aria-label={t('m14.me.workEmail')} placeholder={t('m14.me.workEmail')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <button onClick={() => act(() => m14.sendWorkEmail(session, email), '✉️ ' + t('m14.me.codeSent'))}>{t('m14.me.sendCode')}</button>
          <input aria-label={t('m14.me.code')} placeholder={t('m14.me.code')} value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 130 }} />
          <button onClick={() => act(() => m14.confirmWorkEmail(session, code), '✅ ' + t('m14.me.emailProved'))}>{t('m14.me.confirmCode')}</button>
        </div>
        <div className="dim" style={{ fontSize: 12 }}>{t('m14.me.emailNote')}</div>
      </div>

      <div className="section">
        <h3>{t('m14.lic.title')}</h3>
        <div className="notice" style={{ fontSize: 12.5 }}>{t('m14.lic.honesty')}</div>
        <div className="list-row" style={{ flexWrap: 'wrap' }}>
          <input aria-label={t('m14.lic.type')} placeholder={t('m14.lic.type')} value={lic.licenceType} onChange={(e) => setLic({ ...lic, licenceType: e.target.value })} />
          <input aria-label={t('m14.lic.issuer')} placeholder={t('m14.lic.issuer')} value={lic.issuer} onChange={(e) => setLic({ ...lic, issuer: e.target.value })} />
          <input aria-label={t('m14.lic.identifier')} placeholder={t('m14.lic.identifier')} value={lic.identifier} onChange={(e) => setLic({ ...lic, identifier: e.target.value })} />
          <button onClick={() => act(() => m14.submitLicence(session, lic), '📄 ' + t('m14.lic.submitted'))}>{t('m14.lic.submit')}</button>
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          {t('m14.lic.providers')}: {(providers?.providers ?? []).map((p) => `${p.name} — ${t(`m14.provider.${p.state}`, p.state.replace(/_/g, ' '))}`).join(' · ')}
        </div>
      </div>
    </div>
  );
}

function RequestsTab({ session, notify }: { session: Session; notify: ScreenProps['notify'] }) {
  const [data, reload] = useAsync(() => m14.listRequests(session), [session]);
  const [roleEdit, setRoleEdit] = useState<Record<string, string>>({});
  const decide = async (claimId: string, action: string, opts?: Record<string, unknown>) => {
    try { await m14.decideRequest(session, claimId, action, opts as never); notify(`✅ ${t('m14.req.decided')}: ${action}`); reload(); }
    catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
  };
  const rows = data?.items ?? [];
  const pairs = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.pairId ?? r.claimId;
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
  }
  return (
    <div className="section">
      <h3>{t('m14.req.title')} {rows.length ? <span className="pill blue">{pairs.size}</span> : <span className="pill green">0</span>}</h3>
      <div className="dim" style={{ fontSize: 12.5 }}>{data?.note}</div>
      {[...pairs.values()].map((group) => {
        const roleRow = group.find((g) => g.claimedRole) ?? group[0];
        return (
          <div key={roleRow.claimId} className="list-row" style={{ flexWrap: 'wrap' }}>
            <span className="grow">
              <b>{roleRow.person.name}</b> — {roleRow.claimedRole ?? t('m14.req.affiliationOnly')}
              <div className="dim" style={{ fontSize: 12 }}>
                {t('m14.req.identity')}: {roleRow.identityStatus} · {t('m14.req.email')}: {t(`m14.email.${roleRow.emailStatus}`, roleRow.emailStatus.replace(/_/g, ' '))} · {fmtDate(roleRow.requestedAt)}
                {roleRow.riskFlags.length > 0 && <span> · ⚠ {roleRow.riskFlags.join(', ')} <i>({t('m14.req.flagsNote')})</i></span>}
              </div>
              {roleRow.priorClaims.length > 0 && <div className="dim" style={{ fontSize: 12 }}>{t('m14.req.prior')}: {roleRow.priorClaims.map((p) => `${p.role ?? p.claimType}${p.current ? '' : ` (${t('m14.staff.former')})`}`).join(', ')}</div>}
            </span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button className="primary" onClick={() => decide(roleRow.claimId, 'confirm')}>{t('m14.req.confirm')}</button>
              <input aria-label={t('m14.req.correctedRole')} placeholder={t('m14.req.correctedRole')} value={roleEdit[roleRow.claimId] ?? ''} onChange={(e) => setRoleEdit({ ...roleEdit, [roleRow.claimId]: e.target.value })} style={{ width: 130 }} />
              <button onClick={() => decide(roleRow.claimId, 'correct_role', { role: roleEdit[roleRow.claimId] })}>{t('m14.req.correct')}</button>
              <button onClick={() => decide(roleRow.claimId, 'mark_former')}>{t('m14.req.markFormer')}</button>
              <button onClick={() => decide(roleRow.claimId, 'request_info', { reason: t('m14.req.moreInfoDefault') })}>{t('m14.req.moreInfo')}</button>
              <button onClick={() => decide(roleRow.claimId, 'reject', { reason: t('m14.req.rejectDefault') })}>{t('m14.req.reject')}</button>
            </span>
          </div>
        );
      })}
      {!rows.length && <div className="dim">{t('m14.req.empty')}</div>}
    </div>
  );
}

function StaffTab({ session, notify }: { session: Session; notify: ScreenProps['notify'] }) {
  const [filter, setFilter] = useState('');
  const [data, reload] = useAsync(() => m14.listStaff(session), [session]);
  const rows = (data?.items ?? []).filter((r) => !filter || (r.role ?? '').toLowerCase().includes(filter.toLowerCase()) || r.person.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="section">
      <h3>{t('m14.staff.title')}</h3>
      <input aria-label={t('m14.staff.filter')} placeholder={t('m14.staff.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {rows.map((r) => (
        <div key={r.claimId} className="list-row">
          <span className="grow">
            <b>{r.person.name}</b>{r.role ? ` — ${r.role}` : ''} {statusPill(r.status)}
            {r.effective.historical && <span className="pill" aria-label={t('m14.staff.historicalNote')}>◷ {t('m14.staff.former')} {r.validFrom ? `${new Date(r.validFrom).getFullYear()}–${r.validUntil ? new Date(r.validUntil).getFullYear() : ''}` : ''}</span>}
            <span className="dim" style={{ fontSize: 12 }}> · {r.verificationMethod?.replace(/_/g, ' ') ?? t('m14.staff.noMethod')}</span>
          </span>
          {r.current && r.status === 'verified' && (
            <button onClick={async () => {
              try { const out = await m14.markDeparted(session, r.person.id); notify(`👋 ${out.note}`); reload(); }
              catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
            }}>{t('m14.staff.markDeparted')}</button>
          )}
        </div>
      ))}
      {!rows.length && <div className="dim">{t('m14.staff.empty')}</div>}
    </div>
  );
}

function DomainsTab({ session, notify }: { session: Session; notify: ScreenProps['notify'] }) {
  const [data, reload] = useAsync(() => m14.listDomains(session), [session]);
  const [domain, setDomain] = useState('');
  const [challengeEmail, setChallengeEmail] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});
  return (
    <div className="section">
      <h3>{t('m14.dom.title')}</h3>
      <div className="dim" style={{ fontSize: 12.5 }}>{t('m14.dom.note')}</div>
      {(data?.domains ?? []).map((d) => (
        <div key={d.domain} className="list-row">
          <span className="grow"><b>{d.domain}</b> <span className="pill green">✓ {t('m14.dom.verified')}</span> <span className="dim" style={{ fontSize: 12 }}>{d.method.replace(/_/g, ' ')} · {fmtDate(d.verifiedAt)}</span></span>
        </div>
      ))}
      {(data?.requests ?? []).filter((r) => r.status !== 'verified').map((r) => (
        <div key={r.id} className="list-row">
          <span className="grow"><b>{r.domain}</b> {statusPill(r.status)}</span>
          {r.status === 'email_challenge' && (
            <span>
              <input aria-label={t('m14.me.code')} placeholder={t('m14.me.code')} value={codes[r.id] ?? ''} onChange={(e) => setCodes({ ...codes, [r.id]: e.target.value })} style={{ width: 130 }} />
              <button onClick={async () => {
                try { await m14.confirmDomain(session, r.id, codes[r.id] ?? ''); notify('✅ ' + t('m14.dom.confirmed')); reload(); }
                catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
              }}>{t('m14.me.confirmCode')}</button>
            </span>
          )}
        </div>
      ))}
      <div className="list-row" style={{ flexWrap: 'wrap' }}>
        <input aria-label={t('m14.dom.domain')} placeholder="club-domain.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <input aria-label={t('m14.dom.challengeEmail')} placeholder={t('m14.dom.challengeEmail')} value={challengeEmail} onChange={(e) => setChallengeEmail(e.target.value)} />
        <button onClick={async () => {
          try { const r = await m14.addDomain(session, domain, challengeEmail); notify(`🌐 ${r.note}`); setDomain(''); reload(); }
          catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
        }}>{t('m14.dom.add')}</button>
      </div>
    </div>
  );
}

function AdminsTab({ session, notify }: { session: Session; notify: ScreenProps['notify'] }) {
  const [data, reload] = useAsync(() => m14.listAdmins(session), [session]);
  const [userId, setUserId] = useState('');
  const [level, setLevel] = useState('verification_reviewer');
  return (
    <div className="section">
      <h3>{t('m14.adm.title')}</h3>
      <div className="dim" style={{ fontSize: 12.5 }}>{t('m14.adm.note')}</div>
      {(data?.items ?? []).filter((a) => a.status === 'active').map((a) => (
        <div key={a.id} className="list-row">
          <span className="grow"><b>{a.person.name}</b> <span className="pill blue">{a.level.replace(/_/g, ' ')}</span></span>
          <button onClick={async () => {
            try { const r = await m14.revokeAdmin(session, a.id, 'revoked from console'); notify(`🛑 ${r.note}`); reload(); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m14.adm.revoke')}</button>
        </div>
      ))}
      {(data?.transfers ?? []).filter((tr) => tr.status === 'pending').map((tr) => (
        <div key={tr.id} className="list-row">
          <span className="grow">⏳ {t('m14.adm.pendingTransfer')} → {tr.toUserId}</span>
          <button onClick={async () => {
            try { await m14.approveTransfer(session, tr.id); notify('✅ ' + t('m14.adm.transferApproved')); reload(); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m14.adm.approveTransfer')}</button>
        </div>
      ))}
      <div className="list-row" style={{ flexWrap: 'wrap' }}>
        <input aria-label={t('m14.adm.userId')} placeholder={t('m14.adm.userId')} value={userId} onChange={(e) => setUserId(e.target.value)} />
        <select aria-label={t('m14.adm.level')} value={level} onChange={(e) => setLevel(e.target.value)}>
          {['verification_viewer', 'verification_reviewer', 'verification_admin', 'verification_root_admin'].map((l) => <option key={l} value={l}>{l.replace(/_/g, ' ')}</option>)}
        </select>
        <button onClick={async () => {
          try { const r = await m14.grantAdmin(session, userId, level); notify(r.transfer ? `⏳ ${r.note ?? t('m14.adm.transferPending')}` : '✅ ' + t('m14.adm.granted')); setUserId(''); reload(); }
          catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
        }}>{t('m14.adm.grant')}</button>
      </div>
    </div>
  );
}

function MoreTab({ session, notify }: { session: Session; notify: ScreenProps['notify'] }) {
  const [refs, reloadRefs] = useAsync(() => m14.listReferences(session), [session]);
  const [invites, reloadInv] = useAsync(() => m14.listPlayerInvites(session), [session]);
  const [conflicts, reloadCoi] = useAsync(() => m14.listConflicts(session), [session]);
  const [inv, setInv] = useState({ name: '', squad: '' });
  const [coi, setCoi] = useState({ kind: 'family_relationship', subject: '', note: '' });
  const [ref, setRef] = useState({ playerId: '', relationship: '', summary: '' });
  return (
    <div>
      <div className="section">
        <h3>{t('m14.ref.title')}</h3>
        <div className="dim" style={{ fontSize: 12.5 }}>{t('m14.ref.note')}</div>
        {(refs?.items ?? []).map((r) => (
          <div key={r.id} className="list-row">
            <span className="grow"><b>{r.playerName ?? r.playerId}</b> — {r.structured.summary} <span className="dim" style={{ fontSize: 12 }}>v{r.version} · {r.status} · {r.coachName} ({r.roleAtTime})</span></span>
            {r.status === 'active' && <button onClick={async () => { try { await m14.withdrawReference(session, r.id, 'withdrawn from console'); notify('↩️ ' + t('m14.ref.withdrawn')); reloadRefs(); } catch (e) { notify(e instanceof Error ? e.message : 'failed', true); } }}>{t('m14.ref.withdraw')}</button>}
          </div>
        ))}
        <div className="list-row" style={{ flexWrap: 'wrap' }}>
          <input aria-label={t('m14.ref.playerId')} placeholder={t('m14.ref.playerId')} value={ref.playerId} onChange={(e) => setRef({ ...ref, playerId: e.target.value })} style={{ width: 110 }} />
          <input aria-label={t('m14.ref.relationship')} placeholder={t('m14.ref.relationship')} value={ref.relationship} onChange={(e) => setRef({ ...ref, relationship: e.target.value })} />
          <input aria-label={t('m14.ref.summary')} placeholder={t('m14.ref.summary')} value={ref.summary} onChange={(e) => setRef({ ...ref, summary: e.target.value })} />
          <button onClick={async () => {
            try { await m14.createReference(session, ref); notify('📝 ' + t('m14.ref.created')); setRef({ playerId: '', relationship: '', summary: '' }); reloadRefs(); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m14.ref.create')}</button>
        </div>
      </div>

      <div className="section">
        <h3>{t('m14.inv.title')}</h3>
        <div className="dim" style={{ fontSize: 12.5 }}>{t('m14.inv.note')}</div>
        {(invites?.items ?? []).map((i) => (
          <div key={i.id} className="list-row">
            <span className="grow"><b>{i.name}</b> {i.squad && <span className="dim">· {i.squad}</span>} {statusPill(i.status)} {i.guardianApproved && <span className="pill green">✓ {t('m14.inv.guardianApproved')}</span>}</span>
          </div>
        ))}
        <div className="list-row" style={{ flexWrap: 'wrap' }}>
          <input aria-label={t('m14.inv.name')} placeholder={t('m14.inv.name')} value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} />
          <input aria-label={t('m14.inv.squad')} placeholder={t('m14.inv.squad')} value={inv.squad} onChange={(e) => setInv({ ...inv, squad: e.target.value })} style={{ width: 90 }} />
          <button onClick={async () => {
            try { const r = await m14.createPlayerInvite(session, inv.name, inv.squad); notify(`🎟️ ${t('m14.inv.created')}${r.code ? ` — ${t('m14.inv.code')}: ${r.code}` : ''}`); setInv({ name: '', squad: '' }); reloadInv(); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m14.inv.send')}</button>
        </div>
      </div>

      <div className="section">
        <h3>{t('m14.coi.title')}</h3>
        <div className="dim" style={{ fontSize: 12.5 }}>{t('m14.coi.note')}</div>
        {(conflicts?.items ?? []).filter((c) => !c.withdrawnAt).map((c) => (
          <div key={c.id} className="list-row"><span className="grow"><b>{c.kind.replace(/_/g, ' ')}</b> — {c.subject} <span className="dim" style={{ fontSize: 12 }}>{c.note}</span></span></div>
        ))}
        <div className="list-row" style={{ flexWrap: 'wrap' }}>
          <select aria-label={t('m14.coi.kind')} value={coi.kind} onChange={(e) => setCoi({ ...coi, kind: e.target.value })}>
            {['family_relationship', 'agent_relationship', 'financial_interest', 'coaching_relationship', 'other'].map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
          </select>
          <input aria-label={t('m14.coi.subject')} placeholder={t('m14.coi.subject')} value={coi.subject} onChange={(e) => setCoi({ ...coi, subject: e.target.value })} />
          <input aria-label={t('m14.coi.noteField')} placeholder={t('m14.coi.noteField')} value={coi.note} onChange={(e) => setCoi({ ...coi, note: e.target.value })} />
          <button onClick={async () => {
            try { await m14.declareConflict(session, coi.kind, coi.subject, coi.note); notify('🤝 ' + t('m14.coi.declared')); setCoi({ kind: 'family_relationship', subject: '', note: '' }); reloadCoi(); }
            catch (e) { notify(e instanceof Error ? e.message : 'failed', true); }
          }}>{t('m14.coi.declare')}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================ M23 P5.6C
/**
 * The club's side of a multiple-representation consent. Placed here because the
 * authority is the same one this console already manages: only the club's
 * recorded verification administrator — its signatory — can bind the club. The
 * server decides that; `signatory` below is its answer, and a non-signatory
 * sees the ask read-only rather than a hidden button.
 *
 * No fee, no contract terms, no legal advice. ScoutBox records the answer.
 */
function AgentConsentsTab({ session, notify, tick }: { session: Session; notify: ScreenProps['notify']; tick: number }) {
  const [data, reload, err] = useAsync<{ items: ClubConsentRequest[]; signatory: boolean }>(() => m14.agentConsents(session), [session, tick]);
  const [ack, setAck] = useState<Record<string, { particulars: boolean; legalAdvice: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string, field: 'particulars' | 'legalAdvice') =>
    setAck((cur) => {
      const prev = cur[id] ?? { particulars: false, legalAdvice: false };
      return { ...cur, [id]: { ...prev, [field]: !prev[field] } };
    });
  const answer = async (k: ClubConsentRequest, action: 'grant' | 'decline' | 'revoke') => {
    setBusy(true); setError(null);
    const a = ack[k.id] ?? { particulars: false, legalAdvice: false };
    try {
      await m14.answerAgentConsent(session, k.id, action, {
        ...(action === 'grant' ? { acknowledgedParticulars: a.particulars, acknowledgedLegalAdvice: a.legalAdvice } : {}),
        expectedRev: k.rev, clientKey: `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      });
      notify(action === 'grant' ? t('m25.grantedMsg') : action === 'decline' ? t('m25.declinedMsg') : t('m25.revokedMsg'));
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('m25.failed'));
    } finally { setBusy(false); }
  };
  const items = data?.items ?? [];
  return (
    <div data-testid="club-agent-consents">
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('m25.intro')}</div>
      {data && !data.signatory && <div className="notice warn" data-testid="not-signatory">{t('m25.notSignatory')}</div>}
      {err && <div className="notice block" role="alert">{err}</div>}
      {error && <div className="notice block" role="alert">{error}</div>}
      {items.length === 0 && <div className="notice">{t('m25.none')}</div>}
      <div className="list-rows">
        {items.map((k) => {
          const a = ack[k.id] ?? { particulars: false, legalAdvice: false };
          const cls = k.status === 'granted' ? 'green' : k.status === 'requested' ? 'blue' : 'red';
          return (
            <div key={k.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} data-testid={`club-consent-${k.id}`} data-status={k.status}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="grow"><b>{k.agent.displayName ?? '—'}</b> <span className="dim">· {k.agent.agency ?? '—'} · {t('m25.licence')}: {k.agent.licence.replace(/_/g, ' ').toLowerCase()}</span></span>
                <span className={`pill ${cls}`}>{t(`m25.status.${k.status}`)}</span>
              </div>
              <div className="dim" style={{ fontSize: 12.5 }}>
                {t('m25.transaction')}: {t(`m25.type.${k.context?.type ?? 'other_services'}`)}{k.context?.jurisdictions?.length ? ` (${k.context.jurisdictions.join(', ')})` : ''} · {t('m25.alsoActingFor')}: {k.otherPartyRoles.map((r) => t(`m25.role.${r}`)).join(', ')}
              </div>
              <div className="dim" style={{ fontSize: 12.5 }}>{t('m25.whatItMeans')}</div>
              {k.status === 'requested' && data?.signatory && (
                <>
                  <div className="dim" style={{ fontSize: 12.5 }}>{t('m25.beforeYouAnswer')}</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={a.particulars} onChange={() => toggle(k.id, 'particulars')} /> {t('m25.ackParticulars')}</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><input type="checkbox" checked={a.legalAdvice} onChange={() => toggle(k.id, 'legalAdvice')} /> {t('m25.ackLegalAdvice')}</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="primary" disabled={busy || !a.particulars || !a.legalAdvice} onClick={() => answer(k, 'grant')} data-testid={`grant-${k.id}`}>{t('m25.grant')}</button>
                    <button disabled={busy} onClick={() => answer(k, 'decline')} data-testid={`decline-${k.id}`}>{t('m25.decline')}</button>
                  </div>
                  {(!a.particulars || !a.legalAdvice) && <div className="dim" style={{ fontSize: 12 }}>{t('m25.needAck')}</div>}
                </>
              )}
              {k.status === 'granted' && data?.signatory && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button disabled={busy} onClick={() => answer(k, 'revoke')} data-testid={`revoke-${k.id}`}>{t('m25.revoke')}</button>
                  <span className="dim" style={{ fontSize: 12 }}>{t('m25.revokeNote')}</span>
                </div>
              )}
              <div className="dim" style={{ fontSize: 12 }}>{k.honest}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * M23 P5.6D — the club's side of an Agent Transaction (§44/§45).
 *
 * A club sees the transactions it is ACTUALLY a party to, and only what its own
 * side is entitled to. The engaging club and the releasing club are separate
 * party roles: neither sees the other's private documents or notes, and neither
 * sees the agent's private working notes. Nothing here exposes the club's
 * internal recruitment work to the agent either — that lane is one-way private.
 *
 * The club can do exactly two things: confirm its OWN participation (signatory
 * only, §64) and record a note scoped to its own side. Compliance is the
 * server's answer, shown as words rather than colour alone.
 *
 * No offer, no signing, no fee execution. ScoutBox records; the parties decide.
 */
function AgentTransactionsTab({ session, notify, tick }: { session: Session; notify: ScreenProps['notify']; tick: number }) {
  const [data, reload, err] = useAsync(() => m14.transactions(session), [session, tick]);
  const [open, setOpen] = useState<string | null>(null);
  const items = data?.items ?? [];
  return (
    <div data-testid="club-transactions">
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('m26.intro')}</div>
      {data && !data.signatory && <div className="notice warn" data-testid="tx-not-signatory">{data.note ?? t('m26.notSignatory')}</div>}
      {err && <div className="notice block" role="alert">{err}</div>}
      {data && items.length === 0 && <div className="notice" data-testid="tx-none">{t('m26.none')}</div>}
      <div className="list-rows">
        {items.map((tx) => (
          <ClubTransactionRow
            key={tx.id} tx={tx} session={session} notify={notify} reload={reload}
            signatory={data?.signatory ?? false}
            expanded={open === tx.id} onToggle={() => setOpen((c) => (c === tx.id ? null : tx.id))}
          />
        ))}
      </div>
      {data?.honest && <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>{data.honest}</div>}
    </div>
  );
}

/** Compliance state as a word plus its reason. Never colour alone (§84). */
function TxComplianceLine({ tx }: { tx: ClubTransaction }) {
  const c = tx.compliance;
  const word = c.blocked ? t('m26.compliance.blocked')
    : c.staleness && c.staleness !== 'current' ? t('m26.compliance.stale')
    : c.clear ? t('m26.compliance.clear')
    : c.pendingReason ? t(`m26.pending.${c.pendingReason}`, t('m26.compliance.pending'))
    : t('m26.compliance.pending');
  const cls = c.blocked ? 'red' : c.clear && c.staleness === 'current' ? 'green' : 'blue';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className={`pill ${cls}`}>{word}</span>
      {c.evaluatedAt && <span className="dim" style={{ fontSize: 12 }}>{t('m26.evaluatedAt')}: {fmtDate(c.evaluatedAt)}</span>}
    </div>
  );
}

function ClubTransactionRow({ tx, session, notify, reload, signatory, expanded, onToggle }: {
  tx: ClubTransaction; session: Session; notify: ScreenProps['notify']; reload: () => void;
  signatory: boolean; expanded: boolean; onToggle: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const side = tx.viewerPartyRole === 'releasing_entity' ? 'RELEASING' : 'ENGAGING';
  const noteOptions = [`${side}_CLUB_PRIVATE`, `${side}_AGENT_SHARED`, 'ALL_TRANSACTION_PARTIES'];
  const [noteVis, setNoteVis] = useState(noteOptions[0]);
  const individual = tx.parties.find((p) => p.partyRole === 'individual' && !p.removed);
  const mine = tx.parties.find((p) => !p.removed && p.subjectKind === 'club' && p.partyRole === tx.viewerPartyRole);
  const [timeline, setTimeline] = useState<ClubTxTimelineEntry[] | null>(null);
  const key = () => `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      await m14.confirmTransaction(session, tx.id, { expectedRev: tx.rev });
      notify(t('m26.confirmedMsg')); reload();
    } catch (e) { setError(e instanceof Error ? e.message : t('m26.failed')); } finally { setBusy(false); }
  };
  const addNote = async () => {
    setBusy(true); setError(null);
    try {
      await m14.transactionNote(session, tx.id, { text: noteText, visibility: noteVis, expectedRev: tx.rev });
      setNoteText(''); notify(t('m26.noteAdded')); reload();
    } catch (e) { setError(e instanceof Error ? e.message : t('m26.failed')); } finally { setBusy(false); }
  };
  const loadTimeline = async () => {
    setError(null);
    try { const r = await m14.transactionTimeline(session, tx.id); setTimeline(r.items); }
    catch (e) { setError(e instanceof Error ? e.message : t('m26.failed')); }
  };

  return (
    <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }} data-testid={`club-tx-${tx.id}`} data-status={tx.status}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="grow">
          <b>{individual?.name ?? t('m26.individualUnnamed')}</b>{' '}
          <span className="dim">· {t(`m25.type.${tx.type}`, tx.type)} · {t('m26.yourSide')}: {t(`m25.role.${tx.viewerPartyRole ?? 'engaging_entity'}`)}</span>
        </span>
        <span className="pill">{t(`m26.status.${tx.status}`, tx.status)}</span>
        <button onClick={onToggle} aria-expanded={expanded} data-testid={`tx-toggle-${tx.id}`}>{expanded ? t('m26.hide') : t('m26.show')}</button>
      </div>
      <TxComplianceLine tx={tx} />
      <div className="dim" style={{ fontSize: 12.5 }}>{t('m26.updated')}: {fmtDate(tx.updatedAt)}</div>
      {error && <div className="notice block" role="alert">{error}</div>}
      {mine && !mine.confirmedAt && (
        signatory
          ? <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="primary" disabled={busy} onClick={confirm} data-testid={`tx-confirm-${tx.id}`}>{t('m26.confirm')}</button>
              <span className="dim" style={{ fontSize: 12 }}>{t('m26.confirmNote')}</span>
            </div>
          : <div className="dim" style={{ fontSize: 12.5 }}>{t('m26.confirmNeedsSignatory')}</div>
      )}
      {mine?.confirmedAt && <div className="dim" style={{ fontSize: 12.5 }}>{t('m26.confirmedOn')}: {fmtDate(mine.confirmedAt)}</div>}

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--line, #ddd)', paddingTop: 8 }}>
          <section aria-label={t('m26.parties')}>
            <h4 style={{ margin: '0 0 4px' }}>{t('m26.parties')}</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
              {tx.parties.filter((p) => !p.removed).map((p) => (
                <li key={p.id} data-testid={`tx-party-${p.partyRole}`}>
                  {t(`m25.role.${p.partyRole}`, p.partyRole)}: {p.name ?? t('m26.unnamed')} — {p.confirmedAt ? t('m26.partyConfirmed') : t('m26.partyAwaiting')}
                </li>
              ))}
            </ul>
            {tx.agency && <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>{t('m26.agency')}: {tx.agency.name ?? t('m26.unnamed')}</div>}
          </section>

          <section aria-label={t('m26.compliance')}>
            <h4 style={{ margin: '0 0 4px' }}>{t('m26.compliance')}</h4>
            <div className="dim" style={{ fontSize: 12.5 }}>{tx.compliance.honest}</div>
            {tx.consents.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                {tx.consents.map((c, i) => (
                  <li key={c.id ?? `c${i}`} data-testid={`tx-consent-${c.kind}-${c.partyRole ?? 'none'}`}>
                    {t(`m26.consent.${c.kind}`, c.kind)} — {t(`m25.status.${c.status}`, c.status)}
                    {c.mine ? ` · ${t('m26.consentMine')}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={t('m26.documents')}>
            <h4 style={{ margin: '0 0 4px' }}>{t('m26.documents')}</h4>
            {tx.documents.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('m26.noDocuments')}</div>}
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
              {tx.documents.map((d) => (
                <li key={d.id} data-testid={`tx-doc-${d.id}`}>
                  {t(`m26.docType.${d.documentType}`, d.documentType)} · {t(`m26.visibility.${d.visibility}`, d.visibility)} · v{d.version}
                  {!d.downloadable && <span className="dim"> · {t('m26.notDownloadable')}</span>}
                </li>
              ))}
            </ul>
          </section>

          <section aria-label={t('m26.notes')}>
            <h4 style={{ margin: '0 0 4px' }}>{t('m26.notes')}</h4>
            {tx.notes.length === 0 && <div className="dim" style={{ fontSize: 12.5 }}>{t('m26.noNotes')}</div>}
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
              {tx.notes.map((n) => (
                <li key={n.id}>{t(`m26.visibility.${n.visibility}`, n.visibility)}: {n.text} <span className="dim">· {fmtDate(n.at)}</span></li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12.5, gap: 2 }}>
                {t('m26.noteVisibility')}
                <select value={noteVis} onChange={(e) => setNoteVis(e.target.value)} data-testid={`tx-note-vis-${tx.id}`}>
                  {noteOptions.map((v) => <option key={v} value={v}>{t(`m26.visibility.${v}`, v)}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12.5, gap: 2, flex: '1 1 200px' }}>
                {t('m26.noteText')}
                <input value={noteText} onChange={(e) => setNoteText(e.target.value)} data-testid={`tx-note-text-${tx.id}`} />
              </label>
              <button disabled={busy || !noteText.trim()} onClick={addNote} data-testid={`tx-note-add-${tx.id}`}>{t('m26.addNote')}</button>
            </div>
            <div className="dim" style={{ fontSize: 12 }}>{t('m26.noteScopeNote')}</div>
          </section>

          <section aria-label={t('m26.timeline')}>
            <h4 style={{ margin: '0 0 4px' }}>{t('m26.timeline')}</h4>
            {timeline === null
              ? <button onClick={loadTimeline} data-testid={`tx-timeline-load-${tx.id}`}>{t('m26.loadTimeline')}</button>
              : timeline.length === 0
                ? <div className="dim" style={{ fontSize: 12.5 }}>{t('m26.noTimeline')}</div>
                : <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }} data-testid={`tx-timeline-${tx.id}`}>
                    {timeline.map((e) => (
                      <li key={e.id}>{t(`m26.event.${e.action}`, e.action.replace(/_/g, ' '))} <span className="dim">· {fmtDate(e.at)}{e.actor ? ` · ${e.actor.label}` : ''}</span></li>
                    ))}
                  </ol>}
          </section>

          <div className="dim" style={{ fontSize: 12 }} data-testid={`tx-offer-boundary-${tx.id}`}>{tx.offerBoundary.honest}</div>
          <div className="dim" style={{ fontSize: 12 }}>{tx.honest}</div>
        </div>
      )}
    </div>
  );
}
