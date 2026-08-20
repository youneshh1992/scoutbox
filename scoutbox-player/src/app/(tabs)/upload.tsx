import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import type { Drill } from '../../domain/types';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';
import { ReportButton } from '../../components/ReportSheet';
import { NotificationBell } from '../../components/NotificationBell';

// Web file picker → data URL (capped ~12MB). Native uses the camera roll in
// production; this prototype records title-only entries off-web.
function pickVideoFile(): Promise<{ dataUrl: string; name: string } | null> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 12 * 1024 * 1024) {
        resolve({ dataUrl: '', name: `TOO_LARGE:${file.name}` });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: String(reader.result), name: file.name });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
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
  const { playerId, me, isMinor, refresh } = useSession();
  const [mediaTitle, setMediaTitle] = useState('');
  const [pickedFile, setPickedFile] = useState<{ dataUrl: string; name: string } | null>(null);
  const [linkAttendanceId, setLinkAttendanceId] = useState<string | null>(null);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [drillValues, setDrillValues] = useState<Record<string, string>>({});
  const [drillVideos, setDrillVideos] = useState<Record<string, string>>({});
  const [statDraft, setStatDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (playerId) client.getDrills(playerId).then(setDrills).catch(() => {});
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
    if (!picked) return say(Platform.OS === 'web' ? 'No file chosen.' : 'File picking is web-only in this prototype — native uses the camera roll in production.', true);
    if (picked.name.startsWith('TOO_LARGE:')) return say('That file is over the 12MB prototype cap — trim the clip and retry.', true);
    setPickedFile(picked);
    if (!mediaTitle.trim()) setMediaTitle(picked.name.replace(/\.[^.]+$/, ''));
    say(`Selected ${picked.name} — add a title and upload.`);
  };

  const uploadMedia = async () => {
    if (!mediaTitle.trim()) return say('Give the clip a title.', true);
    try {
      await client.addMedia(playerId, mediaTitle.trim(), pickedFile?.dataUrl || undefined, linkAttendanceId ?? undefined);
      const verified = !!linkAttendanceId && !!pickedFile;
      setMediaTitle('');
      setPickedFile(null);
      setLinkAttendanceId(null);
      await refresh();
      say(verified
        ? '✅ Verified Clip uploaded — provably filmed at a confirmed fixture. Clubs see the seal.'
        : pickedFile ? 'Video uploaded — clubs can watch it now, and it nudges your Trust Score.' : 'Added — attach a video file next time so clubs can watch it.');
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
      await client.addAttendance(playerId, { fixture: fixture.trim(), venue: venue.trim(), date, gps, deviceId: 'device-prototype' });
      setFixture(''); setVenue(''); setGps(null);
      await refresh();
      say('Verified attendance logged — Trust Score raised.');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not log attendance', true);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.h1}>Upload</Text>
          <Row>
            <NotificationBell />
            <ReportButton />
          </Row>
        </Row>
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
            <Button small label={pickedFile ? `🎬 ${pickedFile.name.slice(0, 28)}` : '🎬 Choose video file'} onPress={chooseFile} />
            {pickedFile && <Pill label="ready" tone="green" />}
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
              <Muted size={12.5}>
                ✅ Claim the Verified Clip seal: link this footage to the confirmed fixture it was filmed at.
              </Muted>
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
          <Button primary label={linkAttendanceId ? 'Upload as ✅ Verified Clip' : 'Upload clip'} onPress={uploadMedia} />
          {me && <Muted size={12.5}>{me.media.length} clip{me.media.length === 1 ? '' : 's'} on your profile. Titles are screened — no contact details.</Muted>}
        </Card>

        <Card>
          <SectionTitle>Edit season stats</SectionTitle>
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
                if (statDraft[f.key] !== undefined && statDraft[f.key] !== '') updates[f.key] = Number(statDraft[f.key]);
              }
              if (!Object.keys(updates).length) return say('Change at least one stat first.', true);
              try {
                await client.updateStats(playerId, updates);
                setStatDraft({});
                await refresh();
                say('Stats saved to your profile.');
              } catch (e) {
                say(e instanceof Error ? e.message : 'Could not save stats', true);
              }
            }}
          />
        </Card>

        <Card>
          <SectionTitle>🏟 At-home combine</SectionTitle>
          <Muted size={12.5}>
            Standardised drills with a measurable number. Record it on video and the result is
            <Text style={{ color: colors.accent }}> combine-verified</Text> — real numbers clubs can trust,
            from anywhere.
          </Muted>
          {drills.map((d) => (
            <View key={d.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '600', flex: 1 }}>{d.name}</Text>
                {d.best
                  ? <Pill label={`best ${d.best.value}${d.unit}${d.best.verified ? ' 🎥' : ''}`} tone="green" />
                  : d.completed ? <Pill label="done ✓" tone="blue" /> : null}
              </Row>
              <Muted size={11.5}>{d.metric} · benchmark {d.benchmark}{d.unit}</Muted>
              <Row>
                <TextInput
                  style={[styles.input, { flex: 1, paddingVertical: 6 }]}
                  keyboardType="numeric"
                  placeholder={`your ${d.metric}`}
                  placeholderTextColor={colors.muted}
                  value={drillValues[d.id] ?? ''}
                  onChangeText={(v) => setDrillValues({ ...drillValues, [d.id]: v })}
                />
                <Button small label={drillVideos[d.id] ? '🎥 ✓' : '🎥 attach'} onPress={async () => {
                  const picked = await pickVideoFile();
                  if (picked && !picked.name.startsWith('TOO_LARGE:')) {
                    setDrillVideos({ ...drillVideos, [d.id]: picked.dataUrl });
                    say('Drill video attached — result will be combine-verified.');
                  } else if (picked) {
                    say('That file is over the 12MB cap.', true);
                  }
                }} />
                <Button small primary label="Log" onPress={async () => {
                  const raw = drillValues[d.id];
                  if (!raw) return say('Enter your number first.', true);
                  try {
                    await client.completeDrill(playerId, d.id, Number(raw), drillVideos[d.id]);
                    setDrillValues({ ...drillValues, [d.id]: '' });
                    setDrillVideos({ ...drillVideos, [d.id]: '' });
                    setDrills(await client.getDrills(playerId));
                    await refresh();
                    say(drillVideos[d.id] ? '🎥 Combine-verified result logged.' : 'Result logged (attach video next time to verify it).');
                  } catch (e) {
                    say(e instanceof Error ? e.message : 'Could not log drill', true);
                  }
                }} />
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
          <TextInput style={styles.input} placeholder="Fixture (e.g. County Cup semi-final)" placeholderTextColor={colors.muted} value={fixture} onChangeText={setFixture} />
          <TextInput style={styles.input} placeholder="Venue" placeholderTextColor={colors.muted} value={venue} onChangeText={setVenue} />
          <TextInput style={styles.input} placeholder="Date (YYYY-MM-DD)" placeholderTextColor={colors.muted} value={date} onChangeText={setDate} />
          <Row>
            <Button small label={gps ? 'GPS + device captured ✓' : 'Capture GPS + device'} onPress={captureGps} />
            {gps && <Pill label={`${gps.lat.toFixed(3)}, ${gps.lng.toFixed(3)}`} tone="green" />}
          </Row>
          <Button primary label="Log attendance" onPress={logAttendance} />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 18, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
  h1: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 6 },
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
