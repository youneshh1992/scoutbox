import { GuidanceNote } from './InformationRows';
// M16.2 — the ScoutBox Trust Score surface for the player/guardian app.
//
// The score answers one question: how strongly is this player's football
// record supported by trustworthy, current, attributable evidence? It is not
// ability, talent, potential, character or recruitment suitability, and the
// mandatory disclaimer travels with it on every surface that shows a number.
//
// A LOW score means LIMITED EVIDENCE. Missing evidence is always presented as
// an evidence gap — never as a weakness, a risk or a suggestion of dishonesty.
// There is no gamification here: no streaks, no points animations, no urgency,
// no leaderboard, and nothing about "losing" a score.
//
// Everything shown is derived server-side and rendered verbatim: this screen
// never computes, adjusts or predicts a score.
//
// M24F.3 — the root is the score, the band and one line; the derivation, the
// strengths, the gaps, the policy version and the demo note are one tap away
// under "View breakdown". The disclaimer still travels with the number: it is
// the first line of the breakdown and the accessible description of the score.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { useColors } from '../theme';
import { InfoNote, RecordPanel, DetailFact, Disclosure, Muted } from './ui';
import { RefCard } from './Reference';
import { ScoreRing } from './Vivid';
import { Icon } from './Icon';
import { trust, type TrustActor, type TrustSelf } from '../data/trustClient';
import { pt } from '../i18n';

// Component display names, keyed by the server's component ids.
const COMPONENT_KEYS = {
  identity: 'trsCompIdentity',
  footballHistory: 'trsCompFootballHistory',
  relationships: 'trsCompRelationships',
  evidence: 'trsCompEvidence',
  combine: 'trsCompCombine',
  references: 'trsCompReferences',
} as const;

export const componentLabel = (id: string): string =>
  id in COMPONENT_KEYS ? pt(COMPONENT_KEYS[id as keyof typeof COMPONENT_KEYS]) : id;

/** The mandatory disclaimer. The server sends the canonical wording with every
 *  projection; the catalogue copy is only a fallback if a payload lacks it. */
export const trustDisclaimer = (t: { disclaimer?: string } | null | undefined): string =>
  t?.disclaimer && t.disclaimer.length > 0 ? t.disclaimer : pt('trsDisclaimer');

/** Score + band + the one line, shared by the Trust card and by the Trust block inside the Combine Card. */
export function TrustScoreHeader({ t, compact }: { t: TrustSelf; compact?: boolean }) {
  const colors = useColors();
  return (
    <View accessibilityLabel={`${pt('trsTitle')} ${t.score}. ${t.bandLabel}. ${trustDisclaimer(t)}`}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: compact ? 28 : 38, lineHeight: compact ? 34 : 44 }}>{t.score}</Text>
        <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>{t.bandLabel}</Text>
      </View>
      <Muted size={12.5}>{pt('trsEvidenceOnly')}</Muted>
    </View>
  );
}

// ---------------------------------------------------------- the main section
export function TrustProfileSection({ actor, childName }: { actor: TrustActor; childName?: string }) {
  const colors = useColors();
  const key = actor.kind === 'guardian' ? actor.childId : actor.id;
  const [t, setT] = useState<TrustSelf | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    trust.profile(actor)
      .then((v) => { if (live) setT(v); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'failed'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, actor.kind]);

  return (
    <RefCard testID="trust-card">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }} accessibilityLabel={t ? `${pt('trsTitle')} ${t.score}. ${t.bandLabel}. ${trustDisclaimer(t)}` : undefined}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.muted, fontSize: 11, marginBottom: 5 }}>{pt('trsTitle')}{childName ? ` — ${childName}` : ''}</Text>
          <Text role="heading" aria-level={3} style={{ color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.25 }}>{t ? t.bandLabel : err ? err : pt('trsLoading')}</Text>
          {t ? <Muted size={12.5}>{pt('trsEvidenceOnly')}</Muted> : null}
        </View>
        {t ? (
          <View testID="trust-score"><ScoreRing value={t.score} label={pt('trsTitle')} /></View>
        ) : null}
      </View>

      {t ? (
        <Disclosure label={pt('trsBreakdown')} testID="trust-why">
          <GuidanceNote size={12}>{trustDisclaimer(t)}</GuidanceNote>
          {/* the derivation: one row per component, the level as a word, the reasons behind a tap */}
          <View style={{ marginTop: 4 }} testID="trust-breakdown">
            {t.explanations.map((e) => {
              const strong = /strong|verified|complete|high/i.test(e.levelLabel);
              return (
                <View key={e.component} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}>
                  <Icon name={strong ? 'check' : 'circle'} size={14} color={strong ? colors.accentText : colors.muted} />
                  <Text style={{ color: colors.text, fontSize: 14, flex: 1 }}>{componentLabel(e.component)}</Text>
                  <Text style={{ color: colors.muted, fontSize: 12.5 }}>{e.levelLabel}</Text>
                </View>
              );
            })}
          </View>
          {t.gaps.length > 0 ? (
            <View style={{ marginTop: 10, gap: 4 }} testID="trust-gaps">
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13.5 }}>{pt('trsImprove')}</Text>
              {t.gaps.slice(0, 3).map((g, i) => <InfoNote key={`${g.code}-${i}`} icon="circle-help">{g.text}</InfoNote>)}
            </View>
          ) : null}
          {t.strengths.length > 0 ? (
            <Disclosure label={pt('trsStrengths')} testID="trust-strengths">
              {t.strengths.map((s, i) => <InfoNote key={`${s.code}-${i}`} icon="shield-check">{s.text}</InfoNote>)}
            </Disclosure>
          ) : null}
          <Disclosure label={pt('trsAbout')} testID="trust-about">
            {t.explanations.map((e) => (
              <RecordPanel key={e.component} title={componentLabel(e.component)} icon="shield-check">
                <DetailFact label={pt('trsWeight')} value={e.weight} />
                <Text style={{ color: colors.muted, fontSize: 12 }}>{e.coverage}%</Text>
                {e.reasons.map((r, i) => <InfoNote key={i}>{r}</InfoNote>)}
              </RecordPanel>
            ))}
            {t.context.adultOnlyFacetsExcluded.length > 0 ? <GuidanceNote size={12}>{pt('trsAdultOnly')}</GuidanceNote> : null}
            <GuidanceNote title="Policy version" icon="file-text" size={11.5}>{pt('trsPolicy')} {t.policyVersion}</GuidanceNote>
            {t.simulatedEvidenceIncluded ? <GuidanceNote title="Demo information" icon="info" size={11.5}>{pt('trsDemoSim')}</GuidanceNote> : null}
          </Disclosure>
        </Disclosure>
      ) : null}
    </RefCard>
  );
}
