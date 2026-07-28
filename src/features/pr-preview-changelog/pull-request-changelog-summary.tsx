import { ExternalLink, FlaskConical } from 'lucide-react';

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

const categoryClasses: Record<PullRequestChangelogCategory, string> = {
  added: 'text-emerald-400',
  changed: 'text-sky-300',
  deprecated: 'text-amber-300',
  fixed: 'text-emerald-400',
  removed: 'text-red-300',
  security: 'text-amber-300'
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
  const testingSteps = Array.from(
    new Set(
      presentation.entries.flatMap((entry) => entry.testing)
    )
  );

  return (
    <section
      aria-label={`Changelog for pull request #${snapshot.pullRequestNumber}`}
      className={cn('min-w-0', className)}
      data-changelog-state={presentation.state}
    >
      {presentation.message ? (
        <p
          className="text-sm leading-6 text-neutral-400"
          role="status"
        >
          {presentation.message}
        </p>
      ) : (
        <>
          <div className="space-y-5">
            {presentation.entries.map((entry) => (
              <article key={entry.id}>
                <p
                  className={cn(
                    'text-[11px] font-semibold uppercase tracking-[0.12em]',
                    categoryClasses[entry.category]
                  )}
                >
                  {categoryLabels[entry.category]}
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-neutral-100">
                  {entry.summary}
                </p>
              </article>
            ))}
          </div>

          <section
            aria-labelledby="pull-request-changelog-testing"
            className="mt-7"
          >
            <h2
              className="flex items-center gap-2 text-xs font-semibold text-neutral-300"
              id="pull-request-changelog-testing"
            >
              <FlaskConical
                aria-hidden
                className="size-3.5 text-neutral-500"
              />
              What to test
            </h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-5 text-neutral-500">
              {testingSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </section>
        </>
      )}

      {presentation.state === 'available' && expectedIdentity ? (
        <PullRequestChangelogTestTargets
          expectedIdentity={expectedIdentity}
          snapshot={testTargets}
        />
      ) : null}

      {presentation.docsHref ? (
        <footer className="mt-6">
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
