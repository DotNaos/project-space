'use client';

import {
  docsDeploymentPresentation,
  resolveDocsDeploymentIdentity,
  unavailableDocsDeploymentIdentity,
  type DocsDeploymentIdentity,
} from '@/lib/deployment-identity';
import { ArrowLeft, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';

type DocsDeploymentFooterState =
  | DocsDeploymentIdentity
  | { state: 'loading' };

export function DocsDeploymentFooter() {
  const [identity, setIdentity] =
    useState<DocsDeploymentFooterState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const hostname = window.location.hostname;

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
          resolveDocsDeploymentIdentity(metadata, hostname),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setIdentity(
          unavailableDocsDeploymentIdentity(
            hostname,
            'request-failed',
          ),
        );
      });

    return () => controller.abort();
  }, []);

  return (
    <DocsDeploymentFooterContent identity={identity} />
  );
}

export function DocsDeploymentFooterContent({
  identity,
}: {
  identity: DocsDeploymentFooterState;
}) {
  if (identity.state === 'loading') {
    return (
      <FooterFrame>
        <p className="text-xs font-medium text-fd-foreground">
          Checking Docs version…
        </p>
      </FooterFrame>
    );
  }

  const presentation = docsDeploymentPresentation(identity);

  return (
    <FooterFrame>
      <div
        aria-live="polite"
        className="flex items-center justify-between gap-2"
      >
        <p className="min-w-0 truncate text-xs font-medium text-fd-foreground">
          {presentation.contextLabel}
        </p>
        {presentation.revision && (
          <span className="shrink-0 rounded-md bg-fd-secondary px-2 py-1 font-mono text-[11px] font-medium text-fd-secondary-foreground">
            {presentation.versionLabel}
          </span>
        )}
      </div>
      {presentation.revision ? (
        <p
          className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-fd-muted-foreground"
          title={presentation.fullRevision}
        >
          <GitCommitHorizontal
            aria-hidden
            className="size-3.5 shrink-0"
          />
          {presentation.revision}
        </p>
      ) : (
        <p className="mt-1 text-[11px] leading-4 text-fd-muted-foreground">
          <span className="font-medium text-fd-foreground">
            {presentation.versionLabel}.
          </span>{' '}
          Details could not be verified.
        </p>
      )}
      <a
        className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-fd-muted-foreground no-underline transition-colors hover:text-fd-foreground"
        href={presentation.backHref}
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {presentation.backLabel}
      </a>
    </FooterFrame>
  );
}

function FooterFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-fd-border pt-3">
      {children}
    </div>
  );
}
