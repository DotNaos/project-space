import { CircleSlash2, ExternalLink } from 'lucide-react';

import {
  pullRequestChangelogTestTargetPresentation,
  type PullRequestChangelogTestTargetsSnapshot
} from '@/shared/pr-preview-changelog-test-targets';
import type { PullRequestChangelogIdentity } from '@/shared/pr-preview-changelog-api';

export interface PullRequestChangelogTestTargetsProps {
  expectedIdentity: PullRequestChangelogIdentity;
  snapshot?: PullRequestChangelogTestTargetsSnapshot;
}

export function PullRequestChangelogTestTargets({
  expectedIdentity,
  snapshot
}: PullRequestChangelogTestTargetsProps) {
  const targets = pullRequestChangelogTestTargetPresentation(
    expectedIdentity,
    snapshot
  );

  return (
    <section
      aria-labelledby="pull-request-changelog-test-targets"
      className="border-t border-neutral-800/70 px-4 py-3"
    >
      <h3
        className="text-xs font-semibold text-neutral-300"
        id="pull-request-changelog-test-targets"
      >
        Test targets
      </h3>
      <ul className="mt-2 divide-y divide-neutral-900">
        {targets.map((target) => (
          <li
            className="flex min-w-0 items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
            key={target.kind}
          >
            <span className="min-w-0 text-xs font-medium text-neutral-300">
              {target.label}
            </span>
            {target.state === 'available' ? (
              <a
                aria-label={`Open ${target.label}`}
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-sky-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
                href={target.href}
              >
                Open
                <ExternalLink aria-hidden className="size-3" />
              </a>
            ) : (
              <span className="flex min-w-0 items-start gap-1.5 text-right text-[11px] leading-4 text-neutral-600">
                <CircleSlash2
                  aria-hidden
                  className="mt-0.5 size-3 shrink-0"
                />
                {target.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
