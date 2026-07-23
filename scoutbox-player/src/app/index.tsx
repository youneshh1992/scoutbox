import { Redirect } from 'expo-router';
import { useSession } from '../state';

export default function Index() {
  const { kind } = useSession();
  if (kind === 'guardian') return <Redirect href="/guardian" />;
  if (kind === 'player') return <Redirect href="/(tabs)/discover" />;
  return <Redirect href="/onboarding" />;
}
