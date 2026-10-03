// M23 P2.5 — You: the player's own record and their account, as three page
// tabs. Profile (the former Profile tab's body), Account (notifications,
// data, safety, the rules) and Clubs (what clubs have published to you and
// what you share with them). The football record moved to the Football tab
// and placement check-ins to Opportunities; every section is the same
// component reading the same server projection as before.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { client, type FiledReport, type SeasonWrap } from '../../data/client';
import type { NotificationPrefs } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { Button, Disclosure, ListRow, Muted, Pill, Row } from '../../components/ui';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { PageHeader, PageTabs, pickTab } from '../../components/PageChrome';
import { AccessSection, FeedbackDevSection } from '../../components/M12Sections';
import { ExposureSection, PreferencesSection, RepresentationSection, TransitionsSection } from '../../components/M13Sections';
import { InviteCodeSection, ReferencesSection } from '../../components/M14Sections';
import { AgentSharedOpportunities, MyAgentSection } from '../../components/MyAgentSection';
import { AgentConsentSection } from '../../components/AgentConsentSection';
import { AgentTransactionSection } from '../../components/AgentTransactionSection';
import { ProfileBody } from './profile';

export default function You() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { me, mode, isMinor, logout, playerId, notifications } = useSession();
  const params = useLocalSearchParams<{ tab?: string }>();
  const TABS = [
    { key: 'profile', label: pt('segProfile') },
    { key: 'account', label: pt('segAccount') },
    { key: 'clubs', label: pt('segClubs') },
  ];
  const [tab, setTab] = useState(() => pickTab(TABS, params.tab));
  useEffect(() => { if (params.tab) setTab(pickTab(TABS, params.tab)); }, [params.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const [myReports, setMyReports] = useState<FiledReport[]>([]);
  const [prefs, setPrefs] = useState<NotificationPrefs>({ quietStart: null, quietEnd: null, schoolHoursMute: null });
  const [prefsNote, setPrefsNote] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [wrap, setWrap] = useState<SeasonWrap | null>(null);

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

  const mediaOptions = (me?.media ?? []).map((m) => ({ id: m.id, title: m.title }));
  const actor = playerId ? { kind: 'player' as const, id: playerId } : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader title={pt('tabYou')} />
        <PageTabs tabs={TABS} value={tab} onChange={setTab} />

        {tab === 'profile' && <ProfileBody />}

        {tab === 'account' && (
          <>
            {/* M24F — the Account page is a list, not a stack of boxes: who you
                are, then one row per setting, each opening its detail in place.
                Nothing the previous page said is gone; it is one tap away. */}
            <View style={styles.who}>
              <Text style={styles.whoName}>{me?.name ?? '—'}</Text>
              <Muted size={13}>{me ? `${me.country}${me.city ? ` · ${me.city}` : ''} · born ${me.dob}` : ''}</Muted>
            </View>

            <ListRow label={pt('segProfile')} value="Name, position, availability, media" onPress={() => setTab('profile')} icon="user-round" />
            <ListRow label={pt('segClubs')} value="What clubs and agents can see and share" onPress={() => setTab('clubs')} icon="building-2" />

            <Disclosure label="Privacy and your data" hint="Export everything; delete your account" testID="account-privacy">
              <Muted size={13}>
                ScoutBox is free for players, always. Your profile, your media, your medical records and your
                availability are player-controlled. Organisations act under named-individual accountability and
                everything they do around your profile is on an append-only ledger you benefit from.
              </Muted>
              {isMinor && (
                <Muted size={13}>
                  Your parent or guardian owns this account and handles everything club-related. If anything
                  on ScoutBox ever makes you uncomfortable, use the Report button — it&apos;s on every
                  screen — or tell your guardian.
                </Muted>
              )}
              <Muted size={13}>Take everything with you: profile, threads, requests, insights — one bundle, no questions asked.</Muted>
              <Row>
                <Button small label="Preview my data export" onPress={doExport} />
                {exportPreview && <Button small tertiary label="Hide preview" onPress={() => setExportPreview(null)} />}
              </Row>
              {exportPreview && <Text style={styles.exportPreview} numberOfLines={30}>{exportPreview}…</Text>}
              {!isMinor && (
                <View style={{ gap: 8, marginTop: 6 }}>
                  <Muted size={13}>
                    Deleting removes your profile, media and threads. The safety ledger keeps its append-only
                    record (ids only) so accountability survives the account.
                  </Muted>
                  {!confirmDelete ? (
                    <Row><Button small danger label="Delete my account" onPress={() => setConfirmDelete(true)} /></Row>
                  ) : (
                    <Row>
                      <Button small danger label="Yes — delete everything" onPress={doDelete} />
                      <Button small tertiary label="Keep my account" onPress={() => setConfirmDelete(false)} />
                    </Row>
                  )}
                  {deleteError && <Text style={{ color: colors.danger, fontSize: 13 }}>{deleteError}</Text>}
                </View>
              )}
            </Disclosure>

            <Disclosure label="Notifications" hint={prefs.quietStart || prefs.quietEnd ? `Quiet ${prefs.quietStart ?? '—'} to ${prefs.quietEnd ?? '—'}` : 'Quiet hours, school-hours mute'} testID="account-notifications">
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
            </Disclosure>

            <ListRow label="Appearance" value="Light or dark, for this app" right={<ThemeSwitch />} testID="account-appearance" />

            {playerId ? (
              <Disclosure label="Access & language" hint="Language, data saver, captions, who can see which clip" testID="account-access">
                <AccessSection playerId={playerId} isMinor={isMinor} mediaOptions={mediaOptions} />
              </Disclosure>
            ) : null}

            {myReports.length > 0 && (
              <Disclosure label="Safety centre" hint={`${myReports.length} report${myReports.length === 1 ? '' : 's'} you filed`} testID="account-safety">
                {myReports.map((r) => (
                  <View key={r.id} style={{ gap: 2, paddingVertical: 4 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{r.reason}</Text>
                      <Pill label={r.status === 'resolved' ? 'Reviewed' : 'In review'} tone={r.status === 'resolved' ? 'green' : 'gold'} />
                    </Row>
                    {r.outcome && <Muted size={12.5}>{r.outcome}</Muted>}
                  </View>
                ))}
              </Disclosure>
            )}

            {me?.pathway && (
              <Disclosure label="Your season" hint="Goals, appearances, verified matches and clips" testID="account-season">
                {!wrap && <Row><Button small label="Show my season" onPress={async () => { try { setWrap(await client.getSeasonWrap(playerId!)); } catch { /* stays hidden */ } }} /></Row>}
                {wrap && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>
                      {wrap.player.name} — {wrap.player.level === 'semi_pro' ? 'Semi-pro' : 'Amateur'} {wrap.player.position ?? ''}
                    </Text>
                    <Muted size={13}>
                      {[wrap.season ? `${wrap.season.goals} goals` : null, wrap.season ? `${wrap.season.appearances} appearances` : null, `${wrap.verifiedAttendances} verified matches`, `${wrap.verifiedClips} verified clips`, `best streak ${wrap.bestStreak}`, `${wrap.scoutViews} scout views`, wrap.coachVouches > 0 ? `${wrap.coachVouches} coach reference${wrap.coachVouches === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
                    </Muted>
                    {wrap.combineBests.length > 0 && <Muted size={12.5}>Combine bests: {wrap.combineBests.map((b) => `${b.metric} ${b.value}${b.unit}`).join(' · ')}</Muted>}
                    {wrap.badges.length > 0 && <Muted size={12.5}>{wrap.badges.join(' · ')}</Muted>}
                    <Muted size={11.5}>{wrap.note}</Muted>
                    <Row><Button small tertiary label="Refresh" onPress={async () => { try { setWrap(await client.getSeasonWrap(playerId!)); } catch { /* stays */ } }} /></Row>
                  </View>
                )}
              </Disclosure>
            )}

            <Disclosure label="The rules that protect you" hint={isMinor ? 'Our promises to every under-18' : 'Our promises to every player'} testID="account-rules">
              {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => <Muted key={p.slice(0, 20)} size={13}>{p}</Muted>)}
            </Disclosure>

            {actor && !isMinor ? <InviteCodeSection actor={actor} /> : null}

            {/* M24E — the way out. Sign out ends this identity's session on the
                server and on the device and returns to the entry screen; Switch
                account does the same and opens the entry screen on Sign in, so the
                next person signs in as themselves — no identity carries over. */}
            <View style={{ marginTop: 18 }}>
              <ListRow label="Switch account" value="Sign in as someone else on this device" icon="users" testID="switch-account" onPress={() => { logout(); router.replace('/onboarding?mode=signin'); }} />
              <ListRow label="Sign out" icon="log-out" testID="sign-out" onPress={() => { logout(); router.replace('/onboarding'); }} />
            </View>
            <Text style={styles.env}>{mode === 'live' ? 'Live — connected to scoutbox-server' : 'Demo — self-contained sample data'}</Text>
          </>
        )}

        {tab === 'clubs' && actor && (
          <>
            <FeedbackDevSection actor={actor} />
            <PreferencesSection actor={actor} isMinor={isMinor} />
            <TransitionsSection actor={actor} isMinor={isMinor} mediaOptions={mediaOptions} />
            <MyAgentSection playerId={actor.id} isMinor={isMinor} />
            <AgentSharedOpportunities playerId={actor.id} isMinor={isMinor} />
            <AgentConsentSection playerId={actor.id} isMinor={isMinor} />
            <AgentTransactionSection playerId={actor.id} isMinor={isMinor} />
            <RepresentationSection playerId={actor.id} isMinor={isMinor} />
            <ExposureSection playerId={actor.id} />
            <ReferencesSection playerId={actor.id} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
  who: { paddingTop: 6, paddingBottom: 16, gap: 2 },
  whoName: { color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.6 },
  env: { color: colors.muted, fontSize: 11.5, marginTop: 24, textAlign: 'center' },
  timeInput: {
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, color: colors.text,
    paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, minWidth: 72, backgroundColor: colors.bg2,
  },
  exportPreview: {
    color: colors.muted, fontSize: 11, fontFamily: 'monospace', lineHeight: 15,
    borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 8, marginTop: 6,
  },
});
