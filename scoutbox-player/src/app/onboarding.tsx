import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { client, ClientError, type DemoIdentity } from '../data/client';
import { adultAgeFor, ageOn, SAFEGUARDING_PROMISES } from '../domain/safeguarding';
import { POSITIONS } from '../domain/types';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../components/ui';

const COUNTRIES = ['GB', 'PT', 'FR', 'SE', 'PL', 'NG', 'GH', 'AR', 'JP', 'KR', 'TH', 'SG', 'US'];

type Step = 'welcome' | 'details' | 'football' | 'blocked';

export default function Onboarding() {
  const router = useRouter();
  const { login, mode } = useSession();
  const [step, setStep] = useState<Step>('welcome');
  const [identities, setIdentities] = useState<DemoIdentity[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [country, setCountry] = useState('GB');
  const [city, setCity] = useState('');
  const [position, setPosition] = useState<string | null>(null);
  const [foot, setFoot] = useState<string | null>(null);

  useEffect(() => {
    client.listDemoIdentities().then(setIdentities).catch(() => {});
  }, []);

  const enterAs = (playerId: string) => {
    login(playerId);
    router.replace('/(tabs)/discover');
  };

  const checkDetails = () => {
    setError(null);
    if (!name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      setError('Enter your name and date of birth (YYYY-MM-DD).');
      return;
    }
    // The age gate — mirrored locally, ENFORCED by the server (403 ADULTS_ONLY).
    if (ageOn(dob) < adultAgeFor(country)) {
      setStep('blocked');
      return;
    }
    setStep('football');
  };

  const create = async () => {
    setError(null);
    try {
      const { playerId } = await client.signup({
        name: name.trim(),
        dob,
        country,
        city: city.trim() || undefined,
        position: position ?? undefined,
        foot: foot ?? undefined,
      });
      enterAs(playerId);
    } catch (e) {
      if (e instanceof ClientError && e.code === 'ADULTS_ONLY') setStep('blocked');
      else setError(e instanceof Error ? e.message : 'Could not create your profile.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.logo}>
          Scout<Text style={{ color: colors.accent }}>Box</Text>
        </Text>
        <Muted>Build a verified profile. Get discovered. Never pay to be seen.</Muted>
        {mode === 'demo' && <Pill label="Demo mode — no server connected" tone="blue" />}

        {step === 'welcome' && (
          <>
            <SectionTitle>Our promises to you</SectionTitle>
            {SAFEGUARDING_PROMISES.map((p) => (
              <Card key={p.slice(0, 20)}>
                <Muted size={13.5}>{p}</Muted>
              </Card>
            ))}
            <Button primary label="Create my profile" onPress={() => setStep('details')} />
            {identities.length > 0 && (
              <>
                <SectionTitle>Or continue as a demo player</SectionTitle>
                {identities.map((d) => (
                  <Card key={d.id}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <View>
                        <Text style={styles.name}>{d.name}</Text>
                        <Muted>{d.position}</Muted>
                      </View>
                      <Button small label="Enter" onPress={() => enterAs(d.id)} />
                    </Row>
                  </Card>
                ))}
              </>
            )}
          </>
        )}

        {step === 'details' && (
          <>
            <SectionTitle>About you</SectionTitle>
            <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
            <TextInput style={styles.input} placeholder="Date of birth (YYYY-MM-DD)" placeholderTextColor={colors.muted} value={dob} onChangeText={setDob} />
            <TextInput style={styles.input} placeholder="City (optional)" placeholderTextColor={colors.muted} value={city} onChangeText={setCity} />
            <SectionTitle>Country</SectionTitle>
            <Row>
              {COUNTRIES.map((c) => (
                <Button key={c} small label={c} primary={country === c} onPress={() => setCountry(c)} />
              ))}
            </Row>
            <Muted>
              ScoutBox is launching adults-only: you must be {adultAgeFor(country)}+ in your country. The API
              itself refuses under-age sign-ups — it is not just a form check.
            </Muted>
            <Button primary label="Continue" onPress={checkDetails} />
            <Button label="Back" onPress={() => setStep('welcome')} />
          </>
        )}

        {step === 'football' && (
          <>
            <SectionTitle>Position</SectionTitle>
            <Row>
              {POSITIONS.map((p) => (
                <Button key={p} small label={p} primary={position === p} onPress={() => setPosition(p)} />
              ))}
            </Row>
            <SectionTitle>Stronger foot</SectionTitle>
            <Row>
              {['left', 'right', 'both'].map((f) => (
                <Button key={f} small label={f} primary={foot === f} onPress={() => setFoot(f)} />
              ))}
            </Row>
            <Button primary label="Create profile" onPress={create} />
            <Button label="Back" onPress={() => setStep('details')} />
          </>
        )}

        {step === 'blocked' && (
          <Card style={{ borderColor: colors.danger }}>
            <Text style={[styles.name, { color: colors.danger }]}>ScoutBox is adults-only right now</Text>
            <Muted size={14}>
              You need to be {adultAgeFor(country)} or older in your country to create a profile. This is a
              safeguarding decision for launch: it means no minor can appear in any search, and agencies are
              structurally walled off from under-18s. We&apos;d love to see you back on your birthday.
            </Muted>
            <Button label="Back to start" onPress={() => setStep('welcome')} />
          </Card>
        )}

        {error && (
          <Card style={{ borderColor: colors.danger }}>
            <Text style={{ color: colors.danger }}>{error}</Text>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 20, gap: 12, maxWidth: 520, width: '100%', alignSelf: 'center' },
  logo: { color: colors.text, fontSize: 34, fontWeight: '800', marginTop: 10 },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
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
