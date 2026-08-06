#!/usr/bin/env bun

import { readdirSync } from 'node:fs';
import { platform } from 'node:os';
import {
  fastCiSelection,
  releaseVerificationPolicy,
} from './release-verification-policy';

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

export function preflightPlan(input: {
  changedPaths: string[];
  fullMatrix: boolean;
  host: NodeJS.Platform;
  pullRequest?: number;
  version: string;
}) {
  const selection = fastCiSelection(input.changedPaths, input.fullMatrix);
  const lanes: PreflightLane[] = [
    { id: 'diff-hygiene', command: ['git', 'diff', '--check'] },
    { id: 'package-manager-policy', command: ['bun', 'run', 'check:package-manager'] },
    { id: 'locked-root-dependencies', command: ['bun', 'install', '--frozen-lockfile'] },
    {
      id: 'release-entry',
      command: input.pullRequest
        ? [
            'bun',
            'scripts/validate-release-pr.ts',
            '--pull-request',
            String(input.pullRequest),
          ]
        : ['bun', 'run', 'docs:release:check'],
    },
    { id: 'tests', command: ['bun', 'test', '--isolate'] },
    { id: 'web-build', command: ['bun', 'run', 'build:web'] },
  ];

  if (selection.cliDocs) {
    lanes.push(
      { id: 'generated-cli-docs', command: ['bun', 'run', 'docs:cli:check'] },
      {
        id: 'cli-docs-contract',
        command: [
          'go',
          'test',
          './cmd/project',
          '-run',
          'CLIDocs|RootCommandIncludesExpectedCommands',
        ],
      },
    );
  }
  if (selection.docs) {
    lanes.push(
      {
        id: 'docs-dependencies',
        command: ['bun', 'install', '--frozen-lockfile'],
        reason: 'working-directory=apps/docs',
      },
      {
        id: 'docs-typecheck',
        command: ['bun', 'run', 'typecheck'],
        reason: 'working-directory=apps/docs',
      },
      {
        id: 'docs-build',
        command: ['bun', 'run', 'build'],
        reason: 'working-directory=apps/docs',
      },
    );
  }
  if (selection.mobile) {
    lanes.push(
      {
        id: 'mobile-dependencies',
        command: ['bun', 'install', '--frozen-lockfile'],
        reason: 'working-directory=apps/mobile',
      },
      {
        id: 'mobile-build',
        command: ['bun', 'run', 'build:prototype'],
        reason: 'working-directory=apps/mobile',
      },
    );
  }
  if (selection.go) {
    lanes.push(
      { id: 'go-race', command: ['go', 'test', '-race', './...'] },
      { id: 'go-vet', command: ['go', 'vet', './...'] },
    );
  }
  if (selection.workflow) {
    lanes.push({
      id: 'actionlint',
      command: [
        'go',
        'run',
        'github.com/rhysd/actionlint/cmd/actionlint@v1.7.7',
        ...workflowFiles(),
      ],
    });
    lanes.push({ id: 'shell-syntax', command: ['bash', '-n', ...trackedShellScripts()] });
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

function remote(id: string, reason: string): PreflightLane {
  return { id, reason, remoteOnly: true };
}

function trackedShellScripts() {
  return readdirRecursive('.')
    .filter((path) => path.endsWith('.sh'))
    .filter((path) => !path.includes('/node_modules/') && !path.startsWith('./.git/'))
    .map((path) => path.replace(/^\.\//, ''))
    .sort();
}

function workflowFiles() {
  return readdirSync('.github/workflows')
    .filter((path) => path.endsWith('.yml') || path.endsWith('.yaml'))
    .map((path) => `.github/workflows/${path}`)
    .sort();
}

function readdirRecursive(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') return [];
      return readdirRecursive(path);
    }
    return entry.isFile() ? [path] : [];
  });
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
  const lanes = preflightPlan({
    changedPaths,
    fullMatrix: classification.fullMatrix,
    host: platform(),
    pullRequest: options.pullRequest,
    version: headVersion,
  });
  const results: LaneResult[] = [];
  for (const lane of lanes) {
    if (lane.remoteOnly) {
      results.push({ ...lane, durationMs: 0, exitCode: null, status: 'remote-only' });
      continue;
    }
    const result = await runLane(lane, baseSha, headSha);
    results.push(result);
  }
  const conclusion = results.some((lane) => lane.status === 'failed')
    ? 'failed'
    : 'passed-local';
  const report = {
    schemaVersion: 1,
    baseSha,
    headSha,
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

async function runLane(lane: PreflightLane, baseSha: string, headSha: string) {
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
  const workingDirectory = lane.reason?.includes('apps/docs')
    ? 'apps/docs'
    : lane.reason?.includes('apps/mobile')
      ? 'apps/mobile'
      : '.';
  const actualCommand =
    lane.id === 'diff-hygiene'
      ? ['git', 'diff', '--check', `${baseSha}...${headSha}`]
      : command;
  const display = actualCommand.join(' ');
  console.error(`\n[ci:preflight] ${lane.id}: ${display}`);
  const started = performance.now();
  const child = Bun.spawn(actualCommand, {
    cwd: workingDirectory,
    env:
      lane.id === 'release-entry'
        ? {
            ...process.env,
            RELEASE_BASE_SHA: baseSha,
            RELEASE_HEAD_SHA: headSha,
          }
        : process.env,
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
