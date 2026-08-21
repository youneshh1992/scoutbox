// Profile — layout matches the approved design mock: avatar card with squad
// number, verified name header, trust score card with breakdown bar, season
// output tiles, availability chips, Academy+ card, contract status card.
// All functionality from Milestone 2 is preserved below the fold.

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { client, type PlayerCV } from '../../data/client';
import {
  AVAILABILITY_LABELS, CONTRACT_LABELS,
  type Availability, type ContractStatus,
} from '../../domain/types';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle, TrustBar } from '../../components/ui';
import { ReportSheet } from '../../components/ReportSheet';
import { WebVideo } from '../../components/WebVideo';

function flagEmoji(country: string): string {
  if (!/^[A-Z]{2}$/i.test(country)) return '';
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

function standing(score: number): string {
  if (score >= 75) return 'Excellent standing';
  if (score >= 50) return 'Good standing';
  return 'Building trust';
}

export default function Profile() {
  const router = useRouter();
  const { playerId, me, isMinor, refresh } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [cvOpen, setCvOpen] = useState(false);
  const [cv, setCv] = useState<PlayerCV | null>(null);

  useEffect(() => {
    if (cvOpen && playerId) client.getCv(playerId).then(setCv).catch(() => {});
  }, [cvOpen, playerId, me]);

  if (!playerId || !me) return null;

  const set = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch {
      /* surfaced through unrefreshed UI */
    }
  };

  const initials = me.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* header row: back + menu (menu = report/block, on every screen) */}
        <Row style={{ justifyContent: 'space-between' }}>
          <Pressable style={styles.roundBtn} onPress={() => router.back()} accessibilityLabel="Back">
            <Text style={styles.roundBtnText}>‹</Text>
          </Pressable>
          <Pressable style={styles.roundBtn} onPress={() => setMenuOpen(true)} accessibilityLabel="More — report and block">
            <Text style={styles.roundBtnText}>⋯</Text>
          </Pressable>
        </Row>
        {menuOpen && <ReportSheet onClose={() => setMenuOpen(false)} />}

        {/* identity block: avatar card + details */}
        <View style={styles.identityRow}>
          <View style={styles.avatarCard}>
            <Text style={styles.avatarNumber}>{me.squadNumber ?? ''}</Text>
            <Text style={styles.avatarInitials}>{initials}</Text>
            <View style={styles.cameraBadge}>
              <Text style={{ fontSize: 13 }}>📷</Text>
            </View>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Row>
              <Text style={styles.name}>{me.name}</Text>
              {me.identityVerified && <Text style={{ color: colors.accent, fontSize: 18 }}>✔</Text>}
            </Row>
            <Text style={styles.subline}>
              {me.position ?? '—'} · {me.age} · {me.foot ? `${me.foot[0].toUpperCase()}${me.foot.slice(1)} Foot` : '—'} {flagEmoji(me.country)}
            </Text>
            {!isMinor && !!(me.city || me.country) && (
              <Muted size={14}>📍 {me.city ? `${me.city}, ` : ''}{me.country}</Muted>
            )}
            {isMinor && <Muted size={14}>📍 {me.country} — exact location never shown</Muted>}
            {(me.heightCm || me.weightKg) && (
              <Muted size={14}>{me.heightCm ? `${me.heightCm} cm` : ''}{me.heightCm && me.weightKg ? '  ·  ' : ''}{me.weightKg ? `${me.weightKg} kg` : ''}</Muted>
            )}
            <Row style={{ marginTop: 4 }}>
              {me.identityVerified && <Pill label="🛡 Identity verified" tone="green" />}
              {isMinor && <Pill label="Guardian-managed" tone="blue" />}
              {me.badges.map((b) => <Pill key={b} label={b} tone="gold" />)}
            </Row>
          </View>
        </View>

        {/* aging up: an 18th birthday hands the account to the player */}
        {me.agingUp?.eligible && (
          <Card style={{ borderColor: colors.gold }}>
            <SectionTitle>🎂 You&apos;re 18 — this account can become fully yours</SectionTitle>
            <Muted size={13}>
              Your parent/guardian has kept this account safe until now. Completing the handover moves
              availability, medical sharing and club contact to you. Your history — clips, reports,
              trust — stays exactly as it is.
            </Muted>
            <Row>
              <Button
                small primary label="Complete the handover"
                onPress={() => set(() => client.agingUpComplete(playerId))}
              />
            </Row>
          </Card>
        )}

        {/* trust score */}
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <SectionTitle>Trust score ⓘ</SectionTitle>
            <Text style={{ fontSize: 22 }}>🛡</Text>
          </Row>
          <Row style={{ alignItems: 'flex-end' }}>
            <Text style={styles.trustBig}>{me.trustScore}</Text>
            <Text style={styles.trustDenom}>/100</Text>
            <View style={{ flex: 1, marginLeft: 12, marginBottom: 10 }}>
              <View style={styles.trustTrack}>
                <View style={[styles.trustFill, { width: `${me.trustScore}%` }]} />
                <View style={[styles.trustKnob, { left: `${Math.min(me.trustScore, 97)}%` }]} />
              </View>
            </View>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.standing}>{standing(me.trustScore)}</Text>
            {me.tier && <Pill label={`Tier: ${me.tier}`} tone="green" />}
            {typeof me.streak === 'number' && me.streak > 0 && <Pill label={`🔥 ${me.streak}-day streak`} tone="gold" />}
          </Row>
          <Muted size={12.5}>
            Base {me.trust.base}  ·  Identity +{me.trust.identityVerified}  ·  Attendance +{me.trust.verifiedAttendance}  ·  Trial Reports +{me.trust.trialReports}  ·  Media +{me.trust.media}  ·  Profile +{me.trust.profileComplete}
          </Muted>
          <Muted size={12.5}>
            Trust rises through verified attendance and clubs&apos; filed trial reports. Never through
            payments. Sharing medical data has no effect either way.
          </Muted>
        </Card>

        {/* season output */}
        {me.stats && (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <SectionTitle>📈 Season output</SectionTitle>
              <Pill label="This Season ▾" />
            </Row>
            <Row>
              <StatTile icon="👕" v={String(me.stats.appearances)} k="Apps" />
              {me.position === 'GK' ? (
                <StatTile icon="🧤" v={String(me.stats.cleanSheets ?? 0)} k="Clean Sheets" />
              ) : (
                <>
                  <StatTile icon="⚽" v={String(me.stats.goals)} k="Goals" />
                  <StatTile icon="🥾" v={String(me.stats.assists)} k="Assists" />
                </>
              )}
              {me.stats.paceKmh != null && <StatTile icon="⚡" v={`${me.stats.paceKmh}`} k="km/h Top Speed" />}
              {me.stats.passCompletionPct != null && <StatTile icon="🎯" v={`${me.stats.passCompletionPct}%`} k="Pass Accuracy" />}
            </Row>
            {(me.seasonHistory?.length ?? 0) > 0 && (() => {
              // Progress over time: history (oldest → newest) plus this season.
              const series = [...me.seasonHistory!].reverse().concat([
                { season: 'Now', appearances: me.stats?.appearances ?? 0, goals: me.stats?.goals ?? 0, assists: me.stats?.assists ?? 0 },
              ]);
              const maxGoals = Math.max(...series.map((s) => s.goals), 1);
              return (
                <View style={{ borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8, gap: 6 }}>
                  <Muted size={12}>Your career, season by season — goals trend</Muted>
                  <Row style={{ alignItems: 'flex-end', height: 56, gap: 8 }}>
                    {series.map((s) => (
                      <View key={s.season} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                        <Text style={{ color: colors.text, fontSize: 11, fontWeight: '700' }}>{s.goals}</Text>
                        <View style={{
                          alignSelf: 'stretch',
                          height: Math.max(4, (s.goals / maxGoals) * 34),
                          borderRadius: 3,
                          backgroundColor: s.season === 'Now' ? colors.accent : colors.panel2,
                        }} />
                        <Muted size={9.5}>{s.season}</Muted>
                      </View>
                    ))}
                  </Row>
                  {me.seasonHistory!.map((s) => (
                    <Row key={s.season} style={{ justifyContent: 'space-between' }}>
                      <Pill label={s.season} />
                      <Muted size={12.5}>{s.appearances} apps · {s.goals} goals · {s.assists} assists</Muted>
                    </Row>
                  ))}
                </View>
              );
            })()}
          </Card>
        )}

        {/* availability */}
        {!isMinor ? (
          <Card>
            <SectionTitle>🗓 Availability</SectionTitle>
            <Row>
              {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((a) => (
                <Button key={a} small primary={me.availability === a} label={AVAILABILITY_LABELS[a]}
                  onPress={() => set(() => client.setAvailability(playerId, a, undefined))} />
              ))}
            </Row>
            <SectionTitle>Contract status</SectionTitle>
            <Row>
              {(Object.keys(CONTRACT_LABELS) as ContractStatus[]).filter((c) => c !== 'unknown').map((c) => (
                <Button key={c} small primary={me.contractStatus === c} label={CONTRACT_LABELS[c]}
                  onPress={() => set(() => client.setAvailability(playerId, undefined, c))} />
              ))}
            </Row>
          </Card>
        ) : (
          <Card>
            <SectionTitle>🗓 Availability</SectionTitle>
            <Muted size={13}>
              Availability and club interactions are managed by your parent or guardian. You focus on
              playing — uploads, stats and drills are all yours.
            </Muted>
          </Card>
        )}

        {/* academy+ */}
        {!isMinor && (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <SectionTitle>🎓 Academy+</SectionTitle>
                <Muted size={12.5}>
                  Opt-in cohort for released and late-developing players — a fresh start, surfaced first
                  in club searches.
                </Muted>
              </View>
              <Switch
                value={me.academyPlus}
                onValueChange={(v) => set(() => client.setAcademyPlus(playerId, v))}
                trackColor={{ true: colors.accent, false: colors.line }}
                thumbColor="#fff"
              />
            </Row>
            <View style={styles.subRow}>
              <Text style={{ fontSize: 14 }}>👤</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600' }}>Player-controlled.</Text>
                <Muted size={12.5}>You can switch this off any time.</Muted>
              </View>
              <Text style={{ color: colors.muted, fontSize: 18 }}>›</Text>
            </View>
          </Card>
        )}

        {/* contract status card */}
        {(me.contractUntil || me.marketValueRange || me.agentName) && (
          <Card>
            <SectionTitle>📄 Contract status</SectionTitle>
            <Row style={{ alignItems: 'stretch' }}>
              <View style={{ flex: 1, gap: 10 }}>
                {me.contractUntil && (
                  <View>
                    <Muted size={12}>Contracted until</Muted>
                    <Text style={styles.contractV}>
                      {new Date(me.contractUntil).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </Text>
                  </View>
                )}
                {me.marketValueRange && (
                  <View>
                    <Muted size={12}>Market Value</Muted>
                    <Text style={styles.contractV}>{me.marketValueRange}</Text>
                  </View>
                )}
                {me.agentName && (
                  <View>
                    <Muted size={12}>🕴 Agent</Muted>
                    <Text style={styles.contractV}>{me.agentName}</Text>
                  </View>
                )}
              </View>
              <View style={styles.jersey}>
                <Text style={{ fontSize: 44 }}>👕</Text>
                <Text style={styles.jerseyNumber}>{me.squadNumber ?? ''}</Text>
              </View>
            </Row>
          </Card>
        )}

        {/* ---- everything below keeps Milestone 2 functionality ---- */}

        <Card style={me.medical.shared ? { borderColor: colors.gold } : undefined}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <SectionTitle>Medical sharing {me.medical.shared ? '— ON' : '— OFF'}</SectionTitle>
              <Muted size={12.5}>
                {isMinor
                  ? 'Your parent or guardian controls this. Nothing is visible to any organisation unless they switch it on.'
                  : 'Your medical history is invisible to every organisation unless you switch this on. Sharing never changes your Trust Score.'}
              </Muted>
            </View>
            {!isMinor && (
              <Switch
                value={me.medical.shared}
                onValueChange={(v) => set(() => client.setMedicalShared(playerId, v))}
                trackColor={{ true: colors.gold, false: colors.line }}
                thumbColor="#fff"
              />
            )}
          </Row>
          {me.medical.records.map((r) => (
            <Row key={r.id}>
              <Pill label={r.type} />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{r.title}</Text>
              <Muted size={12}>
                {r.date}{r.layoffWeeks ? ` · ${r.layoffWeeks} wks` : ''}{r.cleared ? ' · cleared' : ''}
              </Muted>
            </Row>
          ))}
          {me.medical.records.length === 0 && <Muted size={12.5}>No records logged.</Muted>}
        </Card>

        {me.trialReports.length > 0 && (
          <Card>
            <SectionTitle>Trial performance reports</SectionTitle>
            {me.trialReports.map((r) => (
              <View key={r.id} style={{ gap: 2 }}>
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>{r.orgName}</Text>
                <Muted size={12.5}>
                  accel {r.acceleration}/10 · {r.sprintSpeedKmh} km/h · {r.distanceKm} km · pass {r.passCompletionPct}% ·
                  duels {r.duelSuccessPct}% · coach {r.coachRating}/10
                </Muted>
                {r.strengthNote ? <Muted size={12.5}>💪 Strength: {r.strengthNote}</Muted> : null}
                {r.focusNote ? <Muted size={12.5}>🎯 Work on: {r.focusNote}</Muted> : null}
              </View>
            ))}
            <Muted size={12.5}>Filed by clubs after your trials — mandatory, and they raise your Trust Score.</Muted>
          </Card>
        )}

        <Card>
          <SectionTitle>Transfer timeline</SectionTitle>
          {me.timeline.length === 0 && <Muted size={13}>No milestones yet.</Muted>}
          {me.timeline.map((t, i) => (
            <Row key={i}>
              <Pill label={t.year} />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{t.event}</Text>
            </Row>
          ))}
        </Card>

        <Card>
          <SectionTitle>Match footage</SectionTitle>
          {me.media.length === 0 && <Muted size={13}>No clips yet — upload from the Upload tab.</Muted>}
          {me.media.map((m) => {
            const src = client.mediaUrl(m.url);
            return (
              <View key={m.id} style={{ gap: 6 }}>
                <Row>
                  {m.verifiedClip ? <Pill label="✅ Verified Clip" tone="green" /> : <Pill label={m.kind} tone="blue" />}
                  <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{m.title}</Text>
                  <Muted size={12}>{m.views ?? 0} view{(m.views ?? 0) === 1 ? '' : 's'}</Muted>
                </Row>
                {Object.keys(m.tags ?? {}).length > 0 && (
                  <Row>
                    {Object.entries(m.tags!).map(([t, n]) => <Pill key={t} label={`${t.replace(/_/g, ' ')} ×${n}`} tone="gold" />)}
                  </Row>
                )}
                {src && <WebVideo src={src} />}
              </View>
            );
          })}
        </Card>

        {(me.drillResults?.length ?? 0) > 0 && (
          <Card>
            <SectionTitle>🏟 At-home combine</SectionTitle>
            {me.drillResults!.map((r) => (
              <Row key={r.id}>
                <Pill label={r.verified ? '🎥 verified' : 'self-reported'} tone={r.verified ? 'green' : 'blue'} />
                <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{r.drillName}</Text>
                <Muted size={12}>{r.metric}: {r.value}{r.unit}</Muted>
              </Row>
            ))}
            <Muted size={12.5}>Video-backed results are combine-verified and visible to clubs.</Muted>
          </Card>
        )}

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <SectionTitle>📄 Your verified sports CV</SectionTitle>
              <Muted size={12.5}>
                Your whole verified record — attendance, trial reports, combine numbers, trust — as a
                portable CV you own. ScoutBox never locks your history in.
              </Muted>
            </View>
            <Button small primary label={cvOpen ? 'Hide' : 'View CV'} onPress={() => setCvOpen(!cvOpen)} />
          </Row>
          {cvOpen && cv && (
            <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10 }}>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }}>{cv.player.name} — Verified Sports CV</Text>
              <Muted size={12.5}>
                {cv.player.position ?? '—'} · {cv.player.age} · {cv.player.foot ?? '—'} foot · {cv.player.country}
                {cv.player.identityVerified ? ' · identity verified' : ''}
              </Muted>
              <Muted size={12.5}>Trust {cv.trust.score}/100 ({cv.trust.tier})</Muted>
              {cv.seasonStats && <Muted size={12.5}>Season: {cv.seasonStats.appearances} apps · {cv.seasonStats.goals} goals · {cv.seasonStats.assists} assists</Muted>}
              <Muted size={12.5}>Verified attendance ({cv.verifiedAttendance.length}): {cv.verifiedAttendance.map((a) => `${a.fixture} (${a.date})`).join(' · ') || '—'}</Muted>
              <Muted size={12.5}>Verified clips: {cv.verifiedClips.map((c) => c.title).join(' · ') || '—'}</Muted>
              <Muted size={12.5}>
                Trial reports ({cv.trialReports.length}): {cv.trialReports.map((r) => `${r.orgName} — coach ${r.coachRating}/10`).join(' · ') || '—'}
              </Muted>
              {cv.combine.length > 0 && (
                <Muted size={12.5}>Combine: {cv.combine.map((r) => `${r.metric} ${r.value}${r.unit}${r.verified ? ' ✓' : ''}`).join(' · ')}</Muted>
              )}
              <Muted size={11.5}>{cv.note}</Muted>
            </View>
          )}
        </Card>

        <Card>
          <SectionTitle>Verified match attendance</SectionTitle>
          {me.attendance.length === 0 && <Muted size={13}>None yet — log one from the Upload tab.</Muted>}
          {me.attendance.map((a) => (
            <Row key={a.id}>
              <Pill label="GPS ✓" tone="green" />
              <Text style={{ color: colors.text, fontSize: 13.5, flex: 1 }}>{a.fixture}</Text>
              <Muted size={12}>{a.venue} · {a.date}</Muted>
            </Row>
          ))}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatTile({ icon, v, k }: { icon: string; v: string; k: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={{ fontSize: 20 }}>{icon}</Text>
      <Text style={styles.statValue}>{v}</Text>
      <Muted size={11}>{k}</Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
  roundBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnText: { color: colors.text, fontSize: 20, lineHeight: 22 },
  identityRow: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  avatarCard: {
    width: 128,
    height: 128,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.6,
    shadowRadius: 12,
    overflow: 'visible',
  },
  avatarNumber: {
    position: 'absolute',
    top: 2,
    right: 8,
    fontSize: 56,
    fontWeight: '800',
    color: 'rgba(53, 208, 127, 0.18)',
  },
  avatarInitials: { color: colors.text, fontSize: 40, fontWeight: '800' },
  cameraBadge: {
    position: 'absolute',
    bottom: -8,
    right: -8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { color: colors.text, fontSize: 27, fontWeight: '800' },
  subline: { color: colors.text, fontSize: 16.5, fontWeight: '600' },
  trustBig: { color: colors.accent, fontSize: 54, fontWeight: '800', lineHeight: 56 },
  trustDenom: { color: colors.muted, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  standing: { color: colors.accent, fontSize: 14.5, fontWeight: '600' },
  trustTrack: { height: 8, borderRadius: 4, backgroundColor: colors.bg, overflow: 'visible' },
  trustFill: { height: '100%', borderRadius: 4, backgroundColor: colors.accent },
  trustKnob: {
    position: 'absolute',
    top: -3,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: '#fff',
  },
  statTile: {
    flexGrow: 1,
    minWidth: 86,
    backgroundColor: colors.bg2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 3,
  },
  statValue: { color: colors.text, fontSize: 21, fontWeight: '800' },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.bg2,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
  },
  contractV: { color: colors.text, fontSize: 17, fontWeight: '800' },
  jersey: {
    width: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jerseyNumber: {
    position: 'absolute',
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 2,
  },
});
