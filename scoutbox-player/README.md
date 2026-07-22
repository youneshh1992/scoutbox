# scoutbox-player

The ScoutBox player mobile app (Expo / React Native, expo-router).

## Run

```sh
npm install

# Self-contained demo mode (no backend needed):
npx expo start --web

# Live mode — shares the dataset with the club app (start scoutbox-server first):
EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web
```

## Structure

- `src/app/` — expo-router routes: onboarding (with the adults-only age gate) and
  tabs `(tabs)/`: discover / inbox / profile / upload / you.
- `src/domain/` — trust-score + safeguarding logic, mirroring
  `scoutbox-server/domain.mjs` (the server copy is authoritative).
- `src/data/` — `httpClient.ts` (live server) and `mockClient.ts` (demo mode),
  selected by `EXPO_PUBLIC_API_URL` in `client.ts`.
