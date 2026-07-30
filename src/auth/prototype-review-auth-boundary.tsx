import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth, useClerk, useSignIn, useUser } from '@clerk/react';
import { FolderKanban } from 'lucide-react';

import { projectSpaceClient, setProjectSpaceAuthTokenProvider } from '@/api/project-space-client';
import { Button, Text } from '@/app/dotnaos-ui';
import { isClerkConfigured } from '@/auth/clerk-provider';
import type { ProjectSpaceAuthSessionResult } from '@/shared/project-space-api';
import { exactPrototypeReviewReturn } from './project-space-auth-return';

function ReviewLogin({
  busy,
  message,
  onSignIn
}: {
  busy: boolean;
  message?: string;
  onSignIn(): void;
}) {
  return (
    <main className="grid min-h-full place-items-center bg-app-canvas px-6 text-neutral-100">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-neutral-800 bg-app-panel shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
          <FolderKanban className="size-6" strokeWidth={1.8} />
        </div>
        <Text as="h1" className="mt-6 text-2xl font-semibold tracking-tight">
          Sign in to review this prototype
        </Text>
        <Text as="p" className="mt-2 max-w-xs text-sm leading-relaxed text-neutral-400">
          Project Space verifies the exact pull request, commit, machine, and live server before
          showing prototype code.
        </Text>
        <Button
          fullWidth
          className="mt-8 rounded-xl bg-white text-neutral-950 hover:bg-neutral-200"
          isDisabled={busy}
          size="lg"
          variant="primary"
          onPress={onSignIn}
        >
          {busy ? 'Signing in…' : 'Continue with Google'}
        </Button>
        {message ? (
          <Text as="p" className="mt-4 text-sm leading-5 text-amber-300">
            {message}
          </Text>
        ) : null}
      </div>
    </main>
  );
}

function ClerkPrototypeReviewAuthBoundary({ children }: { children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const { signIn } = useSignIn();
  const { user } = useUser();
  const [session, setSession] = useState<ProjectSpaceAuthSessionResult>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    let active = true;
    if (!isLoaded) return () => {
      active = false;
    };
    if (!isSignedIn) {
      setProjectSpaceAuthTokenProvider(null);
      setSession({ authenticated: false, authRequired: true });
      return () => {
        active = false;
      };
    }
    setProjectSpaceAuthTokenProvider(() => getTokenRef.current());
    setSession(undefined);
    projectSpaceClient.getAuthSession()
      .then((next) => {
        if (!active) return;
        setSession(next);
        setMessage(next.authenticated ? '' : next.message ?? 'This account is not authorized.');
      })
      .catch((error) => {
        if (!active) return;
        setSession({ authenticated: false, authRequired: true });
        setMessage(error instanceof Error ? error.message : 'Could not verify this account.');
      });
    return () => {
      active = false;
    };
  }, [isLoaded, isSignedIn, user?.id]);

  async function startSignIn() {
    if (!signIn) return;
    setBusy(true);
    setMessage('');
    try {
      if (isSignedIn) await signOut();
      const returnUrl = exactPrototypeReviewReturn(window.location.href);
      const { error } = await signIn.sso({
        redirectCallbackUrl: '/sso-callback',
        redirectUrl: returnUrl,
        strategy: 'oauth_google'
      });
      if (error) {
        setBusy(false);
        setMessage(error.message || 'Could not start Google sign-in.');
      }
    } catch (error) {
      setBusy(false);
      setMessage(error instanceof Error ? error.message : 'Could not start Google sign-in.');
    }
  }

  if (session?.authenticated) return <>{children}</>;
  return (
    <ReviewLogin
      busy={busy || !isLoaded || (Boolean(isSignedIn) && !session)}
      message={message}
      onSignIn={() => void startSignIn()}
    />
  );
}

export function PrototypeReviewAuthBoundary({ children }: { children: ReactNode }) {
  if (import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === '1') return <>{children}</>;
  if (!isClerkConfigured()) {
    return (
      <ReviewLogin
        busy
        message="Project Space authentication is not configured."
        onSignIn={() => undefined}
      />
    );
  }
  return <ClerkPrototypeReviewAuthBoundary>{children}</ClerkPrototypeReviewAuthBoundary>;
}
