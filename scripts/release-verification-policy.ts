#!/usr/bin/env bun

export type ReleaseVerificationInput = {
  baseVersion: string;
  changedPaths: string[];
  eventName: string;
  headVersion: string;
};

const releaseCriticalPaths = [
  /^\.github\/actions\/release-quality\//,
  /^\.github\/workflows\/release(?:-|\.yml)/,
  /^packaging\//,
  /^internal\/approvalsigner\//,
  /^internal\/machineconnect\//,
  /^internal\/selfupdate\//,
  /^server\/connector-/,
  /^tests\/connector-/,
  /^cmd\/project\/connector/,
  /(?:^|\/)[^/]+_(?:darwin|linux|unix|windows)(?:_[^/]*)?\.go$/,
  /\.ps1$/,
  /^(?:go\.mod|go\.sum|bun\.lock)$/,
  /^scripts\/release-verification-policy\.ts$/,
  /^tests\/release-verification-policy\.test\.ts$/,
];

export function releaseVerificationPolicy(input: ReleaseVerificationInput) {
  if (input.eventName !== 'pull_request') {
    return {
      fullMatrix: true,
      reason: 'tags, release candidates, and on-demand runs require every platform',
    };
  }
  const bump = semverBump(input.baseVersion, input.headVersion);
  if (bump !== 'patch') {
    return {
      fullMatrix: true,
      reason: `${bump ?? 'ambiguous'} version change requires every platform`,
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
    reason: 'ordinary patch uses Linux proof plus all shared quality gates',
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
    policy = releaseVerificationPolicy({
      baseVersion: packageVersion(basePackage, 'base'),
      changedPaths: changed.split('\n').filter(Boolean),
      eventName,
      headVersion: packageVersion(headPackage, 'head'),
    });
  }
  console.log(JSON.stringify({
    fullMatrix: policy.fullMatrix,
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
