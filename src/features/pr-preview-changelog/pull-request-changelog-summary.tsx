import { Disclosure } from '@heroui/react';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  pullRequestChangelogPresentation,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '@/shared/pr-preview-changelog-api';
import type { PullRequestChangelogTestTargetsSnapshot } from '@/shared/pr-preview-changelog-test-targets';
import { PullRequestChangelogTestTargets } from './pull-request-changelog-test-targets';

export interface PullRequestChangelogSummaryProps {
  className?: string;
  expectedIdentity?: PullRequestChangelogIdentity;
  showDocsLink?: boolean;
  snapshot: PullRequestChangelogSnapshot;
  testTargets?: PullRequestChangelogTestTargetsSnapshot;
}

export function PullRequestChangelogSummary({
  className,
  expectedIdentity,
  showDocsLink = true,
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
          <ul className="space-y-3">
            {presentation.entries.map((entry) => (
              <li className="flex gap-3" key={entry.id}>
                <span
                  aria-hidden
                  className="mt-[0.6rem] size-1 shrink-0 rounded-full bg-neutral-500"
                />
                <p className="text-sm leading-6 text-neutral-200">
                  {entry.summary}
                </p>
              </li>
            ))}
          </ul>

          <Disclosure className="mt-5">
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex min-h-9 w-full items-center justify-between rounded-md py-1 text-sm text-neutral-400 outline-none transition hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-neutral-500">
                <span>What to test</span>
                <span className="flex items-center gap-2 text-xs text-neutral-600">
                  {testingSteps.length}
                  <Disclosure.Indicator className="size-4" />
                </span>
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="pb-1 pt-2">
                <ul className="list-disc space-y-1.5 pl-5 text-xs leading-5 text-neutral-400">
                  {testingSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
                {expectedIdentity ? (
                  <PullRequestChangelogTestTargets
                    expectedIdentity={expectedIdentity}
                    snapshot={testTargets}
                  />
                ) : null}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        </>
      )}

      {showDocsLink && presentation.docsHref ? (
        <footer className="mt-5">
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
