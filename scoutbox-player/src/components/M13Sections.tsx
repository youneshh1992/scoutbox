// M13 player/guardian sections, dropped into the existing tabs:
// suitability preferences + opportunity fit (You / Home), transitions (You,
// adults; guardian panel for minors), representation (You, adults only),
// coarse exposure (You), and action-required acknowledgements (Inbox).
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m13, type AckNotification, type Preferences, type RepresentationView, type TransitionCase, type Verdict } from '../data/m13client';
import { m12, type BoardItem } from '../data/m12client';
import { pt } from '../i18n';
import type { Actor } from './M12Sections';
import { useEffect } from 'react';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let ok = true;
    setErr(null);
    fn().then((x) => ok && setV(x)).catch((e) => ok && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}

const input = {
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const;

const fitTone = (v: string): 'green' | 'red' | 'default' => (v === 'compatible' ? 'green' : v === 'conflict' ? 'red' : 'default');

// -------------------------------------------------- F3 private preferences
export function PreferencesSection({ actor, isMinor }: { actor: Actor; isMinor: boolean }) {
  const [data, reload] = useLoad(
    () => (actor.kind === 'player' ? m13.getPreferences(actor.id) : m13.gGetPreferences(actor.id, actor.childId)),
    [actor.id]
  );
  const [travel, setTravel] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;
  const p = data.preferences;
  const readOnly = actor.kind === 'player' && isMinor;
  const save = async (patch: Partial<Preferences>) => {
    try {
      if (actor.kind === 'player') await m13.savePreferences(actor.id, patch);
      else await m13.gSavePreferences(actor.id, actor.childId, patch);
      setMsg('Saved — private to you, never shown to clubs.');
      reload();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); }
  };
  return (
    <Card>
      <SectionTitle>🎛 {pt('m13prefs')}</SectionTitle>
      <Muted size={12}>{pt('m13prefsPrivate')}</Muted>
      {readOnly && <Muted size={12}>👨‍👩‍👧 {pt('m13prefsGuardian')}</Muted>}
      <Muted size={12.5}>
        {pt('m13commitments')}: {p.commitments.length ? p.commitments.map((c) => `${c.label ?? c.day} ${c.day} ${c.start}–${c.end}`).join(' · ') : '—'}
      </Muted>
      <Muted size={12.5}>{pt('m13available')}: {p.availableSlots.length ? p.availableSlots.map((c) => `${c.day} ${c.start}–${c.end}`).join(' · ') : '—'}</Muted>
      <Muted size={12.5}>
        {pt('m13travel')}: {p.travelLimitKm != null ? `${p.travelLimitKm} km` : '—'} · {pt('m13transport')}: {p.transport ?? '—'}
        {actor.kind === 'player' && !isMinor && ` · ${pt('m13relocation')}: ${p.relocation ?? '—'}`}
      </Muted>
      <Muted size={12.5}>{pt('m13expenses')}: {p.compensation.expensesNeeded ? pt('m13expensesNeeded') : pt('m13expensesOk')}</Muted>
      {!readOnly && (
        <Row style={{ marginTop: 8 }}>
          <TextInput
            accessibilityLabel={pt('m13travel')} style={[input, { width: 90 }]} keyboardType="numeric"
            placeholder="km" placeholderTextColor={colors.muted} value={travel} onChangeText={setTravel}
          />
          <Button small label={pt('m13saveTravel')} onPress={() => travel && save({ travelLimitKm: Number(travel) })} />
          <Button small label={p.compensation.expensesNeeded ? pt('m13expensesOkBtn') : pt('m13expensesNeedBtn')}
            onPress={() => save({ compensation: { ...p.compensation, expensesNeeded: !p.compensation.expensesNeeded } })} />
        </Row>
      )}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ----------------------------------------------------- F3 opportunity fit
export function OpportunityFitSection({ actor }: { actor: Actor }) {
  const [board, reloadBoard] = useLoad<{ items: BoardItem[] }>(
    () => (actor.kind === 'player' ? m12.getBoard(actor.id) : m12.gBoard(actor.id, actor.childId)),
    [actor.id]
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [fit, setFit] = useState<{ oppId: string; verdicts: Verdict[]; note?: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!board?.items.length) return null;
  return (
    <Card>
      <SectionTitle>🧭 {pt('m13fit')}</SectionTitle>
      <Muted size={12}>{pt('m13fitNote')}</Muted>
      {board.items.filter((o) => o.via !== 'open_trial').slice(0, 4).map((o) => (
        <View key={o.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }}>
          <Row>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{o.title}</Text>
            <Button small label={openId === o.id ? pt('m13hideFit') : pt('m13checkFit')} onPress={async () => {
              if (openId === o.id) { setOpenId(null); setFit(null); return; }
              reloadBoard(); // pick up a just-submitted application so the share control appears
              try {
                const r = actor.kind === 'player' ? await m13.suitability(actor.id, o.id) : await m13.gSuitability(actor.id, actor.childId, o.id);
                setFit({ oppId: o.id, ...r });
                setOpenId(o.id);
              } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); }
            }} />
          </Row>
          {openId === o.id && fit?.oppId === o.id && (
            <View>
              {fit.verdicts.map((v) => (
                <Row key={v.dimension} style={{ marginTop: 4, alignItems: 'flex-start' }}>
                  <Pill label={`${v.dimension}: ${v.verdict}`} tone={fitTone(v.verdict)} />
                  <View style={{ flex: 1, marginLeft: 6 }}><Muted size={11.5}>{v.reason} ({v.source})</Muted></View>
                </Row>
              ))}
              {fit.note && <Muted size={11.5}>{fit.note}</Muted>}
              {o.applied?.id && (
                <Button small label={pt('m13shareFit')} onPress={async () => {
                  try {
                    if (actor.kind === 'player') await m13.shareSuitability(actor.id, o.applied!.id!, true);
                    else await m13.gShareSuitability(actor.id, actor.childId, o.applied!.id!, true);
                    setMsg(pt('m13sharedFit'));
                  } catch (e) { setMsg(e instanceof Error ? e.message : 'failed'); }
                }} />
              )}
            </View>
          )}
        </View>
      ))}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// --------------------------------------------------------- F2 transitions
export function TransitionsSection({ actor, isMinor, mediaOptions }: { actor: Actor; isMinor: boolean; mediaOptions: { id: string; title: string }[] }) {
  const [cases, reload, err] = useLoad<TransitionCase[]>(
    () => (actor.kind === 'player' ? m13.listTransitions(actor.id) : m13.gListTransitions(actor.id)),
    [actor.id]
  );
  const [orgInput, setOrgInput] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (actor.kind === 'player' && isMinor) {
    return (
      <Card>
        <SectionTitle>🔁 {pt('m13trn')}</SectionTitle>
        <Muted size={12}>👨‍👩‍👧 {pt('m13trnGuardian')}</Muted>
      </Card>
    );
  }
  const act = (fn: () => Promise<unknown>, done: string) =>
    fn().then(() => { setMsg(done); reload(); }).catch((e) => setMsg(e instanceof Error ? e.message : 'failed'));
  return (
    <Card>
      <SectionTitle>🔁 {pt('m13trn')}</SectionTitle>
      <Muted size={12}>{pt('m13trnNote')}</Muted>
      {(cases ?? []).map((c) => (
        <View key={c.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }}>
          <Row>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{c.note ?? c.id}</Text>
            <Pill label={c.status} tone={c.status === 'open' ? 'blue' : c.status === 'placed' ? 'green' : 'default'} />
          </Row>
          {c.recipients.map((r) => (
            <Row key={r.orgId} style={{ marginTop: 4 }}>
              <View style={{ flex: 1 }}><Muted size={12}>{r.orgName} {r.revokedAt ? `· ${pt('m13trnRevoked')}` : r.viewedAt ? '· viewed' : '· not viewed yet'}</Muted></View>
              {!r.revokedAt && c.status === 'open' && (
                <Button small label={pt('m13trnRevoke')} onPress={() => act(
                  () => (actor.kind === 'player' ? m13.revokeRecipient(actor.id, c.id, r.orgId) : m13.gRevokeRecipient(actor.id, c.id, r.orgId)),
                  pt('m13trnRevokedMsg')
                )} />
              )}
            </Row>
          ))}
          {c.status === 'open' && (
            <Row style={{ marginTop: 6 }}>
              <TextInput accessibilityLabel="Org id" style={[input, { flex: 1 }]} placeholder="org-eastport" placeholderTextColor={colors.muted} value={orgInput} onChangeText={setOrgInput} />
              <Button small label={pt('m13trnGrant')} onPress={() => orgInput && act(
                () => (actor.kind === 'player' ? m13.addRecipient(actor.id, c.id, orgInput) : m13.gAddRecipient(actor.id, c.id, orgInput)),
                pt('m13trnGranted')
              )} />
              {actor.kind === 'player' && (
                <Button small label={pt('m13trnPlace')} onPress={() => orgInput && act(
                  () => m13.placeTransition(actor.id, c.id, orgInput), pt('m13trnPlaced')
                )} />
              )}
            </Row>
          )}
          {c.placement && <Muted size={12}>✅ {pt('m13trnPlacedAt')} {c.placement.orgName}</Muted>}
        </View>
      ))}
      {(cases ?? []).length === 0 && !err && (
        <Button small primary label={pt('m13trnOpen')} onPress={() => {
          const mediaIds = mediaOptions.slice(0, 1).map((mm) => mm.id);
          if (!mediaIds.length) { setMsg(pt('m13trnNeedMedia')); return; }
          act(
            () => (actor.kind === 'player' ? m13.openTransition(actor.id, { mediaIds, note: 'Open to a new club' }) : m13.gOpenTransition(actor.id, actor.childId, { mediaIds, note: 'Open to a new club' })),
            pt('m13trnOpened')
          );
        }} />
      )}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ------------------------------------------------------ F10 representation
export function RepresentationSection({ playerId, isMinor }: { playerId: string; isMinor: boolean }) {
  const [items, reload, err] = useLoad<RepresentationView[]>(() => m13.listRepresentation(playerId), [playerId]);
  const [msg, setMsg] = useState<string | null>(null);
  if (isMinor) return null; // structurally absent for under-18s — nothing to render
  return (
    <Card>
      <SectionTitle>🤝 {pt('m13rep')}</SectionTitle>
      {err && <Muted size={12}>{err}</Muted>}
      {(items ?? []).map((r) => (
        <View key={r.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }}>
          <Row>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{r.agencyName}</Text>
            <Pill label={r.status} tone={r.status === 'active' ? 'green' : r.status === 'withdrawn' || r.status === 'disputed' ? 'red' : 'blue'} />
          </Row>
          <Muted size={12}>{r.representativeName} · {r.scope.replace(/_/g, ' ')}</Muted>
          {r.credential && <Muted size={11.5}>📄 {r.credential.note} — {r.credential.reviewStatus.replace(/_/g, ' ')}. {r.credential.honest}</Muted>}
          <Row style={{ marginTop: 6 }}>
            {r.status === 'proposed' && <Button small primary label={pt('m13repConfirm')} onPress={async () => { await m13.actRepresentation(playerId, r.id, 'confirm'); setMsg(pt('m13repConfirmed')); reload(); }} />}
            {['proposed', 'active'].includes(r.status) && <Button small label={pt('m13repWithdraw')} onPress={async () => { await m13.actRepresentation(playerId, r.id, 'withdraw'); setMsg(pt('m13repWithdrawn')); reload(); }} />}
            {r.status !== 'disputed' && <Button small label={pt('m13repDispute')} onPress={async () => { await m13.actRepresentation(playerId, r.id, 'dispute', 'I did not agree to this.'); setMsg(pt('m13repDisputed')); reload(); }} />}
          </Row>
        </View>
      ))}
      {(items ?? []).length === 0 && !err && <Muted size={12}>{pt('m13repNone')}</Muted>}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

// ------------------------------------------------------------ F4 exposure
export function ExposureSection({ playerId }: { playerId: string }) {
  const [exp] = useLoad(() => m13.exposure(playerId), [playerId]);
  if (!exp) return null;
  return (
    <Card>
      <SectionTitle>👀 {pt('m13exposure')}</SectionTitle>
      <Muted size={12.5}>{pt('m13expSearches')}: <Text style={{ color: colors.text, fontWeight: '700' }}>{exp.appearedInSearches}</Text> · {pt('m13expProfiles')}: <Text style={{ color: colors.text, fontWeight: '700' }}>{exp.profileViews}</Text> · {pt('m13expClubs')}: <Text style={{ color: colors.text, fontWeight: '700' }}>{exp.clubs}</Text></Muted>
      <Muted size={11.5}>{exp.note}</Muted>
    </Card>
  );
}

// -------------------------------------------------- F11 acknowledgements
export function AckSection({ actor }: { actor: Actor }) {
  const [items, reload] = useLoad<AckNotification[]>(
    () => (actor.kind === 'player' ? m13.ackList(actor.id) : m13.gAckList(actor.id)),
    [actor.id]
  );
  const pending = (items ?? []).filter((nn) => !nn.actionRequired?.ackedAt);
  if (!pending.length) return null;
  return (
    <Card>
      <SectionTitle>⚠️ {pt('m13ack')}</SectionTitle>
      {pending.map((nn) => (
        <View key={nn.id} style={{ marginTop: 6 }}>
          <Muted size={12.5}>{nn.text}</Muted>
          <Button small primary label={pt('m13ackBtn')} onPress={async () => {
            if (actor.kind === 'player') await m13.ack(actor.id, nn.id); else await m13.gAck(actor.id, nn.id);
            reload();
          }} />
        </View>
      ))}
    </Card>
  );
}
