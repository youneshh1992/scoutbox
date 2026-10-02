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
import { Button, Card, Muted, Row, SectionTitle } from '../components/ui';

const COUNTRIES = ['GB', 'PT', 'FR', 'SE', 'PL', 'NG', 'GH', 'AR', 'JP', 'KR', 'TH', 'SG', 'US'];

type Step =
  | 'welcome' | 'signin' | 'pair'
  | 'details' | 'football' | 'needs-guardian'
  | 'g-account' | 'g-email' | 'g-verify' | 'g-disclaimer' | 'g-child';

/* ---- presentation helpers (visual only — every flow string is unchanged) */

function RoleCard({ icon, title, subtitle, accent, onPress }: {
  icon: string; title: string; subtitle: string; accent?: boolean; onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.roleCard,
        accent && { borderColor: colors.accentText, backgroundColor: colors.tabActiveBg },
        pressed && { opacity: 0.75, transform: [{ scale: 0.99 }] },
      ]}
    >
      <View style={[styles.roleIcon, accent && { borderColor: colors.accentText }]}>
        <Text style={{ fontSize: 24 }}>{icon}</Text>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.roleTitle}>{title}</Text>
        <Muted size={12.5}>{subtitle}</Muted>
      </View>
      <Text style={{ color: accent ? colors.accentText : colors.muted, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}

/** M24C.2 — the pitch embossed into the bright-green introduction: each
 *  line is a dark groove with a light edge one pixel beside it. Plain Views,
 *  so iOS, Android and the web draw it alike; behind the copy, never in front
 *  of a tap, hidden from assistive technology. */
function EmbossedPitch() {
  const dark = AUTH_PAGE.embossDark, light = AUTH_PAGE.embossLight;
  const line = (extra: object) => [{ position: 'absolute' as const }, extra];
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={[StyleSheet.absoluteFill, { overflow: 'hidden', zIndex: 0 }]}>
      {/* boundary: light edge then the dark groove */}
      <View style={line({ top: 13, left: 13, right: 11, bottom: 11, borderWidth: 1, borderColor: light, borderRadius: 3 })} />
      <View style={line({ top: 12, left: 12, right: 12, bottom: 12, borderWidth: 1, borderColor: dark, borderRadius: 3 })} />
      {/* halfway line */}
      <View style={line({ left: 12, right: 12, top: '50%', marginTop: 0.5, borderTopWidth: 1, borderColor: light })} />
      <View style={line({ left: 12, right: 12, top: '50%', marginTop: -0.5, borderTopWidth: 1, borderColor: dark })} />
      {/* centre circle and spot */}
      <View style={line({ left: '50%', top: '50%', width: 60, height: 60, marginLeft: -29, marginTop: -29, borderRadius: 30, borderWidth: 1, borderColor: light })} />
      <View style={line({ left: '50%', top: '50%', width: 60, height: 60, marginLeft: -30, marginTop: -30, borderRadius: 30, borderWidth: 1, borderColor: dark })} />
      <View style={line({ left: '50%', top: '50%', width: 4, height: 4, marginLeft: -2, marginTop: -2, borderRadius: 2, backgroundColor: dark })} />
      {/* one penalty area, left end */}
      <View style={line({ left: 13, top: '30%', bottom: '30%', width: 44, borderWidth: 1, borderLeftWidth: 0, borderColor: light, borderTopRightRadius: 3, borderBottomRightRadius: 3 })} />
      <View style={line({ left: 12, top: '30%', bottom: '30%', width: 44, borderWidth: 1, borderLeftWidth: 0, borderColor: dark, borderTopRightRadius: 3, borderBottomRightRadius: 3 })} />
    </View>
  );
}

function StepDots({ current }: { current: number }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.dotsRow}>
      {[1, 2, 3, 4, 5].map((n) => (
        <View key={n} style={[styles.dot, n <= current && { backgroundColor: colors.accent, borderColor: colors.accent }]} />
      ))}
    </View>
  );
}

function CheckList({ items, mark = '✓', markColor }: {
  items: readonly string[]; mark?: string; markColor?: string;
}) {
  const colors = useColors();
  const markTone = markColor ?? colors.accentText;
  return (
    <Card style={{ gap: 12 }}>
      {items.map((p) => (
        <View key={p.slice(0, 20)} style={{ flexDirection: 'row', gap: 10 }}>
          <Text style={{ color: markTone, fontSize: 14, fontWeight: '800', lineHeight: 19 }}>{mark}</Text>
          <View style={{ flex: 1 }}>
            <Muted size={13.5}>{p}</Muted>
          </View>
        </View>
      ))}
    </Card>
  );
}

function Avatar({ name, tone }: { name: string; tone?: 'gold' }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const initials = name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <View style={[styles.avatar, tone === 'gold' && { borderColor: colors.gold }]}>
      <Text style={{ color: tone === 'gold' ? colors.gold : colors.accentText, fontWeight: '800', fontSize: 15 }}>{initials}</Text>
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
    pair: 'Pair this device', details: 'Create your player account', football: 'Your football', 'needs-guardian': 'Under-18s join with a guardian',
    'g-account': 'Guardian account', 'g-email': 'Email verification', 'g-verify': 'ID verification', 'g-disclaimer': 'Safeguarding disclaimer', 'g-child': 'Your child',
  };

  // M24C — the authentication composition (reference B, stacked for a phone):
  // the ScoutBox Player mark near the top, a compact green introduction, then
  // the deep-green form panel. The panel keeps its brand colours whatever
  // appearance the player saved; every existing step renders inside it.
  return (
    <SafeAreaView style={styles.safe} testID="auth-screen">
      {/* M24C.1 — the approved pitch behind the entry screen, in the
          authentication palette (white lines at 8%), behind every surface,
          never in front of a tap, hidden from assistive technology. */}
      <ThemeOverride colors={AUTH_PANEL}><PitchBackdrop height={760} top={64} /></ThemeOverride>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.topRow}>
          <View style={styles.brand} accessibilityRole="header" aria-level={1} accessibilityLabel="ScoutBox Player">
            <Text style={styles.logo}>ScoutBox<Text style={{ color: AUTH_PAGE.green }}>▪</Text></Text>
            <Text style={styles.tm} accessibilityLabel="trademark">TM</Text>
            <Text style={styles.product}>Player</Text>
          </View>
          <ThemeSwitch />
        </View>

        {entry && (
          <View style={styles.intro} testID="auth-intro">
            <EmbossedPitch />
            <Text style={[styles.introTitle, { zIndex: 1 }]}>Your football. Your next opportunity.</Text>
            <View style={{ gap: 6 }}>
              {[
                'A verified Football Passport that clubs can read.',
                'No unsolicited contact: every approach needs your yes.',
                'Trials, Offers and signings in one place, on your terms.',
              ].map((line) => (
                <View key={line.slice(0, 16)} style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={styles.introMark}>✓</Text>
                  <Text style={styles.introLine}>{line}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {serverDown && (
          <Card style={{ borderColor: colors.danger, gap: 8 }}>
            <Text style={styles.name}>Can't reach the ScoutBox backend</Text>
            <Muted size={13}>
              The app is in live mode and the API isn't responding. Start scoutbox-server (port 4000),
              or check EXPO_PUBLIC_API_URL if it runs somewhere else. Nothing is faked while it's down.
            </Muted>
            <Button small label="Try again" onPress={checkServer} />
          </Card>
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
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
            <Text role="heading" aria-level={2} style={styles.stepHeading}>{stepTitle[step] ?? ''}</Text>
            {onGuardianPath && (
              <StepDots current={{ 'g-account': 1, 'g-email': 2, 'g-verify': 3, 'g-disclaimer': 4, 'g-child': 5 }[step as 'g-account'] ?? 1} />
            )}
          </View>
        )}

        {step === 'signin' && (
          <View style={{ gap: 12 }} testID="auth-signin">
            <SectionTitle>Parent or guardian</SectionTitle>
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

            <SectionTitle>Player (18+)</SectionTitle>
            <Field label="Player id">
              <TextInput style={styles.input} placeholder="The id on your profile" placeholderTextColor={AUTH_PANEL.muted} value={siPlayerId} onChangeText={setSiPlayerId} autoCapitalize="none" autoComplete="username" accessibilityLabel="Player id" />
            </Field>
            <Field label="Password">
              <TextInput style={styles.input} placeholder="Your password" placeholderTextColor={AUTH_PANEL.muted} value={siPlayerPassword} onChangeText={setSiPlayerPassword} secureTextEntry={!showPw} autoComplete="current-password" textContentType="password" accessibilityLabel="Player password" onSubmitEditing={() => void signInPlayer()} />
            </Field>
            <Button primary pill label={busy === 'player' ? 'Signing in…' : 'Sign in as player'} disabled={busy !== null} onPress={() => void signInPlayer()} testID="auth-signin-player" />
            <Pressable onPress={() => setStep('pair')} style={({ pressed }) => [styles.pairLink, pressed && { opacity: 0.7 }]}>
              <Text style={{ color: AUTH_PANEL.accent2, fontSize: 13.5, fontWeight: '600' }}>I have a code from my parent/guardian</Text>
            </Pressable>
          </View>
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
              <Text style={{ color: AUTH_PANEL.accent2, fontSize: 13.5, fontWeight: '600' }}>
                🔗  I have a code from my parent/guardian
              </Text>
            </Pressable>
          </>
        )}

        {entry && identities.length > 0 && (
          <>
            <SectionTitle>Or continue as a demo account</SectionTitle>
            <Card style={{ gap: 0, paddingVertical: 4 }} testID="demo-identities">
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
            <Button primary pill label="Continue" onPress={checkDetails} />
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
            <Button primary pill label="Create profile" onPress={create} />
            <Button label="Back" onPress={() => setStep('details')} />
          </>
        )}

        {step === 'needs-guardian' && (
          <Card>
            <Text style={styles.name}>Under-18s join with a parent or guardian</Text>
            <Muted size={14}>
              Your account will be owned and managed by your parent or guardian — that&apos;s how ScoutBox
              keeps you safe. You still upload your videos, edit your stats and complete drills; scouts can
              only ever talk to your parent, never to you.
            </Muted>
            <Button primary pill label="Set up the guardian account" onPress={() => setStep('g-account')} />
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
              <Button primary pill label="Continue to email verification" onPress={guardianCreate} />
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
              <Button primary pill label="Verify email" onPress={guardianVerifyEmail} />
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
              <Button primary pill label="Verify my identity" onPress={guardianVerify} />
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
            <Button primary pill label="I agree — continue" onPress={guardianDisclaimer} />
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
            <Button primary pill label="Create child profile" onPress={guardianAddChild} />
          </>
        )}

        {error && (
          <Card style={{ borderColor: AUTH_PANEL.danger }} testID="auth-error">
            <Text style={{ color: AUTH_PANEL.danger }} role="alert">{error}</Text>
          </Card>
        )}
        </View>
        </ThemeOverride>

        {step === 'welcome' && (
          <>
            <Text style={styles.outsideTitle}>Our promises to every player</Text>
            <CheckList items={SAFEGUARDING_PROMISES} />
            <Text style={styles.outsideTitle}>Under-18? The rules that protect you</Text>
            <CheckList items={U18_PROMISES.slice(0, 3)} mark="🛡" markColor={colors.accent2} />
          </>
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
  safe: { flex: 1, backgroundColor: AUTH_PAGE.page },
  scroll: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 28, gap: 14 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  brand: { flexDirection: 'row', alignItems: 'baseline', gap: 7, flexShrink: 1 },
  logo: { color: AUTH_PAGE.white, fontSize: 26, fontWeight: '800', letterSpacing: -1.1 },
  tm: { color: AUTH_PAGE.soft, fontSize: 8, fontWeight: '700', letterSpacing: 0.6, lineHeight: 10, alignSelf: 'flex-start', marginTop: 2, marginLeft: -4, marginRight: 2 },
  product: { color: AUTH_PAGE.soft, fontSize: 12, fontWeight: '600' },
  intro: { backgroundColor: AUTH_PAGE.green, borderRadius: 14, padding: 18, gap: 12, overflow: 'hidden' },
  introTitle: { color: AUTH_PAGE.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.5, lineHeight: 27 },
  introMark: { color: AUTH_PAGE.ink, fontSize: 13, fontWeight: '800', lineHeight: 19 },
  introLine: { color: AUTH_PAGE.ink, fontSize: 13, lineHeight: 19, flex: 1 },
  panel: { backgroundColor: AUTH_PAGE.panel, borderRadius: 14, padding: 18, gap: 12, borderWidth: 1, borderColor: AUTH_PAGE.panelLine, shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
  authTabs: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 4 },
  authTab: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingRight: 8, minHeight: 44 },
  authTabText: { color: AUTH_PANEL.muted, fontSize: 15, fontWeight: '500' },
  authTabTextOn: { color: AUTH_PANEL.text, fontWeight: '700' },
  authTabDivider: { color: AUTH_PANEL.line, fontSize: 15 },
  stepHeading: { color: AUTH_PANEL.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.3, flexShrink: 1 },
  outsideTitle: { color: AUTH_PAGE.white, fontSize: 17, fontWeight: '600', letterSpacing: -0.3, marginTop: 10 },
  footer: { alignItems: 'center', gap: 6, marginTop: 8 },
  footerNote: { color: AUTH_PAGE.soft, fontSize: 12 },
  // The makers' signature on the entry screen: quiet, centred, never a control.
  signature: { color: AUTH_PAGE.soft, fontSize: 12, letterSpacing: 0.4, textAlign: 'center' },
  signatureName: { color: AUTH_PAGE.white, fontSize: 13.5, fontWeight: '700', letterSpacing: 0 },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
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
  pairLink: { alignItems: 'center', paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
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
    borderColor: colors.accentText,
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
