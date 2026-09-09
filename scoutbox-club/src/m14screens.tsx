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
  m14, type MyVerification, type PublicVerProfile, type SubjectClaim, type VerBadge,
} from './m14api';
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
  const [tab, setTab] = useState<'me' | 'requests' | 'staff' | 'domains' | 'admins' | 'more'>('me');
  const [me, reloadMe] = useAsync<MyVerification>(() => m14.me(session), [session, tick]);
  const TABS: [typeof tab, string][] = [
    ['me', t('m14.tab.me')], ['requests', t('m14.tab.requests')], ['staff', t('m14.tab.staff')],
    ['domains', t('m14.tab.domains')], ['admins', t('m14.tab.admins')], ['more', t('m14.tab.more')],
  ];
  return (
    <div>
      <h2>{t('nav.verification')}</h2>
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
