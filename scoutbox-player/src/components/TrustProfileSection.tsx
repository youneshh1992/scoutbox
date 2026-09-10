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
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
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

/** Score + band + disclaimer, shared by the Trust Profile card and by the
 *  visually separate Trust block inside the Combine Card. */
export function TrustScoreHeader({ t, compact }: { t: TrustSelf; compact?: boolean }) {
  return (
    <View>
      <Row>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: compact ? 28 : 38, lineHeight: compact ? 34 : 44 }}>{t.score}</Text>
        <Text style={{ color: colors.muted, fontWeight: '700', fontSize: 13 }}>/ 100</Text>
        <Pill label={t.bandLabel} tone="blue" />
        {t.simulatedEvidenceIncluded ? <Pill label={pt('trsDemoShort')} tone="gold" /> : null}
      </Row>
      <Muted size={12}>{trustDisclaimer(t)}</Muted>
      {t.simulatedEvidenceIncluded ? <Muted size={11.5}>{pt('trsDemoSim')}</Muted> : null}
    </View>
  );
}

// ---------------------------------------------------------- the main section
export function TrustProfileSection({ actor, childName }: { actor: TrustActor; childName?: string }) {
  const key = actor.kind === 'guardian' ? actor.childId : actor.id;
  const [t, setT] = useState<TrustSelf | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [why, setWhy] = useState(false);

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
    <Card>
      <SectionTitle>{pt('trsTitle')}{childName ? ` — ${childName}` : ''}</SectionTitle>

      {!t && !err ? <Muted size={12}>{pt('trsLoading')}</Muted> : null}
      {err ? <Muted size={12}>{err}</Muted> : null}

      {t ? (
        <>
          <TrustScoreHeader t={t} />

          <Row style={{ marginTop: 4 }}>
            <Button small label={why ? pt('trsHide') : pt('trsWhy')} onPress={() => setWhy((x) => !x)} />
            <Muted size={11}>{pt('trsPolicy')} {t.policyVersion}</Muted>
          </Row>

          {/* "Why this score?" — the per-component derivation, in the server's
              own neutral words. Weights and coverage are shown so the score is
              explainable rather than mysterious. */}
          {why ? (
            <View style={{ marginTop: 6, backgroundColor: colors.panel2, borderRadius: 10, padding: 10 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('trsEvidenceConfidence')}</Text>
              {t.explanations.map((e) => (
                <View key={e.component} style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6, marginTop: 6 }}>
                  <Row>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{componentLabel(e.component)}</Text>
                    <Pill label={e.levelLabel} />
                    <Muted size={11}>{e.coverage}% · {pt('trsWeight')} {e.weight}</Muted>
                  </Row>
                  {e.reasons.map((r, i) => <Muted key={i} size={12}>{r}</Muted>)}
                </View>
              ))}
              {t.context.adultOnlyFacetsExcluded.length > 0 ? (
                <Muted size={11.5}>{pt('trsAdultOnly')}</Muted>
              ) : null}
            </View>
          ) : null}

          {/* What strengthens the Trust Profile — evidence already on record. */}
          <View style={{ marginTop: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('trsStrengths')}</Text>
            {t.strengths.length > 0
              ? t.strengths.map((s, i) => <Muted key={`${s.code}-${i}`} size={12}>✓ {s.text}</Muted>)
              : <Muted size={12}>{pt('trsNoStrengths')}</Muted>}
          </View>

          {/* Evidence gaps — what could strengthen it further. Never framed as
              a failing, a risk, or anything about the player themselves. */}
          <View style={{ marginTop: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{pt('trsGaps')}</Text>
            {t.gaps.length > 0
              ? t.gaps.map((g, i) => <Muted key={`${g.code}-${i}`} size={12}>○ {g.text}</Muted>)
              : <Muted size={12}>{pt('trsNoGaps')}</Muted>}
            <Muted size={11.5}>{pt('trsBuild')} {pt('trsVerifiedStrengthens')}</Muted>
          </View>
        </>
      ) : null}
    </Card>
  );
}
