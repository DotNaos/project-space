import { ExternalLink } from 'lucide-react';

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
  const availableTargets = targets.filter(
    (target) => target.state === 'available'
  );
  const unavailableTargets = targets.filter(
    (target) => target.state === 'unavailable'
  );
  const unavailableGroups = Array.from(
    unavailableTargets.reduce((groups, target) => {
      const labels = groups.get(target.detail) ?? [];
      labels.push(target.label);
      groups.set(target.detail, labels);
      return groups;
    }, new Map<string, string[]>())
  );

  return (
    <section
      aria-labelledby="pull-request-changelog-test-targets"
      className="mt-7"
    >
      <h3
        className="text-xs font-semibold text-neutral-300"
        id="pull-request-changelog-test-targets"
      >
        Test targets
      </h3>
      {availableTargets.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {availableTargets.map((target) => (
            <li key={target.kind}>
              <a
                aria-label={`Open ${target.label}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-sky-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
                href={target.href}
              >
                {target.label}
                <ExternalLink aria-hidden className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 space-y-1.5 text-[11px] leading-5 text-neutral-600">
        {unavailableGroups.map(([detail, labels]) => (
          <p key={detail}>
            <span className="text-neutral-500">
              {labels.join(', ')}:
            </span>{' '}
            {detail}
          </p>
        ))}
      </div>
    </section>
  );
}
