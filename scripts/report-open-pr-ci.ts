#!/usr/bin/env bun

import { writeFileSync } from 'node:fs';

export type PullRequestInventoryInput = {
  files: Array<{ path: string }>;
  headRefOid: string;
  isDraft: boolean;
  number: number;
  statusCheckRollup: Array<{
    conclusion?: string;
    name?: string;
    status?: string;
    workflowName?: string;
  }>;
  title: string;
  updatedAt: string;
  url: string;
};

const previewProblemConclusions = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);

export function classifyPullRequest(
  pr: PullRequestInventoryInput,
  generatedAt = new Date(),
) {
  const entryPath = `apps/docs/content/docs/releases/entries/${pr.number}.mdx`;
  const ownsReleaseEntry = pr.files.some(({ path }) => path === entryPath);
  const releaseChecks = [...pr.statusCheckRollup].reverse();
  const releaseCheck = releaseChecks.find(({ name }) => name === 'Release decision') ??
    releaseChecks.find(({ name }) => name === 'Versioned release entry');
  const previewFailures = pr.statusCheckRollup
    .filter(
      (check) =>
        check.workflowName === 'Deploy PR preview' &&
        check.conclusion !== undefined &&
        previewProblemConclusions.has(check.conclusion),
    )
    .map(({ name }) => name ?? 'unnamed Preview check');
  if (pr.isDraft) {
    return {
      classification: 'neutral_draft' as const,
      ownsReleaseEntry,
      previewFailures,
      releaseCheck: releaseCheck?.conclusion ?? 'NOT_PRESENT',
      recommendedAction:
        'Keep neutral until ready; the exact head will declare whether it requests a versioned release.',
    };
  }
  if (releaseCheck?.conclusion === 'SUCCESS') {
    return {
      classification: 'ready_valid' as const,
      ownsReleaseEntry,
      previewFailures,
      releaseCheck: releaseCheck.conclusion,
      recommendedAction: ownsReleaseEntry
        ? 'The requested versioned release is valid for this exact head.'
        : 'This exact head is valid as an ordinary non-release pull request.',
    };
  }
  const ageDays = Math.floor(
    (generatedAt.getTime() - new Date(pr.updatedAt).getTime()) / 86_400_000,
  );
  if (!Number.isFinite(ageDays) || ageDays > 30) {
    return {
      classification: 'ready_needs_owner_decision' as const,
      ownsReleaseEntry,
      previewFailures,
      releaseCheck: releaseCheck?.conclusion ?? 'NOT_PRESENT',
      recommendedAction:
        'Likely inactive: an owner must decide whether to refresh or close it; this report makes neither change.',
    };
  }
  return {
    classification: 'ready_needs_migration' as const,
    ownsReleaseEntry,
    previewFailures,
    releaseCheck: releaseCheck?.conclusion ?? 'NOT_PRESENT',
    recommendedAction:
      'The owning task must reconcile with current main and rerun the trusted release decision for its exact head.',
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await run(['git', 'fetch', '--no-tags', 'origin', 'main']);
  const [baseSha, packageSource, pullRequestsSource] = await Promise.all([
    gitText('rev-parse', 'origin/main^{commit}'),
    gitText('show', 'origin/main:package.json'),
    ghText([
      'pr',
      'list',
      '--repo',
      options.repository,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,isDraft,headRefOid,updatedAt,url,statusCheckRollup,files',
    ]),
  ]);
  const pullRequests = JSON.parse(pullRequestsSource) as PullRequestInventoryInput[];
  const generatedAt = new Date();
  const entries = pullRequests
    .sort((left, right) => right.number - left.number)
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      headSha: pullRequest.headRefOid,
      draft: pullRequest.isDraft,
      updatedAt: pullRequest.updatedAt,
      ...classifyPullRequest(pullRequest, generatedAt),
    }));
  const report = {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    repository: options.repository,
    baseSha,
    baseVersion: (JSON.parse(packageSource) as { version: string }).version,
    mutationPolicy: 'read-only',
    counts: {
      open: entries.length,
      readyValid: entries.filter(({ classification }) => classification === 'ready_valid').length,
      readyNeedsMigration: entries.filter(({ classification }) => classification === 'ready_needs_migration').length,
      readyNeedsOwnerDecision: entries.filter(({ classification }) => classification === 'ready_needs_owner_decision').length,
      neutralDraft: entries.filter(({ classification }) => classification === 'neutral_draft').length,
      previewFailures: entries.reduce((sum, entry) => sum + entry.previewFailures.length, 0),
    },
    pullRequests: entries,
  };
  const output = options.format === 'json' ? JSON.stringify(report, null, 2) : markdown(report);
  if (options.output) writeFileSync(options.output, `${output.trim()}\n`);
  else console.log(output);
}

function markdown(report: {
  generatedAt: string;
  repository: string;
  baseSha: string;
  baseVersion: string;
  counts: Record<string, number>;
  pullRequests: Array<ReturnType<typeof classifyPullRequest> & {
    number: number;
    title: string;
    url: string;
    headSha: string;
    draft: boolean;
    updatedAt: string;
  }>;
}) {
  const lines = [
    '# Open pull request CI inventory',
    '',
    `Generated read-only at ${report.generatedAt} for \`${report.repository}\` against main \`${report.baseSha}\` (v${report.baseVersion}).`,
    '',
    'This report does not edit, ready, close, or replace checks on any pull request. Historical red checks remain historical evidence; only the owning task should prepare a new exact revision.',
    '',
    `Summary: ${report.counts.open} open; ${report.counts.readyValid} ready-valid; ${report.counts.readyNeedsMigration} active ready needing migration; ${report.counts.readyNeedsOwnerDecision} inactive ready needing an owner decision; ${report.counts.neutralDraft} neutral drafts; ${report.counts.previewFailures} current Preview problems.`,
    '',
    '| PR | State | Release request | Exact-head check | Preview failures | Owner action |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const pr of report.pullRequests) {
    lines.push(
      `| [#${pr.number}](${pr.url}) | ${pr.classification} | ${pr.ownsReleaseEntry ? 'versioned' : 'ordinary'} | ${pr.releaseCheck} | ${pr.previewFailures.length ? escapeCell(pr.previewFailures.join(', ')) : 'none'} | ${escapeCell(pr.recommendedAction)} |`,
    );
  }
  return lines.join('\n');
}

function escapeCell(value: string) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) usage();
    values.set(key, value);
  }
  const format = values.get('--format') ?? 'json';
  const output = values.get('--output');
  if (format !== 'json' && format !== 'markdown') usage();
  if (output && !/^docs\/[A-Za-z0-9._/-]+\.md$/.test(output)) {
    throw new Error('--output must be a Markdown file under docs/.');
  }
  return {
    format,
    output,
    repository: values.get('--repository') ?? 'DotNaos/project-space',
  };
}

function usage(): never {
  throw new Error(
    'Usage: bun scripts/report-open-pr-ci.ts [--repository owner/name] [--format json|markdown] [--output docs/file.md]',
  );
}

async function gitText(...args: string[]) {
  return (await run(['git', ...args])).trim();
}

async function ghText(args: string[]) {
  return (await run(['gh', ...args])).trim();
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command.join(' ')} failed.`);
  return stdout;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `Open-PR inventory could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
