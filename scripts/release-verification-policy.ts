#!/usr/bin/env bun

export type ReleaseVerificationInput = {
  baseVersion: string;
  changedPaths: string[];
  eventName: string;
  headVersion: string;
};

export type FastCiSelection = {
  cliDocs: boolean;
  docs: boolean;
  go: boolean;
  mobile: boolean;
  workflow: boolean;
};

const releaseCriticalPaths = [
  /^\.github\/actions\/release-quality\//,
  /^\.github\/workflows\/release(?:-|\.yml)/,
  /^packaging\//,
  /^internal\/approvalsigner\//,
  /^internal\/machineconnect\//,
  /^internal\/selfupdate\//,
  /^server\/connector-/,
  /^scripts\/(?:publish-merged-release|release-handoff-state|release-queue-state)\.ts$/,
  /^tests\/connector-/,
  /^cmd\/project\/connector/,
  /(?:^|\/)[^/]+_(?:darwin|linux|unix|windows)(?:_[^/]*)?\.go$/,
  /\.ps1$/,
  /^(?:go\.mod|go\.sum|bun\.lock)$/,
  /^scripts\/release-verification-policy\.ts$/,
  /^tests\/release-verification-policy\.test\.ts$/,
];

const releaseWorkflowPaths = [
  /^\.github\/actions\/release-quality\//,
  /^\.github\/workflows\/release(?:-|\.yml)/,
  /^cmd\/project\//,
  /^(?:go\.mod|go\.sum|package\.json|bun\.lock)$/,
  /^internal\/(?:approvalsigner|machineconnect|projectrun|selfupdate)\//,
  /^packaging\//,
  /^server\//,
  /^scripts\/(?:ci-preflight|publish-merged-release|release-handoff-state|release-queue-state|release-verification-policy)\.ts$/,
  /^tests\//,
];

export function releaseWorkflowTriggered(changedPaths: string[]) {
  if (changedPaths.length === 0) return true;
  return changedPaths.some((path) =>
    releaseWorkflowPaths.some((pattern) => pattern.test(path)),
  );
}

export function fastCiSelection(
  changedPaths: string[],
  fullMatrix: boolean,
): FastCiSelection {
  if (fullMatrix || changedPaths.length === 0) {
    return {
      cliDocs: true,
      docs: true,
      go: true,
      mobile: true,
      workflow: true,
    };
  }
  return {
    cliDocs: changedPaths.some((path) =>
      /^(?:cmd\/project\/|scripts\/generate-cli-docs\.ts$|docs\/project-cli\.md$|apps\/docs\/(?:generated\/project-cli\.json$|content\/docs\/cli\/))/.test(
        path,
      ),
    ),
    docs: changedPaths.some((path) => /^apps\/docs\//.test(path)),
    go: changedPaths.some((path) =>
      /^(?:cmd\/|internal\/|go\.mod$|go\.sum$)|\.go$/.test(path),
    ),
    mobile: changedPaths.some((path) => /^apps\/mobile\//.test(path)),
    workflow: changedPaths.some((path) =>
      /^(?:\.github\/(?!release-intents\/)|deploy\/|packaging\/|scripts\/.*\.(?:sh|ts)$)/.test(path),
    ),
  };
}

export function releaseVerificationPolicy(input: ReleaseVerificationInput) {
  if (input.eventName !== 'pull_request') {
    return {
      fullMatrix: true,
      reason: 'tags, release candidates, and on-demand runs require every platform',
    };
  }
  if (input.baseVersion !== input.headVersion) {
    const bump = semverBump(input.baseVersion, input.headVersion);
    return {
      fullMatrix: true,
      reason: `${bump ?? 'ambiguous'} version change requires every local extra and the release platform gates`,
    };
  }
  if (input.changedPaths.length === 0) {
    return {
      fullMatrix: true,
      reason: 'ambiguous changed-path set requires every platform',
    };
  }
  const criticalPath = input.changedPaths.find((path) =>
    releaseCriticalPaths.some((pattern) => pattern.test(path)),
  );
  if (criticalPath) {
    return {
      fullMatrix: true,
      reason: `release-critical or platform-specific path changed: ${criticalPath}`,
    };
  }
  return {
    fullMatrix: false,
    reason: 'ordinary pull request keeps the current version and uses changed-path extras',
  };
}

function semverBump(base: string, head: string) {
  const before = parseSemver(base);
  const after = parseSemver(head);
  if (!before || !after) return undefined;
  if (
    after.major === before.major &&
    after.minor === before.minor &&
    after.patch === before.patch + 1
  ) return 'patch';
  if (
    after.major === before.major &&
    after.minor === before.minor + 1 &&
    after.patch === 0
  ) return 'minor';
  if (after.major === before.major + 1 && after.minor === 0 && after.patch === 0) {
    return 'major';
  }
  return 'non-sequential';
}

function parseSemver(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

async function gitText(...args: string[]) {
  const child = Bun.spawn(['git', ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return stdout.trim();
}

async function main() {
  const values = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(
        'Usage: release-verification-policy.ts --event <event> --base <sha> --head <sha>',
      );
    }
    values.set(name, value);
  }
  const eventName = values.get('--event') ?? '';
  let changedPaths: string[] = [];
  let policy;
  if (eventName !== 'pull_request') {
    policy = releaseVerificationPolicy({
      baseVersion: '',
      changedPaths: [],
      eventName,
      headVersion: '',
    });
  } else {
    const base = requireCommit(values.get('--base'), '--base');
    const head = requireCommit(values.get('--head'), '--head');
    const [basePackage, headPackage, changed] = await Promise.all([
      gitText('show', `${base}:package.json`),
      gitText('show', `${head}:package.json`),
      gitText('diff', '--no-renames', '--name-only', base, head),
    ]);
    changedPaths = changed.split('\n').filter(Boolean);
    policy = releaseVerificationPolicy({
      baseVersion: packageVersion(basePackage, 'base'),
      changedPaths,
      eventName,
      headVersion: packageVersion(headPackage, 'head'),
    });
  }
  console.log(JSON.stringify({
    fullMatrix: policy.fullMatrix,
    fastCi: fastCiSelection(changedPaths, policy.fullMatrix),
    mode: policy.fullMatrix ? 'full' : 'patch-fast',
    reason: policy.reason,
  }));
}

function requireCommit(value: string | undefined, name: string) {
  if (!value || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a full lowercase Git commit SHA`);
  }
  return value;
}

function packageVersion(source: string, label: string) {
  const parsed = JSON.parse(source) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`${label} package.json has no string version`);
  }
  return parsed.version;
}

if (import.meta.main) await main();
