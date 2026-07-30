'use client';

import {
  docsDeploymentPresentation,
  resolveDocsDeploymentIdentity,
  unavailableDocsDeploymentIdentity,
  type DocsDeploymentIdentity,
} from '@/lib/deployment-identity';
import {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';

const DocsDeploymentIdentityContext = createContext<
  DocsDeploymentIdentity | undefined
>(undefined);

export function useDocsDeploymentIdentity() {
  return useContext(DocsDeploymentIdentityContext);
}

export function DocsDeploymentIdentityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [identity, setIdentity] = useState<
    DocsDeploymentIdentity | undefined
  >();

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/app/meta', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Metadata request failed: ${response.status}`);
        }
        return response.json() as Promise<unknown>;
      })
      .then((metadata) => {
        setIdentity(
          resolveDocsDeploymentIdentity(
            metadata,
            window.location.hostname,
          ),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setIdentity(
          unavailableDocsDeploymentIdentity(
            window.location.hostname,
            'request-failed',
          ),
        );
      });
    return () => controller.abort();
  }, []);

  return (
    <DocsDeploymentIdentityContext.Provider value={identity}>
      {children}
    </DocsDeploymentIdentityContext.Provider>
  );
}

export function DocsArticleIdentity({
  title,
}: {
  title: string;
}) {
  const identity = useDocsDeploymentIdentity();
  const label = identity
    ? articleIdentityLabel(title, identity)
    : `${title} · Checking Docs version…`;

  return (
    <p
      aria-live="polite"
      className="not-prose mt-2 text-sm font-medium text-fd-muted-foreground"
      data-docs-identity={identity?.state ?? 'loading'}
    >
      {label}
    </p>
  );
}

export function articleIdentityLabel(
  title: string,
  identity: DocsDeploymentIdentity,
) {
  const presentation = docsDeploymentPresentation(identity);
  if (identity.state === 'preview') {
    return `${title} · Preview PR #${identity.pullRequestNumber} · expected ${presentation.versionLabel}`;
  }
  if (identity.state === 'production') {
    return `${title} · Docs ${presentation.versionLabel}`;
  }
  return `${title} · Version unavailable`;
}
