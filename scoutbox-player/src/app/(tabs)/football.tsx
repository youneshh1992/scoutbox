// M23 P2.5 — Football: the player's football record in one destination.
// Passport, Development, Box Cam and Combine were the 9th–13th sections of
// the You tab; they are page tabs here, and "+ Add evidence" is the primary
// action (it opens the existing Upload screen, whose route is unchanged).
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, useLocalSearchParams } from 'expo-router';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { pt } from '../../i18n';
import { PageHeader, PageTabs, pickTab } from '../../components/PageChrome';
import { FootballPassportSection } from '../../components/M15Sections';
import { BoxTrainingSection } from '../../components/M16Sections';
import { DevelopmentHubSection } from '../../components/M21Sections';
import { CombineSection } from '../../components/CombineSection';
import { TrustProfileSection } from '../../components/TrustProfileSection';

export default function Football() {
  const { playerId, isMinor } = useSession();
  const params = useLocalSearchParams<{ tab?: string }>();
  const TABS = [
    { key: 'passport', label: pt('segPassport') },
    { key: 'development', label: pt('segDevelopment') },
    { key: 'boxcam', label: pt('segBoxCam') },
    { key: 'combine', label: pt('segCombine') },
  ];
  const [tab, setTab] = useState(() => pickTab(TABS, params.tab));
  useEffect(() => { if (params.tab) setTab(pickTab(TABS, params.tab)); }, [params.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const actor = playerId ? { kind: 'player' as const, id: playerId } : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader
          title={pt('tabFootball')}
          hint={pt('footballHint')}
          action={(
            <Link href="/upload" asChild>
              <Pressable accessibilityRole="button" accessibilityLabel={pt('addEvidence')} style={styles.primary}>
                <Text style={styles.primaryText}>{pt('addEvidence')}</Text>
              </Pressable>
            </Link>
          )}
        />
        <PageTabs tabs={TABS} value={tab} onChange={setTab} />

        {/* M16.2 — the Passport payload carries no numeric score, so the Trust
            Profile is fetched from its own endpoint and composed at the head of
            the Passport, exactly as before. */}
        {actor && tab === 'passport' ? <TrustProfileSection actor={actor} /> : null}
        {actor && tab === 'passport' ? <FootballPassportSection actor={actor} isMinor={isMinor} /> : null}
        {actor && tab === 'development' ? <DevelopmentHubSection actor={actor} /> : null}
        {actor && tab === 'boxcam' ? <BoxTrainingSection actor={actor} isMinor={isMinor} /> : null}
        {actor && tab === 'combine' ? <CombineSection actor={actor} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 12 },
  primaryText: { color: '#04240f', fontWeight: '700', fontSize: 13 },
});
