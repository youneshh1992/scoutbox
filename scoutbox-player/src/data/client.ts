// Client selection: EXPO_PUBLIC_API_URL set → live server, otherwise the
// self-contained demo. (See README: start with
//   EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web
// to join the live dataset shared with the club app.)

import { httpClient } from './httpClient';
import { mockClient } from './mockClient';
import type { PlayerClient } from './types';

export const client: PlayerClient = process.env.EXPO_PUBLIC_API_URL ? httpClient : mockClient;
export { ClientError } from './types';
export type { Me, SignupInput, AttendanceInput, DemoIdentity, PlayerClient } from './types';
