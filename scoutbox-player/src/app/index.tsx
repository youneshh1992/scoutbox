import { Redirect } from 'expo-router';
import { useSession } from '../state';

export default function Index() {
  const { playerId } = useSession();
  return <Redirect href={playerId ? '/(tabs)/discover' : '/onboarding'} />;
}
