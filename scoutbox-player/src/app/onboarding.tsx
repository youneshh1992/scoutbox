import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
  | 'welcome' | 'pair'
  | 'details' | 'football' | 'needs-guardian'
  | 'g-account' | 'g-email' | 'g-verify' | 'g-disclaimer' | 'g-child';

/* ---- presentation helpers (visual only — every flow string is unchanged) */

function RoleCard({ icon, title, subtitle, accent, onPress }: {
  icon: string; title: string; subtitle: string; accent?: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.roleCard,
        accent && { borderColor: colors.accent, backgroundColor: '#12291f' },
        pressed && { opacity: 0.75, transform: [{ scale: 0.99 }] },
      ]}
    >
      <View style={[styles.roleIcon, accent && { borderColor: colors.accent }]}>
        <Text style={{ fontSize: 24 }}>{icon}</Text>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.roleTitle}>{title}</Text>
        <Muted size={12.5}>{subtitle}</Muted>
      </View>
      <Text style={{ color: accent ? colors.accent : colors.muted, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}

function StepDots({ current }: { current: number }) {
  return (
    <View style={styles.dotsRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <View key={n} style={[styles.dot, n <= current && { backgroundColor: colors.accent, borderColor: colors.accent }]} />
      ))}
    </View>
  );
}

function CheckList({ items, mark = '✓', markColor = colors.accent }: {
  items: readonly string[]; mark?: string; markColor?: string;
}) {
  return (
    <Card style={{ gap: 12 }}>
      {items.map((p) => (
        <View key={p.slice(0, 20)} style={{ flexDirection: 'row', gap: 10 }}>
          <Text style={{ color: markColor, fontSize: 14, fontWeight: '800', lineHeight: 19 }}>{mark}</Text>
          <View style={{ flex: 1 }}>
            <Muted size={13.5}>{p}</Muted>
          </View>
        </View>
      ))}
    </Card>
  );
}

function Avatar({ name, tone }: { name: string; tone?: 'gold' }) {
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <View style={[styles.avatar, tone === 'gold' && { borderColor: colors.gold }]}>
      <Text style={{ color: tone === 'gold' ? colors.gold : colors.accent, fontWeight: '800', fontSize: 15 }}>{initials}</Text>
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

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
  const [gPassword, setGPassword] = useState('');
  const [gEmailCode, setGEmailCode] = useState('');
  const [gEmailHint, setGEmailHint] = useState<string | null>(null);
  const [gId, setGId] = useState<string | null>(null);
  const [docType, setDocType] = useState<'passport' | 'driving_licence' | null>(null);
  const [docRef, setDocRef] = useState('');
  const [childName, setChildName] = useState('');
  const [childDob, setChildDob] = useState('');
  const [childCountry, setChildCountry] = useState('GB');
  const [childPosition, setChildPosition] = useState<string | null>(null);

  // child device pairing
  const [pairCode, setPairCode] = useState('');

  useEffect(() => {
    client.listDemoIdentities().then(setIdentities).catch(() => {});
  }, []);

  const enterAsPlayer = async (playerId: string, skipLogin = false) => {
    try {
      if (!skipLogin) await client.login(playerId); // mints the bearer session
      loginPlayer(playerId);
      router.replace('/(tabs)/discover');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed.');
    }
  };

  const checkDetails = () => {
    setError(null);
    if (!name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      setError('Enter your name and date of birth (YYYY-MM-DD).');
      return;
    }
    if (password.length < 8) {
      setError('Pick a password of at least 8 characters — your profile is yours alone.');
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
        password,
      });
      await enterAsPlayer(playerId, true); // signup already minted the session
    } catch (e) {
      if (e instanceof ClientError && e.code === 'GUARDIAN_REQUIRED') setStep('needs-guardian');
      else setError(e instanceof Error ? e.message : 'Could not create your profile.');
    }
  };

  const guardianCreate = async () => {
    setError(null);
    if (!gName.trim() || !gEmail.includes('@')) return setError('Enter your name and a valid email.');
    if (gPassword.length < 8) return setError('Pick a password of at least 8 characters.');
    try {
      const r = await client.guardianSignup(gName.trim(), gEmail.trim(), gPassword);
      setGId(r.guardianId);
      setGEmailHint(r.devEmailCode ?? null);
      setStep('g-email');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the guardian account.');
    }
  };

  const guardianVerifyEmail = async () => {
    setError(null);
    if (!gId) return;
    try {
      await client.guardianVerifyEmail(gId, gEmailCode.trim());
      setStep('g-verify');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Email verification failed.');
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

  const onGuardianPath = step.startsWith('g-');

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* ---- hero */}
        <View style={styles.hero}>
          <View style={styles.crest}>
            <Text style={{ fontSize: 30 }}>⚽</Text>
          </View>
          <Text style={styles.logo}>
            Scout<Text style={{ color: colors.accent }}>Box</Text>
          </Text>
          <Text style={styles.tagline}>Build a verified profile. Get discovered. Never pay to be seen.</Text>
          <Row style={{ justifyContent: 'center', marginTop: 4 }}>
            <Pill label="Free for players — forever" tone="green" />
            <Pill label="Safeguarding-first" tone="blue" />
            {mode === 'demo' && <Pill label="Demo mode — no server connected" />}
          </Row>
        </View>

        {onGuardianPath && (
          <StepDots current={{ 'g-account': 1, 'g-email': 2, 'g-verify': 3, 'g-disclaimer': 4, 'g-child': 5 }[step as 'g-account'] ?? 1} />
        )}

        {step === 'welcome' && (
          <>
            <RoleCard
              icon="🏃"
              title="I'm a player (18+)"
              subtitle="Your own verified profile, your own password. Clubs come to you — you never pay to be seen."
              accent
              onPress={() => setStep('details')}
            />
            <RoleCard
              icon="🛡️"
              title="I'm a parent / guardian"
              subtitle="You own your child's account and hold every club conversation. They keep the football."
              onPress={() => setStep('g-account')}
            />
            <Pressable onPress={() => setStep('pair')} style={({ pressed }) => [styles.pairLink, pressed && { opacity: 0.7 }]}>
              <Text style={{ color: colors.accent2, fontSize: 13.5, fontWeight: '600' }}>
                🔗  I have a code from my parent/guardian
              </Text>
            </Pressable>

            <SectionTitle>Our promises to every player</SectionTitle>
            <CheckList items={SAFEGUARDING_PROMISES} />

            <SectionTitle>Under-18? The rules that protect you</SectionTitle>
            <CheckList items={U18_PROMISES.slice(0, 3)} mark="🛡" markColor={colors.accent2} />

            {identities.length > 0 && (
              <>
                <SectionTitle>Or continue as a demo account</SectionTitle>
                <Card style={{ gap: 0, paddingVertical: 4 }}>
                  {identities.map((d, i) => (
                    <View key={d.id} style={[styles.demoRow, i > 0 && styles.demoRowBorder]}>
                      <Avatar name={d.name} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name}>{d.name}</Text>
                        <Muted size={12}>{d.position}</Muted>
                      </View>
                      <Button small label="Enter" onPress={() => enterAsPlayer(d.id)} />
                    </View>
                  ))}
                  <View style={[styles.demoRow, styles.demoRowBorder]}>
                    <Avatar name="Amara Adebayo" tone="gold" />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name}>Amara Adebayo</Text>
                      <Muted size={12}>Parent / guardian of Guni (14)</Muted>
                    </View>
                    <Button small label="Enter" onPress={enterDemoGuardian} />
                  </View>
                </Card>
              </>
            )}
          </>
        )}

        {step === 'pair' && (
          <>
            <SectionTitle>Pair this device</SectionTitle>
            <Card style={{ gap: 12 }}>
              <Muted size={13.5}>
                Your parent or guardian generates a 6-character code from their dashboard. It works once
                and expires after 15 minutes. Pairing gives you your limited player login — uploads,
                stats and drills — while all club contact stays with them.
              </Muted>
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="XXXXXX"
                placeholderTextColor={colors.muted}
                value={pairCode}
                onChangeText={(v) => setPairCode(v.toUpperCase().slice(0, 6))}
                autoCapitalize="characters"
              />
              <Button
                primary
                label="Pair and enter"
                onPress={async () => {
                  setError(null);
                  try {
                    const { playerId } = await client.pair(pairCode.trim());
                    await enterAsPlayer(playerId, true); // pairing already minted the session
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Pairing failed.');
                  }
                }}
              />
            </Card>
            <Button label="Back" onPress={() => setStep('welcome')} />
          </>
        )}

        {step === 'details' && (
          <>
            <SectionTitle>About you</SectionTitle>
            <Card style={{ gap: 12 }}>
              <Field label="Full name">
                <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
              </Field>
              <Field label="Date of birth">
                <TextInput
                  style={styles.input}
                  placeholder="Date of birth — just type the digits (YYYYMMDD)"
                  placeholderTextColor={colors.muted}
                  value={dob}
                  onChangeText={(v) => setDob(formatDob(v))}
                  keyboardType="numeric"
                />
              </Field>
              {dobAge !== null && (
                <View style={styles.ageHint}>
                  <Muted size={12.5}>
                    {dobAge >= adultAgeFor(country)
                      ? `You're ${dobAge} — you can create your own account.`
                      : `You're ${dobAge} — under ${adultAgeFor(country)}, so a parent or guardian sets up the account (next step will guide you).`}
                  </Muted>
                </View>
              )}
              <Field label="City">
                <TextInput style={styles.input} placeholder="City (optional)" placeholderTextColor={colors.muted} value={city} onChangeText={setCity} />
              </Field>
              <Field label="Password">
                <TextInput style={styles.input} placeholder="Password (required, 8+ characters)" placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry />
              </Field>
            </Card>
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
            <Card>
              <Row>
                {POSITIONS.map((p) => (
                  <Button key={p} small label={p} primary={position === p} onPress={() => setPosition(p)} />
                ))}
              </Row>
            </Card>
            <SectionTitle>Stronger foot</SectionTitle>
            <Card>
              <Row>
                {['left', 'right', 'both'].map((f) => (
                  <Button key={f} small label={f} primary={foot === f} onPress={() => setFoot(f)} />
                ))}
              </Row>
            </Card>
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
            <SectionTitle>Guardian account — step 1 of 5</SectionTitle>
            <Card style={{ gap: 12 }}>
              <Muted size={13.5}>
                Parents own every under-18 account. You manage all messages, notifications and club
                interactions; your child keeps the football.
              </Muted>
              <Field label="Your name">
                <TextInput style={styles.input} placeholder="Your full name" placeholderTextColor={colors.muted} value={gName} onChangeText={setGName} />
              </Field>
              <Field label="Email">
                <TextInput style={styles.input} placeholder="Your email" placeholderTextColor={colors.muted} value={gEmail} onChangeText={setGEmail} autoCapitalize="none" />
              </Field>
              <Field label="Password">
                <TextInput style={styles.input} placeholder="Password (required, 8+ characters)" placeholderTextColor={colors.muted} value={gPassword} onChangeText={setGPassword} secureTextEntry />
              </Field>
              <Button primary label="Continue to email verification" onPress={guardianCreate} />
            </Card>
            <Button label="Back" onPress={() => setStep('welcome')} />
          </>
        )}

        {step === 'g-email' && (
          <>
            <SectionTitle>Email verification — step 2 of 5</SectionTitle>
            <Card style={{ gap: 12 }}>
              <Muted size={13.5}>
                We sent a 6-character code to {gEmail}. Entering it proves the mailbox is yours — the
                first of three gates (email, ID, disclaimer) before any child profile can exist.
              </Muted>
              {gEmailHint && (
                <View style={styles.ageHint}>
                  <Muted size={12.5}>Prototype mail transport — your code is: {gEmailHint}</Muted>
                </View>
              )}
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="XXXXXX"
                placeholderTextColor={colors.muted}
                value={gEmailCode}
                onChangeText={(v) => setGEmailCode(v.toUpperCase().slice(0, 6))}
                autoCapitalize="characters"
              />
              <Button primary label="Verify email" onPress={guardianVerifyEmail} />
            </Card>
          </>
        )}

        {step === 'g-verify' && (
          <>
            <SectionTitle>ID verification — step 3 of 5</SectionTitle>
            <Card style={{ gap: 12 }}>
              <Muted size={13.5}>
                We verify every guardian before any child profile can exist. Pick a document — production
                runs a document + liveness check; this prototype records the attestation.
              </Muted>
              <Row>
                <Button small primary={docType === 'passport'} label="Passport" onPress={() => setDocType('passport')} />
                <Button small primary={docType === 'driving_licence'} label="Driving licence" onPress={() => setDocType('driving_licence')} />
              </Row>
              <Field label="Document reference">
                <TextInput style={styles.input} placeholder="Document reference number" placeholderTextColor={colors.muted} value={docRef} onChangeText={setDocRef} />
              </Field>
              <Button primary label="Verify my identity" onPress={guardianVerify} />
            </Card>
          </>
        )}

        {step === 'g-disclaimer' && (
          <>
            <SectionTitle>Safeguarding disclaimer — step 4 of 5</SectionTitle>
            <CheckList items={U18_PROMISES} mark="🛡" markColor={colors.accent2} />
            <Muted size={13}>
              By continuing you confirm you are this child&apos;s parent or legal guardian, you will manage
              all club contact on their behalf, and you accept the rules above.
            </Muted>
            <Button primary label="I agree — continue" onPress={guardianDisclaimer} />
          </>
        )}

        {step === 'g-child' && (
          <>
            <SectionTitle>Your child — step 5 of 5</SectionTitle>
            <Card style={{ gap: 12 }}>
              <Field label="Child's name">
                <TextInput style={styles.input} placeholder="Child's full name" placeholderTextColor={colors.muted} value={childName} onChangeText={setChildName} />
              </Field>
              <Field label="Child's date of birth">
                <TextInput style={styles.input} placeholder="Child's date of birth (YYYY-MM-DD)" placeholderTextColor={colors.muted} value={childDob} onChangeText={setChildDob} />
              </Field>
            </Card>
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
  hero: { alignItems: 'center', gap: 6, paddingTop: 14, paddingBottom: 10 },
  crest: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: colors.panel2,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  logo: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  tagline: { color: colors.muted, fontSize: 13.5, textAlign: 'center' },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  roleIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pairLink: { alignItems: 'center', paddingVertical: 6 },
  dotsRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', paddingVertical: 2 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  demoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  demoRowBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.bg2,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ageHint: {
    backgroundColor: colors.bg2,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent2,
    padding: 10,
  },
  fieldLabel: { color: colors.muted, fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
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
  codeInput: { letterSpacing: 6, textAlign: 'center', fontSize: 20, fontWeight: '700' },
});
