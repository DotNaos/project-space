import { ClerkProvider } from '@clerk/react';
import type { ReactNode } from 'react';

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export function isClerkConfigured() {
  return Boolean(clerkPublishableKey);
}

export function AppClerkProvider({ children }: { children: ReactNode }) {
  if (!clerkPublishableKey) {
    return <>{children}</>;
  }

  return <ClerkProvider publishableKey={clerkPublishableKey}>{children}</ClerkProvider>;
}
