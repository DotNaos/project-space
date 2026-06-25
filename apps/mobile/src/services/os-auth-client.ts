import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { createAuthClient } from 'better-auth/react';

export const osAuthBaseUrl =
  process.env.EXPO_PUBLIC_OS_AUTH_URL ?? 'https://os-vps-1.tail5bb1d7.ts.net:8444';

export const osAuthClient = createAuthClient({
  baseURL: osAuthBaseUrl,
  plugins: [
    expoClient({
      scheme: 'projectspace',
      storage: SecureStore,
      storagePrefix: 'projectspace',
    }),
  ],
});
