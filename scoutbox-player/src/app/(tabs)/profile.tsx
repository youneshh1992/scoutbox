import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import {
  AVAILABILITY_LABELS, CONTRACT_LABELS,
  type Availability, type ContractStatus,
} from '../../domain/types';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle, TrustBar } from '../../components/ui';

export default function Profile() {
  const { playerId, me, refresh } = useSession();
  if (!playerId || !me) return null;

  const set = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch {
      /* surfaced through unrefreshed UI */
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>{me.name}</Text>
        <Muted>
          {me.position ?? '—'} · {me.age} · {me.foot ?? '—'} foot · {me.city ? `${me.city}, ` : ''}{me.country}
          {me.heightCm ? ` · ${me.heightCm} cm` : ''}
        </Muted>
        <Row>
          {me.identityVerified && <Pill label="Identity verified" tone="green" />}
          {me.badges.map((b) => <Pill key={b} label={b} tone="gold" />)}
        </Row>

        <Card>
          <TrustBar score={me.trustScore} />
          <Muted size={12.5}>
            Base {me.trust.base} · identity +{me.trust.identityVerified} · attendance +{me.trust.verifiedAttendance} ·
            trial reports +{me.trust.trialReports} · media +{me.trust.media} · profile +{me.trust.profileComplete}
          </Muted>
          <Muted size={12.5}>
            Trust rises through things ScoutBox can corroborate — verified attendance and clubs&apos; filed trial
            reports — never through payments. Sharing medical data has no effect either way.
          </Muted>
        </Card>

        {me.stats && (
          <Card>
            <SectionTitle>Season output</SectionTitle>
            <Row>
              <Stat v={String(me.stats.appearances)} k="Apps" />
              {me.position === 'GK' ? (
                <Stat v={String(me.stats.cleanSheets ?? 0)} k="Clean sheets" />
              ) : (
                <>
                  <Stat v={String(me.stats.goals)} k="Goals" />
                  <Stat v={String(me.stats.assists)} k="Assists" />
                </>
              )}
              {me.stats.paceKmh != null && <Stat v={`${me.stats.paceKmh}`} k="km/h" />}
              {me.stats.passCompletionPct != null && <Stat v={`${me.stats.passCompletionPct}%`} k="Pass" />}
            </Row>
          </Card>
        )}

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={styles.cardTitle}>Academy+</Text>
              <Muted size={12.5}>
                Opt-in cohort for released and late-developing players — a fresh start, surfaced first in club
                searches. Player-controlled: switch it off any time.
              </Muted>
            </View>
            <Switch
              value={me.academyPlus}
              onValueChange={(v) => set(() => client.setAcademyPlus(playerId, v))}
              trackColor={{ true: colors.accent, false: colors.line }}
              thumbColor="#fff"
            />
          </Row>
        </Card>

        <Card>
          <SectionTitle>Availability — shown on your profile</SectionTitle>
          <Row>
            {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((a) => (
              <Button key={a} small primary={me.availability === a} label={AVAILABILITY_LABELS[a]}
                onPress={() => set(() => client.setAvailability(playerId, a, undefined))} />
            ))}
          </Row>
          <SectionTitle>Contract status</SectionTitle>
          <Row>
            {(Object.keys(CONTRACT_LABELS) as ContractStatus[]).filter((c) => c !== 'unknown').map((c) => (
              <Button key={c} small primary={me.contractStatus === c} label={CONTRACT_LABELS[c]}
                onPress={() => set(() => client.setAvailability(playerId, undefined, c))} />
            ))}
          </Row>
        </Card>

        <Card style={me.medical.shared ? { borderColor: colors.gold } : undefined}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={styles.cardTitle}>Medical sharing {me.medical.shared ? '— ON' : '— OFF'}</Text>
              <Muted size={12.5}>
                Your medical history is invisible to every organisation unless you switch this on. That&apos;s
                data-protection law, and it&apos;s your call — sharing never changes your Trust Score.
              </Muted>
            </View>
            <Switch
              value={me.medical.shared}
              onValueChange={(v) => set(() => client.setMedicalShared(playerId, v))}
              trackColor={{ true: colors.gold, false: colors.line }}
              thumbColor="#fff"
            />
          </Row>
          {me.medical.records.map((r) => (
            <Row key={r.id}>
              <Pill label={r.type} />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{r.title}</Text>
              <Muted size={12}>
                {r.date}{r.layoffWeeks ? ` · ${r.layoffWeeks} wks` : ''}{r.cleared ? ' · cleared' : ''}
              </Muted>
            </Row>
          ))}
          {me.medical.records.length === 0 && <Muted size={12.5}>No records logged.</Muted>}
        </Card>

        {me.trialReports.length > 0 && (
          <Card>
            <SectionTitle>Trial performance reports</SectionTitle>
            {me.trialReports.map((r) => (
              <View key={r.id} style={{ gap: 2 }}>
                <Text style={styles.cardTitle}>{r.orgName}</Text>
                <Muted size={12.5}>
                  accel {r.acceleration}/10 · {r.sprintSpeedKmh} km/h · {r.distanceKm} km · pass {r.passCompletionPct}% ·
                  duels {r.duelSuccessPct}% · coach {r.coachRating}/10
                </Muted>
              </View>
            ))}
            <Muted size={12.5}>Filed by clubs after your trials — mandatory, and they raise your Trust Score.</Muted>
          </Card>
        )}

        <Card>
          <SectionTitle>Transfer timeline</SectionTitle>
          {me.timeline.length === 0 && <Muted size={13}>No milestones yet.</Muted>}
          {me.timeline.map((t, i) => (
            <Row key={i}>
              <Pill label={t.year} />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{t.event}</Text>
            </Row>
          ))}
        </Card>

        <Card>
          <SectionTitle>Verified match attendance</SectionTitle>
          {me.attendance.length === 0 && <Muted size={13}>None yet — log one from the Upload tab.</Muted>}
          {me.attendance.map((a) => (
            <Row key={a.id}>
              <Pill label="GPS ✓" tone="green" />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{a.fixture}</Text>
              <Muted size={12}>{a.venue} · {a.date}</Muted>
            </Row>
          ))}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ v, k }: { v: string; k: string }) {
  return (
    <View style={styles.stat}>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>{v}</Text>
      <Muted size={11}>{k}</Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  h1: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 6 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  stat: {
    backgroundColor: colors.bg2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
});
