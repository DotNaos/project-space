#!/usr/bin/env bun

import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fastCiSelection,
  releaseVerificationPolicy,
} from './release-verification-policy';
import { sharedCheckCommand } from './quality-checks';

export type PreflightLane = {
  command?: string[];
  id: string;
  reason?: string;
  remoteOnly?: boolean;
};

type LaneResult = PreflightLane & {
  durationMs: number;
  exitCode: number | null;
  status: 'failed' | 'passed' | 'remote-only';
};

type Options = {
  base: string;
  format: 'json' | 'text';
  head: string;
  pullRequest?: number;
};

const GIBIBYTE = 1024 ** 3;
const MINIMUM_FAST_MATRIX_FREE_BYTES = 2 * GIBIBYTE;
const MINIMUM_FULL_MATRIX_FREE_BYTES = 5 * GIBIBYTE;

export function preflightPlan(input: {
  changedPaths: string[];
  fullMatrix: boolean;
  host: NodeJS.Platform;
  pullRequest?: number;
  version: string;
}) {
  const selection = fastCiSelection(input.changedPaths, input.fullMatrix);
  const lanes: PreflightLane[] = [
    { id: 'diff-hygiene', command: sharedCheckCommand('diff-hygiene') },
    { id: 'package-manager-policy', command: sharedCheckCommand('package-manager-policy') },
    { id: 'docs-specs', command: sharedCheckCommand('docs-specs') },
    { id: 'locked-root-dependencies', command: sharedCheckCommand('locked-root-dependencies') },
    {
      id: 'changelog',
      command: input.pullRequest
        ? [
            'bun',
            'scripts/validate-release-pr.ts',
            '--pull-request',
            String(input.pullRequest),
          ]
        : ['bun', 'run', 'docs:release:check'],
    },
    { id: 'tests', command: sharedCheckCommand('tests') },
    { id: 'web-build', command: sharedCheckCommand('web-build') },
  ];

  if (selection.cliDocs) {
    lanes.push(
      { id: 'generated-cli-docs', command: sharedCheckCommand('generated-cli-docs') },
      {
        id: 'cli-docs-contract',
        command: sharedCheckCommand('cli-docs-contract'),
      },
    );
  }
  if (selection.docs) {
    lanes.push(
      {
        id: 'docs-dependencies',
        command: sharedCheckCommand('docs-dependencies'),
      },
      {
        id: 'docs-typecheck',
        command: sharedCheckCommand('docs-typecheck'),
      },
      {
        id: 'docs-build',
        command: sharedCheckCommand('docs-build'),
      },
    );
  }
  if (selection.mobile) {
    lanes.push(
      {
        id: 'mobile-dependencies',
        command: sharedCheckCommand('mobile-dependencies'),
      },
      {
        id: 'mobile-build',
        command: sharedCheckCommand('mobile-build'),
      },
    );
  }
  if (selection.go) {
    lanes.push(
      { id: 'go-race', command: sharedCheckCommand('go-race') },
      { id: 'go-vet', command: sharedCheckCommand('go-vet') },
    );
  }
  if (selection.rust) {
    lanes.push(
      { id: 'rust-format', command: sharedCheckCommand('rust-format') },
      { id: 'rust-clippy', command: sharedCheckCommand('rust-clippy') },
      { id: 'rust-tests', command: sharedCheckCommand('rust-tests') },
    );
  }
  if (selection.workflow) {
    lanes.push({ id: 'actionlint', command: sharedCheckCommand('actionlint') });
    lanes.push({ id: 'shell-syntax', command: sharedCheckCommand('shell-syntax') });
  }
  if (input.fullMatrix && input.host === 'darwin') {
    lanes.push({
      id: 'macos-packaging',
      command: ['packaging/macos/test-release-packaging.sh', input.version],
    });
  } else if (input.fullMatrix) {
    lanes.push(remote('macos-packaging', 'requires a macOS runner'));
  }
  lanes.push({
    id: 'post-run-cleanliness',
    command: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
  });
  lanes.push(
    remote('linux-release-artifact', 'requires the isolated Linux release runner and trust-root artifact receipt'),
    remote('windows-release-artifact', 'requires Windows, Inno Setup, and WinGet validation'),
    remote('signing-and-publication', 'requires protected signing identities, artifacts, and GitHub environments'),
    remote('preview-and-production', 'requires protected Preview/VPS credentials, exact remote identity, TLS, capacity, rollback, and health proof'),
  );
  return lanes;
}

export function preflightCapacity(input: {
  fullMatrix: boolean;
  temporaryAvailableBytes: number;
  worktreeAvailableBytes: number;
}) {
  const requiredBytes = input.fullMatrix
    ? MINIMUM_FULL_MATRIX_FREE_BYTES
    : MINIMUM_FAST_MATRIX_FREE_BYTES;
  const availableBytes = Math.min(
    input.temporaryAvailableBytes,
    input.worktreeAvailableBytes,
  );
  return { availableBytes, requiredBytes, sufficient: availableBytes >= requiredBytes };
}

export function preflightTemporaryParent(
  host: NodeJS.Platform,
  systemTemporaryDirectory: string,
) {
  return host === 'darwin' ? '/tmp' : systemTemporaryDirectory;
}

export function preflightLaneEnvironment(input: {
  baseSha: string;
  environment: NodeJS.ProcessEnv;
  headSha: string;
  laneId: string;
  temporaryRoot: string;
}) {
  const environment = {
    ...input.environment,
    GOTMPDIR: input.temporaryRoot,
    TEMP: input.temporaryRoot,
    TMP: input.temporaryRoot,
    TMPDIR: input.temporaryRoot,
  };
  if (input.laneId.startsWith('rust-')) {
    return {
      ...environment,
      CARGO_TARGET_DIR: join(input.temporaryRoot, 'cargo-target'),
    };
  }
  if (input.laneId === 'changelog') {
    return {
      ...environment,
      RELEASE_BASE_SHA: input.baseSha,
      RELEASE_HEAD_SHA: input.headSha,
    };
  }
  if (input.laneId === 'docs-specs') {
    return { ...environment, DOCS_SPECS_BASE: input.baseSha };
  }
  if (input.laneId === 'diff-hygiene') {
    return {
      ...environment,
      CI_CHECK_DIFF_RANGE: `${input.baseSha}...${input.headSha}`,
    };
  }
  return environment;
}

function remote(id: string, reason: string): PreflightLane {
  return { id, reason, remoteOnly: true };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const baseSha = await gitText('rev-parse', `${options.base}^{commit}`);
  const headSha = await gitText('rev-parse', `${options.head}^{commit}`);
  const checkoutSha = await gitText('rev-parse', 'HEAD^{commit}');
  if (headSha !== checkoutSha) {
    throw new Error(
      `Requested head ${headSha} is not the checked-out HEAD ${checkoutSha}; preflight refuses to name an untested revision.`,
    );
  }
  const status = await gitText('status', '--porcelain=v1', '--untracked-files=all');
  if (status) {
    throw new Error(
      'CI preflight requires a clean worktree so its head SHA names the exact tested revision.',
    );
  }
  const [basePackage, headPackage, changed] = await Promise.all([
    gitText('show', `${baseSha}:package.json`),
    gitText('show', `${headSha}:package.json`),
    gitText('diff', '--no-renames', '--name-only', baseSha, headSha),
  ]);
  const changedPaths = changed.split('\n').filter(Boolean);
  const headVersion = packageVersion(headPackage);
  const classification = releaseVerificationPolicy({
    baseVersion: packageVersion(basePackage),
    changedPaths,
    eventName: 'pull_request',
    headVersion,
  });
  const capacity = currentPreflightCapacity(classification.fullMatrix);
  if (!capacity.sufficient) {
    throw new Error(
      `CI preflight needs at least ${formatBytes(capacity.requiredBytes)} free on both the worktree and temporary filesystems; only ${formatBytes(capacity.availableBytes)} is available. No test, install, build, or cache cleanup was started.`,
    );
  }
  const lanes = preflightPlan({
    changedPaths,
    fullMatrix: classification.fullMatrix,
    host: platform(),
    pullRequest: options.pullRequest,
    version: headVersion,
  });
  const results: LaneResult[] = [];
  const temporaryRoot = mkdtempSync(
    join(preflightTemporaryParent(platform(), tmpdir()), 'ps-ci-'),
  );
  try {
    for (const lane of lanes) {
      if (lane.remoteOnly) {
        results.push({ ...lane, durationMs: 0, exitCode: null, status: 'remote-only' });
        continue;
      }
      const result = await runLane(lane, baseSha, headSha, temporaryRoot);
      results.push(result);
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
  const conclusion = results.some((lane) => lane.status === 'failed')
    ? 'failed'
    : 'passed-local';
  const report = {
    schemaVersion: 1,
    baseSha,
    headSha,
    capacity,
    changedPaths,
    classification: {
      fastCi: fastCiSelection(changedPaths, classification.fullMatrix),
      fullMatrix: classification.fullMatrix,
      mode: classification.fullMatrix ? 'full' : 'patch-fast',
      reason: classification.reason,
    },
    lanes: results,
    conclusion,
  };
  if (options.format === 'json') console.log(JSON.stringify(report));
  else printText(report);
  if (conclusion === 'failed') process.exit(1);
}

async function runLane(
  lane: PreflightLane,
  baseSha: string,
  headSha: string,
  temporaryRoot: string,
) {
  if (lane.id === 'post-run-cleanliness') {
    const started = performance.now();
    const status = await gitText('status', '--porcelain=v1', '--untracked-files=all');
    if (status) {
      console.error(`\n[ci:preflight] generated files or edits remain after local lanes:\n${status}`);
    }
    return {
      ...lane,
      durationMs: Math.round(performance.now() - started),
      exitCode: status ? 1 : 0,
      reason: status ? 'local lanes left generated files or edits in the worktree' : undefined,
      status: status ? 'failed' : 'passed',
    } as LaneResult;
  }
  const command = lane.command!;
  const actualCommand = command;
  const display = actualCommand.join(' ');
  console.error(`\n[ci:preflight] ${lane.id}: ${display}`);
  const started = performance.now();
  const child = Bun.spawn(actualCommand, {
    cwd: '.',
    env: preflightLaneEnvironment({
      baseSha,
      environment: process.env,
      headSha,
      laneId: lane.id,
      temporaryRoot,
    }),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stdout) process.stderr.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return {
    ...lane,
    command: actualCommand,
    durationMs: Math.round(performance.now() - started),
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
  } as LaneResult;
}

function currentPreflightCapacity(fullMatrix: boolean) {
  const temporaryParent = preflightTemporaryParent(platform(), tmpdir());
  return preflightCapacity({
    fullMatrix,
    temporaryAvailableBytes: availableBytes(temporaryParent),
    worktreeAvailableBytes: availableBytes('.'),
  });
}

function availableBytes(path: string) {
  const filesystem = statfsSync(path);
  return filesystem.bavail * filesystem.bsize;
}

function formatBytes(bytes: number) {
  return `${(bytes / GIBIBYTE).toFixed(1)} GiB`;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) usage();
    values.set(key, value);
  }
  const format = values.get('--format') ?? 'text';
  const rawPr = values.get('--pull-request');
  const pullRequest = rawPr === undefined ? undefined : Number(rawPr);
  if (format !== 'json' && format !== 'text') usage();
  if (pullRequest !== undefined && (!Number.isSafeInteger(pullRequest) || pullRequest <= 0)) usage();
  return {
    base: values.get('--base') ?? 'origin/main',
    format,
    head: values.get('--head') ?? 'HEAD',
    pullRequest,
  };
}

function usage(): never {
  throw new Error(
    'Usage: bun run ci:preflight --base <ref> [--head HEAD] [--pull-request <number>] [--format json|text]',
  );
}

function packageVersion(source: string) {
  const parsed = JSON.parse(source) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error('package.json version is invalid.');
  return parsed.version;
}

function printText(report: {
  baseSha: string;
  headSha: string;
  classification: { mode: string; reason: string };
  lanes: LaneResult[];
  conclusion: string;
}) {
  console.log(`CI preflight ${report.conclusion}: ${report.headSha} against ${report.baseSha}`);
  console.log(`Matrix: ${report.classification.mode} — ${report.classification.reason}`);
  for (const lane of report.lanes) {
    console.log(`- ${lane.id}: ${lane.status}${lane.reason ? ` (${lane.reason})` : ''}`);
  }
}

async function gitText(...args: string[]) {
  const child = Bun.spawn(['git', ...args], { stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(' ')} failed.`);
  return stdout.trim();
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const formatIndex = process.argv.indexOf('--format');
    const json = formatIndex >= 0 && process.argv[formatIndex + 1] === 'json';
    if (json) {
      console.log(JSON.stringify({ schemaVersion: 1, conclusion: 'refused', errors: [message] }));
    } else {
      console.error(`CI preflight could not run: ${message}`);
    }
    process.exit(2);
  }
}
