'use client';

import type {
  ChangelogPrototype
} from '@/lib/changelog/model';
import {
  resolveDocsDeploymentIdentity,
  unavailableDocsDeploymentIdentity,
  type DocsDeploymentIdentity
} from '@/lib/deployment-identity';
import {
  ArrowUpRight,
  Monitor,
  Smartphone
} from 'lucide-react';
import { useEffect, useState } from 'react';

interface ChangelogPrototypeActionProps {
  changeId: string;
  prototype: ChangelogPrototype;
  pullRequestNumber: number;
  title: string;
}

type IdentityState =
  | DocsDeploymentIdentity
  | { state: 'loading' };

const surfaceLabels = {
  'desktop-prototype': 'Desktop prototype',
  'mobile-prototype': 'Mobile prototype'
} as const;

export function ChangelogPrototypeAction({
  changeId,
  prototype,
  pullRequestNumber,
  title
}: ChangelogPrototypeActionProps) {
  const [identity, setIdentity] = useState<IdentityState>({
    state: 'loading'
  });

  useEffect(() => {
    const controller = new AbortController();
    const hostname = window.location.hostname;
    void fetch('/api/app/meta', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Metadata request failed: ${response.status}`);
        }
        return response.json() as Promise<unknown>;
      })
      .then((metadata) => {
        setIdentity(resolveDocsDeploymentIdentity(metadata, hostname));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setIdentity(
          unavailableDocsDeploymentIdentity(
            hostname,
            'request-failed'
          )
        );
      });
    return () => controller.abort();
  }, []);

  const href =
    identity.state === 'preview' &&
    identity.pullRequestNumber === pullRequestNumber
      ? reviewHref(
          identity.commit,
          changeId,
          prototype,
          pullRequestNumber
        )
      : undefined;
  const Icon =
    prototype.surface === 'mobile-prototype'
      ? Smartphone
      : Monitor;

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-y border-fd-border py-3">
      <span className="inline-flex items-center gap-2 text-sm text-fd-muted-foreground">
        <Icon aria-hidden className="size-4" />
        {surfaceLabels[prototype.surface]}
        <span aria-hidden>·</span>
        {prototype.viewport}
      </span>
      {href ? (
        <a
          aria-label={`Open prototype for ${title}`}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-fd-primary px-3 text-sm font-medium text-fd-primary-foreground no-underline transition hover:opacity-90"
          href={href}
        >
          Open prototype
          <ArrowUpRight aria-hidden className="size-4" />
        </a>
      ) : (
        <span className="text-xs text-fd-muted-foreground">
          {identity.state === 'loading'
            ? 'Checking Preview identity…'
            : 'Open this Change from its exact PR Preview.'}
        </span>
      )}
    </div>
  );
}

function reviewHref(
  headSha: string,
  changeId: string,
  prototype: ChangelogPrototype,
  pullRequestNumber: number
) {
  const params = new URLSearchParams();
  params.set('repository', 'DotNaos/project-space');
  params.set('pr', String(pullRequestNumber));
  params.set('head', headSha);
  params.set('change', changeId);
  params.set(
    'surface',
    prototype.surface === 'mobile-prototype' ? 'native' : 'web'
  );
  params.set('viewport', prototype.viewport);
  return `/prototype-review?${params}`;
}
