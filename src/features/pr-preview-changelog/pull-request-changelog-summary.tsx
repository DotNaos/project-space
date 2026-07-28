import { Chip } from '@heroui/react';
import { BookOpen, ExternalLink, FlaskConical } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  pullRequestChangelogPresentation,
  type PullRequestChangelogCategory,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '@/shared/pr-preview-changelog-api';
import type { PullRequestChangelogTestTargetsSnapshot } from '@/shared/pr-preview-changelog-test-targets';
import { PullRequestChangelogTestTargets } from './pull-request-changelog-test-targets';

const categoryLabels: Record<PullRequestChangelogCategory, string> = {
  added: 'Added',
  changed: 'Changed',
  deprecated: 'Deprecated',
  fixed: 'Fixed',
  removed: 'Removed',
  security: 'Security'
};

const categoryColors: Record<
  PullRequestChangelogCategory,
  'accent' | 'danger' | 'default' | 'success' | 'warning'
> = {
  added: 'success',
  changed: 'accent',
  deprecated: 'warning',
  fixed: 'success',
  removed: 'danger',
  security: 'warning'
};

export interface PullRequestChangelogSummaryProps {
  className?: string;
  expectedIdentity?: PullRequestChangelogIdentity;
  snapshot: PullRequestChangelogSnapshot;
  testTargets?: PullRequestChangelogTestTargetsSnapshot;
}

export function PullRequestChangelogSummary({
  className,
  expectedIdentity,
  snapshot,
  testTargets
}: PullRequestChangelogSummaryProps) {
  const presentation = pullRequestChangelogPresentation(
    snapshot,
    expectedIdentity
  );

  return (
    <section
      aria-label={`Changelog for pull request #${snapshot.pullRequestNumber}`}
      className={cn(
        'min-w-0 border-y border-neutral-800/80 bg-neutral-950/35',
        className
      )}
      data-changelog-state={presentation.state}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpen
              aria-hidden
              className="size-4 shrink-0 text-sky-300"
            />
            <h2 className="truncate text-sm font-semibold text-neutral-100">
              Changelog
            </h2>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            Pull request #{snapshot.pullRequestNumber}
          </p>
        </div>
        {presentation.state === 'available' ? (
          <Chip color="accent" size="sm" variant="soft">
            {presentation.entries.length}{' '}
            {presentation.entries.length === 1 ? 'change' : 'changes'}
          </Chip>
        ) : null}
      </header>

      {presentation.message ? (
        <p
          className="border-t border-neutral-800/70 px-4 py-3 text-sm leading-6 text-neutral-400"
          role="status"
        >
          {presentation.message}
        </p>
      ) : (
        <div className="divide-y divide-neutral-800/70 border-t border-neutral-800/70">
          {presentation.entries.map((entry) => (
            <article className="px-4 py-3" key={entry.id}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Chip
                  color={categoryColors[entry.category]}
                  size="sm"
                  variant="soft"
                >
                  {categoryLabels[entry.category]}
                </Chip>
                <p className="min-w-0 text-sm font-medium leading-5 text-neutral-100">
                  {entry.summary}
                </p>
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                PR #{entry.pullRequestNumber}
                {entry.issueNumber
                  ? ` · Issue #${entry.issueNumber}`
                  : ''}
              </p>
              <div className="mt-3 flex items-start gap-2">
                <FlaskConical
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-neutral-500"
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-neutral-300">
                    What to test
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-neutral-500">
                    {entry.testing.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {presentation.state === 'available' && expectedIdentity ? (
        <PullRequestChangelogTestTargets
          expectedIdentity={expectedIdentity}
          snapshot={testTargets}
        />
      ) : null}

      {presentation.docsHref ? (
        <footer className="border-t border-neutral-800/70 px-4 py-3">
          <a
            className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-sky-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
            href={presentation.docsHref}
          >
            Open complete changelog
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </footer>
      ) : null}
    </section>
  );
}
