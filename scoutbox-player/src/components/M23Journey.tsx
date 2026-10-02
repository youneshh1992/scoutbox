// M23 P8 — the player's (or guardian's) recruitment journeys: one line per
// club, derived on the server only from records that reached this person —
// a contact, a trial invitation, a schedule, an Offer, a signing. The stage
// word and the next action come from GET /player/journeys; nothing here
// derives them, and nothing here knows about a club's watchlist, its
// priority, its decision or its assessments (§16, §58).
//
// M24B — the same read, four views: the overview line (as before), the
// current stage with what each club shared, the next things the person can
// do (server next-action codes, nothing invented), and the full timeline.
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { View } from 'react-native';
import { Text } from './Text';
import { m12, type PlayerJourney, type PlayerJourneyStage, type PlayerNextActionCode } from '../data/m12client';
import { useColors } from '../theme';
import { pt } from '../i18n';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';

type Actor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };
export type JourneyView = 'overview' | 'stage' | 'tasks' | 'activity';

const GLYPH: Record<PlayerJourneyStage, string> = { contacted: '', trial_invited: '➤', trial_scheduled: '', trial_completed: '✓', offer_received: '➤', offer_accepted: '✓', offer_declined: '✕', signing: '', signed: '✓', none: '○' };
const tone = (s: PlayerJourneyStage) => (s === 'signed' || s === 'offer_accepted' || s === 'trial_completed' ? 'green' : s === 'offer_received' || s === 'trial_invited' || s === 'signing' ? 'gold' : s === 'offer_declined' ? 'red' : 'default');
const stLabel = (s: PlayerJourneyStage) => { const key = `jnSt_${s}` as Parameters<typeof pt>[0]; try { return pt(key) ?? s; } catch { return s; } };
const nextLabel = (code: string) => { const key = `jnNext_${code}` as Parameters<typeof pt>[0]; try { return pt(key) ?? ''; } catch { return ''; } };
const evLabel = (kind: string) => { const key = `jnEv_${kind}` as Parameters<typeof pt>[0]; try { return pt(key) ?? kind.replace(/_/g, ' '); } catch { return kind.replace(/_/g, ' '); } };
const sharedLabel = (kind: string) => { const key = `jnShared_${kind}` as Parameters<typeof pt>[0]; try { return pt(key) ?? kind.replace(/_/g, ' '); } catch { return kind.replace(/_/g, ' '); } };
/** The category that holds the record a next action points to. */
export const CATEGORY_FOR_ACTION: Record<PlayerNextActionCode, string | null> = {
  RESPOND_TO_CONTACT: 'contact', RESPOND_TO_TRIAL_INVITATION: 'trial', CONFIRM_TRIAL_SCHEDULE: 'trial', RESPOND_TO_OFFER: 'offer', SIGN: 'signing', NONE: null,
};

export function JourneySection({ actor, view = 'overview', onGo }: { actor: Actor; view?: JourneyView; onGo?: (category: string) => void }) {
  const colors = useColors();
  const [items, setItems] = useState<PlayerJourney[] | null>(null);
  // Every return to the tab re-reads: a club may have moved while the person was elsewhere (§55).
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(useCallback(() => { setFocusTick((x) => x + 1); }, []));
  useEffect(() => {
    let on = true;
    (actor.kind === 'player' ? m12.getJourneys(actor.id) : m12.gJourneys(actor.id, actor.childId)).then((x) => on && setItems(x)).catch(() => on && setItems([]));
    return () => { on = false; };
  }, [actor.id, actor.kind, focusTick]);
  if (!items) return null;
  if (items.length === 0) {
    if (view === 'overview') return null;
    return <View testID="journey-empty"><Card><SectionTitle>{pt('jnTitle')}</SectionTitle><Muted size={12.5}>{pt('jnNone')}</Muted></Card></View>;
  }
  const clubRow = (j: PlayerJourney) => (
    <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }}>{j.club.name ?? pt('jnClub')}</Text>
      <Pill label={`${GLYPH[j.journey.stage] ?? ''} ${stLabel(j.journey.stage)}`} tone={tone(j.journey.stage)} />
    </Row>
  );
  const sep = { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 4 } as const;

  if (view === 'stage') {
    return (
      <View testID="journey-stage"><Card>
        <SectionTitle>{pt('subStage')}</SectionTitle>
        <Muted size={12.5}>{pt('jnHint')}</Muted>
        <View style={{ gap: 8, marginTop: 6 }}>
          {items.map((j) => (
            <View key={j.club.id} style={sep} testID={`journey-stage-${j.club.id}`}>
              {clubRow(j)}
              <Muted size={12}>{pt('jnSharedTitle')}</Muted>
              {j.shared.length === 0 ? <Muted size={12}>—</Muted> : j.shared.map((s) => (
                <Text key={`${s.kind}-${s.id}`} style={{ color: colors.text, fontSize: 13 }}>• {sharedLabel(s.kind)}{s.status ? ` · ${String(s.status).replace(/_/g, ' ').toLowerCase()}` : ''}{s.at ? ` · ${new Date(s.at).toLocaleDateString()}` : ''}</Text>
              ))}
            </View>
          ))}
        </View>
      </Card></View>
    );
  }
  if (view === 'tasks') {
    const todo = items.filter((j) => j.journey.nextAction.code !== 'NONE');
    return (
      <View testID="journey-tasks"><Card>
        <SectionTitle>{pt('jnTasksTitle')}</SectionTitle>
        <Muted size={12.5}>{pt('jnTasksHint')}</Muted>
        {todo.length === 0 && <View style={{ marginTop: 6 }}><Muted size={12.5}>{pt('jnNothingToDo')}</Muted></View>}
        <View style={{ gap: 8, marginTop: 6 }}>
          {todo.map((j) => {
            const cat = CATEGORY_FOR_ACTION[j.journey.nextAction.code] ?? null;
            return (
              <View key={j.club.id} style={sep} testID={`journey-task-${j.club.id}`}>
                {clubRow(j)}
                <Text style={{ color: colors.accentText, fontSize: 13 }} testID="journey-next">{nextLabel(j.journey.nextAction.code)}</Text>
                {cat && onGo && <Row><Button small primary label={pt('jnGo')} onPress={() => onGo(cat)} testID={`journey-go-${j.club.id}`} /></Row>}
              </View>
            );
          })}
        </View>
      </Card></View>
    );
  }
  if (view === 'activity') {
    return (
      <View testID="journey-activity"><Card>
        <SectionTitle>{pt('jnActivityTitle')}</SectionTitle>
        <Muted size={12.5}>{pt('jnActivityHint')}</Muted>
        <View style={{ gap: 8, marginTop: 6 }}>
          {items.map((j) => (
            <View key={j.club.id} style={sep} testID={`journey-activity-${j.club.id}`}>
              {clubRow(j)}
              {j.journey.timeline.length === 0 ? <Muted size={12}>{pt('jnActivityNone')}</Muted> : j.journey.timeline.map((e, i) => (
                <Text key={`${e.kind}-${e.at}-${i}`} style={{ color: colors.text, fontSize: 13 }}>{new Date(e.at).toLocaleDateString()} · {evLabel(e.kind)}</Text>
              ))}
            </View>
          ))}
        </View>
      </Card></View>
    );
  }
  // M24D — the Overview carries what the Current stage and Tasks pages
  // carried: per club, the stage, what the club has shared, and the next
  // action with its "Go" where one exists.
  const todo = items.filter((j) => j.journey.nextAction.code !== 'NONE');
  return (
    <View testID="journey-section"><Card>
      <SectionTitle>{pt('jnTitle')}</SectionTitle>
      <Muted size={12.5}>{pt('jnHint')}</Muted>
      <View style={{ gap: 8, marginTop: 6 }}>
        {items.map((j) => (
          <View key={j.club.id} style={sep} testID={`journey-club-${j.club.id}`} accessibilityRole="summary" accessibilityLabel={`${j.club.name ?? ''}: ${stLabel(j.journey.stage)}`}>
            {clubRow(j)}
            {j.journey.nextAction.code !== 'NONE' ? (
              <Text style={{ color: colors.accentText, fontSize: 13 }} testID="journey-next">{nextLabel(j.journey.nextAction.code)}</Text>
            ) : (
              <Muted size={12.5}>{pt('jnNothingToDo')}</Muted>
            )}
            {j.shared.length > 0 ? (
              <Muted size={12}>{pt('jnSharedTitle')} · {j.shared.map((s) => `${sharedLabel(s.kind)}${s.status ? ` (${String(s.status).replace(/_/g, ' ').toLowerCase()})` : ''}`).join(' · ')}</Muted>
            ) : null}
            {j.journey.timeline.length > 0 ? (
              <Muted size={11.5}>{pt('jnLast')} {evLabel(j.journey.timeline[j.journey.timeline.length - 1].kind)} · {new Date(j.journey.timeline[j.journey.timeline.length - 1].at).toLocaleDateString()}</Muted>
            ) : null}
          </View>
        ))}
      </View>
      {todo.length > 0 && onGo ? (
        <View style={{ gap: 8, marginTop: 10 }} testID="journey-tasks">
          <SectionTitle>{pt('jnTasksTitle')}</SectionTitle>
          {todo.map((j) => {
            const cat = CATEGORY_FOR_ACTION[j.journey.nextAction.code] ?? null;
            return (
              <View key={j.club.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }} testID={`journey-task-${j.club.id}`}>
                <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{j.club.name ?? pt('jnClub')} · {nextLabel(j.journey.nextAction.code)}</Text>
                {cat ? <Button small primary label={pt('jnGo')} onPress={() => onGo(cat)} testID={`journey-go-${j.club.id}`} /> : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </Card></View>
  );
}
