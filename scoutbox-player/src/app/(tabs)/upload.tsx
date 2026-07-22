import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { client } from '../../data/client';
import { useSession } from '../../state';
import { colors } from '../../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../../components/ui';

export default function Upload() {
  const { playerId, me, refresh } = useSession();
  const [mediaTitle, setMediaTitle] = useState('');
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

  const uploadMedia = async () => {
    if (!mediaTitle.trim()) return say('Give the clip a title.', true);
    try {
      await client.addMedia(playerId, mediaTitle.trim());
      setMediaTitle('');
      await refresh();
      say('Uploaded — clubs can see it now, and it nudges your Trust Score.');
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
        <Text style={styles.h1}>Upload</Text>
        <Muted>Footage and verified appearances — the evidence that moves your Trust Score.</Muted>

        {notice && (
          <Card style={{ borderColor: notice.error ? colors.danger : colors.accent }}>
            <Text style={{ color: notice.error ? colors.danger : colors.text }}>{notice.text}</Text>
          </Card>
        )}

        <Card>
          <SectionTitle>Add match footage</SectionTitle>
          <TextInput
            style={styles.input}
            placeholder="Clip title (e.g. Highlights vs Riverside)"
            placeholderTextColor={colors.muted}
            value={mediaTitle}
            onChangeText={setMediaTitle}
          />
          <Button primary label="Upload clip" onPress={uploadMedia} />
          {me && <Muted size={12.5}>{me.media.length} clip{me.media.length === 1 ? '' : 's'} on your profile.</Muted>}
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
