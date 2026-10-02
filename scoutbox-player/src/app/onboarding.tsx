import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { useRouter } from 'expo-router';
import { client, ClientError, type DemoIdentity } from '../data/client';
import { adultAgeFor, ageOn, SAFEGUARDING_PROMISES, U18_PROMISES } from '../domain/safeguarding';
import { POSITIONS } from '../domain/types';
import { useSession } from '../state';
import { AUTH_PAGE, AUTH_PANEL, ThemeOverride, useColors, useStyles, type Palette } from '../theme';
import { PitchBackdrop } from '../components/PitchBackdrop';
import { Wordmark } from '../components/Wordmark';
import { Button, Muted, Row, SectionTitle } from '../components/ui';

const COUNTRIES = ['GB', 'PT', 'FR', 'SE', 'PL', 'NG', 'GH', 'AR', 'JP', 'KR', 'TH', 'SG', 'US'];

type Step =
  | 'welcome' | 'signin' | 'pair'
  | 'details' | 'football' | 'needs-guardian'
  | 'g-account' | 'g-email' | 'g-verify' | 'g-disclaimer' | 'g-child';

/* ---- presentation helpers (visual only — every flow string is unchanged) */

// M24D — a choice is a row: a title, an optional quiet line, an arrow, a
// hairline above. No icon, no circle, no card.
function ChoiceRow({ title, subtitle, onPress, testID }: { title: string; subtitle?: string; onPress: () => void; testID?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      testID={testID}
      style={({ pressed }) => [styles.choiceRow, pressed && { opacity: 0.7 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.choiceTitle}>{title}</Text>
        {subtitle ? <Muted size={12.5}>{subtitle}</Muted> : null}
      </View>
      <Text style={styles.choiceArrow} aria-hidden>→</Text>
    </Pressable>
  );
}

// M24D — a plain list: the brand square as the marker, one line per promise.
function PromiseList({ items }: { items: readonly string[] }) {
  const colors = useColors();
  return (
    <View style={{ gap: 12 }}>
      {items.map((p) => (
        <View key={p.slice(0, 20)} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          <View style={{ width: 6, height: 6, borderRadius: 1, backgroundColor: colors.accent, marginTop: 7 }} />
          <View style={{ flex: 1 }}>
            <Muted size={13.5}>{p}</Muted>
          </View>
        </View>
      ))}
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

export default function Onboarding() {
  const colors = useColors();
  // M24C — the screen's own styles are built from the authentication panel's
  // palette: everything the screen lays out itself sits inside that panel,
  // whatever appearance the player saved. The sub-components read the same
  // palette through the ThemeOverride below.
  const styles = useMemo(() => makeStyles(AUTH_PANEL), []);
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

  // M24C — sign in with the credentials the backend already accepts: a
  // guardian's email + password (/auth/guardian/login) or a player's id +
  // password (/auth/player/login). Nothing new is minted here; a failed
  // attempt keeps the non-sensitive input and shows the server's reason.
  const [siEmail, setSiEmail] = useState('');
  const [siPassword, setSiPassword] = useState('');
  const [siPlayerId, setSiPlayerId] = useState('');
  const [siPlayerPassword, setSiPlayerPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // M24D — one form, one primary action: the person says who is signing in first.
  const [siKind, setSiKind] = useState<'guardian' | 'player'>('guardian');
  const signInGuardian = async () => {
    if (busy) return;
    setError(null);
    if (!siEmail.trim().includes('@')) return setError('Enter the email address of your guardian account.');
    if (!siPassword) return setError('Enter your password.');
    setBusy('guardian');
    try {
      const { guardianId } = await client.guardianLogin(siEmail.trim(), siPassword);
      setSiPassword('');
      loginGuardian(guardianId);
      router.replace('/guardian');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally { setBusy(null); }
  };
  const signInPlayer = async () => {
    if (busy) return;
    setError(null);
    if (!siPlayerId.trim()) return setError('Enter your player id.');
    if (!siPlayerPassword) return setError('Enter your password.');
    setBusy('player');
    try {
      await client.login(siPlayerId.trim(), siPlayerPassword);
      setSiPlayerPassword('');
      loginPlayer(siPlayerId.trim());
      router.replace('/(tabs)/discover');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally { setBusy(null); }
  };

  // Live mode: an unreachable backend is an actionable error, never a silent
  // fall-back to fabricated data.
  const [serverDown, setServerDown] = useState(false);
  const checkServer = () => {
    client.ping().then(() => setServerDown(false)).catch(() => setServerDown(true));
  };
  useEffect(() => {
    client.listDemoIdentities().then(setIdentities).catch(() => {});
    checkServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const entry = step === 'welcome' || step === 'signin';
  const stepTitle: Partial<Record<Step, string>> = {
    pair: 'Pair this device', details: 'About you', football: 'Your football', 'needs-guardian': 'Under-18s join with a parent or guardian',
    'g-account': 'Guardian account', 'g-email': 'Email verification', 'g-verify': 'ID verification', 'g-disclaimer': 'Safeguarding disclaimer', 'g-child': 'Your child',
  };

  // M24C — the authentication composition (reference B, stacked for a phone):
  // the ScoutBox Player mark near the top, a compact green introduction, then
  // the deep-green form panel. The panel keeps its brand colours whatever
  // appearance the player saved; every existing step renders inside it.
  // M24D — fewer, larger elements: the introduction is a headline and one
  // sentence; choices are rows; every step has one primary action.
  return (
    <SafeAreaView style={styles.safe} testID="auth-screen">
      {/* M24C.1 — the approved pitch behind the entry screen, in the
          authentication palette (white lines at 8%), behind every surface,
          never in front of a tap, hidden from assistive technology. */}
      <ThemeOverride colors={AUTH_PANEL}><PitchBackdrop height={760} top={64} /></ThemeOverride>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.topRow}>
          <View style={styles.brand}>
            <Wordmark size={26} color={AUTH_PAGE.white} tmColor={AUTH_PAGE.soft} label="ScoutBox Player" />
            <Text style={styles.product}>Player</Text>
          </View>
          <ThemeSwitch />
        </View>

        {entry && (
          <View style={styles.intro} testID="auth-intro">
            <Text style={styles.introTitle}>Your football. Your next opportunity.</Text>
            <Text style={styles.introLine}>A verified Football Passport that clubs can read. No unsolicited contact: every approach needs your yes.</Text>
          </View>
        )}

        {serverDown && (
          <View style={styles.alertBox}>
            <Text style={styles.name}>Can't reach the ScoutBox backend</Text>
            <Muted size={13}>
              The app is in live mode and the API isn't responding. Start scoutbox-server (port 4000),
              or check EXPO_PUBLIC_API_URL if it runs somewhere else. Nothing is faked while it's down.
            </Muted>
            <Button small label="Try again" onPress={checkServer} />
          </View>
        )}

        <ThemeOverride colors={AUTH_PANEL}>
        <View style={styles.panel} testID="auth-panel">
        {entry ? (
          <View role="tablist" aria-label="Sign in or sign up" style={styles.authTabs}>
            {([['signin', 'Sign in'], ['welcome', 'Sign up']] as const).map(([k, label]) => {
              const on = step === k;
              return (
                <Pressable key={k} role="tab" aria-selected={on} testID={`auth-tab-${k}`} onPress={() => { setError(null); setStep(k); }} style={({ pressed }) => [styles.authTab, pressed && { opacity: 0.7 }]}>
                  <Text style={[styles.authTabText, on && styles.authTabTextOn]}>{label}</Text>
                  {k === 'signin' ? <Text style={styles.authTabDivider}>|</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={{ gap: 4, marginBottom: 4 }}>
            <Text role="heading" aria-level={2} style={styles.stepHeading}>{stepTitle[step] ?? ''}</Text>
            {onGuardianPath && (
              <Muted size={12.5}>Step {{ 'g-account': 1, 'g-email': 2, 'g-verify': 3, 'g-disclaimer': 4, 'g-child': 5 }[step as 'g-account'] ?? 1} of 5</Muted>
            )}
          </View>
        )}

        {step === 'signin' && (
          <View style={{ gap: 20 }} testID="auth-signin">
            <View role="tablist" aria-label="Who is signing in" style={styles.kindRow}>
              {([['guardian', 'Parent or guardian'], ['player', 'Player (18+)']] as const).map(([k, label]) => {
                const on = siKind === k;
                return (
                  <Pressable key={k} role="tab" aria-selected={on} testID={`auth-kind-${k}`} onPress={() => { setError(null); setSiKind(k); }} style={({ pressed }) => [styles.kindTab, on && styles.kindTabOn, pressed && { opacity: 0.7 }]}>
                    <Text style={[styles.kindText, on && styles.kindTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {siKind === 'guardian' ? (
              <View style={{ gap: 18 }}>
                <Field label="Email">
                  <TextInput style={styles.input} placeholder="you@example.com" placeholderTextColor={AUTH_PANEL.muted} value={siEmail} onChangeText={setSiEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" inputMode="email" accessibilityLabel="Guardian email" />
                </Field>
                <Field label="Password">
                  <View style={styles.pwRow}>
                    <TextInput style={[styles.input, { flex: 1 }]} placeholder="Your password" placeholderTextColor={AUTH_PANEL.muted} value={siPassword} onChangeText={setSiPassword} secureTextEntry={!showPw} autoComplete="current-password" textContentType="password" accessibilityLabel="Guardian password" onSubmitEditing={() => void signInGuardian()} />
                    <Pressable onPress={() => setShowPw((x) => !x)} accessibilityRole="button" accessibilityLabel={showPw ? 'Hide password' : 'Show password'} hitSlop={8} style={styles.pwToggle}><Text style={styles.pwToggleText}>{showPw ? 'Hide' : 'Show'}</Text></Pressable>
                  </View>
                </Field>
                <Button primary pill label={busy === 'guardian' ? 'Signing in…' : 'Sign in'} disabled={busy !== null} onPress={() => void signInGuardian()} testID="auth-signin-guardian" />
              </View>
            ) : (
              <View style={{ gap: 18 }}>
                <Field label="Player id">
                  <TextInput style={styles.input} placeholder="The id on your profile" placeholderTextColor={AUTH_PANEL.muted} value={siPlayerId} onChangeText={setSiPlayerId} autoCapitalize="none" autoComplete="username" accessibilityLabel="Player id" />
                </Field>
                <Field label="Password">
                  <View style={styles.pwRow}>
                    <TextInput style={[styles.input, { flex: 1 }]} placeholder="Your password" placeholderTextColor={AUTH_PANEL.muted} value={siPlayerPassword} onChangeText={setSiPlayerPassword} secureTextEntry={!showPw} autoComplete="current-password" textContentType="password" accessibilityLabel="Player password" onSubmitEditing={() => void signInPlayer()} />
                    <Pressable onPress={() => setShowPw((x) => !x)} accessibilityRole="button" accessibilityLabel={showPw ? 'Hide password' : 'Show password'} hitSlop={8} style={styles.pwToggle}><Text style={styles.pwToggleText}>{showPw ? 'Hide' : 'Show'}</Text></Pressable>
                  </View>
                </Field>
                <Button primary pill label={busy === 'player' ? 'Signing in…' : 'Sign in'} disabled={busy !== null} onPress={() => void signInPlayer()} testID="auth-signin-player" />
              </View>
            )}
            <Pressable onPress={() => setStep('pair')} style={({ pressed }) => [styles.textLink, pressed && { opacity: 0.7 }]} accessibilityRole="button">
              <Text style={styles.textLinkText}>I have a code from my parent/guardian</Text>
            </Pressable>
          </View>
        )}

        {step === 'welcome' && (
          <View style={{ gap: 16 }} testID="auth-welcome">
            <View style={{ gap: 6 }}>
              <Text role="heading" aria-level={2} style={styles.stepHeading}>Create your ScoutBox account</Text>
              <Muted size={13.5}>Choose how you&apos;re joining ScoutBox.</Muted>
            </View>
            <View style={styles.choiceList}>
              <ChoiceRow title="Player" subtitle="18 or over, your own account" onPress={() => setStep('details')} testID="auth-choice-player" />
              <ChoiceRow title="Parent" subtitle="You hold the account for your child" onPress={() => setStep('g-account')} testID="auth-choice-parent" />
              <ChoiceRow title="Guardian" subtitle="You hold the account for a child in your care" onPress={() => setStep('g-account')} testID="auth-choice-guardian" />
              <ChoiceRow title="Use an invitation code" subtitle="A code from your parent or guardian" onPress={() => setStep('pair')} testID="auth-choice-code" />
            </View>
            <Muted size={12.5}>Clubs come to you. You never pay to be seen.</Muted>
          </View>
        )}

        {entry && identities.length > 0 && (
          <View style={{ gap: 8, marginTop: 8 }}>
            <SectionTitle>Or continue as a demo account</SectionTitle>
            <View style={styles.choiceList} testID="demo-identities">
              {identities.map((d) => (
                <View key={d.id} style={styles.demoRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name}>{d.name}</Text>
                    <Muted size={12}>{d.position}</Muted>
                  </View>
                  <Button small label="Enter" onPress={() => enterAsPlayer(d.id)} />
                </View>
              ))}
              <View style={styles.demoRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name}>Amara Adebayo</Text>
                  <Muted size={12}>Parent / guardian of Guni (14)</Muted>
                </View>
                <Button small label="Enter" onPress={enterDemoGuardian} />
              </View>
            </View>
          </View>
        )}

        {step === 'pair' && (
          <>
            <View style={styles.group}>
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
            </View>
            <Button label="Back" onPress={() => setStep('welcome')} />
          </>
        )}

        {step === 'details' && (
          <>
            <View style={styles.group}>
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
            </View>
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
            <Button primary pill label="Continue" onPress={checkDetails} />
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
            <Button primary pill label="Create profile" onPress={create} />
            <Button label="Back" onPress={() => setStep('details')} />
          </>
        )}

        {step === 'needs-guardian' && (
          <View style={styles.group}>
            <Muted size={14}>
              Your account will be owned and managed by your parent or guardian — that&apos;s how ScoutBox
              keeps you safe. You still upload your videos, edit your stats and complete drills; scouts can
              only ever talk to your parent, never to you.
            </Muted>
            <Button primary pill label="Set up the guardian account" onPress={() => setStep('g-account')} />
            <Button label="Back to start" onPress={() => setStep('welcome')} />
          </View>
        )}

        {step === 'g-account' && (
          <>
            <View style={styles.group}>
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
              <Button primary pill label="Continue to email verification" onPress={guardianCreate} />
            </View>
            <Button label="Back" onPress={() => setStep('welcome')} />
          </>
        )}

        {step === 'g-email' && (
          <>
            <View style={styles.group}>
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
              <Button primary pill label="Verify email" onPress={guardianVerifyEmail} />
            </View>
          </>
        )}

        {step === 'g-verify' && (
          <>
            <View style={styles.group}>
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
              <Button primary pill label="Verify my identity" onPress={guardianVerify} />
            </View>
          </>
        )}

        {step === 'g-disclaimer' && (
          <>
            <PromiseList items={U18_PROMISES} />
            <Muted size={13}>
              By continuing you confirm you are this child&apos;s parent or legal guardian, you will manage
              all club contact on their behalf, and you accept the rules above.
            </Muted>
            <Button primary pill label="I agree — continue" onPress={guardianDisclaimer} />
          </>
        )}

        {step === 'g-child' && (
          <>
            <View style={styles.group}>
              <Field label="Child's name">
                <TextInput style={styles.input} placeholder="Child's full name" placeholderTextColor={colors.muted} value={childName} onChangeText={setChildName} />
              </Field>
              <Field label="Child's date of birth">
                <TextInput style={styles.input} placeholder="Child's date of birth (YYYY-MM-DD)" placeholderTextColor={colors.muted} value={childDob} onChangeText={setChildDob} />
              </Field>
            </View>
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
            <Button primary pill label="Create child profile" onPress={guardianAddChild} />
          </>
        )}

        {error && (
          <View style={styles.errorBox} testID="auth-error">
            <Text style={{ color: AUTH_PANEL.danger, fontSize: 13.5, lineHeight: 19 }} role="alert">{error}</Text>
          </View>
        )}
        </View>
        </ThemeOverride>

        {step === 'welcome' && (
          <ThemeOverride colors={AUTH_PANEL}>
            <View style={styles.outsideSection}>
              <Text style={styles.outsideTitle}>Our promises to every player</Text>
              <PromiseList items={SAFEGUARDING_PROMISES} />
            </View>
            <View style={styles.outsideSection}>
              <Text style={styles.outsideTitle}>Under-18? The rules that protect you</Text>
              <PromiseList items={U18_PROMISES.slice(0, 3)} />
            </View>
          </ThemeOverride>
        )}

        <View style={styles.footer}>
          {mode === 'demo' && <Text style={styles.footerNote}>Demo mode — no server connected</Text>}
          <Text style={styles.signature} testID="login-signature">
            BUILT BY <Text style={styles.signatureName}>Guni &amp; Younes</Text>
          </Text>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  // M24C — the page is the brand green; the form panel is the deep green.
  // M24D — 24px gutters, 32–48px between sections, 16–24px between fields.
  safe: { flex: 1, backgroundColor: AUTH_PAGE.page },
  scroll: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 36, gap: 24 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  brand: { flexDirection: 'row', alignItems: 'baseline', gap: 7, flexShrink: 1 },
  product: { color: AUTH_PAGE.soft, fontSize: 12, fontWeight: '600' },
  intro: { backgroundColor: AUTH_PAGE.green, borderRadius: 14, padding: 22, gap: 10, overflow: 'hidden' },
  introTitle: { color: AUTH_PAGE.ink, fontSize: 24, fontWeight: '700', letterSpacing: -0.6, lineHeight: 29 },
  introLine: { color: AUTH_PAGE.ink, fontSize: 14, lineHeight: 20 },
  panel: { backgroundColor: AUTH_PAGE.panel, borderRadius: 14, padding: 22, gap: 16, borderWidth: 1, borderColor: AUTH_PAGE.panelLine, shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
  authTabs: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 4 },
  authTab: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingRight: 8, minHeight: 44 },
  authTabText: { color: AUTH_PANEL.muted, fontSize: 15, fontWeight: '500' },
  authTabTextOn: { color: AUTH_PANEL.text, fontWeight: '700' },
  authTabDivider: { color: AUTH_PANEL.line, fontSize: 15 },
  kindRow: { flexDirection: 'row', gap: 18 },
  kindTab: { paddingVertical: 8, minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  kindTabOn: { borderBottomColor: AUTH_PANEL.accent },
  kindText: { color: AUTH_PANEL.muted, fontSize: 13.5, fontWeight: '600' },
  kindTextOn: { color: AUTH_PANEL.text },
  stepHeading: { color: AUTH_PANEL.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.4, flexShrink: 1 },
  group: { gap: 18 },
  choiceList: { borderTopWidth: 1, borderTopColor: AUTH_PANEL.line },
  choiceRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, minHeight: 56, borderBottomWidth: 1, borderBottomColor: AUTH_PANEL.line },
  choiceTitle: { color: AUTH_PANEL.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  choiceArrow: { color: AUTH_PANEL.muted, fontSize: 17 },
  demoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: AUTH_PANEL.line },
  textLink: { alignItems: 'flex-start', paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  textLinkText: { color: AUTH_PANEL.accent2, fontSize: 13.5, fontWeight: '600' },
  outsideSection: { gap: 14, marginTop: 8 },
  outsideTitle: { color: AUTH_PAGE.white, fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  footer: { alignItems: 'center', gap: 6, marginTop: 8 },
  footerNote: { color: AUTH_PAGE.soft, fontSize: 12 },
  // The makers' signature on the entry screen: quiet, centred, never a control.
  signature: { color: AUTH_PAGE.soft, fontSize: 12, letterSpacing: 0.4, textAlign: 'center' },
  signatureName: { color: AUTH_PAGE.white, fontSize: 13.5, fontWeight: '700', letterSpacing: 0 },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  alertBox: { gap: 8, padding: 16, borderRadius: 12, backgroundColor: AUTH_PANEL.dangerBg },
  errorBox: { paddingVertical: 4 },
  ageHint: { paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: colors.accent2 },
  fieldLabel: { color: colors.muted, fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  // The reference's minimalist underlined input.
  input: {
    backgroundColor: 'transparent',
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    borderRadius: 0,
    color: colors.text,
    paddingHorizontal: 0,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 44,
  },
  pwRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pwToggle: { paddingVertical: 10, paddingHorizontal: 4, minHeight: 44, justifyContent: 'center' },
  pwToggleText: { color: colors.accent2, fontSize: 12.5, fontWeight: '600' },
  codeInput: { letterSpacing: 6, textAlign: 'center', fontSize: 20, fontWeight: '700' },
});
