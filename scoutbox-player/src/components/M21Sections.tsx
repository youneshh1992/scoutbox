// M21 — Development Hub, player and guardian surface.
//
// Six sections: Overview, Goals, Actions, Evidence, Reviews, History. Every
// figure on the screen arrives derived from the server; nothing here computes
// a percentage, decides a target, or upgrades a provenance.
//
// Three things this screen deliberately does NOT render, each of which would
// be the easy thing to build:
//
//   • a progress bar across the plan. "3 of 5 actions completed" is a count of
//     a to-do list; the same three numbers drawn as a filled bar reads as a
//     measure of the player, and there is no honest way to draw it;
//   • a green tick on a simulated Combine result. The demo's own result says
//     the target is not satisfied, and says why;
//   • a club's internal review note. It is not in the payload — the screen
//     shows that the club wrote one, which is different from showing it.
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from './ui';
import {
  m21, type DevActor, type DevelopmentPlanView, type GoalView, type ActionView,
  type EvidenceView, type ReviewView, type TargetView, type DevelopmentCatalogue,
  type LinkableEvidence,
} from '../data/m21client';
import { pt, pFmtDate } from '../i18n';

const input = {
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const;

/** State is never colour alone: every pill carries its word (§115). */
const GOAL_TONE: Record<string, 'green' | 'blue' | 'gold' | 'red' | 'default'> = {
  achieved: 'green', in_progress: 'blue', blocked: 'gold', stopped: 'default', not_started: 'default',
};
const ACTION_TONE: Record<string, 'green' | 'blue' | 'gold' | 'default'> = {
  done: 'green', in_progress: 'blue', blocked: 'gold', todo: 'default', cancelled: 'default',
};
const TARGET_TONE: Record<string, 'green' | 'gold' | 'default'> = {
  target_met: 'green', target_not_met: 'gold', no_current_valid_measurement: 'default',
};

const label = (key: string, fallback: string) => {
  try { return pt(key as Parameters<typeof pt>[0]) ?? fallback; } catch { return fallback; }
};

const goalStatusLabel = (s: string) => label(`m21goal_${s}`, s.replace(/_/g, ' '));
const actionStatusLabel = (s: string) => label(`m21act_${s}`, s.replace(/_/g, ' '));
const dueLabel = (d: { state: string; days: number | null }) => {
  switch (d.state) {
    case 'overdue': return `${pt('m21overdue')} · ${d.days}d`;
    case 'due_today': return pt('m21dueToday');
    case 'due_soon': return `${pt('m21dueIn')} ${d.days}d`;
    case 'upcoming': return `${pt('m21dueIn')} ${d.days}d`;
    default: return null;
  }
};

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setErr(null);
    fn().then((x) => alive && setV(x)).catch((e) => alive && setErr(e instanceof Error ? e.message : 'failed'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((x) => x + 1), err];
}

// ------------------------------------------------------------------ pieces

function TargetBlock({ t }: { t: TargetView }) {
  return (
    <View style={{ gap: 4, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 10 }}>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{t.statement}</Text>
        <Pill label={label(`m21target_${t.state}`, t.state.replace(/_/g, ' '))} tone={TARGET_TONE[t.state] ?? 'default'} />
      </Row>
      {t.measured ? (
        <Muted size={12}>{pt('m21measured')}: {t.measured.value} {t.metricUnit}</Muted>
      ) : null}
      <Muted size={12}>{t.note}</Muted>
      <Muted size={11}>{t.limitation}</Muted>
    </View>
  );
}

function EvidenceRow({ e }: { e: EvidenceView }) {
  return (
    <View style={{ gap: 3, paddingVertical: 4 }}>
      <Row>
        <Text style={{ color: e.available ? colors.text : colors.muted, fontSize: 13 }}>
          {e.available ? (e.title ?? e.sourceLabel) : pt('m21evUnavailable')}
        </Text>
        <Pill label={e.sourceLabel} />
        {e.simulated ? <Pill label={pt('m21simulated')} tone="gold" /> : null}
        {!e.available ? <Pill label={pt('m21evGone')} tone="default" /> : null}
      </Row>
      {e.available && e.measuredValue != null ? (
        <Muted size={12}>{e.measuredValue} {e.metricUnit}</Muted>
      ) : null}
      {e.note ? <Muted size={11}>{e.note}</Muted> : null}
      {e.occurredAt ? <Muted size={11}>{pFmtDate(e.occurredAt)}</Muted> : null}
    </View>
  );
}

function ActionRow({ a, onSet, canWrite }: { a: ActionView; onSet: (status: string) => void; canWrite: boolean }) {
  const due = dueLabel(a.due);
  return (
    <View style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line }}>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13.5, flexShrink: 1 }}>{a.title}</Text>
        <Pill label={actionStatusLabel(a.status)} tone={ACTION_TONE[a.status] ?? 'default'} />
        {due ? <Pill label={due} tone={a.due.state === 'overdue' ? 'gold' : 'default'} /> : null}
      </Row>
      <Row>
        <Muted size={11}>{label(`m21type_${a.type}`, a.type.replace(/_/g, ' '))}</Muted>
        {a.assignee ? <Muted size={11}>· {a.assignee.name}</Muted> : null}
      </Row>
      {canWrite && a.status !== 'cancelled' ? (
        <Row>
          {a.status !== 'done'
            ? <Button small label={pt('m21markDone')} onPress={() => onSet('done')} />
            : <Button small label={pt('m21reopen')} onPress={() => onSet('in_progress')} />}
        </Row>
      ) : null}
      {a.evidence.length ? a.evidence.map((e) => <EvidenceRow key={e.linkId} e={e} />) : null}
    </View>
  );
}

function GoalCard({ g, view, actor, reload }: { g: GoalView; view: DevelopmentPlanView; actor: DevActor; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [linkable, setLinkable] = useState<LinkableEvidence[] | null>(null);
  const canWrite = !!view.access.writeGoals;
  const canLink = !!view.access.linkEvidence;
  const alreadyLinked = new Set(g.evidence.map((e) => `${e.sourceType}:${e.sourceId}`));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); reload(); } finally { setBusy(false); }
  };

  return (
    <Card>
      <Row>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 }}>{g.title}</Text>
        <Pill label={g.categoryLabel} />
        <Pill label={goalStatusLabel(g.status)} tone={GOAL_TONE[g.status] ?? 'default'} />
      </Row>
      {g.description ? <Muted size={12.5}>{g.description}</Muted> : null}
      {/* The word never travels without the sentence. */}
      {g.statusMeaning ? <Muted size={11.5}>{g.statusMeaning}</Muted> : null}
      {g.status === 'blocked' ? (
        <Muted size={12}>
          {pt('m21blocked')}: {label(`m21block_${g.blockReason}`, String(g.blockReason ?? '').replace(/_/g, ' '))}
          {g.blockNote ? ` — ${g.blockNote}` : ''}
        </Muted>
      ) : null}

      {g.targetState ? <TargetBlock t={g.targetState} /> : null}

      {/* Counts, and a sentence made of counts. Never a bar. */}
      <Row>
        <Text style={{ color: colors.text, fontSize: 13 }}>{g.completion.phrase}</Text>
        {g.actionCounts.overdue ? <Pill label={`${g.actionCounts.overdue} ${pt('m21overdue')}`} tone="gold" /> : null}
      </Row>

      {g.actions.map((a) => (
        <ActionRow
          key={a.id}
          a={a}
          canWrite={canWrite || a.assignee?.kind === 'player'}
          onSet={(status) => run(() => m21.updateAction(actor, a.id, { status }))}
        />
      ))}

      {canWrite ? (
        adding ? (
          <View style={{ gap: 6 }}>
            <TextInput
              style={input}
              value={title}
              onChangeText={setTitle}
              placeholder={pt('m21actionTitle')}
              placeholderTextColor={colors.muted}
              accessibilityLabel={pt('m21actionTitle')}
            />
            <Row>
              <Button small primary label={pt('m21add')} disabled={busy || !title.trim()} onPress={() => run(async () => {
                await m21.addAction(actor, g.id, { title: title.trim(), type: 'training' });
                setTitle(''); setAdding(false);
              })} />
              <Button small label={pt('m21cancel')} onPress={() => { setAdding(false); setTitle(''); }} />
            </Row>
          </View>
        ) : <Row><Button small label={pt('m21addAction')} onPress={() => setAdding(true)} /></Row>
      ) : null}

      {g.evidence.length ? (
        <View style={{ gap: 2 }}>
          <SectionTitle>{pt('m21evidence')}</SectionTitle>
          {g.evidence.map((e) => <EvidenceRow key={e.linkId} e={e} />)}
          <Muted size={11}>{g.evidenceSummary.note}</Muted>
        </View>
      ) : <Muted size={12}>{pt('m21noEvidence')}</Muted>}

      {/* Linking stores a reference. What it points at is read live, every
          time, so nothing is copied into the plan. */}
      {canLink ? (
        linkable === null
          ? <Row><Button small label={pt('m21linkEvidence')} disabled={busy} onPress={() => { void m21.linkable(actor).then((r) => setLinkable(r.items)); }} /></Row>
          : (
            <View style={{ gap: 4 }} accessibilityLabel={pt('m21linkEvidence')}>
              <SectionTitle>{pt('m21linkEvidence')}</SectionTitle>
              {linkable.filter((i) => !alreadyLinked.has(`${i.sourceType}:${i.sourceId}`)).length === 0
                ? <Muted size={12}>{pt('m21nothingToLink')}</Muted>
                : linkable.filter((i) => !alreadyLinked.has(`${i.sourceType}:${i.sourceId}`)).slice(0, 8).map((i) => (
                  <Row key={`${i.sourceType}:${i.sourceId}`}>
                    <Text style={{ color: colors.text, fontSize: 12.5, flexShrink: 1 }}>{i.title}</Text>
                    <Pill label={i.sourceLabel} />
                    {i.simulated ? <Pill label={pt('m21simulated')} tone="gold" /> : null}
                    <Button small label={pt('m21link')} disabled={busy} onPress={() => run(async () => {
                      await m21.linkEvidence(actor, g.id, { sourceType: i.sourceType, sourceId: i.sourceId });
                      setLinkable(null);
                    })} />
                  </Row>
                ))}
              <Row><Button small label={pt('m21cancel')} onPress={() => setLinkable(null)} /></Row>
            </View>
          )
      ) : null}

      {canWrite && g.status !== 'achieved' ? (
        <Row>
          {g.status === 'not_started'
            ? <Button small label={pt('m21start')} disabled={busy} onPress={() => run(() => m21.updateGoal(actor, g.id, { status: 'in_progress' }))} />
            : null}
          {g.status === 'in_progress'
            ? <Button small label={pt('m21markAchieved')} disabled={busy} onPress={() => run(() => m21.updateGoal(actor, g.id, { status: 'achieved' }))} />
            : null}
        </Row>
      ) : null}
    </Card>
  );
}

function ReviewCard({ r }: { r: ReviewView }) {
  return (
    <Card>
      <Row>
        <Pill label={label(`m21rev_${r.reviewerKind}`, r.reviewerKind.replace(/_/g, ' '))} tone={r.reviewerKind === 'coach_review' ? 'blue' : 'default'} />
        <Muted size={12}>{r.reviewedByName} · {pFmtDate(r.reviewedAt)}</Muted>
        {r.supersededBy ? <Pill label={pt('m21superseded')} tone="gold" /> : null}
        {r.supersedes ? <Pill label={pt('m21correction')} /> : null}
      </Row>
      {r.summary ? <Text style={{ color: colors.text, fontSize: 13.5, lineHeight: 19 }}>{r.summary}</Text> : <Muted size={12}>{pt('m21noSummary')}</Muted>}
      {/* Existence acknowledged, content absent. */}
      {r.internalNoteNote ? <Muted size={11.5}>{r.internalNoteNote}</Muted> : null}
      {r.goalSnapshots.length ? (
        <View style={{ gap: 2 }}>
          <SectionTitle>{pt('m21atReview')}</SectionTitle>
          {r.goalSnapshots.map((s) => (
            <Muted key={s.goalId} size={12}>{s.title} — {goalStatusLabel(s.status)} · {s.completion.phrase}</Muted>
          ))}
        </View>
      ) : null}
      {r.nextReviewAt ? <Muted size={12}>{pt('m21nextReview')}: {pFmtDate(r.nextReviewAt)}</Muted> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ screen

export function DevelopmentHubSection({ actor }: { actor: DevActor }) {
  const [cat] = useLoad<DevelopmentCatalogue>(() => m21.catalogue(actor), [actor.id]);
  const [list, reloadList] = useLoad(() => m21.plans(actor), [actor.id]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [view, reloadPlan, err] = useLoad<DevelopmentPlanView | null>(
    async () => (planId ? m21.plan(actor, planId) : null), [actor.id, planId],
  );
  const [showHistory, setShowHistory] = useState(false);
  const [reflection, setReflection] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!planId && list?.items?.length) setPlanId(list.items[0].id);
  }, [list, planId]);

  const reload = () => { reloadPlan(); reloadList(); };
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } finally { setBusy(false); } };

  if (err) {
    return (
      <View style={{ gap: 8 }}>
        <SectionTitle>{pt('m21title')}</SectionTitle>
        <Card><Muted>{pt('m21loadError')}</Muted><Row><Button small label={pt('m21retry')} onPress={reload} /></Row></Card>
      </View>
    );
  }

  if (list && list.items.length === 0) {
    return (
      <View style={{ gap: 8 }}>
        <SectionTitle>{pt('m21title')}</SectionTitle>
        <Card>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{pt('m21emptyTitle')}</Text>
          <Muted size={12.5}>{pt('m21emptyBody')}</Muted>
          <Row>
            <Button
              small
              primary
              label={pt('m21createPlan')}
              disabled={busy}
              onPress={() => run(async () => {
                const created = await m21.createPlan(actor, {
                  title: pt('m21defaultPlanTitle'), visibility: 'private', status: 'active',
                  goals: [{ title: cat?.goalLibrary.items[0]?.title ?? 'First touch under pressure', category: cat?.goalLibrary.items[0]?.category ?? 'technical' }],
                });
                setPlanId(created.plan.id);
              })}
            />
          </Row>
          {cat ? <Muted size={11}>{cat.goalLibrary.note}</Muted> : null}
        </Card>
      </View>
    );
  }

  if (!view) {
    return (
      <View style={{ gap: 8 }}>
        <SectionTitle>{pt('m21title')}</SectionTitle>
        <Card><Muted>{pt('m21loading')}</Muted></Card>
      </View>
    );
  }

  const s = view.summary;

  return (
    <View style={{ gap: 8 }} accessibilityLabel={pt('m21title')}>
      <SectionTitle>{pt('m21title')}</SectionTitle>

      {/* ---- Overview */}
      <Card>
        <Row>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 }}>{view.plan.title}</Text>
          <Pill label={label(`m21plan_${view.plan.status}`, view.plan.status)} tone={view.plan.status === 'active' ? 'green' : 'default'} />
          <Pill label={label(`m21vis_${view.plan.visibility}`, view.plan.visibility)} />
        </Row>
        {view.plan.owner.kind === 'org' ? <Muted size={12}>{pt('m21clubPlan')} — {view.plan.owner.orgName}</Muted> : null}
        <Row>
          <Muted size={13}>{pt('m21activeGoals')}: {s.activeGoals}</Muted>
          <Muted size={13}>· {pt('m21actionsDue')}: {s.actionsDue}</Muted>
          {s.actionsOverdue ? <Pill label={`${s.actionsOverdue} ${pt('m21overdue')}`} tone="gold" /> : null}
        </Row>
        <Row>
          <Muted size={13}>{pt('m21lastReview')}: {s.lastReviewAt ? pFmtDate(s.lastReviewAt) : pt('m21none')}</Muted>
          <Muted size={13}>· {pt('m21nextReview')}: {s.nextReviewAt ? pFmtDate(s.nextReviewAt) : pt('m21none')}</Muted>
          {s.reviewDue.state === 'review_overdue' ? <Pill label={pt('m21reviewOverdue')} tone="gold" /> : null}
        </Row>
        <Muted size={13}>{pt('m21linkedEvidence')}: {s.linkedEvidenceAvailable}</Muted>
        {/* Said out loud where a headline number would otherwise sit. */}
        <Muted size={11.5}>{s.note}</Muted>
        {cat ? <Muted size={11}>{cat.reminders.note}</Muted> : null}
        {list && list.items.length > 1 ? (
          <Row>
            {list.items.map((p) => (
              <Button key={p.id} small label={p.title} onPress={() => setPlanId(p.id)} />
            ))}
          </Row>
        ) : null}
      </Card>

      {/* ---- Goals (with their actions and evidence) */}
      <SectionTitle>{pt('m21goals')}</SectionTitle>
      {view.goals.length === 0 ? <Card><Muted>{pt('m21noGoals')}</Muted></Card> : null}
      {view.goals.map((g) => <GoalCard key={g.id} g={g} view={view} actor={actor} reload={reload} />)}

      {view.access.writeGoals ? (
        <Card>
          <TextInput
            style={input}
            value={newGoal}
            onChangeText={setNewGoal}
            placeholder={pt('m21goalTitle')}
            placeholderTextColor={colors.muted}
            accessibilityLabel={pt('m21goalTitle')}
          />
          <Row>
            <Button small primary label={pt('m21addGoal')} disabled={busy || !newGoal.trim()} onPress={() => run(async () => {
              await m21.addGoal(actor, view.plan.id, { title: newGoal.trim(), category: 'technical' });
              setNewGoal('');
            })} />
          </Row>
          {cat ? (
            <View style={{ gap: 4 }}>
              <Muted size={11}>{cat.goalLibrary.note}</Muted>
              <Row>
                {cat.goalLibrary.items.slice(0, 4).map((i) => (
                  <Button key={i.id} small label={i.title} onPress={() => setNewGoal(i.title)} />
                ))}
              </Row>
            </View>
          ) : null}
        </Card>
      ) : null}

      {/* ---- Reviews */}
      <SectionTitle>{pt('m21reviews')}</SectionTitle>
      {view.reviews.length === 0 ? <Card><Muted>{pt('m21noReviews')}</Muted></Card> : null}
      {view.reviews.map((r) => <ReviewCard key={r.id} r={r} />)}

      {view.access.reflect ? (
        <Card>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{pt('m21addReflection')}</Text>
          {/* A reflection is never presented as an assessment. */}
          <Muted size={12}>{pt('m21reflectionNote')}</Muted>
          <TextInput
            style={[input, { minHeight: 64 }]}
            multiline
            value={reflection}
            onChangeText={setReflection}
            placeholder={pt('m21reflectionPlaceholder')}
            placeholderTextColor={colors.muted}
            accessibilityLabel={pt('m21addReflection')}
          />
          <Row>
            <Button small primary label={pt('m21submit')} disabled={busy || !reflection.trim()} onPress={() => run(async () => {
              await m21.addReflection(actor, view.plan.id, { summary: reflection.trim() });
              setReflection('');
            })} />
          </Row>
        </Card>
      ) : null}

      {/* ---- History */}
      <Row>
        <Button small label={showHistory ? pt('m21hideHistory') : pt('m21showHistory')} onPress={() => setShowHistory((x) => !x)} />
      </Row>
      {showHistory ? (
        <Card>
          {view.timeline.length === 0 ? <Muted>{pt('m21noHistory')}</Muted> : null}
          {view.timeline.map((h) => (
            <Row key={h.id}>
              <Muted size={12}>{pFmtDate(h.at)}</Muted>
              <Text style={{ color: colors.text, fontSize: 12.5, flexShrink: 1 }}>{h.label}</Text>
              {h.subject.title ? <Muted size={12}>— {h.subject.title}</Muted> : null}
              {h.byName ? <Muted size={11}>· {h.byName}</Muted> : null}
            </Row>
          ))}
        </Card>
      ) : null}

      <Muted size={11}>{view.limitation}</Muted>
      <Muted size={11}>{view.neverBuilt.note}</Muted>
    </View>
  );
}
