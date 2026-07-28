import {
  isPullRequestChangelogIdentity,
  samePullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from './pr-preview-changelog-api';

export const pullRequestChangelogTestTargetsSchema =
  'project-space.pr-preview-changelog-test-targets/v1' as const;

export const pullRequestChangelogDeploymentTargetKinds = [
  'full-preview',
  'mobile-prototype',
  'desktop-prototype'
] as const;

export type PullRequestChangelogDeploymentTargetKind =
  (typeof pullRequestChangelogDeploymentTargetKinds)[number];

export type PullRequestChangelogDeploymentTargetUnavailableReason =
  | 'not-deployed'
  | 'verification-unavailable';

export type PullRequestChangelogDeploymentTarget =
  | {
      headSha: string;
      kind: PullRequestChangelogDeploymentTargetKind;
      state: 'available';
      url: string;
      verifiedAt: string;
    }
  | {
      kind: PullRequestChangelogDeploymentTargetKind;
      reasonCode: PullRequestChangelogDeploymentTargetUnavailableReason;
      state: 'unavailable';
      headSha?: never;
      url?: never;
      verifiedAt?: never;
    };

export interface PullRequestChangelogTestTargetsSnapshot {
  identity: PullRequestChangelogIdentity;
  schema: typeof pullRequestChangelogTestTargetsSchema;
  targets: readonly PullRequestChangelogDeploymentTarget[];
}

export type PullRequestChangelogTestTargetPresentation =
  | {
      href: string;
      kind: PullRequestChangelogDeploymentTargetKind;
      label: string;
      state: 'available';
      verifiedAt: string;
    }
  | {
      detail: string;
      kind:
        | PullRequestChangelogDeploymentTargetKind
        | 'dev-server';
      label: string;
      state: 'unavailable';
    };

const targetLabels: Record<
  PullRequestChangelogDeploymentTargetKind,
  string
> = {
  'desktop-prototype': 'Desktop prototype',
  'full-preview': 'Full Preview',
  'mobile-prototype': 'Mobile prototype'
};

const unavailableDetails: Record<
  PullRequestChangelogDeploymentTargetUnavailableReason,
  string
> = {
  'not-deployed': 'No verified deployment is available.',
  'verification-unavailable':
    'Deployment verification is unavailable.'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
) {
  const allowed = new Set(allowedKeys);
  return (
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isExactIdentity(value: unknown): value is PullRequestChangelogIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'headSha',
      'pullRequestNumber',
      'repositoryFullName'
    ]) &&
    isPullRequestChangelogIdentity(
      value as unknown as PullRequestChangelogIdentity
    )
  );
}

function isDeploymentTargetKind(
  value: unknown
): value is PullRequestChangelogDeploymentTargetKind {
  return pullRequestChangelogDeploymentTargetKinds.some(
    (kind) => kind === value
  );
}

function isVerifiedTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function safePublicDeploymentUrl(
  value: unknown,
  identity: PullRequestChangelogIdentity,
  kind: PullRequestChangelogDeploymentTargetKind
) {
  if (typeof value !== 'string') return undefined;

  try {
    const url = new URL(value);
    const expectedPath: Record<
      PullRequestChangelogDeploymentTargetKind,
      string
    > = {
      'desktop-prototype': '/prototype/desktop/',
      'full-preview': '/',
      'mobile-prototype': '/prototype/mobile/'
    };
    if (
      url.protocol !== 'https:' ||
      url.hostname !==
        `pr-${identity.pullRequestNumber}.projects.os-home.net` ||
      url.pathname !== expectedPath[kind] ||
      url.port ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function unavailableTargets(detail: string) {
  return pullRequestChangelogDeploymentTargetKinds.map(
    (kind): PullRequestChangelogTestTargetPresentation => ({
      detail,
      kind,
      label: targetLabels[kind],
      state: 'unavailable'
    })
  );
}

function parseTargets(
  snapshot: PullRequestChangelogTestTargetsSnapshot
): Map<
  PullRequestChangelogDeploymentTargetKind,
  PullRequestChangelogTestTargetPresentation
> | undefined {
  if (!Array.isArray(snapshot.targets)) return undefined;

  const targets = new Map<
    PullRequestChangelogDeploymentTargetKind,
    PullRequestChangelogTestTargetPresentation
  >();
  for (const candidate of snapshot.targets as readonly unknown[]) {
    if (!isRecord(candidate) || !isDeploymentTargetKind(candidate.kind)) {
      return undefined;
    }
    if (targets.has(candidate.kind)) return undefined;

    if (candidate.state === 'available') {
      if (
        !hasExactKeys(candidate, [
          'headSha',
          'kind',
          'state',
          'url',
          'verifiedAt'
        ])
      ) {
        return undefined;
      }
      const href = safePublicDeploymentUrl(
        candidate.url,
        snapshot.identity,
        candidate.kind
      );
      if (
        !href ||
        !isVerifiedTimestamp(candidate.verifiedAt) ||
        typeof candidate.headSha !== 'string' ||
        candidate.headSha.toLowerCase() !==
          snapshot.identity.headSha.toLowerCase()
      ) {
        return undefined;
      }
      targets.set(candidate.kind, {
        href,
        kind: candidate.kind,
        label: targetLabels[candidate.kind],
        state: 'available',
        verifiedAt: candidate.verifiedAt
      });
      continue;
    }

    if (
      candidate.state !== 'unavailable' ||
      !hasExactKeys(candidate, ['kind', 'reasonCode', 'state']) ||
      (candidate.reasonCode !== 'not-deployed' &&
        candidate.reasonCode !== 'verification-unavailable') ||
      'url' in candidate ||
      'headSha' in candidate ||
      'verifiedAt' in candidate
    ) {
      return undefined;
    }
    targets.set(candidate.kind, {
      detail: unavailableDetails[candidate.reasonCode],
      kind: candidate.kind,
      label: targetLabels[candidate.kind],
      state: 'unavailable'
    });
  }
  return targets;
}

export function pullRequestChangelogTestTargetPresentation(
  expectedIdentity: PullRequestChangelogIdentity,
  snapshot?: PullRequestChangelogTestTargetsSnapshot
): PullRequestChangelogTestTargetPresentation[] {
  let deployments: PullRequestChangelogTestTargetPresentation[];

  if (!snapshot) {
    deployments = unavailableTargets(
      'No verified deployment link was provided to this Preview.'
    );
  } else if (
    !isRecord(snapshot) ||
    !hasExactKeys(snapshot, ['identity', 'schema', 'targets']) ||
    snapshot.schema !== pullRequestChangelogTestTargetsSchema ||
    !isExactIdentity(snapshot.identity) ||
    !samePullRequestChangelogIdentity(
      snapshot.identity,
      expectedIdentity
    )
  ) {
    deployments = unavailableTargets(
      'The deployment links do not match this Preview revision.'
    );
  } else {
    const parsedTargets = parseTargets(snapshot);
    deployments = parsedTargets
      ? pullRequestChangelogDeploymentTargetKinds.map(
          (kind) =>
            parsedTargets.get(kind) ?? {
              detail:
                'No verified deployment link was provided to this Preview.',
              kind,
              label: targetLabels[kind],
              state: 'unavailable' as const
            }
        )
      : unavailableTargets(
          'The deployment-link snapshot could not be verified.'
        );
  }

  return [
    ...deployments,
    {
      detail:
        'Live Dev Server details stay outside the public Preview boundary.',
      kind: 'dev-server',
      label: 'Live Dev Server',
      state: 'unavailable'
    }
  ];
}
