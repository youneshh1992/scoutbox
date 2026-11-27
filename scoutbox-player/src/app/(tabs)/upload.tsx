import { GuidanceNote } from '../../components/InformationRows';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../../components/Text';
import { PlayerScreen as SafeAreaView } from '../../components/Vivid';
import { client, type ProgrammeInfo } from '../../data/client';
import type { Drill } from '../../domain/types';
import { useSession } from '../../state';
import { useColors, useStyles, type Palette } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { pt } from '../../i18n';
import { PageHeader } from '../../components/PageChrome';
import { CampaignsSection, LargeUploadCard } from '../../components/M12Sections';
import { UPLOAD_LIMITS } from '../../../../shared/upload';

// Web file picker. Native uses the camera roll in production; this prototype
// records title-only entries off-web.
const CLIP_MAX_BYTES = UPLOAD_LIMITS.player_clip.maxBytes;
const CLIP_MAX_MB = Math.round(CLIP_MAX_BYTES / (1024 * 1024));

function pickVideoFile(): Promise<{ file: File | null; name: string } | null> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > CLIP_MAX_BYTES) {
        resolve({ file: null, name: `TOO_LARGE:${file.name}` });
        return;
      }
      resolve({ file, name: file.name });
    };
    input.click();
  });
}

const STAT_FIELDS = [
  { key: 'appearances', label: 'Apps' },
  { key: 'goals', label: 'Goals' },
  { key: 'assists', label: 'Assists' },
  { key: 'paceKmh', label: 'Top speed' },
  { key: 'passCompletionPct', label: 'Pass %' },
  { key: 'duelSuccessPct', label: 'Duel %' },
] as const;

export default function Upload() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const { playerId, me, isMinor, refresh } = useSession();
  const [mediaTitle, setMediaTitle] = useState('');
  const [pickedFile, setPickedFile] = useState<{ file: File | null; name: string } | null>(null);
  const [linkAttendanceId, setLinkAttendanceId] = useState<string | null>(null);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [drillValues, setDrillValues] = useState<Record<string, string>>({});
  const [drillVideos, setDrillVideos] = useState<Record<string, File | undefined>>({});
  const [statDraft, setStatDraft] = useState<Record<string, string>>({});
  const [seasonDraft, setSeasonDraft] = useState('');
  const [programme, setProgramme] = useState<ProgrammeInfo | null>(null);

  useEffect(() => {
    if (playerId)
      client
        .getDrills(playerId)
        .then(setDrills)
        .catch(() => {});
    if (playerId && me?.pathway)
      client
        .getProgramme(playerId)
        .then(setProgramme)
        .catch(() => setProgramme(null));
  }, [playerId, me]);
  const [fixture, setFixture] = useState('');
  const [venue, setVenue] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  if (!playerId) return null;

  const say = (text: string, error = false) => {
    setNotice({ text, error });
    setTimeout(() => setNotice(null), 4000);
  };

  const chooseFile = async () => {
    const picked = await pickVideoFile();
    if (!picked)
      return say(
        Platform.OS === 'web'
          ? 'No file chosen.'
          : 'File picking is web-only in this prototype — native uses the camera roll in production.',
        true,
      );
    if (picked.name.startsWith('TOO_LARGE:'))
      return say(`That file is over the ${CLIP_MAX_MB}MB cap — trim the clip and retry.`, true);
    setPickedFile(picked);
    if (!mediaTitle.trim()) setMediaTitle(picked.name.replace(/\.[^.]+$/, ''));
    say(`Selected ${picked.name} — add a title and upload.`);
  };

  const uploadMedia = async () => {
    if (!mediaTitle.trim()) return say('Give the clip a title.', true);
    try {
      await client.addMedia(playerId, mediaTitle.trim(), pickedFile?.file ?? undefined, linkAttendanceId ?? undefined);
      const verified = !!linkAttendanceId && !!pickedFile;
      setMediaTitle('');
      setPickedFile(null);
      setLinkAttendanceId(null);
      await refresh();
      say(
        verified
          ? 'Verified Clip uploaded — provably filmed at a confirmed fixture. Clubs see the seal.'
          : pickedFile
            ? 'Video uploaded — clubs can watch it now, and it nudges your Trust Score.'
            : 'Added — attach a video file next time so clubs can watch it.',
      );
    } catch (e) {
      say(e instanceof Error ? e.message : 'Upload failed', true);
    }
  };

  // Prototype capture: production uses geofenced GPS + device attestation.
  const captureGps = () => {
    setGps({ lat: 53.4 + Math.random() * 0.1, lng: -2.3 + Math.random() * 0.1 });
    say('Location + device captured for this fixture.');
  };

  const logAttendance = async () => {
    if (!fixture.trim() || !venue.trim() || !date.trim()) return say('Fixture, venue and date are all required.', true);
    if (!gps) return say('Capture GPS + device first — attendance must be verifiable.', true);
    try {
      await client.addAttendance(playerId, {
        fixture: fixture.trim(),
        venue: venue.trim(),
        date,
        gps,
        deviceId: 'device-prototype',
      });
      setFixture('');
      setVenue('');
      setGps(null);
      await refresh();
      say('Verified attendance logged — Trust Score raised.');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not log attendance', true);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <PageHeader title={pt('tabUpload')} back />
        <Muted>
          Footage, stats, drills and verified appearances — the evidence that moves your Trust Score.
          {isMinor ? ' All yours to manage — clubs talk to your guardian, but the football is you.' : ''}
        </Muted>

        {notice && (
          <Card style={{ borderColor: notice.error ? colors.danger : colors.accent }}>
            <Text style={{ color: notice.error ? colors.danger : colors.text }}>{notice.text}</Text>
          </Card>
        )}

        <Card>
          <SectionTitle>Add match footage</SectionTitle>
          <Row>
            <Button
              small
              label={pickedFile ? `${pickedFile.name.slice(0, 28)}` : 'Choose video file'}
              onPress={chooseFile}
            />
            {pickedFile && <Pill label="Ready" tone="green" />}
          </Row>
          <TextInput
            style={styles.input}
            placeholder="Clip title (e.g. Highlights vs Riverside)"
            placeholderTextColor={colors.muted}
            value={mediaTitle}
            onChangeText={setMediaTitle}
          />
          {pickedFile && (me?.attendance.length ?? 0) > 0 && (
            <>
              <GuidanceNote icon="info" size={12.5}>
                Claim the Verified Clip seal: link this footage to the confirmed fixture it was filmed at.
              </GuidanceNote>
              <Row>
                {me!.attendance.map((a) => (
                  <Button
                    key={a.id}
                    small
                    primary={linkAttendanceId === a.id}
                    label={`${a.fixture.slice(0, 24)} (${a.date})`}
                    onPress={() => setLinkAttendanceId(linkAttendanceId === a.id ? null : a.id)}
                  />
                ))}
              </Row>
            </>
          )}
          <Button primary label={linkAttendanceId ? 'Upload as Verified Clip' : 'Upload clip'} onPress={uploadMedia} />
          {me && (
            <GuidanceNote icon="info" size={12.5}>
              {me.media.length} clip{me.media.length === 1 ? '' : 's'} on your profile. Titles are screened — no contact
              details.
            </GuidanceNote>
          )}
        </Card>

        <Card>
          <SectionTitle>Edit season stats</SectionTitle>
          <Muted size={12.5}>
            Leave the season blank to update this season, or name a past one (e.g. 2024/25) to build your
            season-by-season record.
          </Muted>
          <View style={{ gap: 4, maxWidth: 160 }}>
            <Muted size={11.5}>Season (optional)</Muted>
            <TextInput
              style={styles.input}
              placeholder="This season"
              placeholderTextColor={colors.muted}
              value={seasonDraft}
              onChangeText={setSeasonDraft}
            />
          </View>
          <Row>
            {STAT_FIELDS.map((f) => (
              <View key={f.key} style={{ gap: 4, minWidth: 92, flexGrow: 1 }}>
                <Muted size={11.5}>{f.label}</Muted>
                <TextInput
                  style={styles.input}
                  keyboardType="numeric"
                  placeholder={String((me?.stats as Record<string, number> | null)?.[f.key] ?? 0)}
                  placeholderTextColor={colors.muted}
                  value={statDraft[f.key] ?? ''}
                  onChangeText={(v) => setStatDraft({ ...statDraft, [f.key]: v })}
                />
              </View>
            ))}
          </Row>
          <Button
            primary
            label="Save stats"
            onPress={async () => {
              const updates: Record<string, number> = {};
              for (const f of STAT_FIELDS) {
                if (statDraft[f.key] !== undefined && statDraft[f.key] !== '')
                  updates[f.key] = Number(statDraft[f.key]);
              }
              if (!Object.keys(updates).length) return say('Change at least one stat first.', true);
              try {
                await client.updateStats(playerId, updates, seasonDraft.trim() || undefined);
                setStatDraft({});
                setSeasonDraft('');
                await refresh();
                say(
                  seasonDraft.trim()
                    ? `Filed under ${seasonDraft.trim()} in your season history.`
                    : 'Stats saved to your profile.',
                );
              } catch (e) {
                say(e instanceof Error ? e.message : 'Could not save stats', true);
              }
            }}
          />
        </Card>

        {programme && (
          <Card>
            <SectionTitle>Your training programme</SectionTitle>
            {!programme.current ? (
              <>
                <GuidanceNote icon="info" size={12.5}>
                  Academy players get coaches — you get this. Free, position-specific, and every session feeds your
                  streak and weekly goal. Pick your track:
                </GuidanceNote>
                <Row>
                  {programme.tracks.map((t) => (
                    <Button
                      key={t.key}
                      small
                      primary={t.key === programme.suggested}
                      label={`${t.label}${t.key === programme.suggested ? ' ★' : ''}`}
                      onPress={async () => {
                        try {
                          await client.selectProgramme(playerId, t.key);
                          setProgramme(await client.getProgramme(playerId));
                          say('Track selected — first session is waiting below.');
                        } catch (e) {
                          say(e instanceof Error ? e.message : 'Could not start', true);
                        }
                      }}
                    />
                  ))}
                </Row>
              </>
            ) : (
              <>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Muted size={12.5}>{programme.current.label}</Muted>
                  <Pill
                    label={`${programme.current.doneThisWeek}/${programme.current.totalPerWeek} this week`}
                    tone={programme.current.doneThisWeek >= programme.current.totalPerWeek ? 'green' : 'blue'}
                  />
                </Row>
                {programme.current.sessions.map((sesh) => (
                  <Row key={sesh.id} style={{ justifyContent: 'space-between' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: sesh.done ? colors.muted : colors.text, fontSize: 13.5 }}>
                        {sesh.done ? 'Done · ' : ''}
                        {sesh.day} — {sesh.title}
                      </Text>
                    </View>
                    {!sesh.done && (
                      <Button
                        small
                        label="Done"
                        onPress={async () => {
                          try {
                            await client.completeProgrammeSession(playerId, sesh.id);
                            setProgramme(await client.getProgramme(playerId));
                            await refresh();
                            say('Session logged — it counts toward your streak and weekly goal.');
                          } catch (e) {
                            say(e instanceof Error ? e.message : 'Could not log', true);
                          }
                        }}
                      />
                    )}
                  </Row>
                ))}
                <GuidanceNote icon="info" size={11.5}>
                  Sessions with a matching drill count double when you record the drill below with video.
                </GuidanceNote>
              </>
            )}
          </Card>
        )}

        <Card>
          <SectionTitle>At-home combine</SectionTitle>
          <Muted size={12.5}>
            Standardised drills with a measurable number. Record it on video and the result is
            <Text style={{ color: colors.accentText }}> combine-verified</Text> — real numbers clubs can trust, from
            anywhere.
          </Muted>
          {drills.map((d) => (
            <View key={d.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600', flex: 1 }}>{d.name}</Text>
                {d.best ? (
                  <Pill label={`best ${d.best.value}${d.unit}${d.best.verified ? ' ' : ''}`} tone="green" />
                ) : d.completed ? (
                  <Pill label="Done" tone="blue" />
                ) : null}
              </Row>
              <Muted size={11.5}>
                {d.metric} · benchmark {d.benchmark}
                {d.unit}
              </Muted>
              <Row>
                <TextInput
                  style={[styles.input, { flex: 1, paddingVertical: 6 }]}
                  keyboardType="numeric"
                  placeholder={`your ${d.metric}`}
                  placeholderTextColor={colors.muted}
                  value={drillValues[d.id] ?? ''}
                  onChangeText={(v) => setDrillValues({ ...drillValues, [d.id]: v })}
                />
                <Button
                  small
                  label={drillVideos[d.id] ? 'Attached' : 'Attach'}
                  onPress={async () => {
                    const picked = await pickVideoFile();
                    if (picked?.file) {
                      setDrillVideos({ ...drillVideos, [d.id]: picked.file });
                      say('Drill video attached — result will be combine-verified.');
                    } else if (picked) {
                      say(`That file is over the ${CLIP_MAX_MB}MB cap.`, true);
                    }
                  }}
                />
                <Button
                  small
                  primary
                  label="Log"
                  onPress={async () => {
                    const raw = drillValues[d.id];
                    if (!raw) return say('Enter your number first.', true);
                    try {
                      const video = drillVideos[d.id];
                      // The footage becomes one of the player's clips, which the result names.
                      const mediaId = video ? await client.addMedia(playerId, `${d.name} — combine`, video) : undefined;
                      await client.completeDrill(playerId, d.id, Number(raw), mediaId);
                      setDrillValues({ ...drillValues, [d.id]: '' });
                      setDrillVideos({ ...drillVideos, [d.id]: undefined });
                      setDrills(await client.getDrills(playerId));
                      await refresh();
                      say(
                        drillVideos[d.id]
                          ? 'Combine-verified result logged.'
                          : 'Result logged (attach video next time to verify it).',
                      );
                    } catch (e) {
                      say(e instanceof Error ? e.message : 'Could not log drill', true);
                    }
                  }}
                />
              </Row>
            </View>
          ))}
        </Card>

        <Card>
          <SectionTitle>Log verified match attendance</SectionTitle>
          <Muted size={12.5}>
            ScoutBox confirms you were physically at the fixture — venue, date, GPS and device data together.
            That&apos;s why verified attendance carries real weight with clubs.
          </Muted>
          <TextInput
            style={styles.input}
            placeholder="Fixture (e.g. County Cup semi-final)"
            placeholderTextColor={colors.muted}
            value={fixture}
            onChangeText={setFixture}
          />
          <TextInput
            style={styles.input}
            placeholder="Venue"
            placeholderTextColor={colors.muted}
            value={venue}
            onChangeText={setVenue}
          />
          <TextInput
            style={styles.input}
            placeholder="Date (YYYY-MM-DD)"
            placeholderTextColor={colors.muted}
            value={date}
            onChangeText={setDate}
          />
          <Row>
            <Button small label={gps ? 'GPS + device captured' : 'Capture GPS + device'} onPress={captureGps} />
            {gps && <Pill label={`${gps.lat.toFixed(3)}, ${gps.lng.toFixed(3)}`} tone="green" />}
          </Row>
          <Button primary label="Log attendance" onPress={logAttendance} />
        </Card>
        {playerId ? (
          <CampaignsSection
            actor={{ kind: 'player', id: playerId }}
            mediaOptions={(me?.media ?? []).map((m) => ({ id: m.id, title: m.title }))}
          />
        ) : null}
        {playerId ? <LargeUploadCard playerId={playerId} onDone={refresh} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    scroll: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 32, gap: 0 },
    input: {
      backgroundColor: colors.bg2,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 10,
      color: colors.text,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15,
    },
  });
