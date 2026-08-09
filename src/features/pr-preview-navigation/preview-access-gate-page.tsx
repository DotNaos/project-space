import { useAuth, useClerk, useSignIn } from '@clerk/react';
import { Button } from '@heroui/react';
import { ArrowRight, FolderKanban, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { establishPrototypeAccess } from '@/api/prototype-access-client';
import { projectSpaceClient, setProjectSpaceAuthTokenProvider } from '@/api/project-space-client';
import { isClerkConfigured } from '@/auth/clerk-provider';
import { parsePreviewAccessGateSearch, type PreviewAccessGateTarget } from '@/shared/preview-access-gate';

function GateLayout({
  action,
  busy,
  message,
  onAction,
  title
}: {
  action?: string;
  busy: boolean;
  message: string;
  onAction?(): void;
  title: string;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-app-canvas px-6 text-neutral-100">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <div className="grid size-12 place-items-center rounded-xl border border-neutral-800 bg-app-panel">
          {busy
            ? <LoaderCircle aria-hidden className="size-5 animate-spin text-neutral-400" />
            : <FolderKanban aria-hidden className="size-5 text-neutral-300" />}
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">{title}</h1>
        <p aria-live="polite" className="mt-2 text-sm leading-6 text-neutral-400">{message}</p>
        {action && onAction ? (
          <Button
            className="mt-7 w-full rounded-xl"
            isDisabled={busy}
            size="lg"
            onPress={onAction}
          >
            {action}
            <ArrowRight aria-hidden className="size-4" />
          </Button>
        ) : null}
        <a className="mt-5 text-xs text-neutral-600 transition hover:text-neutral-300" href="/">
          Open Preview manager
        </a>
      </div>
    </main>
  );
}

function ClerkPreviewAccessGate({ target }: { target: PreviewAccessGateTarget }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const { signIn } = useSignIn();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const grantKey = useRef('');

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const key = `${target.pullRequestNumber}:${target.returnTarget}:${attempt}`;
    if (grantKey.current === key) return;
    grantKey.current = key;
    let active = true;
    setError('');
    setProjectSpaceAuthTokenProvider(() => getToken());
    const grant = target.surface === 'prototype'
      ? establishPrototypeAccess(
          target.targetUrl,
          target.pullRequestNumber,
          target.changeId!,
          target.surfaceKind!
        )
      : projectSpaceClient.establishPullRequestPreviewAccess(target.pullRequestNumber);
    grant
      .then(() => {
        if (active) window.location.replace(target.targetUrl);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : 'Preview access could not be granted.');
      });
    return () => {
      active = false;
    };
  }, [attempt, getToken, isLoaded, isSignedIn, target]);

  async function startSignIn() {
    if (!signIn) return;
    setError('');
    try {
      if (isSignedIn) await signOut();
      const { error: signInError } = await signIn.sso({
        redirectCallbackUrl: '/sso-callback',
        redirectUrl: window.location.href,
        strategy: 'oauth_google'
      });
      if (signInError) setError(signInError.message || 'Could not start Google sign-in.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start Google sign-in.');
    }
  }

  if (!isLoaded) {
    return <GateLayout busy message="Checking your Project Space session…" title="Opening Preview" />;
  }
  if (!isSignedIn) {
    return (
      <GateLayout
        action="Continue with Google"
        busy={false}
        message={`Sign in once, then continue directly to PR #${target.pullRequestNumber}.`}
        onAction={() => void startSignIn()}
        title="Preview access"
      />
    );
  }
  if (error) {
    return (
      <GateLayout
        action="Try again"
        busy={false}
        message={error}
        onAction={() => setAttempt((value) => value + 1)}
        title="Preview could not be opened"
      />
    );
  }
  return (
    <GateLayout
      busy
      message={`Opening the ${target.surface === 'prototype' ? 'Prototype' : 'full Preview'} for PR #${target.pullRequestNumber}…`}
      title="Opening Preview"
    />
  );
}

export function PreviewAccessGatePage() {
  const target = useMemo(
    () => parsePreviewAccessGateSearch(window.location.search),
    []
  );
  if (!target) {
    return (
      <GateLayout
        busy={false}
        message="The requested Preview destination is invalid or incomplete."
        title="Invalid Preview link"
      />
    );
  }
  if (import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === '1') {
    return <GateLayout busy={false} message="Preview authentication is disabled." title="Preview unavailable" />;
  }
  if (!isClerkConfigured()) {
    return <GateLayout busy={false} message="Project Space authentication is not configured." title="Preview unavailable" />;
  }
  return <ClerkPreviewAccessGate target={target} />;
}
