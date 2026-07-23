// Guardian dashboard — parents own every under-18 account. All club contact
// lands here (club-first identity, verified role), the parent accepts or
// declines, and the full communications log is always visible.

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, useRouter } from 'expo-router';
import { client } from '../data/client';
import { U18_PROMISES } from '../domain/safeguarding';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle, TrustBar } from '../components/ui';
import { ReportButton } from '../components/ReportSheet';

export default function GuardianDashboard() {
  const router = useRouter();
  const { kind, guardianId, guardian, guardianInbox, children, refresh, logout, mode } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<{ id: string; ts: number; type: string; orgName: string; scoutName: string }[]>([]);

  useEffect(() => {
    if (showLog && guardianId) client.guardianLog(guardianId).then(setLog).catch(() => {});
  }, [showLog, guardianId, guardianInbox]);

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
          <ReportButton />
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

        <SectionTitle>Your children</SectionTitle>
        {children.map((c) => (
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
        ))}

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
});
