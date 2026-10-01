// M23 P2.5 — Opportunities: everything a player can pursue and everything a
// club has put in front of them.
//
// M24B — the recruitment experience is CATEGORY → SUBCATEGORY: My journey,
// Club contact, Trial, Offer, Signing, and the Board the screen always
// carried. Only the chosen page renders; `?cat=&tab=` deep-links it and a
// notification opens the category that holds its record. A category is UI
// organisation only — the stage a club is at comes from the server's journey
// projection and nothing here knows a club's private state.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { PitchBackdrop } from '../../components/PitchBackdrop';
import { useSession } from '../../state';
import { useStyles, type Palette } from '../../theme';
import { pt } from '../../i18n';
import { PageHeader, PageTabs } from '../../components/PageChrome';
import { CaseCategories } from '../../components/CaseNav';
import { PLAYER_NAV, playerLocation, type PlayerCaseLocation } from '../../caseNav';
import { BoardSection, FollowUpsSection, SquadInvitesSection, TrialSafetySection } from '../../components/M12Sections';
import { OpportunityFitSection } from '../../components/M13Sections';
import { TrialWorkflowSection } from '../../components/M23Trial';
import { OfferSection } from '../../components/M23Offer';
import { SigningSection } from '../../components/M23Signing';
import { JourneySection } from '../../components/M23Journey';
import { ContactRequestsSection, MessagesSummarySection } from '../../components/M24Contact';

export default function Opportunities() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { playerId } = useSession();
  const params = useLocalSearchParams<{ cat?: string; tab?: string }>();
  const [loc, setLoc] = useState<PlayerCaseLocation>(() => playerLocation(params.cat, params.tab));
  useEffect(() => { setLoc(playerLocation(params.cat, params.tab)); }, [params.cat, params.tab]);
  const go = (next: PlayerCaseLocation) => {
    setLoc(next);
    try { router.setParams({ cat: next.category, tab: next.sub }); } catch { /* the params are a convenience for links; the state is already set */ }
  };
  const goCategory = (category: string) => {
    const c = PLAYER_NAV.categories.find((x) => x.id === category);
    if (c) go({ category: c.id, sub: c.subs[0].id });
  };
  const category = PLAYER_NAV.categories.find((c) => c.id === loc.category) ?? PLAYER_NAV.categories[0];
  const sub = category.subs.some((s) => s.id === loc.sub) ? loc.sub : category.subs[0].id;
  const tabs = category.subs.map((s) => ({ key: s.id, label: pt(s.labelKey as Parameters<typeof pt>[0]) }));
  const actor = playerId ? { kind: 'player' as const, id: playerId } : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
        <PitchBackdrop />
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader title={pt('tabOpportunities')} hint={pt('opportunitiesHint')} />
        <CaseCategories model={PLAYER_NAV} value={category.id} onChange={goCategory} />
        <PageTabs tabs={tabs} value={sub} onChange={(k) => go({ category: category.id, sub: k })} />
        <View testID={`case-panel-${sub}`} style={styles.panel} accessibilityLabel={pt(category.labelKey as Parameters<typeof pt>[0])}>
          {actor && sub === 'overview' ? <JourneySection actor={actor} view="overview" /> : null}
          {actor && sub === 'stage' ? <JourneySection actor={actor} view="stage" /> : null}
          {actor && sub === 'tasks' ? <JourneySection actor={actor} view="tasks" onGo={goCategory} /> : null}
          {actor && sub === 'activity' ? <JourneySection actor={actor} view="activity" /> : null}
          {sub === 'messages' ? <MessagesSummarySection /> : null}
          {sub === 'requests' ? <ContactRequestsSection kind="contact" /> : null}
          {sub === 'invitation' ? <ContactRequestsSection kind="trial" /> : null}
          {actor && sub === 'schedule' ? <TrialWorkflowSection actor={actor} standalone /> : null}
          {actor && sub === 'details' ? <TrialSafetySection actor={actor} /> : null}
          {actor && sub === 'offer-terms' ? <OfferSection actor={actor} view="offer" /> : null}
          {actor && sub === 'offer-documents' ? <OfferSection actor={actor} view="documents" /> : null}
          {actor && sub === 'offer-response' ? <OfferSection actor={actor} view="response" /> : null}
          {actor && sub === 'signing-status' ? <SigningSection actor={actor} view="signing" /> : null}
          {actor && sub === 'signing-documents' ? <SigningSection actor={actor} view="documents" /> : null}
          {actor && sub === 'signing-contract' ? <SigningSection actor={actor} view="contract" /> : null}
          {actor && sub === 'board-open' ? <BoardSection actor={actor} /> : null}
          {actor && sub === 'board-fit' ? <OpportunityFitSection actor={actor} /> : null}
          {actor && sub === 'board-invites' ? <SquadInvitesSection actor={actor} /> : null}
          {actor && sub === 'board-followups' ? <FollowUpsSection actor={actor} /> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  panel: { gap: 10 },
});
