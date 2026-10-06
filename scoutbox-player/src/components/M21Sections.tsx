import { GuidanceNote } from './InformationRows';
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
import { Pressable, View } from 'react-native';
import { Text, TextInput } from './Text';
import { useColors, type Palette } from '../theme';
import { TimelineItem, RecordPanel, DetailFact, MetricTiles, Button, Card, Disclosure, ListRow, Muted, Pill, Row, SectionTitle } from './ui';
import { Icon } from './Icon';
import {
  m21, type DevActor, type DevelopmentPlanView, type GoalView, type ActionView,
  type EvidenceView, type ReviewView, type TargetView, type DevelopmentCatalogue,
  type LinkableEvidence,
} from '../data/m21client';
import { pt, pFmtDate } from '../i18n';
import { fmtShortDay } from '../time';

const inputStyle = (colors: Palette) => ({
  backgroundColor: colors.panel2, color: colors.text, borderRadius: 8,
  paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, borderWidth: 1, borderColor: colors.line,
} as const);

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
  const colors = useColors();
  return (
    <View style={{ gap: 4, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 10 }}>
      <Row>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{t.statement}</Text>
        <Pill label={label(`m21target_${t.state}`, t.state.replace(/_/g, ' '))} tone={TARGET_TONE[t.state] ?? 'default'} />
      </Row>
      {t.measured ? (
        <Muted size={12}>{pt('m21measured')}: {t.measured.value} {t.metricUnit}</Muted>
      ) : null}
      <Disclosure label="About this target"><GuidanceNote size={12}>{t.note}</GuidanceNote><GuidanceNote title="Limits" icon="info" size={12}>{t.limitation}</GuidanceNote></Disclosure>
    </View>
  );
}

function EvidenceRow({ e }: { e: EvidenceView }) {
  const colors = useColors();
  return (
    <View style={{ gap: 9, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <Icon name={e.available ? 'file-check-2' : 'file-text'} size={19} color={colors.iconFg} />
        <Text style={{ color: e.available ? colors.text : colors.muted, fontSize: 13, fontWeight: '500', lineHeight: 19, flex: 1 }}>{e.available ? (e.title ?? e.sourceLabel) : pt('m21evUnavailable')}</Text>
      </View>
      <Row><Pill label={e.sourceLabel} />{e.simulated ? <Pill label={pt('m21simulated')} tone="gold" /> : null}{!e.available ? <Pill label={pt('m21evGone')} /> : null}</Row>
      {e.available && e.measuredValue != null ? <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{e.measuredValue} {e.metricUnit}</Text> : null}
      {e.note ? <Text style={{ color: colors.muted, fontSize: 11.5, lineHeight: 18 }}>{e.note}</Text> : null}
      {e.occurredAt ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Icon name="calendar-days" size={13} color={colors.muted} /><Text style={{ color: colors.muted, fontSize: 11 }}>{pFmtDate(e.occurredAt)}</Text></View> : null}
    </View>
  );
}

const ACTION_ICON: Record<string, string> = {
  training: 'soccer-ball', assessment: 'clipboard-list', video_review: 'video',
  match_objective: 'football-pitch', coach_review: 'chat-bubble', combine: 'activity',
  box_cam: 'video', evidence_request: 'folder-open', custom: 'list-checks',
};

function ActionRow({ a, onSet, canWrite, busy = false }: { a: ActionView; onSet: (status: string) => void; canWrite: boolean; busy?: boolean }) {
  const colors = useColors();
  const due = dueLabel(a.due);
  const done = a.status === 'done';
  return (
    <View testID={`dev-action-${a.id}`} style={{ gap: 12, padding: 14, borderRadius: 18, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
        <View style={{ width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? colors.greenBg : colors.panel }}>
          <Icon name={done ? 'check' : ACTION_ICON[a.type] ?? 'list-checks'} size={20} color={done ? colors.greenInk : colors.iconFg} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 20 }}>{a.title}</Text>
          <Text style={{ color: colors.muted, fontSize: 11.5, lineHeight: 17 }}>{label(`m21type_${a.type}`, a.type.replace(/_/g, ' '))}{a.assignee?.name ? ` · ${a.assignee.name}` : ''}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 9 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          <Pill label={actionStatusLabel(a.status)} tone={ACTION_TONE[a.status] ?? 'default'} />
          {due ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Icon name="calendar-days" size={13} color={a.due.state === 'overdue' ? colors.goldInk : colors.muted} /><Text style={{ fontSize: 11, color: a.due.state === 'overdue' ? colors.goldInk : colors.muted }}>{due}</Text></View> : null}
        </View>
        {canWrite && a.status !== 'cancelled' ? (
          <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={`${done ? pt('m21reopen') : pt('m21markDone')}: ${a.title}`} onPress={() => onSet(done ? 'in_progress' : 'done')} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel, opacity: busy || pressed ? 0.6 : 1 })}>
            <Icon name={done ? 'refresh-cw' : 'check'} size={15} color={colors.accentText} />
            <Text style={{ color: colors.accentText, fontSize: 12, fontWeight: '600' }}>{done ? pt('m21reopen') : pt('m21markDone')}</Text>
          </Pressable>
        ) : null}
      </View>
      {a.evidence.length ? <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 6 }}>{a.evidence.map((e) => <EvidenceRow key={e.linkId} e={e} />)}</View> : null}
    </View>
  );
}

function GoalCard({ g, view, actor, reload }: { g: GoalView; view: DevelopmentPlanView; actor: DevActor; reload: () => void }) {
  const colors = useColors();
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
    <Card testID={`dev-goal-${g.id}`} style={{ padding: 16, gap: 14, borderRadius: 24 }}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
            <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.greenBg, alignItems: 'center', justifyContent: 'center' }}><Icon name="target" size={20} color={colors.accentText} /></View>
            <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, flexShrink: 1 }}>{g.categoryLabel}</Text>
          </View>
          <Pill label={goalStatusLabel(g.status)} tone={GOAL_TONE[g.status] ?? 'default'} />
        </View>
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: '600', lineHeight: 27, letterSpacing: -0.4 }}>{g.title}</Text>
        {g.description ? <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>{g.description}</Text> : null}
      </View>
      {/* The word never travels without the sentence. */}
      {g.statusMeaning ? <GuidanceNote icon="info" size={11.5}>{g.statusMeaning}</GuidanceNote> : null}
      {g.status === 'blocked' ? (
        <GuidanceNote icon="info" size={12}>
          {pt('m21blocked')}: {label(`m21block_${g.blockReason}`, String(g.blockReason ?? '').replace(/_/g, ' '))}
          {g.blockNote ? ` — ${g.blockNote}` : ''}
        </GuidanceNote>
      ) : null}

      {g.targetState ? <TargetBlock t={g.targetState} /> : null}

      {/* Counts, and a sentence made of counts. Never a bar. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line }}>
        <Icon name="list-checks" size={20} color={colors.accentText} />
        <Text style={{ flex: 1, color: colors.text, fontSize: 12.5, fontWeight: '600' }}>{g.completion.phrase}</Text>
        {g.actionCounts.overdue ? <Pill label={`${g.actionCounts.overdue} ${pt('m21overdue')}`} tone="gold" /> : null}
      </View>

      {g.actions.map((a) => (
        <ActionRow
          key={a.id}
          a={a}
          busy={busy}
          canWrite={canWrite || a.assignee?.kind === 'player'}
          onSet={(status) => run(() => m21.updateAction(actor, a.id, { status }))}
        />
      ))}

      {canWrite ? (
        adding ? (
          <View style={{ gap: 6 }}>
            <TextInput
              style={inputStyle(colors)}
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
        <Disclosure label={pt('m21evidence')} icon="folder-open" hint={g.evidenceSummary.note}>
          {g.evidence.map((e) => <EvidenceRow key={e.linkId} e={e} />)}
        </Disclosure>
      ) : <GuidanceNote icon="info" size={12}>{pt('m21noEvidence')}</GuidanceNote>}

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
  const colors = useColors();
  const coach = r.reviewerKind === 'coach_review';
  const kind = label(`m21rev_${r.reviewerKind}`, r.reviewerKind.replace(/_/g, ' '));
  const author = r.reviewedByName || kind;
  const initials = author.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return (
    <Card testID={`dev-review-${r.id}`} style={{ padding: 16, gap: 15, borderRadius: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: coach ? colors.infoBg : colors.greenBg, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: coach ? colors.infoInk : colors.greenInk }}>{initials}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600' }}>{author}</Text>
          <Text style={{ color: colors.muted, fontSize: 11.5 }}>{kind}</Text>
        </View>
        <Text style={{ color: colors.muted, fontSize: 11.5 }}>{pFmtDate(r.reviewedAt)}</Text>
      </View>
      {r.supersededBy || r.supersedes ? <Row>{r.supersededBy ? <Pill label={pt('m21superseded')} tone="gold" /> : null}{r.supersedes ? <Pill label={pt('m21correction')} /> : null}</Row> : null}
      <View style={{ borderLeftWidth: 3, borderLeftColor: coach ? colors.infoInk : colors.accent, paddingLeft: 13, paddingVertical: 2 }}>
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 22 }}>{r.summary || pt('m21noSummary')}</Text>
      </View>
      {/* Only acknowledge that an internal note exists. Never render its content. */}
      {r.internalNoteNote ? <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line }}><Icon name="lock-keyhole" size={16} color={colors.muted} /><Text style={{ flex: 1, color: colors.muted, fontSize: 11.5, lineHeight: 18 }}>{r.internalNoteNote}</Text></View> : null}
      {r.goalSnapshots.length ? (
        <Disclosure label={pt('m21atReview')} icon="target">
          {r.goalSnapshots.map((s) => (
            <View key={s.goalId} style={{ gap: 8, padding: 12, borderRadius: 14, backgroundColor: colors.panel2 }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '500', lineHeight: 19 }}>{s.title}</Text>
              <Row><Pill label={goalStatusLabel(s.status)} tone={GOAL_TONE[s.status] ?? 'default'} /><Muted size={11.5}>{s.completion.phrase}</Muted></Row>
            </View>
          ))}
        </Disclosure>
      ) : null}
      {r.nextReviewAt ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 11, borderRadius: 12, backgroundColor: colors.panel2 }}><Icon name="calendar-days" size={18} color={colors.iconFg} /><Text style={{ flex: 1, color: colors.muted, fontSize: 12 }}>{pt('m21nextReview')}</Text><Text style={{ color: colors.text, fontWeight: '600', fontSize: 12 }}>{pFmtDate(r.nextReviewAt)}</Text></View> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ screen

export function DevelopmentHubSection({ actor }: { actor: DevActor }) {
  const colors = useColors();
  const [cat] = useLoad<DevelopmentCatalogue>(() => m21.catalogue(actor), [actor.id]);
  const [list, reloadList] = useLoad(() => m21.plans(actor), [actor.id]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [view, reloadPlan, err] = useLoad<DevelopmentPlanView | null>(
    async () => (planId ? m21.plan(actor, planId) : null), [actor.id, planId],
  );
  // M24F.4 — the root is four rows; each opens its own page-local detail.
  const [page, setPage] = useState<'goals' | 'feedback' | 'progress' | 'history' | null>(null);
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
          {cat ? <Disclosure label="About goals"><GuidanceNote title="Goal guidance" icon="target" size={12}>{cat.goalLibrary.note}</GuidanceNote></Disclosure> : null}
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
  const focus = view.goals.find((g) => g.status === 'in_progress') ?? view.goals.find((g) => g.status !== 'achieved') ?? view.goals[0] ?? null;
  const latestReview = [...view.reviews].sort((a, b) => b.reviewedAt - a.reviewedAt)[0] ?? null;
  const actions = view.goals.flatMap((g) => g.actions);
  const actionsDone = actions.filter((a) => a.status === 'done').length;
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  const back = (
    <Pressable onPress={() => setPage(null)} accessibilityRole="button" accessibilityLabel={pt('devBack')} testID="dev-back" hitSlop={8} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, alignSelf: 'flex-start' }, pressed && { opacity: 0.7 }]}>
      <Icon name="chevron-left" size={16} color={colors.accent2} />
      <Text style={{ color: colors.accent2, fontSize: 13, fontWeight: '500' }}>{pt('devBack')}</Text>
    </Pressable>
  );

  // ---- Goals: the plan, every goal with its actions, evidence and the add form
  if (page === 'goals') {
    return (
      <View style={{ gap: 8 }} accessibilityLabel={pt('m21goals')} testID="dev-page-goals">
        {back}
        <SectionTitle>{pt('m21goals')}</SectionTitle>
        <Row>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 }}>{view.plan.title}</Text>
          <Pill label={label(`m21plan_${view.plan.status}`, view.plan.status)} tone={view.plan.status === 'active' ? 'green' : 'default'} />
          <Pill label={label(`m21vis_${view.plan.visibility}`, view.plan.visibility)} />
        </Row>
        {view.plan.owner.kind === 'org' ? <Muted size={12}>{pt('m21clubPlan')} — {view.plan.owner.orgName}</Muted> : null}
        {list && list.items.length > 1 ? (
          <Row>
            {list.items.map((p) => (
              <Button key={p.id} small label={p.title} onPress={() => setPlanId(p.id)} />
            ))}
          </Row>
        ) : null}
        {view.goals.length === 0 ? <Card><Muted>{pt('m21noGoals')}</Muted></Card> : null}
        {view.goals.map((g) => <GoalCard key={g.id} g={g} view={view} actor={actor} reload={reload} />)}
        {view.access.writeGoals ? (
          <Card>
            <TextInput
              style={inputStyle(colors)}
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
                <Row>
                  {cat.goalLibrary.items.slice(0, 4).map((i) => (
                    <Button key={i.id} small label={i.title} onPress={() => setNewGoal(i.title)} />
                  ))}
                </Row>
                <Disclosure label="About goals"><GuidanceNote title="Goal guidance" icon="target" size={12}>{cat.goalLibrary.note}</GuidanceNote></Disclosure>
              </View>
            ) : null}
          </Card>
        ) : null}
      </View>
    );
  }

  // ---- Feedback: every review, newest first, then the reflection form
  if (page === 'feedback') {
    return (
      <View style={{ gap: 8 }} accessibilityLabel={pt('m21reviews')} testID="dev-page-feedback">
        {back}
        <SectionTitle icon="chat-bubble">{pt('m21reviews')}</SectionTitle>
        {view.reviews.length === 0 ? <Card><Muted>{pt('m21noReviews')}</Muted></Card> : null}
        {[...view.reviews].sort((a, b) => b.reviewedAt - a.reviewedAt).map((r) => <ReviewCard key={r.id} r={r} />)}
        {view.access.reflect ? (
          <Card style={{ padding: 16, gap: 12, borderRadius: 24 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}><Icon name="file-text" size={20} color={colors.accentText} /><Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{pt('m21addReflection')}</Text></View>
            {/* A reflection is never presented as an assessment. */}
            <Muted size={12}>{pt('m21reflectionNote')}</Muted>
            <TextInput
              style={[inputStyle(colors), { minHeight: 64 }]}
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
      </View>
    );
  }

  // ---- Progress: the actions across every goal, each with its state word
  if (page === 'progress') {
    return (
      <View style={{ gap: 8 }} accessibilityLabel={pt('devProgress')} testID="dev-page-progress">
        {back}
        <SectionTitle>{pt('devProgress')}</SectionTitle>
        <MetricTiles items={[{ label: 'Active goals', value: s.activeGoals, icon: 'target' }, { label: pt('m21actionsDue'), value: s.actionsDue, icon: 'clipboard-list' }, { label: pt('m21overdue'), value: s.actionsOverdue, icon: 'timer' }]} />
        <RecordPanel><DetailFact label={pt('m21lastReview')} value={s.lastReviewAt ? pFmtDate(s.lastReviewAt) : pt('m21none')} /><DetailFact label={pt('m21nextReview')} value={s.nextReviewAt ? pFmtDate(s.nextReviewAt) : pt('m21none')} /></RecordPanel>
        {view.goals.map((g) => (
          <View key={g.id} style={{ gap: 12, paddingTop: 8 }}>
            <Row><Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }}>{g.title}</Text><Pill label={goalStatusLabel(g.status)} tone={GOAL_TONE[g.status] ?? 'default'} /></Row>
            <Muted size={12.5}>{g.completion.phrase}</Muted>
            {g.actions.map((a) => (
              <ActionRow
                key={a.id}
                a={a}
                busy={busy}
                canWrite={!!view.access.writeGoals || a.assignee?.kind === 'player'}
                onSet={(status) => run(() => m21.updateAction(actor, a.id, { status }))}
              />
            ))}
          </View>
        ))}
        <Disclosure label="About these counts"><GuidanceNote size={12}>{s.note}</GuidanceNote>{cat ? <GuidanceNote title="Reminders" icon="bell" size={12}>{cat.reminders.note}</GuidanceNote> : null}</Disclosure>
      </View>
    );
  }

  // ---- History: the plan's timeline
  if (page === 'history') {
    return (
      <View style={{ gap: 8 }} accessibilityLabel={pt('devHistory')} testID="dev-page-history">
        {back}
        <SectionTitle>{pt('devHistory')}</SectionTitle>
        {view.timeline.length === 0 ? <Muted>{pt('m21noHistory')}</Muted> : null}
        <View>{view.timeline.map((h, i) => (
          <TimelineItem key={h.id} date={pFmtDate(h.at)} last={i === view.timeline.length - 1}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500', lineHeight: 21 }}>{h.label}{h.subject.title ? ` — ${h.subject.title}` : ''}</Text>
            {h.byName ? <Muted size={12}>{h.byName}</Muted> : null}
          </TimelineItem>
        ))}</View>
      </View>
    );
  }

  // ---- Root: four rows, each one line, each a way in
  return (
    <View style={{ gap: 0 }} accessibilityLabel={pt('m21title')} testID="dev-root">
      <SectionTitle>{pt('m21title')}</SectionTitle>
      <ListRow label={pt('devCurrentFocus')} value={focus ? clip(focus.title, 40) : pt('devNone')} onPress={() => setPage('goals')} testID="dev-focus" />
      <ListRow label={pt('devLatestFeedback')} value={latestReview ? [latestReview.reviewedByName ?? label(`m21rev_${latestReview.reviewerKind}`, latestReview.reviewerKind), fmtShortDay(latestReview.reviewedAt)].join(' · ') : pt('devNone')} onPress={() => setPage('feedback')} testID="dev-feedback" />
      <ListRow label={pt('devProgress')} value={pt(s.activeGoals === 1 ? 'devActiveGoal' : 'devActiveGoals').replace('{n}', String(s.activeGoals))} onPress={() => setPage('progress')} testID="dev-progress" />
      <ListRow label={pt('devHistory')} value={pt('devEntries').replace('{n}', String(view.timeline.length))} onPress={() => setPage('history')} testID="dev-history" />
      <View style={{ marginTop: 10 }}>
        {/* M24F.5 — one way in to every explanation: the plan's limits and what its counts are. */}
        <Disclosure label="About this plan" testID="dev-about"><GuidanceNote title="Limits" icon="info" size={12}>{view.limitation}</GuidanceNote><GuidanceNote title="Not included" icon="eye-off" size={12}>{view.neverBuilt.note}</GuidanceNote><GuidanceNote size={12}>{s.note}</GuidanceNote>{cat ? <GuidanceNote title="Reminders" icon="bell" size={12}>{cat.reminders.note}</GuidanceNote> : null}</Disclosure>
      </View>
    </View>
  );
}
