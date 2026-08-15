import { ClerkProvider } from '@clerk/react';
import type { ReactNode } from 'react';

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function isAuthDisabled() {
  return import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === '1';
}

export function isClerkConfigured() {
  // Clerk publishable keys always start with `pk_`; anything else is an
  // unresolved secret reference (e.g. `infisical://…`) leaking into a dev build.
  return !isAuthDisabled() && Boolean(clerkPublishableKey?.startsWith('pk_'));
}

export function AppClerkProvider({ children }: { children: ReactNode }) {
  if (!isClerkConfigured()) {
    return <>{children}</>;
  }

  return <ClerkProvider publishableKey={clerkPublishableKey!}>{children}</ClerkProvider>;
}
