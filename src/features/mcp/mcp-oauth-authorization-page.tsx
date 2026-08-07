import { useAuth, useSignIn } from '@clerk/react';
import { LoaderCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { isClerkConfigured } from '@/auth/clerk-provider';

const localAuthDisabled = import.meta.env.VITE_PROJECT_SPACE_AUTH_DISABLED === '1';

interface AuthorizationDetails {
  clientName: string;
  expiresAt: string;
  scopes: string[];
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-app-canvas px-6 py-12 text-neutral-100">
      <div className="w-full max-w-xl">{children}</div>
    </main>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <Frame>
      <div className="flex flex-col items-center py-10 text-center">
        <TriangleAlert className="size-8 text-amber-300" />
        <Text as="h1" className="mt-5 text-2xl font-semibold">Connection unavailable</Text>
        <Text as="p" className="mt-2 max-w-md text-sm text-neutral-400">{children}</Text>
      </div>
    </Frame>
  );
}

function Authorization({ getToken, requestId }: { getToken(): Promise<string | null>; requestId: string }) {
  const [details, setDetails] = useState<AuthorizationDetails>();
  const [error, setError] = useState('');
  const [decision, setDecision] = useState<'approve' | 'deny'>();

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const response = await fetch(`/api/mcp/oauth/authorization?request=${encodeURIComponent(requestId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      const body = await response.json() as AuthorizationDetails & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not load the authorization request.');
      setDetails(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the authorization request.');
    }
  }, [getToken, requestId]);

  useEffect(() => { void load(); }, [load]);

  async function decide(nextDecision: 'approve' | 'deny') {
    setDecision(nextDecision);
    setError('');
    try {
      const token = await getToken();
      const response = await fetch('/api/mcp/oauth/authorization', {
        body: JSON.stringify({ decision: nextDecision, requestId }),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        method: 'POST'
      });
      const body = await response.json() as { error?: string; redirectUrl?: string };
      if (!response.ok || !body.redirectUrl) throw new Error(body.error ?? 'Could not complete authorization.');
      window.location.assign(body.redirectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete authorization.');
      setDecision(undefined);
    }
  }

  if (error && !details) return <Message>{error}</Message>;
  if (!details) {
    return <Frame><div className="flex justify-center py-12"><LoaderCircle className="size-7 animate-spin" /></div></Frame>;
  }

  return (
    <Frame>
      <div className="flex items-start gap-4">
        <div className="flex size-12 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-950/70">
          <ShieldCheck className="size-5" />
        </div>
        <div>
          <Chip size="sm" variant="primary">Project Space MCP</Chip>
          <Text as="h1" className="mt-2 text-3xl font-semibold tracking-tight">Connect {details.clientName}?</Text>
          <Text as="p" className="mt-2 text-sm leading-6 text-neutral-400">
            This lets the client use Project Space on your behalf. You can revoke the connection later.
          </Text>
        </div>
      </div>
      <Surface className="mt-8 rounded-xl p-5" variant="secondary">
        <Text as="p" className="text-sm font-medium text-neutral-200">Requested access</Text>
        <ul className="mt-3 space-y-2 text-sm text-neutral-400">
          {details.scopes.includes('project-space:read') ? <li>Read projects, machines, and Codex tasks</li> : null}
          {details.scopes.includes('project-space:write') ? <li>Start Codex tasks and send follow-up messages</li> : null}
        </ul>
      </Surface>
      {error ? <Text as="p" className="mt-4 text-sm text-amber-200" role="alert">{error}</Text> : null}
      <div className="mt-8 flex justify-end gap-3">
        <Button isDisabled={Boolean(decision)} variant="ghost" onPress={() => void decide('deny')}>Deny</Button>
        <Button isDisabled={Boolean(decision)} variant="primary" onPress={() => void decide('approve')}>
          {decision === 'approve' ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          Allow
        </Button>
      </div>
    </Frame>
  );
}

function ClerkAuthorization({ requestId }: { requestId: string }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { signIn } = useSignIn();
  const [redirecting, setRedirecting] = useState(false);

  if (!isLoaded) return <Frame><div className="flex justify-center"><LoaderCircle className="size-7 animate-spin" /></div></Frame>;
  if (!isSignedIn) {
    return (
      <Frame>
        <div className="flex flex-col items-center text-center">
          <ShieldCheck className="size-8" />
          <Text as="h1" className="mt-5 text-2xl font-semibold">Sign in to connect Project Space</Text>
          <Text as="p" className="mt-2 text-sm text-neutral-400">Review the requested MCP permissions after signing in.</Text>
          <Button className="mt-7" isDisabled={redirecting} variant="primary" onPress={() => {
            if (!signIn) return;
            setRedirecting(true);
            void signIn.sso({
              redirectCallbackUrl: '/sso-callback',
              redirectUrl: `/mcp/authorize?request=${encodeURIComponent(requestId)}`,
              strategy: 'oauth_google'
            });
          }}>
            {redirecting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Continue with Google
          </Button>
        </div>
      </Frame>
    );
  }
  return <Authorization getToken={getToken} requestId={requestId} />;
}

export function McpOAuthAuthorizationPage() {
  const requestId = new URLSearchParams(window.location.search).get('request')?.trim();
  if (!requestId) return <Message>The authorization request is missing.</Message>;
  if (localAuthDisabled) return <Authorization getToken={() => Promise.resolve(null)} requestId={requestId} />;
  if (!isClerkConfigured()) return <Message>Project Space login is not configured.</Message>;
  return <ClerkAuthorization requestId={requestId} />;
}
