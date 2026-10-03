// You — M24F.2. Three page tabs (Profile, Account, Clubs), each a page that
// fits a phone. Profile is the M24F.1 composition. Account is a short list
// of categories — Profile, Privacy, Preferences, Appearance — with Switch
// account and Sign out beneath it; a category opens its own settings, and
// `?section=` deep-links it. Clubs is four categories — Current, Requests,
// Development, History — on the same `?section=` parameter. Nothing the
// old pages held is gone: it is grouped, and a row stands on its own
// label; supporting copy is the exception.
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { client, type FiledReport, type SeasonWrap } from '../../data/client';
import type { InboxRequest } from '../../domain/types';
import type { NotificationPrefs } from '../../data/types';
import { SAFEGUARDING_PROMISES, U18_PROMISES } from '../../domain/safeguarding';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { Button, Disclosure, ListRow, Muted, Pill, Row } from '../../components/ui';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { PageHeader, PageTabs, pickTab } from '../../components/PageChrome';
import { Icon } from '../../components/Icon';
import { AccessSection } from '../../components/M12Sections';
import { PreferencesSection } from '../../components/M13Sections';
import { InviteCodeSection } from '../../components/M14Sections';
import { ClubsCurrent, ClubsDevelopment, ClubsHistory, ClubsRequests } from '../../components/ClubsSections';
import { AvailabilitySettings, MedicalSettings, ProfileBody } from './profile';

const isRequest = (r: unknown): r is InboxRequest => !!r && typeof r === 'object' && 'createdAt' in (r as object) && 'orgName' in (r as object);

export default function You() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { me, mode, isMinor, logout, playerId, notifications, inbox } = useSession();
  const params = useLocalSearchParams<{ tab?: string; section?: string }>();
  const TABS = [
    { key: 'profile', label: pt('segProfile') },
    { key: 'account', label: pt('segAccount') },
    { key: 'clubs', label: pt('segClubs') },
  ];
  const [tab, setTabState] = useState(() => pickTab(TABS, params.tab));
  useEffect(() => { if (params.tab) setTabState(pickTab(TABS, params.tab)); }, [params.tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // M24F.2 — a tab or category change is a history entry on the web (the router's own navigation to the
  // same tab screen only replaces the entry), so the browser's back and forward move between them.
  const remember = (tabKey: string, sec: string) => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.history?.pushState) return;
    try { window.history.pushState(window.history.state, '', `/you?tab=${tabKey}${sec ? `&section=${sec}` : ''}`); } catch { /* history is a convenience */ }
  };
  const setTab = (k: string) => { setTabState(k); setChosen(null); remember(k, ''); try { router.setParams({ tab: k, section: '' }); } catch { /* links only */ } };

  // the category inside Account / Clubs: the URL's `?section=` when it names one, else the last tap (no effect)
  const ACCOUNT = [
    { key: 'profile', label: pt('accProfile') },
    { key: 'privacy', label: pt('accPrivacy') },
    { key: 'preferences', label: pt('accPreferences') },
    { key: 'appearance', label: pt('accAppearance') },
  ];
  const CLUBS = [
    { key: 'current', label: pt('clubsCurrent') },
    { key: 'requests', label: pt('clubsRequests') },
    { key: 'development', label: pt('clubsDevelopment') },
    { key: 'history', label: pt('clubsHistory') },
  ];
  const [chosen, setChosen] = useState<string | null>(null);
  const [seenParam, setSeenParam] = useState(params.section);
  if (params.section !== seenParam) { setSeenParam(params.section); setChosen(null); }
  const section = chosen ?? (typeof params.section === 'string' ? params.section : '');
  const go = (k: string) => { setChosen(k); remember(tab, k); try { router.setParams({ section: k }); } catch { /* links only */ } };
  const accountSection = ACCOUNT.some((s) => s.key === section) ? section : '';
  const clubsSection = CLUBS.some((s) => s.key === section) ? section : 'current';

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
    try { await client.setPrefs(playerId, merged); setPrefsNote('Saved.'); } catch { setPrefsNote('Could not save — try again.'); }
  };
  const doExport = async () => {
    if (!playerId) return;
    try { const data = await client.getExport(playerId); setExportPreview(JSON.stringify(data, null, 2).slice(0, 1500)); } catch { setExportPreview('Export failed — try again.'); }
  };
  const doDelete = async () => {
    if (!playerId) return;
    setDeleteError(null);
    try { await client.deleteAccount(playerId); logout(); router.replace('/onboarding'); } catch (e) { setDeleteError(e instanceof Error ? e.message : 'Could not delete'); }
  };

  const mediaOptions = (me?.media ?? []).map((m) => ({ id: m.id, title: m.title }));
  const actor = playerId ? { kind: 'player' as const, id: playerId } : null;
  const requests = inbox.filter(isRequest);
  const schoolMute = prefs.schoolHoursMute === true || (prefs.schoolHoursMute === null && isMinor);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader title={pt('tabYou')} />
        <PageTabs tabs={TABS} value={tab} onChange={setTab} />

        {tab === 'profile' && <ProfileBody />}

        {tab === 'account' && accountSection === '' && (
          <View testID="account-root">
            <View style={styles.who}>
              <Text style={styles.whoName}>{me?.name ?? '—'}</Text>
              <Muted size={13}>{me ? [me.city, me.country].filter(Boolean).join(', ') : ''}</Muted>
            </View>
            <ListRow label={pt('accProfile')} onPress={() => go('profile')} testID="account-cat-profile" />
            <ListRow label={pt('accPrivacy')} onPress={() => go('privacy')} testID="account-cat-privacy" />
            <ListRow label={pt('accPreferences')} onPress={() => go('preferences')} testID="account-cat-preferences" />
            <ListRow label={pt('accAppearance')} onPress={() => go('appearance')} testID="account-cat-appearance" />
            {/* M24E — the way out: Sign out ends this identity's session on the server and on the device; Switch account does the same and opens the entry screen on Sign in. */}
            <View style={{ marginTop: 26 }}>
              <ListRow label="Switch account" icon="users" testID="switch-account" onPress={() => { logout(); router.replace('/onboarding?mode=signin'); }} />
              <ListRow label="Sign out" icon="log-out" testID="sign-out" onPress={() => { logout(); router.replace('/onboarding'); }} />
            </View>
            <Text style={styles.env}>{mode === 'live' ? 'Live — connected to scoutbox-server' : 'Demo — sample data'}</Text>
          </View>
        )}

        {tab === 'account' && accountSection !== '' && (
          <View testID={`account-section-${accountSection}`}>
            <Pressable onPress={() => go('')} accessibilityRole="button" accessibilityLabel={pt('accBack')} testID="account-back" hitSlop={6} style={({ pressed }) => [styles.back, pressed && { opacity: 0.7 }]}>
              <Icon name="chevron-left" size={15} color={colors.accent2} />
              <Text style={styles.backText}>{pt('accBack')}</Text>
            </Pressable>
            <PageTabs tabs={ACCOUNT} value={accountSection} onChange={go} />
            <View style={styles.section}>
              {accountSection === 'profile' && (
                <>
                  <ListRow label={pt('segProfile')} onPress={() => setTab('profile')} icon="user-round" testID="account-open-profile" />
                  <AvailabilitySettings />
                  {me?.pathway && (
                    <Disclosure label="Your season" testID="account-season">
                      {!wrap && <Row><Button small label="Show my season" onPress={async () => { try { setWrap(await client.getSeasonWrap(playerId!)); } catch { /* stays hidden */ } }} /></Row>}
                      {wrap && (
                        <View style={{ gap: 6 }}>
                          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>{wrap.player.name} — {wrap.player.level === 'semi_pro' ? 'Semi-pro' : 'Amateur'} {wrap.player.position ?? ''}</Text>
                          <Muted size={13}>{[wrap.season ? `${wrap.season.goals} goals` : null, wrap.season ? `${wrap.season.appearances} appearances` : null, `${wrap.verifiedAttendances} verified matches`, `${wrap.verifiedClips} verified clips`, `best streak ${wrap.bestStreak}`, `${wrap.scoutViews} scout views`, wrap.coachVouches > 0 ? `${wrap.coachVouches} coach reference${wrap.coachVouches === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</Muted>
                          {wrap.combineBests.length > 0 && <Muted size={12.5}>Combine bests: {wrap.combineBests.map((b) => `${b.metric} ${b.value}${b.unit}`).join(' · ')}</Muted>}
                          {wrap.badges.length > 0 && <Muted size={12.5}>{wrap.badges.join(' · ')}</Muted>}
                          <Muted size={11.5}>{wrap.note}</Muted>
                        </View>
                      )}
                    </Disclosure>
                  )}
                  {actor && !isMinor ? <InviteCodeSection actor={actor} /> : null}
                </>
              )}

              {accountSection === 'privacy' && (
                <>
                  {/* one section-level sentence, not a note under every row */}
                  <Muted size={13.5}>{pt('accPrivacyIntro')}</Muted>
                  <View style={{ height: 10 }} />
                  <MedicalSettings />
                  <Disclosure label="Your data" testID="account-privacy">
                    {isMinor && <Muted size={13}>Your parent or guardian owns this account and handles everything club-related. If anything on ScoutBox ever makes you uncomfortable, use the Report button or tell your guardian.</Muted>}
                    <Row>
                      <Button small label="Preview my data export" onPress={doExport} />
                      {exportPreview && <Button small tertiary label="Hide preview" onPress={() => setExportPreview(null)} />}
                    </Row>
                    {exportPreview && <Text style={styles.exportPreview} numberOfLines={30}>{exportPreview}…</Text>}
                    {!isMinor && (
                      <View style={{ gap: 8, marginTop: 6 }}>
                        <Muted size={13}>Deleting removes your profile, media and threads. The safety ledger keeps its append-only record (ids only).</Muted>
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
                  <Disclosure label="The rules that protect you" testID="account-rules">
                    {(isMinor ? U18_PROMISES : SAFEGUARDING_PROMISES).map((p) => <Muted key={p.slice(0, 20)} size={13}>{p}</Muted>)}
                  </Disclosure>
                </>
              )}

              {accountSection === 'preferences' && (
                <>
                  {actor ? <PreferencesSection actor={actor} isMinor={isMinor} /> : null}
                  <Disclosure label="Notifications" hint={prefs.quietStart || prefs.quietEnd ? `Quiet ${prefs.quietStart ?? '—'} to ${prefs.quietEnd ?? '—'}` : undefined} testID="account-notifications">
                    <Row>
                      <Muted size={13}>Quiet from</Muted>
                      <TextInput style={styles.timeInput} placeholder="22:00" placeholderTextColor={colors.muted} value={prefs.quietStart ?? ''} onChangeText={(v) => setPrefs((p) => ({ ...p, quietStart: v || null }))} onBlur={() => savePrefs({})} accessibilityLabel="Quiet from" />
                      <Muted size={13}>until</Muted>
                      <TextInput style={styles.timeInput} placeholder="07:00" placeholderTextColor={colors.muted} value={prefs.quietEnd ?? ''} onChangeText={(v) => setPrefs((p) => ({ ...p, quietEnd: v || null }))} onBlur={() => savePrefs({})} accessibilityLabel="Quiet until" />
                    </Row>
                    <Row>
                      <Button small primary={schoolMute} label={`School-hours mute: ${schoolMute ? 'on' : 'off'}`} onPress={() => savePrefs({ schoolHoursMute: !schoolMute })} />
                    </Row>
                    {prefsNote && <Muted size={12.5}>{prefsNote}</Muted>}
                  </Disclosure>
                  {playerId ? (
                    <Disclosure label="Access & language" testID="account-access">
                      <AccessSection playerId={playerId} isMinor={isMinor} mediaOptions={mediaOptions} />
                    </Disclosure>
                  ) : null}
                </>
              )}

              {accountSection === 'appearance' && (
                <ListRow label={pt('accAppearance')} value="Light or dark" right={<ThemeSwitch />} testID="account-appearance" />
              )}
            </View>
          </View>
        )}

        {tab === 'clubs' && actor && (
          <View testID="clubs-page">
            <PageTabs tabs={CLUBS} value={clubsSection} onChange={go} />
            <View style={styles.section}>
              {clubsSection === 'current' && <ClubsCurrent actor={actor} isMinor={isMinor} mediaOptions={mediaOptions} />}
              {clubsSection === 'requests' && <ClubsRequests actor={actor} isMinor={isMinor} requests={requests} />}
              {clubsSection === 'development' && <ClubsDevelopment actor={actor} />}
              {clubsSection === 'history' && <ClubsHistory actor={actor} isMinor={isMinor} requests={requests} />}
            </View>
          </View>
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
  section: { paddingTop: 18 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 8, alignSelf: 'flex-start' },
  backText: { color: colors.accent2, fontSize: 13, fontWeight: '500' },
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
