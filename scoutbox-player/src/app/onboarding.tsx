import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { client, ClientError, type DemoIdentity } from '../data/client';
import { adultAgeFor, ageOn, SAFEGUARDING_PROMISES, U18_PROMISES } from '../domain/safeguarding';
import { POSITIONS } from '../domain/types';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Pill, Row, SectionTitle } from '../components/ui';

const COUNTRIES = ['GB', 'PT', 'FR', 'SE', 'PL', 'NG', 'GH', 'AR', 'JP', 'KR', 'TH', 'SG', 'US'];

type Step =
  | 'welcome'
  | 'details' | 'football' | 'needs-guardian'
  | 'g-account' | 'g-verify' | 'g-disclaimer' | 'g-child';

export default function Onboarding() {
  const router = useRouter();
  const { loginPlayer, loginGuardian, mode } = useSession();
  const [step, setStep] = useState<Step>('welcome');
  const [identities, setIdentities] = useState<DemoIdentity[]>([]);
  const [error, setError] = useState<string | null>(null);

  // player self-signup (adults)
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [country, setCountry] = useState('GB');
  const [city, setCity] = useState('');
  const [password, setPassword] = useState('');
  const [position, setPosition] = useState<string | null>(null);
  const [foot, setFoot] = useState<string | null>(null);

  // Live age feedback: format as they type and show what the date means.
  const formatDob = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 8);
    let out = digits;
    if (digits.length > 4) out = `${digits.slice(0, 4)}-${digits.slice(4, 6)}`;
    if (digits.length > 6) out = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    return out;
  };
  const dobValid = /^\d{4}-\d{2}-\d{2}$/.test(dob) && !Number.isNaN(new Date(dob).getTime());
  const dobAge = dobValid ? ageOn(dob) : null;

  // guardian flow
  const [gName, setGName] = useState('');
  const [gEmail, setGEmail] = useState('');
  const [gId, setGId] = useState<string | null>(null);
  const [docType, setDocType] = useState<'passport' | 'driving_licence' | null>(null);
  const [docRef, setDocRef] = useState('');
  const [childName, setChildName] = useState('');
  const [childDob, setChildDob] = useState('');
  const [childCountry, setChildCountry] = useState('GB');
  const [childPosition, setChildPosition] = useState<string | null>(null);

  useEffect(() => {
    client.listDemoIdentities().then(setIdentities).catch(() => {});
  }, []);

  const enterAsPlayer = (playerId: string) => {
    loginPlayer(playerId);
    router.replace('/(tabs)/discover');
  };

  const checkDetails = () => {
    setError(null);
    if (!name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      setError('Enter your name and date of birth (YYYY-MM-DD).');
      return;
    }
    // Under-18s: the account belongs to a guardian — mirrored locally,
    // ENFORCED by the server (403 GUARDIAN_REQUIRED).
    if (ageOn(dob) < adultAgeFor(country)) {
      setStep('needs-guardian');
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
        password: password || undefined,
      });
      enterAsPlayer(playerId);
    } catch (e) {
      if (e instanceof ClientError && e.code === 'GUARDIAN_REQUIRED') setStep('needs-guardian');
      else setError(e instanceof Error ? e.message : 'Could not create your profile.');
    }
  };

  const guardianCreate = async () => {
    setError(null);
    if (!gName.trim() || !gEmail.includes('@')) return setError('Enter your name and a valid email.');
    try {
      const { guardianId } = await client.guardianSignup(gName.trim(), gEmail.trim());
      setGId(guardianId);
      setStep('g-verify');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the guardian account.');
    }
  };

  const guardianVerify = async () => {
    setError(null);
    if (!gId) return;
    if (!docType || !docRef.trim()) return setError('Pick a document and enter its reference number.');
    try {
      await client.guardianVerifyId(gId, docType, docRef.trim());
      setStep('g-disclaimer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ID verification failed.');
    }
  };

  const guardianDisclaimer = async () => {
    setError(null);
    if (!gId) return;
    try {
      await client.guardianAcceptDisclaimer(gId);
      setStep('g-child');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record acceptance.');
    }
  };

  const guardianAddChild = async () => {
    setError(null);
    if (!gId) return;
    if (!childName.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(childDob)) {
      return setError("Enter your child's name and date of birth (YYYY-MM-DD).");
    }
    try {
      await client.guardianAddChild(gId, {
        name: childName.trim(),
        dob: childDob,
        country: childCountry,
        position: childPosition ?? undefined,
      });
      loginGuardian(gId);
      router.replace('/guardian');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the child profile.');
    }
  };

  const enterDemoGuardian = async () => {
    setError(null);
    try {
      const { guardianId } = await client.guardianLogin('amara.adebayo@example.com');
      loginGuardian(guardianId);
      router.replace('/guardian');
    } catch {
      // live server seeds gd-amara by id
      try {
        const { guardianId } = await client.guardianLogin('gd-amara');
        loginGuardian(guardianId);
        router.replace('/guardian');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Guardian demo login failed.');
      }
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
            <Row>
              <Button primary label="I'm a player (18+)" onPress={() => setStep('details')} />
              <Button label="I'm a parent / guardian" onPress={() => setStep('g-account')} />
            </Row>
            <SectionTitle>Our promises to every player</SectionTitle>
            {SAFEGUARDING_PROMISES.map((p) => (
              <Card key={p.slice(0, 20)}>
                <Muted size={13.5}>{p}</Muted>
              </Card>
            ))}
            <SectionTitle>Under-18? The rules that protect you</SectionTitle>
            {U18_PROMISES.slice(0, 3).map((p) => (
              <Card key={p.slice(0, 20)}>
                <Muted size={13.5}>{p}</Muted>
              </Card>
            ))}
            {identities.length > 0 && (
              <>
                <SectionTitle>Or continue as a demo account</SectionTitle>
                {identities.map((d) => (
                  <Card key={d.id}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <View>
                        <Text style={styles.name}>{d.name}</Text>
                        <Muted>{d.position}</Muted>
                      </View>
                      <Button small label="Enter" onPress={() => enterAsPlayer(d.id)} />
                    </Row>
                  </Card>
                ))}
                <Card>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View>
                      <Text style={styles.name}>Amara Adebayo</Text>
                      <Muted>Parent / guardian of Guni (14)</Muted>
                    </View>
                    <Button small label="Enter" onPress={enterDemoGuardian} />
                  </Row>
                </Card>
              </>
            )}
          </>
        )}

        {step === 'details' && (
          <>
            <SectionTitle>About you</SectionTitle>
            <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
            <TextInput
              style={styles.input}
              placeholder="Date of birth — just type the digits (YYYYMMDD)"
              placeholderTextColor={colors.muted}
              value={dob}
              onChangeText={(v) => setDob(formatDob(v))}
              keyboardType="numeric"
            />
            {dobAge !== null && (
              <Muted size={12.5}>
                {dobAge >= adultAgeFor(country)
                  ? `You're ${dobAge} — you can create your own account.`
                  : `You're ${dobAge} — under ${adultAgeFor(country)}, so a parent or guardian sets up the account (next step will guide you).`}
              </Muted>
            )}
            <TextInput style={styles.input} placeholder="City (optional)" placeholderTextColor={colors.muted} value={city} onChangeText={setCity} />
            <TextInput style={styles.input} placeholder="Password (optional — protects your profile login)" placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry />
            <SectionTitle>Country</SectionTitle>
            <Row>
              {COUNTRIES.map((c) => (
                <Button key={c} small label={c} primary={country === c} onPress={() => setCountry(c)} />
              ))}
            </Row>
            <Muted>
              Self sign-up is {adultAgeFor(country)}+ in your country. Younger players join through a
              parent or guardian — the API itself refuses a minor self-signup.
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

        {step === 'needs-guardian' && (
          <Card style={{ borderColor: colors.accent2 }}>
            <Text style={styles.name}>Under-18s join with a parent or guardian</Text>
            <Muted size={14}>
              Your account will be owned and managed by your parent or guardian — that&apos;s how ScoutBox
              keeps you safe. You still upload your videos, edit your stats and complete drills; scouts can
              only ever talk to your parent, never to you.
            </Muted>
            <Button primary label="Set up the guardian account" onPress={() => setStep('g-account')} />
            <Button label="Back to start" onPress={() => setStep('welcome')} />
          </Card>
        )}

        {step === 'g-account' && (
          <>
            <SectionTitle>Guardian account — step 1 of 4</SectionTitle>
            <Muted size={13.5}>
              Parents own every under-18 account. You manage all messages, notifications and club
              interactions; your child keeps the football.
            </Muted>
            <TextInput style={styles.input} placeholder="Your full name" placeholderTextColor={colors.muted} value={gName} onChangeText={setGName} />
            <TextInput style={styles.input} placeholder="Your email" placeholderTextColor={colors.muted} value={gEmail} onChangeText={setGEmail} autoCapitalize="none" />
            <Button primary label="Continue to ID verification" onPress={guardianCreate} />
            <Button label="Back" onPress={() => setStep('welcome')} />
          </>
        )}

        {step === 'g-verify' && (
          <>
            <SectionTitle>ID verification — step 2 of 4</SectionTitle>
            <Muted size={13.5}>
              We verify every guardian before any child profile can exist. Pick a document — production
              runs a document + liveness check; this prototype records the attestation.
            </Muted>
            <Row>
              <Button small primary={docType === 'passport'} label="Passport" onPress={() => setDocType('passport')} />
              <Button small primary={docType === 'driving_licence'} label="Driving licence" onPress={() => setDocType('driving_licence')} />
            </Row>
            <TextInput style={styles.input} placeholder="Document reference number" placeholderTextColor={colors.muted} value={docRef} onChangeText={setDocRef} />
            <Button primary label="Verify my identity" onPress={guardianVerify} />
          </>
        )}

        {step === 'g-disclaimer' && (
          <>
            <SectionTitle>Safeguarding disclaimer — step 3 of 4</SectionTitle>
            {U18_PROMISES.map((p) => (
              <Card key={p.slice(0, 20)}>
                <Muted size={13}>{p}</Muted>
              </Card>
            ))}
            <Muted size={13}>
              By continuing you confirm you are this child&apos;s parent or legal guardian, you will manage
              all club contact on their behalf, and you accept the rules above.
            </Muted>
            <Button primary label="I agree — continue" onPress={guardianDisclaimer} />
          </>
        )}

        {step === 'g-child' && (
          <>
            <SectionTitle>Your child — step 4 of 4</SectionTitle>
            <TextInput style={styles.input} placeholder="Child's full name" placeholderTextColor={colors.muted} value={childName} onChangeText={setChildName} />
            <TextInput style={styles.input} placeholder="Child's date of birth (YYYY-MM-DD)" placeholderTextColor={colors.muted} value={childDob} onChangeText={setChildDob} />
            <SectionTitle>Country</SectionTitle>
            <Row>
              {COUNTRIES.map((c) => (
                <Button key={c} small label={c} primary={childCountry === c} onPress={() => setChildCountry(c)} />
              ))}
            </Row>
            <SectionTitle>Position (optional)</SectionTitle>
            <Row>
              {POSITIONS.map((p) => (
                <Button key={p} small label={p} primary={childPosition === p} onPress={() => setChildPosition(p)} />
              ))}
            </Row>
            <Button primary label="Create child profile" onPress={guardianAddChild} />
          </>
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
