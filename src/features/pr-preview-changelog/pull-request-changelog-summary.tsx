import { Disclosure } from '@heroui/react';
import {
  ExternalLink,
  Monitor,
  Smartphone
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  pullRequestChangelogPresentation,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '@/shared/pr-preview-changelog-api';
import {
  pullRequestPrototypeReviewHref,
  pullRequestPrototypeSurfaceLabels
} from '@/shared/pr-preview-changelog-prototypes';
import type { PullRequestChangelogTestTargetsSnapshot } from '@/shared/pr-preview-changelog-test-targets';

export interface PullRequestChangelogSummaryProps {
  className?: string;
  expectedIdentity?: PullRequestChangelogIdentity;
  prototypeTarget?: string;
  selectedChangeId?: string;
  showDocsLink?: boolean;
  snapshot: PullRequestChangelogSnapshot;
  testTargets?: PullRequestChangelogTestTargetsSnapshot;
}

export function PullRequestChangelogSummary({
  className,
  expectedIdentity,
  prototypeTarget,
  selectedChangeId,
  showDocsLink = true,
  snapshot
}: PullRequestChangelogSummaryProps) {
  const presentation = pullRequestChangelogPresentation(
    snapshot,
    expectedIdentity
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
        <ul className="divide-y divide-neutral-800/80">
            {presentation.entries.map((entry) => (
              <li
                className="py-5 first:pt-0 last:pb-0"
                data-selected={
                  entry.id === selectedChangeId || undefined
                }
                id={`change-${entry.id}`}
                key={entry.id}
              >
                <article aria-labelledby={`change-title-${entry.id}`}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
                    Change
                  </p>
                  <h3
                    className="mt-1.5 text-sm font-semibold leading-6 text-neutral-100"
                    id={`change-title-${entry.id}`}
                  >
                    {entry.summary}
                  </h3>
                  <p className="mt-1.5 text-xs leading-5 text-neutral-400">
                    {entry.description}
                  </p>

                  {entry.prototype ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-2 text-xs font-medium text-neutral-400">
                        {entry.prototype.surface ===
                        'mobile-prototype' ? (
                          <Smartphone
                            aria-hidden
                            className="size-3.5"
                          />
                        ) : (
                          <Monitor
                            aria-hidden
                            className="size-3.5"
                          />
                        )}
                        {
                          pullRequestPrototypeSurfaceLabels[
                            entry.prototype.surface
                          ]
                        }
                        <span aria-hidden>·</span>
                        {entry.prototype.viewport}
                      </span>
                      {expectedIdentity ? (
                        <a
                          aria-label={`Open prototype for ${entry.summary}`}
                          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-neutral-100 px-3 text-xs font-semibold text-neutral-950 transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300"
                          href={pullRequestPrototypeReviewHref(
                            expectedIdentity,
                            entry,
                            { target: prototypeTarget }
                          )}
                        >
                          Open prototype
                          <ExternalLink
                            aria-hidden
                            className="size-3.5"
                          />
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  <Disclosure className="mt-4">
                    <Disclosure.Heading>
                      <Disclosure.Trigger className="flex min-h-9 w-full items-center justify-between rounded-md py-1 text-sm text-neutral-400 outline-none transition hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-neutral-500">
                        <span>What to test</span>
                        <span className="flex items-center gap-2 text-xs text-neutral-600">
                          {entry.testing.length}
                          <Disclosure.Indicator className="size-4" />
                        </span>
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <Disclosure.Body className="pb-1 pt-2">
                        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-5 text-neutral-400">
                          {entry.testing.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ul>
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </article>
              </li>
            ))}
          </ul>
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
