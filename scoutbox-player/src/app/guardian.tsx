// Guardian dashboard — parents own every under-18 account. All club contact
// lands here (club-first identity, verified role), the parent accepts or
// declines, and the full communications log is always visible.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, useRouter } from 'expo-router';
import { client, type Channel, type FiledReport, type GuardianDigest, type Insights } from '../data/client';
import type { NotificationPrefs, GuardianOpenTrial } from '../data/types';
import { U18_PROMISES } from '../domain/safeguarding';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle, TrustBar } from '../components/ui';
import { ReportButton } from '../components/ReportSheet';
import { NotificationBell } from '../components/NotificationBell';
import { Threads } from '../components/Threads';
import { PopupBanner } from '../components/PopupBanner';

const CHILD_AVAILABILITY = [
  { value: 'available_now', label: 'Open to trials' },
  { value: 'end_of_season', label: 'From end of season' },
  { value: 'not_seeking', label: 'Not seeking' },
] as const;

export default function GuardianDashboard() {
  const router = useRouter();
  const { kind, guardianId, guardian, guardianInbox, children, notifications, refresh, logout, mode } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<{ id: string; ts: number; type: string; orgName: string; scoutName: string }[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [insights, setInsights] = useState<Record<string, Insights>>({});
  const [myReports, setMyReports] = useState<FiledReport[]>([]);
  const [coName, setCoName] = useState('');
  const [coEmail, setCoEmail] = useState('');
  const [digest, setDigest] = useState<GuardianDigest | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [chosenSlots, setChosenSlots] = useState<Record<string, string>>({});
  const [pairCodes, setPairCodes] = useState<Record<string, { code: string; expiresAt: number }>>({});
  const [prefs, setPrefs] = useState<NotificationPrefs>({ quietStart: null, quietEnd: null, schoolHoursMute: null });
  const [prefsNote, setPrefsNote] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [confirmDeleteChild, setConfirmDeleteChild] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Record<string, GuardianOpenTrial[]>>({});
  const [vouchDrafts, setVouchDrafts] = useState<Record<string, { name: string; email: string }>>({});

  useEffect(() => {
    if (!guardianId) return;
    for (const c of children) {
      client.guardianChildOpenTrials(guardianId, c.id)
        .then((list) => setOpenDays((prev) => ({ ...prev, [c.id]: list })))
        .catch(() => {});
    }
  }, [guardianId, children, guardianInbox]);

  useEffect(() => {
    if (guardianId) client.guardianPrefs(guardianId).then((p) => p && setPrefs(p)).catch(() => {});
  }, [guardianId]);

  const savePrefs = async (next: Partial<NotificationPrefs>) => {
    if (!guardianId) return;
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    try {
      await client.guardianSetPrefs(guardianId, merged);
      setPrefsNote('Saved. Quiet hours apply to push delivery — the in-app record is always complete.');
    } catch {
      setPrefsNote('Could not save — try again.');
    }
  };

  useEffect(() => {
    if (showLog && guardianId) client.guardianLog(guardianId).then(setLog).catch(() => {});
  }, [showLog, guardianId, guardianInbox]);

  const load = useCallback(() => {
    if (!guardianId) return;
    client.guardianChannels(guardianId).then(setChannels).catch(() => {});
    client.guardianReports(guardianId).then(setMyReports).catch(() => {});
    client.guardianDigest(guardianId).then(setDigest).catch(() => {});
    for (const c of children) {
      client.guardianChildInsights(guardianId, c.id).then((i) => setInsights((prev) => ({ ...prev, [c.id]: i }))).catch(() => {});
    }
  }, [guardianId, children]);

  useEffect(load, [load, guardianInbox, notifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    load();
    setRefreshing(false);
  }, [refresh, load]);

  if (kind !== 'guardian') return <Redirect href="/onboarding" />;

  const respond = async (requestId: string, accept: boolean) => {
    if (!guardianId) return;
    setError(null);
    try {
      await client.guardianRespond(guardianId, requestId, accept, accept ? chosenSlots[requestId] : undefined);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not respond');
    }
  };

  const setMedical = async (childId: string, shared: boolean) => {
    if (!guardianId) return;
    try {
      await client.guardianSetMedicalShared(guardianId, childId, shared);
      await refresh();
    } catch {
      /* refresh shows truth */
    }
  };

  const unreadMsgs = channels.reduce(
    (sum, c) => sum + c.messages.filter((m) => m.sender.kind === 'org_user' && m.ts > (c.readBy?.counterparty ?? 0)).length,
    0
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <PopupBanner />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>Guardian</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>

        {digest && digest.children.length > 0 && (
          <Card style={{ borderColor: colors.accent }}>
            <SectionTitle>📬 This week&apos;s digest</SectionTitle>
            {digest.children.map((c) => (
              <Muted key={c.id} size={13}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{c.name}:</Text> {c.views} club view{c.views === 1 ? '' : 's'},{' '}
                {c.newRequests} new request{c.newRequests === 1 ? '' : 's'}, {c.activityThisWeek} training activit{c.activityThisWeek === 1 ? 'y' : 'ies'}
                {c.streak > 0 ? ` · 🔥 ${c.streak}-day streak` : ''}{c.weeklyGoal.met ? ' · weekly goal met ✓' : ''}
              </Muted>
            ))}
            <Muted size={11.5}>{digest.note}</Muted>
          </Card>
        )}
        <Muted>
          {guardian?.name} · {guardian?.email}
        </Muted>
        <Row>
          <Pill label={guardian?.idVerified ? 'ID verified' : 'ID unverified'} tone={guardian?.idVerified ? 'green' : 'red'} />
          <Pill label={guardian?.disclaimerAccepted ? 'Disclaimer accepted' : 'Disclaimer pending'} tone={guardian?.disclaimerAccepted ? 'green' : 'red'} />
          <Pill label={mode === 'live' ? 'Live sync' : 'Demo mode'} tone={mode === 'live' ? 'green' : 'blue'} />
        </Row>

        {error && (
          <Card style={{ borderColor: colors.danger }}>
            <Text style={{ color: colors.danger }}>{error}</Text>
          </Card>
        )}

        <SectionTitle>Club requests — you decide, never your child</SectionTitle>
        {guardianInbox.length === 0 && (
          <Card>
            <Muted size={13.5}>
              No requests yet. When a verified club wants to talk about your child, it appears here as
              e.g. “Eastport FC has requested to discuss a trial.” The conversation happens between adults.
            </Muted>
          </Card>
        )}
        {guardianInbox.map((r) => (
          <Card key={r.id} style={r.status === 'pending' ? { borderColor: colors.accent2 } : undefined}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.org}>{r.orgName}</Text>
              <Row>
                {r.orgVerified && <Pill label="Verified" tone="green" />}
                <Pill label={r.type === 'trial' ? 'trial invitation' : 'conversation request'} tone={r.type === 'trial' ? 'gold' : 'blue'} />
              </Row>
            </Row>
            <Muted size={13}>
              {r.scoutRole ?? 'Scout'} — {r.scoutName} · about {r.playerName ?? r.playerId} · {new Date(r.createdAt).toLocaleString()}
            </Muted>
            {r.message ? <Text style={styles.msg}>“{r.message}”</Text> : null}
            {r.type === 'trial' && r.trialDetails && (
              <Muted size={12.5}>
                {r.trialDetails.venue ? `Venue: ${r.trialDetails.venue}. ` : ''}
                {r.trialDetails.notes}
              </Muted>
            )}
            {r.status === 'pending' && r.type === 'trial' && r.trialDetails?.proposedDate && (
              <>
                <Muted size={12.5}>Pick the date that works for your family — accepting confirms it:</Muted>
                <Row style={{ flexWrap: 'wrap' }}>
                  {[r.trialDetails.proposedDate, ...(r.trialDetails.altSlots ?? [])].map((slot) => {
                    const active = (chosenSlots[r.id] ?? r.trialDetails?.proposedDate) === slot;
                    return (
                      <Pressable key={slot} onPress={() => setChosenSlots((s) => ({ ...s, [r.id]: slot }))}>
                        <Pill label={slot} tone={active ? 'green' : undefined} />
                      </Pressable>
                    );
                  })}
                </Row>
              </>
            )}
            {r.status === 'pending' ? (
              <Row>
                <Button small primary label={r.type === 'trial' ? 'Accept trial' : 'Accept conversation'} onPress={() => respond(r.id, true)} />
                <Button small danger label="Decline" onPress={() => respond(r.id, false)} />
              </Row>
            ) : (
              <Row>
                <Pill label={r.status} tone={r.status === 'accepted' ? 'green' : 'red'} />
                {r.status === 'accepted' && r.contactChannel && <Pill label={`adult-to-adult channel: ${r.contactChannel}`} />}
              </Row>
            )}
          </Card>
        ))}

        <Row>
          <SectionTitle>Messages with clubs — adult to adult</SectionTitle>
          {unreadMsgs > 0 && <Pill label={`${unreadMsgs} new`} tone="red" />}
        </Row>
        <Threads
          channels={channels}
          onSend={(channelId, text, attachMediaId) => client.guardianSendMessage(guardianId!, channelId, text, attachMediaId)}
          onOpen={(channelId) => void client.guardianMarkChannelRead(guardianId!, channelId).catch(() => {})}
          onTyping={(channelId) => void client.guardianSendTyping(guardianId!, channelId).catch(() => {})}
          attachableClips={children.flatMap((c) => c.media)}
          emptyText="No threads yet. Accept a club request above and the conversation opens here — always with you, never with your child."
        />

        <SectionTitle>Your children</SectionTitle>
        {children.map((c) => {
          const ins = insights[c.id];
          return (
            <Card key={c.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.org}>{c.name}</Text>
                <Pill label={`${c.age} · ${c.position ?? '—'}`} tone="blue" />
              </Row>
              <TrustBar score={c.trustScore} />
              <Muted size={12.5}>
                {c.media.length} clip{c.media.length === 1 ? '' : 's'} · {c.attendance.length} verified
                attendance{c.attendance.length === 1 ? '' : 's'} · {c.trialReports.length} trial report{c.trialReports.length === 1 ? '' : 's'}
              </Muted>
              {ins && (
                <Muted size={12.5}>
                  👁 {ins.thisMonth.views} profile view{ins.thisMonth.views === 1 ? '' : 's'} this month
                  {ins.byOrg.length > 0 ? ` — most recently ${ins.byOrg[0].orgName}` : ''}. Only verified clubs can look.
                </Muted>
              )}
              <SectionTitle>Availability — your call, not the club&apos;s</SectionTitle>
              <Row>
                {CHILD_AVAILABILITY.map((a) => (
                  <Button
                    key={a.value}
                    small
                    primary={c.availability === a.value}
                    label={a.label}
                    onPress={async () => {
                      try {
                        await client.guardianSetChildAvailability(guardianId!, c.id, a.value);
                        await refresh();
                      } catch { /* refresh shows truth */ }
                    }}
                  />
                ))}
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Muted size={12.5}>
                    Medical sharing {c.medical.shared ? 'ON' : 'OFF'} — your decision as guardian; invisible
                    to every organisation unless you switch it on.
                  </Muted>
                </View>
                <Switch value={c.medical.shared} onValueChange={(v) => setMedical(c.id, v)} trackColor={{ true: colors.gold, false: colors.line }} thumbColor="#fff" />
              </Row>
              <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 6 }}>
                <Muted size={12.5}>
                  Pair {c.name.split(' ')[0]}&apos;s device: generate a one-time code (15-minute expiry) and
                  they enter it on their phone. Their login stays limited — uploads, stats and drills only.
                </Muted>
                <Row>
                  <Button
                    small
                    label="Generate pairing code"
                    onPress={async () => {
                      try {
                        const pc = await client.guardianPairingCode(guardianId!, c.id);
                        setPairCodes((prev) => ({ ...prev, [c.id]: pc }));
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'Could not generate a code');
                      }
                    }}
                  />
                  {pairCodes[c.id] && pairCodes[c.id].expiresAt > Date.now() && (
                    <Pill label={`Code: ${pairCodes[c.id].code}`} tone="gold" />
                  )}
                </Row>
                {(openDays[c.id]?.length ?? 0) > 0 && (
                  <View style={{ gap: 6 }}>
                    <Muted size={12.5}>📅 Open days near {c.name.split(' ')[0]} — verified local clubs only. You register; they play.</Muted>
                    {openDays[c.id]!.map((t) => (
                      <Row key={t.id} style={{ justifyContent: 'space-between' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: colors.text, fontSize: 13 }}>{t.orgName}: {t.title} · {t.date}</Text>
                          <Muted size={11.5}>{t.venue} · {t.distanceKm} km away</Muted>
                        </View>
                        {t.registered ? <Pill label="registered ✓" tone="green" /> : (
                          <Button small primary label="Register" onPress={async () => {
                            try {
                              await client.guardianRegisterOpenTrial(guardianId!, t.id, c.id);
                              const list = await client.guardianChildOpenTrials(guardianId!, c.id);
                              setOpenDays((prev) => ({ ...prev, [c.id]: list }));
                            } catch (e) { setError(e instanceof Error ? e.message : 'Could not register'); }
                          }} />
                        )}
                      </Row>
                    ))}
                  </View>
                )}
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Muted size={12.5}>
                      🔎 First Team Seeker {c.firstTeamSeeker ? 'ON' : 'OFF'} — surfaces {c.name.split(' ')[0]} first to
                      local verified clubs looking for new players. Your call, free, reversible.
                    </Muted>
                  </View>
                  <Switch
                    value={!!c.firstTeamSeeker}
                    onValueChange={async (v) => {
                      try { await client.guardianSetFirstTeamSeeker(guardianId!, c.id, v); await refresh(); }
                      catch { /* refresh shows truth */ }
                    }}
                    trackColor={{ true: colors.accent, false: colors.line }}
                    thumbColor="#fff"
                  />
                </Row>
                <View style={{ gap: 6 }}>
                  <Muted size={12.5}>⭐ Request a coach reference for {c.name.split(' ')[0]} — the coach confirms by email.</Muted>
                  <Row>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      placeholder="Coach name"
                      placeholderTextColor={colors.muted}
                      value={vouchDrafts[c.id]?.name ?? ''}
                      onChangeText={(v) => setVouchDrafts((prev) => ({ ...prev, [c.id]: { name: v, email: prev[c.id]?.email ?? '' } }))}
                    />
                    <TextInput
                      style={[styles.input, { flex: 1.3 }]}
                      placeholder="Coach email"
                      placeholderTextColor={colors.muted}
                      autoCapitalize="none"
                      value={vouchDrafts[c.id]?.email ?? ''}
                      onChangeText={(v) => setVouchDrafts((prev) => ({ ...prev, [c.id]: { name: prev[c.id]?.name ?? '', email: v } }))}
                    />
                    <Button small label="Ask" onPress={async () => {
                      const d = vouchDrafts[c.id];
                      if (!d?.name.trim() || !d?.email.includes('@')) { setError('Coach name and a valid email are needed.'); return; }
                      try {
                        await client.guardianRequestVouch(guardianId!, c.id, d.name.trim(), d.email.trim(), 'Coach');
                        setVouchDrafts((prev) => ({ ...prev, [c.id]: { name: '', email: '' } }));
                        setError(null);
                      } catch (e) { setError(e instanceof Error ? e.message : 'Could not send'); }
                    }} />
                  </Row>
                </View>
                {confirmDeleteChild === c.id ? (
                  <Row>
                    <Muted size={12.5}>Delete {c.name}&apos;s profile and all their content?</Muted>
                    <Button
                      small danger label="Yes, delete"
                      onPress={async () => {
                        try {
                          await client.guardianDeleteChild(guardianId!, c.id);
                          setConfirmDeleteChild(null);
                          await refresh();
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Could not delete');
                        }
                      }}
                    />
                    <Button small label="Keep" onPress={() => setConfirmDeleteChild(null)} />
                  </Row>
                ) : (
                  <Row>
                    <Button small danger label="Delete this profile" onPress={() => setConfirmDeleteChild(c.id)} />
                  </Row>
                )}
              </View>
            </Card>
          );
        })}

        <SectionTitle>Co-guardian</SectionTitle>
        <Card>
          <Muted size={13}>
            Add a second parent or guardian. They get their own account for the same children — and must
            pass ID verification and accept the disclaimer before they can act.
          </Muted>
          {(guardian as (typeof guardian & { coGuardians?: { id: string; name: string; email: string }[] }) | null)?.coGuardians?.map((co) => (
            <Row key={co.id}>
              <Pill label="co-guardian" tone="blue" />
              <Text style={{ color: colors.text, fontSize: 13.5 }}>{co.name} · {co.email}</Text>
            </Row>
          ))}
          <Row>
            <TextInput style={[styles.input, { flex: 1 }]} placeholder="Name" placeholderTextColor={colors.muted} value={coName} onChangeText={setCoName} />
            <TextInput style={[styles.input, { flex: 1.4 }]} placeholder="Email" placeholderTextColor={colors.muted} value={coEmail} onChangeText={setCoEmail} autoCapitalize="none" />
            <Button small label="Invite" onPress={async () => {
              if (!coName.trim() || !coEmail.includes('@')) { setError('Co-guardian needs a name and valid email.'); return; }
              try {
                await client.guardianAddCoGuardian(guardianId!, coName.trim(), coEmail.trim());
                setCoName(''); setCoEmail(''); setError(null);
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not add co-guardian');
              }
            }} />
          </Row>
        </Card>

        {myReports.length > 0 && (
          <>
            <SectionTitle>Safety centre — your reports</SectionTitle>
            {myReports.map((r) => (
              <Card key={r.id}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{r.reason}</Text>
                  <Pill label={r.status === 'resolved' ? 'reviewed' : 'in review'} tone={r.status === 'resolved' ? 'green' : 'gold'} />
                </Row>
                {r.outcome && <Muted size={12.5}>{r.outcome}</Muted>}
              </Card>
            ))}
          </>
        )}

        <SectionTitle>Notifications</SectionTitle>
        <Card>
          <Muted size={13}>
            Quiet hours pause push notifications overnight. Everything still lands in your in-app feed —
            no club contact ever slips past you.
          </Muted>
          <Row>
            <Muted size={13}>Quiet from</Muted>
            <TextInput
              style={[styles.input, { minWidth: 72 }]}
              placeholder="22:00"
              placeholderTextColor={colors.muted}
              value={prefs.quietStart ?? ''}
              onChangeText={(v) => setPrefs((p) => ({ ...p, quietStart: v || null }))}
              onBlur={() => savePrefs({})}
            />
            <Muted size={13}>until</Muted>
            <TextInput
              style={[styles.input, { minWidth: 72 }]}
              placeholder="07:00"
              placeholderTextColor={colors.muted}
              value={prefs.quietEnd ?? ''}
              onChangeText={(v) => setPrefs((p) => ({ ...p, quietEnd: v || null }))}
              onBlur={() => savePrefs({})}
            />
          </Row>
          {prefsNote && <Muted size={12.5}>{prefsNote}</Muted>}
        </Card>

        <SectionTitle>Your family&apos;s data</SectionTitle>
        <Card>
          <Muted size={13}>
            One bundle with everything: your account, your children&apos;s profiles, every request and
            every thread. Yours to take, any time.
          </Muted>
          <Row>
            <Button
              small label="Preview data export"
              onPress={async () => {
                try {
                  const data = await client.guardianExport(guardianId!);
                  setExportPreview(JSON.stringify(data, null, 2).slice(0, 1500));
                } catch {
                  setExportPreview('Export failed — try again.');
                }
              }}
            />
            {exportPreview && <Button small label="Hide preview" onPress={() => setExportPreview(null)} />}
          </Row>
          {exportPreview && <Text style={styles.exportPreview} numberOfLines={30}>{exportPreview}…</Text>}
        </Card>

        <SectionTitle>Communications log</SectionTitle>
        <Card>
          <Muted size={13}>Every scouting action around your children is logged and visible to you.</Muted>
          <Button small label={showLog ? 'Hide log' : `Show log`} onPress={() => setShowLog(!showLog)} />
          {showLog && log.map((l) => (
            <Row key={l.id}>
              <Pill label={new Date(l.ts).toLocaleDateString()} />
              <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>
                {l.type.replace(/_/g, ' ')} — {l.orgName}{l.scoutName ? ` (${l.scoutName})` : ''}
              </Text>
            </Row>
          ))}
          {showLog && log.length === 0 && <Muted size={12.5}>Nothing logged yet.</Muted>}
        </Card>

        <SectionTitle>The rules that protect your child</SectionTitle>
        {U18_PROMISES.map((p) => (
          <Card key={p.slice(0, 20)}>
            <Muted size={13}>{p}</Muted>
          </Card>
        ))}

        <Button
          label="Log out"
          onPress={() => {
            logout();
            router.replace('/onboarding');
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  h1: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 6 },
  org: { color: colors.text, fontSize: 16, fontWeight: '700' },
  msg: { color: colors.text, fontSize: 14, fontStyle: 'italic', lineHeight: 20 },
  input: {
    backgroundColor: colors.bg2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  exportPreview: {
    color: colors.muted, fontSize: 11, fontFamily: 'monospace', lineHeight: 15,
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 8, marginTop: 6,
  },
});
