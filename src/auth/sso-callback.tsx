import { useEffect } from 'react';
import { AuthenticateWithRedirectCallback } from '@clerk/react';
import { isClerkConfigured } from '@/auth/clerk-provider';

/**
 * Landing page for the OAuth redirect started by `signIn.authenticateWithRedirect`.
 * Clerk finishes the handshake here and then navigates to `redirectUrlComplete`.
 */
export function SsoCallbackScreen() {
  const clerkConfigured = isClerkConfigured();

  useEffect(() => {
    if (!clerkConfigured) {
      window.location.replace('/');
    }
  }, [clerkConfigured]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-app-canvas text-neutral-100">
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-100"
      />
      <p className="text-sm text-neutral-400">Completing sign-in…</p>
      {clerkConfigured ? <AuthenticateWithRedirectCallback /> : null}
    </div>
  );
}
