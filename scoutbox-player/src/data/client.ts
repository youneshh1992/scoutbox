// Client selection: the app is LIVE by default against EXPO_PUBLIC_API_URL
// (falling back to http://localhost:4000 when unset). The self-contained demo
// client is chosen only by the explicit EXPO_PUBLIC_DEMO=1 flag — a missing
// API variable never silently swaps in mock data.
//   live:  EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web
//   demo:  EXPO_PUBLIC_DEMO=1 npx expo start --web

import { httpClient } from './httpClient';
import { mockClient } from './mockClient';
import type { PlayerClient } from './types';

export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO === '1';
export const client: PlayerClient = DEMO_MODE ? mockClient : httpClient;
export { ClientError } from './types';
export type {
  Me, SignupInput, AttendanceInput, DemoIdentity, PlayerClient, ReportInput, ChildInput,
  Channel, Message, MessageAttachment, AppNotification, Insights, FiledReport,
  PlayerFeedItem, PlayerCV, GuardianDigest,
  Pathway, ProgrammeInfo, ProgrammeProgress, Benchmarks, Opportunities,
  GuardianOpenTrial, Vouch, SeasonWrap,
} from './types';
