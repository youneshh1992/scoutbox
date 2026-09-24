// M23 P8 — the player's (or guardian's) recruitment journeys: one line per
// club, derived on the server only from records that reached this person —
// a contact, a trial invitation, a schedule, an Offer, a signing. The stage
// word and the next action come from GET /player/journeys; nothing here
// derives them, and nothing here knows about a club's watchlist, its
// priority, its decision or its assessments (§16, §58).
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';
import { m12, type PlayerJourney, type PlayerJourneyStage } from '../data/m12client';
import { colors } from '../theme';
import { pt } from '../i18n';
import { Card, Muted, Pill, Row, SectionTitle } from './ui';

type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };

const GLYPH: Record<PlayerJourneyStage, string> = { contacted: '✉', trial_invited: '➤', trial_scheduled: '📅', trial_completed: '✓', offer_received: '➤', offer_accepted: '✓', offer_declined: '✕', signing: '✍', signed: '✓', none: '○' };
const tone = (s: PlayerJourneyStage) => (s === 'signed' || s === 'offer_accepted' || s === 'trial_completed' ? 'green' : s === 'offer_received' || s === 'trial_invited' || s === 'signing' ? 'gold' : s === 'offer_declined' ? 'red' : 'default');
const stLabel = (s: PlayerJourneyStage) => { const key = `jnSt_${s}` as Parameters<typeof pt>[0]; try { return pt(key) ?? s; } catch { return s; } };
const nextLabel = (code: string) => { const key = `jnNext_${code}` as Parameters<typeof pt>[0]; try { return pt(key) ?? ''; } catch { return ''; } };

export function JourneySection({ actor }: { actor: Actor }) {
  const [items, setItems] = useState<PlayerJourney[] | null>(null);
  // Every return to the tab re-reads: a club may have moved while the person was elsewhere (§55).
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(useCallback(() => { setFocusTick((x) => x + 1); }, []));
  useEffect(() => {
    let on = true;
    (actor.kind === 'player' ? m12.getJourneys(actor.id) : m12.gJourneys(actor.id, actor.childId)).then((x) => on && setItems(x)).catch(() => on && setItems([]));
    return () => { on = false; };
  }, [actor.id, actor.kind, focusTick]);
  if (!items || items.length === 0) return null;
  return (
    <View testID="journey-section"><Card>
      <SectionTitle>{pt('jnTitle')}</SectionTitle>
      <Muted size={12.5}>{pt('jnHint')}</Muted>
      <View style={{ gap: 8, marginTop: 6 }}>
        {items.map((j) => (
          <View key={j.club.id} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 4 }} testID={`journey-club-${j.club.id}`} accessibilityRole="summary" accessibilityLabel={`${j.club.name ?? ''}: ${stLabel(j.journey.stage)}`}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }}>{j.club.name ?? pt('jnClub')}</Text>
              <Pill label={`${GLYPH[j.journey.stage] ?? ''} ${stLabel(j.journey.stage)}`} tone={tone(j.journey.stage)} />
            </Row>
            {j.journey.nextAction.code !== 'NONE' ? (
              <Text style={{ color: colors.accent, fontSize: 13 }} testID="journey-next">{nextLabel(j.journey.nextAction.code)}</Text>
            ) : (
              <Muted size={12.5}>{pt('jnNothingToDo')}</Muted>
            )}
            {j.journey.timeline.length > 0 ? (
              <Muted size={11.5}>{pt('jnLast')} {lastLabel(j.journey.timeline[j.journey.timeline.length - 1].kind)} · {new Date(j.journey.timeline[j.journey.timeline.length - 1].at).toLocaleDateString()}</Muted>
            ) : null}
          </View>
        ))}
      </View>
    </Card></View>
  );
}

function lastLabel(kind: string) { const key = `jnEv_${kind}` as Parameters<typeof pt>[0]; try { return pt(key) ?? kind.replace(/_/g, ' '); } catch { return kind.replace(/_/g, ' '); } }
