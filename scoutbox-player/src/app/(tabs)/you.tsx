import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { client, type FiledReport } from '../../data/client';
import type { NotificationPrefs } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { ReportButton } from '../../components/ReportSheet';
import { NotificationBell } from '../../components/NotificationBell';

export default function You() {
  const router = useRouter();
  const { me, mode, isMinor, logout, playerId, notifications } = useSession();
  const [myReports, setMyReports] = useState<FiledReport[]>([]);
  const [prefs, setPrefs] = useState<NotificationPrefs>({ quietStart: null, quietEnd: null, schoolHoursMute: null });
  const [prefsNote, setPrefsNote] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (playerId) client.getMyReports(playerId).then(setMyReports).catch(() => {});
  }, [playerId, notifications]);

  useEffect(() => {
    if (playerId) client.getPrefs(playerId).then((p) => p && setPrefs(p)).catch(() => {});
  }, [playerId]);

  const savePrefs = async (next: Partial<NotificationPrefs>) => {
    if (!playerId) return;
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    try {
      await client.setPrefs(playerId, merged);
      setPrefsNote('Saved. Quiet hours apply to push delivery — the in-app feed always keeps the record.');
    } catch {
      setPrefsNote('Could not save — try again.');
    }
  };

  const doExport = async () => {
    if (!playerId) return;
    try {
      const data = await client.getExport(playerId);
      setExportPreview(JSON.stringify(data, null, 2).slice(0, 1500));
    } catch {
      setExportPreview('Export failed — try again.');
    }
  };

  const doDelete = async () => {
    if (!playerId) return;
    setDeleteError(null);
    try {
      await client.deleteAccount(playerId);
      logout();
      router.replace('/onboarding');
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete');
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>You</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>

        <Card>
          <Text style={styles.cardTitle}>{me?.name ?? '—'}</Text>
          <Muted size={13}>
            {me ? `${me.country}${me.city ? ` · ${me.city}` : ''} · born ${me.dob}` : ''}
          </Muted>
          <Row>
            <Pill label={mode === 'live' ? 'Live sync — connected to scoutbox-server' : 'Demo mode — self-contained'} tone={mode === 'live' ? 'green' : 'blue'} />
          </Row>
        </Card>

        <Card>
          <SectionTitle>Your account, your data</SectionTitle>
          <Muted size={13}>
            ScoutBox is free for players, always. Your profile, your media, your medical records and your
            availability are player-controlled. Organisations act under named-individual accountability and
            everything they do around your profile is on an append-only ledger you benefit from.
          </Muted>
        </Card>

        {isMinor && (
          <Card style={{ borderColor: colors.accent2 }}>
            <SectionTitle>Your guardian-managed account</SectionTitle>
            <Muted size={13}>
              Your parent or guardian owns this account and handles everything club-related. If anything
              on ScoutBox ever makes you uncomfortable, use the ⚑ Report button — it&apos;s on every
              screen — or tell your guardian.
            </Muted>
          </Card>
        )}

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
            Quiet hours pause push notifications overnight{isMinor ? '; the school-hours mute is on by default for under-18 accounts' : ''}.
            Anything sent while muted waits in your feed — nothing is lost.
          </Muted>
          <Row>
            <Muted size={13}>Quiet from</Muted>
            <TextInput
              style={styles.timeInput}
              placeholder="22:00"
              placeholderTextColor={colors.muted}
              value={prefs.quietStart ?? ''}
              onChangeText={(v) => setPrefs((p) => ({ ...p, quietStart: v || null }))}
              onBlur={() => savePrefs({})}
            />
            <Muted size={13}>until</Muted>
            <TextInput
              style={styles.timeInput}
              placeholder="07:00"
              placeholderTextColor={colors.muted}
              value={prefs.quietEnd ?? ''}
              onChangeText={(v) => setPrefs((p) => ({ ...p, quietEnd: v || null }))}
              onBlur={() => savePrefs({})}
            />
          </Row>
          <Row>
            <Button
              small
              primary={prefs.schoolHoursMute === true || (prefs.schoolHoursMute === null && isMinor)}
              label={`School-hours mute: ${prefs.schoolHoursMute === true || (prefs.schoolHoursMute === null && isMinor) ? 'on' : 'off'}`}
              onPress={() => savePrefs({ schoolHoursMute: !(prefs.schoolHoursMute === true || (prefs.schoolHoursMute === null && isMinor)) })}
            />
          </Row>
          {prefsNote && <Muted size={12.5}>{prefsNote}</Muted>}
        </Card>

        <SectionTitle>Your data</SectionTitle>
        <Card>
          <Muted size={13}>
            Take everything with you: profile, threads, requests, insights — one bundle, no questions asked.
          </Muted>
          <Row>
            <Button small label="Preview my data export" onPress={doExport} />
            {exportPreview && <Button small label="Hide preview" onPress={() => setExportPreview(null)} />}
          </Row>
          {exportPreview && (
            <Text style={styles.exportPreview} numberOfLines={30}>{exportPreview}…</Text>
          )}
        </Card>
        {!isMinor && (
          <Card style={confirmDelete ? { borderColor: colors.danger } : undefined}>
            <Muted size={13}>
              Deleting removes your profile, media and threads. The safety ledger keeps its append-only
              record (ids only) so accountability survives the account.
            </Muted>
            {!confirmDelete ? (
              <Row><Button small danger label="Delete my account" onPress={() => setConfirmDelete(true)} /></Row>
            ) : (
              <Row>
                <Button small danger label="Yes — delete everything" onPress={doDelete} />
                <Button small label="Keep my account" onPress={() => setConfirmDelete(false)} />
              </Row>
            )}
            {deleteError && <Text style={{ color: colors.danger, fontSize: 13 }}>{deleteError}</Text>}
          </Card>
        )}

        <SectionTitle>The rules that protect you</SectionTitle>
        {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => (
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
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  timeInput: {
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, color: colors.text,
    paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, minWidth: 72, backgroundColor: colors.bg2,
  },
  exportPreview: {
    color: colors.muted, fontSize: 11, fontFamily: 'monospace', lineHeight: 15,
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 8, marginTop: 6,
  },
});
