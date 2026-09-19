// M23 P5.6B — "My Agent": the player's side of agent representation.
//
// The client's confirmation is the root of every relationship. This card
// shows what an agent asked for and what the agent's licence state IS in
// ScoutBox (never a number), and offers exactly the four acts the server
// allows the client: confirm, decline, end, dispute. A dispute suspends the
// agent's access and is terminal here — attributed Trust & Safety review is
// not yet available, and the card says so rather than pretending otherwise.
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import { m24, m24ClientKey, type AgentAction, type AgentRelationship, type DisclosureKey } from '../data/m24client';
import { pt } from '../i18n';

/**
 * M23 P5.6E — the three disclosure choices, in the order a player meets them.
 * Each is a SEPARATE question with its own words, because they are separate
 * questions: one asks whether clubs may see who represents you, one whether a
 * club's message also reaches your agent, one whether your agent is given your
 * trial schedule. Each starts off. Confirming a relationship turns none of them
 * on, and turning one off stops the next one immediately.
 */
const DISCLOSURES: { key: DisclosureKey; label: Parameters<typeof pt>[0]; help: Parameters<typeof pt>[0] }[] = [
  { key: 'clubPresence', label: 'm27dPresence', help: 'm27dPresenceHelp' },
  { key: 'contactRouting', label: 'm27dRouting', help: 'm27dRoutingHelp' },
  { key: 'trialVisibility', label: 'm27dTrials', help: 'm27dTrialsHelp' },
];

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

const statusKey = (s: AgentRelationship['status']) => (
  s === 'proposed' ? 'm24pending' : s === 'active' ? 'm24active' : s === 'declined' ? 'm24declined' : s === 'expired' ? 'm24expired' : s === 'disputed' ? 'm24disputed' : 'm24ended'
) as Parameters<typeof pt>[0];
const tone = (s: AgentRelationship['status']): 'green' | 'blue' | 'gold' | 'red' | 'default' => (s === 'active' ? 'green' : s === 'proposed' ? 'blue' : s === 'disputed' ? 'red' : s === 'expired' ? 'gold' : 'default');
const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : '—');

export function MyAgentSection({ playerId, isMinor }: { playerId: string; isMinor: boolean }) {
  const [data, reload, err] = useLoad(() => m24.list(playerId), [playerId]);
  const [msg, setMsg] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [disputing, setDisputing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Structurally absent for under-18s — the server answers an empty list with a note; nothing is rendered.
  if (isMinor) return null;
  const act = async (r: AgentRelationship, action: AgentAction, okKey: Parameters<typeof pt>[0]) => {
    setBusy(true); setMsg(null);
    try {
      await m24.act(playerId, r.id, action, { expectedRev: r.rev, clientKey: m24ClientKey(), ...(action === 'dispute' ? { reason: reason[r.id] ?? '' } : {}) });
      setMsg(pt(okKey)); setDisputing(null); reload();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setMsg(code === 'REPRESENTATION_VERSION_CONFLICT' ? pt('m24conflict') : e instanceof Error && e.message ? e.message : pt('m24failed'));
    } finally { setBusy(false); }
  };
  const share = async (r: AgentRelationship) => {
    setBusy(true); setMsg(null);
    try { await m24.setSharing(playerId, r.id, !r.shareWithAgencyStaff, r.rev); reload(); } catch (e) { setMsg(e instanceof Error && e.message ? e.message : pt('m24failed')); } finally { setBusy(false); }
  };
  /** One disclosure, one request. The other two are not sent, so they cannot move. */
  const disclose = async (r: AgentRelationship, key: DisclosureKey) => {
    setBusy(true); setMsg(null);
    try {
      await m24.setDisclosure(playerId, r.id, key, !(r.disclosure?.[key] ?? false), r.rev);
      reload();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setMsg(code === 'REPRESENTATION_VERSION_CONFLICT' ? pt('m24conflict') : e instanceof Error && e.message ? e.message : pt('m24failed'));
    } finally { setBusy(false); }
  };
  const items = data?.items ?? [];
  return (
    <Card testID="my-agent">
      <SectionTitle>🤝 {pt('m24title')}</SectionTitle>
      <Muted size={12}>{pt('m24intro')}</Muted>
      {err && <Muted size={12}>{err}</Muted>}
      {items.map((r) => (
        <View key={r.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }} testID={`my-agent-${r.id}`}>
          <Row>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{r.agent.displayName ?? '—'}</Text>
            <Pill label={pt(statusKey(r.status))} tone={tone(r.status)} />
          </Row>
          <Muted size={12}>{pt('m24agency')}: {r.agent.agency?.name ?? '—'} · {pt('m24scope')}: {r.scope.map((s) => s.replace(/_/g, ' ')).join(', ')}{r.termMonths ? ` · ${pt('m24term')}: ${r.termMonths} ${pt('m24months')}` : ''}{r.endAt ? ` · ${pt('m24ends')} ${fmt(r.endAt)}` : ''}</Muted>
          {r.legacy ? (
            <Muted size={11.5}>{pt('m24legacy')}</Muted>
          ) : (
            <Muted size={11.5}>
              {pt('m24licence')}: {(r.agent.verification?.fifaLicence ?? 'UNVERIFIED').replace(/_/g, ' ').toLowerCase()} — {r.agent.verification?.fifaLicence === 'VERIFIED' ? pt('m24honestVerified') : pt('m24honestUnverified')}
            </Muted>
          )}
          {r.status === 'disputed' && <Muted size={11.5}>{pt('m24disputedMsg')}</Muted>}
          {!r.legacy && (
            <>
              <Row style={{ marginTop: 6 }}>
                {r.status === 'proposed' && <Button small primary disabled={busy} label={pt('m24confirm')} onPress={() => act(r, 'confirm', 'm24confirmed')} />}
                {r.status === 'proposed' && <Button small disabled={busy} label={pt('m24decline')} onPress={() => act(r, 'decline', 'm24declinedMsg')} />}
                {r.status === 'active' && <Button small disabled={busy} label={pt('m24end')} onPress={() => act(r, 'terminate', 'm24endedMsg')} />}
                {(r.status === 'proposed' || r.status === 'active') && <Button small danger disabled={busy} label={pt('m24dispute')} onPress={() => setDisputing(disputing === r.id ? null : r.id)} />}
              </Row>
              {disputing === r.id && (
                <View style={{ marginTop: 6, gap: 6 }}>
                  <TextInput
                    accessibilityLabel={pt('m24disputeReason')}
                    placeholder={pt('m24disputeReason')}
                    placeholderTextColor={colors.muted}
                    value={reason[r.id] ?? ''}
                    onChangeText={(v) => setReason((c) => ({ ...c, [r.id]: v }))}
                    style={{ backgroundColor: colors.panel2, color: colors.text, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line }}
                  />
                  <Button small danger disabled={busy} label={pt('m24dispute')} onPress={() => act(r, 'dispute', 'm24disputedMsg')} />
                </View>
              )}
              {r.status === 'active' && (
                <View style={{ marginTop: 6 }}>
                  <Button small disabled={busy} label={r.shareWithAgencyStaff ? pt('m24unshare') : pt('m24share')} onPress={() => share(r)} />
                  <Muted size={11}>{pt('m24shareNote')}</Muted>
                </View>
              )}
              {/*
                M23 P5.6E — what this agent may see and be sent. Three separate
                choices, each with its own state in words (on / off) rather than
                a bare switch, so a screen reader and a glance both get the same
                answer. Every one starts off.
              */}
              {r.status === 'active' && (
                <View style={{ marginTop: 8 }} testID={`my-agent-disclosure-${r.id}`}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12.5 }}>{pt('m27dTitle')}</Text>
                  <Muted size={11}>{pt('m27dIntro')}</Muted>
                  {DISCLOSURES.map((d) => {
                    const on = r.disclosure?.[d.key] === true;
                    return (
                      <View key={d.key} style={{ marginTop: 6 }} testID={`my-agent-d-${d.key}`}>
                        <Row>
                          <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>{pt(d.label)}</Text>
                          <Pill label={on ? pt('m27dOn') : pt('m27dOff')} tone={on ? 'green' : 'default'} />
                        </Row>
                        <Muted size={11}>{pt(d.help)}</Muted>
                        <View style={{ marginTop: 4, alignSelf: 'flex-start' }}>
                          <Button
                            small
                            disabled={busy}
                            label={on ? pt('m27dTurnOff') : pt('m27dTurnOn')}
                            onPress={() => disclose(r, d.key)}
                            testID={`my-agent-d-${d.key}-toggle`}
                          />
                        </View>
                      </View>
                    );
                  })}
                  <Muted size={11}>{pt('m27dHonest')}</Muted>
                </View>
              )}
            </>
          )}
          <Muted size={11}>{pt('m24whatIs')}</Muted>
        </View>
      ))}
      {items.length === 0 && !err && <Muted size={12}>{pt('m24none')}</Muted>}
      {msg && <View accessibilityLiveRegion="polite"><Muted size={12}>{msg}</Muted></View>}
    </Card>
  );
}

/**
 * M23 P5.6E §19 — opportunities an agent put in front of this player.
 *
 * A separate card, because it is a separate thing: these are chances to look at,
 * not relationship admin. Every row says in words that applying is the player's
 * own action, and there is no "apply" button here at all — the player applies on
 * the opportunity's own screen, in their own name, exactly as they always did.
 */
export function AgentSharedOpportunities({ playerId, isMinor }: { playerId: string; isMinor: boolean }) {
  const [data, , err] = useLoad(() => m24.sharedOpportunities(playerId), [playerId]);
  if (isMinor) return null;
  const items = (data?.items ?? []).filter((s) => !s.withdrawnAt);
  // Absent rather than empty: a card that says "your agent has shared nothing"
  // is a nudge about having an agent, and this surface is not for that.
  if (!items.length) return null;
  return (
    <Card testID="agent-shared-opportunities">
      <SectionTitle>📣 {pt('m27sTitle')}</SectionTitle>
      <Muted size={12}>{pt('m27sIntro')}</Muted>
      {err && <Muted size={12}>{err}</Muted>}
      {items.map((s) => (
        <View key={s.id} style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }} testID={`agent-shared-${s.id}`}>
          <Row>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{s.title ?? pt('m27sUntitled')}</Text>
            {s.deadline && <Pill label={`${pt('m27sBy')} ${s.deadline}`} tone="blue" />}
          </Row>
          <Muted size={12}>{s.orgName ?? '—'} · {pt('m27sSharedBy')} {s.sharedByName ?? '—'} · {fmt(s.sharedAt)}</Muted>
          {s.note && <Text style={{ color: colors.text, fontSize: 12.5, marginTop: 4 }}>{s.note}</Text>}
          <Muted size={11}>{pt('m27sYours')}</Muted>
        </View>
      ))}
      <Muted size={11}>{pt('m27sHonest')}</Muted>
    </Card>
  );
}
