// M23 P2.5 — Opportunities: everything a player can pursue and everything a
// club has put in front of them. The board and fit check lived at the foot
// of Home; squad invitations and trial days at the foot of Inbox; placement
// check-ins at the foot of You. Same sections, one destination.
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { pt } from '../../i18n';
import { PageHeader } from '../../components/PageChrome';
import { BoardSection, FollowUpsSection, SquadInvitesSection, TrialSafetySection } from '../../components/M12Sections';
import { OpportunityFitSection } from '../../components/M13Sections';
import { TrialWorkflowSection } from '../../components/M23Trial';

export default function Opportunities() {
  const { playerId } = useSession();
  const actor = playerId ? { kind: 'player' as const, id: playerId } : null;
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader title={pt('tabOpportunities')} hint={pt('opportunitiesHint')} />
        {actor ? <BoardSection actor={actor} /> : null}
        {actor ? <OpportunityFitSection actor={actor} /> : null}
        {actor ? <SquadInvitesSection actor={actor} /> : null}
        {actor ? <TrialWorkflowSection actor={actor} /> : null}
        {actor ? <TrialSafetySection actor={actor} /> : null}
        {actor ? <FollowUpsSection actor={actor} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
});
