# Project Space mobile prototype

This directory contains the existing Expo / React Native prototype. The current
native entry point shows a bundled snapshot of local projects. It does not yet
provide the planned Project Space Home, Chat, Projects, authentication, or
backend features from issue #301.

## macOS prerequisites

- Node.js and npm
- Xcode with an iOS Simulator runtime installed
- An available iPhone Simulator

If Xcode has no iOS runtime yet, install the matching runtime from Xcode's
Settings under Components. On Apple silicon, the command-line equivalent is:

```bash
xcodebuild -downloadPlatform iOS -architectureVariant arm64
```

List the installed simulator devices and copy the UDID of the iPhone you want to
use:

```bash
xcrun simctl list devices available
```

If necessary, boot that exact device before starting Expo:

```bash
xcrun simctl boot <simulator-udid>
open -a Simulator
```

## Clean install and iOS start

Run these commands from the repository root:

```bash
cd apps/mobile
npm ci
npm run ios
```

`npm run ios` starts Metro on the repository's mobile port (`8082`) in Expo Go
mode and opens the project in the booted iOS Simulator. Expo Go is sufficient
for this prototype; no EAS build or custom development client is required.

Stop Metro with Control-C. To prove a clean restart, run the same start command
again:

```bash
npm run ios
```

If Metro reports a stale cache after dependency or configuration changes, use:

```bash
npm run start -- --clear
```

## Checks

Run the focused checks from `apps/mobile`:

```bash
npm run typecheck
npx expo install --check
npx expo-doctor@latest
```

## Optional environment

No environment file or secret is required to start the native prototype. With
no local configuration it renders the committed project snapshot and a
signed-out account label.

Expo automatically reads an optional `.env.local` file. Start from
`.env.example` only when testing the older optional inventory or authentication
experiments:

```bash
cp .env.example .env.local
```

- `EXPO_PUBLIC_PROJECT_SPACE_INVENTORY_URL` enables the Refresh button to load a
  different project-inventory JSON endpoint. If it is missing or unreachable,
  the app keeps the bundled snapshot and shows the fallback state.
- `EXPO_PUBLIC_OS_AUTH_URL` overrides the optional OS account endpoint.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `AUTH_SERVER_ORIGIN` are used
  only by the separate `npm run auth` helper for the older web OAuth experiment.
- `EXPO_PUBLIC_AUTH_SERVER_ORIGIN` points that older web experiment at its auth
  helper.

Never put secrets in an `EXPO_PUBLIC_` value because Expo includes those values
in the client bundle. `.env.local` is ignored by Git.
