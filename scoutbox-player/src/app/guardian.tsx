// Guardian dashboard — parents own every under-18 account. All club contact
// lands here (club-first identity, verified role), the parent accepts or
// declines, and the full communications log is always visible.

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, useRouter } from 'expo-router';
import { client, type Channel, type FiledReport, type Insights } from '../data/client';
import { U18_PROMISES } from '../domain/safeguarding';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle, TrustBar } from '../components/ui';
import { ReportButton } from '../components/ReportSheet';
import { NotificationBell } from '../components/NotificationBell';
import { Threads } from '../components/Threads';

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

  useEffect(() => {
    if (showLog && guardianId) client.guardianLog(guardianId).then(setLog).catch(() => {});
  }, [showLog, guardianId, guardianInbox]);

  useEffect(() => {
    if (!guardianId) return;
    client.guardianChannels(guardianId).then(setChannels).catch(() => {});
    client.guardianReports(guardianId).then(setMyReports).catch(() => {});
    for (const c of children) {
      client.guardianChildInsights(guardianId, c.id).then((i) => setInsights((prev) => ({ ...prev, [c.id]: i }))).catch(() => {});
    }
  }, [guardianId, children, guardianInbox, notifications]);

  if (kind !== 'guardian') return <Redirect href="/onboarding" />;

  const respond = async (requestId: string, accept: boolean) => {
    if (!guardianId) return;
    setError(null);
    try {
      await client.guardianRespond(guardianId, requestId, accept);
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>Guardian</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>
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

        <SectionTitle>Messages with clubs — adult to adult</SectionTitle>
        <Threads
          channels={channels}
          onSend={(channelId, text) => client.guardianSendMessage(guardianId!, channelId, text)}
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
});
