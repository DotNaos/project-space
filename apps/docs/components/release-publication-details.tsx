'use client';

import {
  parseReleasePublication,
  publicationMatchesDeployment,
} from '@/lib/releases/publication';
import type {
  PublishedReleaseEntry,
  ReleasePublication,
} from '@/lib/releases/types';
import { useDocsDeploymentIdentity } from './docs-article-identity';
import { canShowPreviewOnly } from '@/lib/releases/presentation';
import {
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  Tag,
} from 'lucide-react';
import { useEffect, useState } from 'react';

type PublicationState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { publication: ReleasePublication; state: 'ready' };

export function ReleasePublicationDetails({
  children,
  entry,
}: {
  children: React.ReactNode;
  entry: PublishedReleaseEntry;
}) {
  const identity = useDocsDeploymentIdentity();
  const [publication, setPublication] =
    useState<PublicationState>({ state: 'loading' });
  const exactPreview = canShowPreviewOnly(entry, identity);

  useEffect(() => {
    if (!identity || identity.state !== 'production') return;
    const controller = new AbortController();
    void fetch(`/docs/api/releases/${entry.version}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('publication unavailable');
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        const result = parseReleasePublication(value, entry.version);
        if (
          !result.ok ||
          !publicationMatchesDeployment(
            result.publication,
            identity,
          )
        ) {
          setPublication({ state: 'unavailable' });
          return;
        }
        setPublication({
          publication: result.publication,
          state: 'ready',
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPublication({ state: 'unavailable' });
        }
      });
    return () => controller.abort();
  }, [entry.version, identity]);

  if (exactPreview && identity?.state === 'preview') {
    return (
      <>
        <ReleaseStatus
          entry={entry}
          status="Preview · Not published"
        />
        {children}
        <ReleaseReferences commit={identity.commit} entry={entry} />
      </>
    );
  }
  if (
    identity?.state === 'production' &&
    publication.state === 'ready'
  ) {
    return (
      <>
        <ReleaseStatus
          entry={entry}
          publication={publication.publication}
          status={publication.publication.status}
        />
        {children}
        <ReleaseReferences
          commit={publication.publication.commit}
          entry={entry}
          publication={publication.publication}
        />
      </>
    );
  }

  return (
    <>
      <div
        aria-live="polite"
        className="mt-3 text-sm text-fd-muted-foreground"
        data-release-publication="unavailable"
      >
        {identity
          ? 'Verified publication details are unavailable.'
          : 'Checking release identity…'}
      </div>
      {children}
      <ReleaseReferences entry={entry} />
    </>
  );
}

function ReleaseStatus({
  entry,
  publication,
  status,
}: {
  entry: PublishedReleaseEntry;
  publication?: ReleasePublication;
  status: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fd-muted-foreground">
      <span>{status}</span>
      <span aria-hidden>·</span>
      <span className="capitalize">{entry.bump} release</span>
      {publication && (
        <>
          <span aria-hidden>·</span>
          <time dateTime={publication.publishedAt}>
            {formatDate(publication.publishedAt)}
          </time>
        </>
      )}
    </div>
  );
}

function ReleaseReferences({
  commit,
  entry,
  publication,
}: {
  commit?: string;
  entry: PublishedReleaseEntry;
  publication?: ReleasePublication;
}) {
  return (
    <ReleaseGridRow label="References">
      <nav
        aria-label={`Links for v${entry.version}`}
        className="flex flex-wrap gap-x-4 gap-y-2 text-sm"
      >
        <MetadataLink
          href={`https://github.com/DotNaos/project-space/pull/${entry.pullRequest}`}
          icon={GitPullRequest}
          label={`PR #${entry.pullRequest}`}
        />
        {entry.issues.map((issue) => (
          <MetadataLink
            key={issue}
            href={`https://github.com/DotNaos/project-space/issues/${issue}`}
            icon={ExternalLink}
            label={`Issue #${issue}`}
          />
        ))}
        {commit && (
          <MetadataLink
            href={`https://github.com/DotNaos/project-space/commit/${commit}`}
            icon={GitCommitHorizontal}
            label={commit.slice(0, 8)}
          />
        )}
        {publication && (
          <>
            <MetadataLink
              href={`https://github.com/DotNaos/project-space/tree/${publication.tag}`}
              icon={Tag}
              label={publication.tag}
            />
            <MetadataLink
              href={publication.githubReleaseUrl}
              icon={ExternalLink}
              label="GitHub Release"
            />
          </>
        )}
      </nav>
    </ReleaseGridRow>
  );
}

function MetadataLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: typeof ExternalLink;
  label: string;
}) {
  return (
    <a
      className="inline-flex items-center gap-1.5 text-fd-muted-foreground no-underline transition hover:text-fd-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-primary"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </a>
  );
}

function ReleaseGridRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="grid gap-3 border-t border-fd-border py-6 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-8">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-fd-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 text-sm leading-7 text-fd-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export { ReleaseGridRow };
