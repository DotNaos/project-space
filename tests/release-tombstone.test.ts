import { describe, expect, test } from 'bun:test';
import {
  parseReleaseTombstone,
  validateReleaseTombstoneDirectoryHistory,
  validateReleaseTombstoneHistory,
  validateReleaseTombstoneProof,
  type TombstoneWorkflowJob,
} from '../scripts/release-tombstone';
import { verifyReleaseTombstoneFromGitHub } from
  '../scripts/release-tombstone-github';
import { tagReservations } from '../scripts/release-queue-evidence';

const sourceCommit = '5bdb794e52f2d2ed15aba0d7e5c5b4a97c322d4e';
const tombstoneSource = JSON.stringify({
  exhaustedRunId: 31593252766,
  reason: 'windows-x64-source-incompatible',
  schema: 'project-space.unpublished-release-tombstone/v1',
  sourceCommit,
  tag: 'v0.21.0',
  verificationRunId: 31595552451,
  workflowSha256: 'b00a6eff42211d8497e6121e642fe0db15c2493d3cdbbb1c10efe55c22c6b052',
});

function job(name: string, conclusion: string): TombstoneWorkflowJob {
  return { conclusion, name, status: 'completed' };
}

const windows = 'Windows x64 machine tools / Build Windows x64 machine tools';
const linux = 'Linux x64 machine tools / Build Linux x64 machine tools';
const exhaustedJobs = [
  job(windows, 'failure'),
  job('Publish GitHub release', 'skipped'),
];
const verificationJobs = [
  job(windows, 'failure'),
  job(linux, 'success'),
  job('macOS arm64 machine tools / Build macOS arm64 runtime', 'success'),
  job(
    'macOS arm64 machine tools / Package verified macOS machine tools',
    'success',
  ),
  job('Cross-platform quality gates', 'success'),
  job('Publish GitHub release', 'skipped'),
];

describe('unpublished immutable release tombstones', () => {
  test('keeps only ordered unpublished semantic tag reservations', () => {
    const targets = new Map([
      ['v0.21.0', sourceCommit],
      ['v0.21.1', '7'.repeat(40)],
    ]);
    expect(tagReservations({
      currentMain: '8'.repeat(40),
      gitOutput: (args) => args[0] === 'tag'
        ? 'v0.20.0\nv0.21.1\ninvalid\nv0.21.0'
        : targets.get(args.at(-1) ?? '') ?? '',
      publishedVersion: '0.20.0',
    })).toEqual([
      { commit: sourceCommit, tag: 'v0.21.0' },
      { commit: '7'.repeat(40), tag: 'v0.21.1' },
    ]);
  });

  test('accepts only the closed tag-bound evidence shape', () => {
    expect(parseReleaseTombstone(tombstoneSource, 'v0.21.0.json')).toEqual({
      exhaustedRunId: 31593252766,
      reason: 'windows-x64-source-incompatible',
      schema: 'project-space.unpublished-release-tombstone/v1',
      sourceCommit,
      tag: 'v0.21.0',
      verificationRunId: 31595552451,
      workflowSha256: 'b00a6eff42211d8497e6121e642fe0db15c2493d3cdbbb1c10efe55c22c6b052',
    });
    for (const value of [
      { ...JSON.parse(tombstoneSource), extra: true },
      { ...JSON.parse(tombstoneSource), tag: 'v0.21.1' },
      { ...JSON.parse(tombstoneSource), reason: 'other' },
      { ...JSON.parse(tombstoneSource), verificationRunId: 31593252766 },
    ]) {
      expect(() => parseReleaseTombstone(
        JSON.stringify(value),
        'v0.21.0.json',
      )).toThrow();
    }
    expect(() => parseReleaseTombstone(
      'x'.repeat(4097),
      'v0.21.0.json',
    )).toThrow('invalid size');
    expect(() => parseReleaseTombstone(
      tombstoneSource,
      'not-a-version.json',
    )).toThrow('invalid filename');
  });

  test('accepts only one immutable add in repository history', () => {
    expect(() => validateReleaseTombstoneHistory({
      commits: [sourceCommit],
      path: '.github/release-tombstones/v0.21.0.json',
      status: 'A\t.github/release-tombstones/v0.21.0.json',
    })).not.toThrow();
    expect(() => validateReleaseTombstoneHistory({
      commits: [sourceCommit, 'a'.repeat(40)],
      path: '.github/release-tombstones/v0.21.0.json',
      status: 'A\t.github/release-tombstones/v0.21.0.json',
    })).toThrow('added once');
    expect(() => validateReleaseTombstoneHistory({
      commits: [sourceCommit],
      path: '.github/release-tombstones/v0.21.0.json',
      status: 'M\t.github/release-tombstones/v0.21.0.json',
    })).toThrow('not added immutably');
    expect(() => validateReleaseTombstoneDirectoryHistory({
      currentPaths: ['.github/release-tombstones/v0.21.0.json'],
      deletedPaths: [],
    })).not.toThrow();
    expect(() => validateReleaseTombstoneDirectoryHistory({
      currentPaths: ['.github/release-tombstones/archive/v0.21.0.json'],
      deletedPaths: [],
    })).toThrow('unexpected path');
    expect(() => validateReleaseTombstoneDirectoryHistory({
      currentPaths: [],
      deletedPaths: ['.github/release-tombstones/v0.21.0.json'],
    })).toThrow('contains a deletion');
  });

  test('requires the exact exhausted and representative failed runs', () => {
    const tombstone = parseReleaseTombstone(
      tombstoneSource,
      'v0.21.0.json',
    );
    const exhaustedRun = {
      conclusion: 'failure',
      displayTitle: 'Release v0.21.0',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: sourceCommit,
      id: 31593252766,
      runAttempt: 2,
      status: 'completed',
      workflowPath: '.github/workflows/release.yml',
      workflowSha256: 'b00a6eff42211d8497e6121e642fe0db15c2493d3cdbbb1c10efe55c22c6b052',
    };
    const verificationRun = {
      ...exhaustedRun,
      id: 31595552451,
      runAttempt: 1,
    };
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun,
      releaseState: 'missing',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs,
      verificationRun,
    })).not.toThrow();
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun: { ...exhaustedRun, runAttempt: 1 },
      releaseState: 'missing',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs,
      verificationRun,
    })).toThrow('exhausted automatic retry');
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun: { ...exhaustedRun, runAttempt: 3 },
      releaseState: 'missing',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs,
      verificationRun,
    })).toThrow('exhausted automatic retry');
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun,
      releaseState: 'published',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs,
      verificationRun,
    })).toThrow('already has GitHub Release state published');
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun,
      releaseState: 'missing',
      tagCommit: 'a'.repeat(40),
      tombstone,
      verificationJobs,
      verificationRun,
    })).toThrow('no longer points at its exact source');
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun,
      releaseState: 'missing',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs: verificationJobs.filter((entry) =>
        entry.name !== 'Cross-platform quality gates'
      ),
      verificationRun,
    })).toThrow('Cross-platform quality gates');
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun: { ...exhaustedRun, headSha: 'a'.repeat(40) },
      releaseState: 'missing',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs,
      verificationRun,
    })).toThrow('invalid workflow evidence');
    expect(() => validateReleaseTombstoneProof({
      exhaustedJobs,
      exhaustedRun,
      releaseState: 'missing',
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs: [
        ...verificationJobs,
        job('Publish GitHub release', 'success'),
      ],
      verificationRun,
    })).toThrow('Publish GitHub release');
  });

  test('accepts only matching cross-platform packaging incompatibility evidence', () => {
    const tombstone = parseReleaseTombstone(JSON.stringify({
      ...JSON.parse(tombstoneSource),
      reason: 'cross-platform-packaging-check-source-incompatible',
    }), 'v0.21.0.json');
    const exhaustedRun = {
      conclusion: 'failure',
      displayTitle: 'Release v0.21.0',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: sourceCommit,
      id: tombstone.exhaustedRunId,
      runAttempt: 2,
      status: 'completed',
      workflowPath: '.github/workflows/release.yml',
      workflowSha256: tombstone.workflowSha256,
    };
    const verificationRun = {
      ...exhaustedRun,
      headSha: '7'.repeat(40),
      id: tombstone.verificationRunId,
      runAttempt: 1,
    };
    const packagingFailures = [
      job(windows, 'failure'),
      job(linux, 'failure'),
      job('macOS arm64 machine tools / Build macOS arm64 runtime', 'success'),
      job(
        'macOS arm64 machine tools / Package verified macOS machine tools',
        'success',
      ),
      job('Cross-platform quality gates', 'success'),
      job('Publish GitHub release', 'skipped'),
    ];
    const verifiedFailures = verificationJobs.map((entry) =>
      entry.name === linux ? job(linux, 'failure') : entry
    );
    const input = {
      exhaustedJobs: packagingFailures,
      exhaustedRun,
      releaseState: 'missing' as const,
      tagCommit: sourceCommit,
      tombstone,
      verificationJobs: verifiedFailures,
      verificationRun,
    };
    expect(() => validateReleaseTombstoneProof(input)).not.toThrow();
    expect(() => validateReleaseTombstoneProof({
      ...input,
      verificationJobs,
    })).toThrow(linux);
    expect(() => validateReleaseTombstoneProof({
      ...input,
      exhaustedJobs: exhaustedJobs,
    })).toThrow(linux);
  });

  test('loads and projects only the required live GitHub evidence', async () => {
    const tombstone = parseReleaseTombstone(
      tombstoneSource,
      'v0.21.0.json',
    );
    const verificationCommit = '7'.repeat(40);
    const workflow = 'name: Release\non:\n  workflow_dispatch:\n';
    const workflowSha256 = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(workflow),
    ).then((value) => Buffer.from(value).toString('hex'));
    const run = (id: number, runAttempt: number, headSha: string) => ({
      conclusion: 'failure',
      display_title: 'Release v0.21.0',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: headSha,
      id,
      run_attempt: runAttempt,
      status: 'completed',
      path: '.github/workflows/release.yml',
    });
    const routes = new Map<string, unknown>([
      [`/actions/runs/${tombstone.exhaustedRunId}/attempts/2`,
        run(tombstone.exhaustedRunId, 2, sourceCommit)],
      [`/actions/runs/${tombstone.exhaustedRunId}/attempts/2/jobs?per_page=100`, {
        jobs: exhaustedJobs,
        total_count: exhaustedJobs.length,
      }],
      [`/actions/runs/${tombstone.verificationRunId}/attempts/1`,
        run(tombstone.verificationRunId, 1, verificationCommit)],
      [`/actions/runs/${tombstone.verificationRunId}/attempts/1/jobs?per_page=100`, {
        jobs: verificationJobs,
        total_count: verificationJobs.length,
      }],
      [`/git/ref/tags/${tombstone.tag}`, {
        object: { sha: sourceCommit, type: 'commit' },
      }],
      [`/contents/.github/workflows/release.yml?ref=${sourceCommit}`, {
        content: Buffer.from(workflow).toString('base64'),
        encoding: 'base64',
      }],
      [`/contents/.github/workflows/release.yml?ref=${verificationCommit}`, {
        content: Buffer.from(workflow).toString('base64'),
        encoding: 'base64',
      }],
    ]);
    tombstone.workflowSha256 = workflowSha256;
    const requested: string[] = [];
    await expect(verifyReleaseTombstoneFromGitHub(
      tombstone,
      async (path) => {
        requested.push(path);
        if (path === `/releases/tags/${tombstone.tag}`) {
          return new Response('{}', { status: 404 });
        }
        const body = routes.get(path);
        if (body === undefined) return new Response('{}', { status: 404 });
        return Response.json(body);
      },
    )).resolves.toBeUndefined();
    expect(requested.sort()).toEqual([
      `/actions/runs/${tombstone.exhaustedRunId}/attempts/2`,
      `/actions/runs/${tombstone.exhaustedRunId}/attempts/2/jobs?per_page=100`,
      `/actions/runs/${tombstone.verificationRunId}/attempts/1`,
      `/actions/runs/${tombstone.verificationRunId}/attempts/1/jobs?per_page=100`,
      `/git/ref/tags/${tombstone.tag}`,
      `/contents/.github/workflows/release.yml?ref=${sourceCommit}`,
      `/contents/.github/workflows/release.yml?ref=${verificationCommit}`,
      `/releases/tags/${tombstone.tag}`,
    ].sort());
  });
});
