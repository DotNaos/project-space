import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  correlatePullRequestPreviews,
  getPullRequestPreviewStatus,
  sanitizePullRequestPreview,
  withUndeployedOpenPullRequests
} from '../server/pull-request-preview-status';

const requestedSha = 'a'.repeat(40);
const runningSha = 'b'.repeat(40);

describe('pull request Preview status adapter', () => {
  test('allows a public link only with full requested and running SHA evidence', () => {
    expect(sanitizePullRequestPreview({
      liveUrl: 'https://pr-263.projects.os-home.net',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      runningSha,
      state: 'ready'
    }, 'DotNaos/project-space')).toMatchObject({
      liveUrl: 'https://pr-263.projects.os-home.net/',
      liveUrlState: 'available',
      requestedSha,
      runningSha,
      state: 'ready'
    });

    expect(sanitizePullRequestPreview({
      liveUrl: 'https://pr-263.projects.os-home.net',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      state: 'ready'
    }, 'DotNaos/project-space')).toMatchObject({
      liveUrl: undefined,
      liveUrlState: 'withheld'
    });
  });

  test('exposes the prototype only with a healthy exact-head receipt', () => {
    expect(sanitizePullRequestPreview({
      prototypeHealthy: true,
      prototypeMetaSha: runningSha,
      prototypeUrl: 'https://pr-263.projects.os-home.net/prototype/desktop/',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      runningSha,
      state: 'ready'
    }, 'DotNaos/project-space')).toMatchObject({
      prototypeHealthy: true,
      prototypeMetaSha: runningSha,
      prototypeUrl: 'https://pr-263.projects.os-home.net/prototype/desktop/',
      prototypeUrlState: 'available'
    });

    expect(sanitizePullRequestPreview({
      prototypeHealthy: true,
      prototypeMetaSha: requestedSha,
      prototypeUrl: 'https://pr-263.projects.os-home.net/prototype/desktop/',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      runningSha,
      state: 'ready'
    }, 'DotNaos/project-space')).toMatchObject({
      prototypeUrl: undefined,
      prototypeUrlState: 'withheld'
    });
  });

  test('accepts removed and absent tombstones without a SHA but never a link', () => {
    for (const state of ['removed', 'absent']) {
      expect(sanitizePullRequestPreview({
        liveUrl: 'https://pr-263.projects.os-home.net',
        pullRequestNumber: 263,
        repositoryFullName: 'DotNaos/project-space',
        state
      }, 'DotNaos/project-space')).toMatchObject({
        liveUrl: undefined,
        liveUrlState: 'withheld',
        requestedSha: undefined,
        state: 'removed'
      });
    }
  });

  test('accepts an exact-head capacity block without exposing a link', () => {
    expect(sanitizePullRequestPreview({
      errorCode: 'preview_quota_full',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      state: 'blocked_capacity'
    }, 'DotNaos/project-space')).toMatchObject({
      liveUrl: undefined,
      liveUrlState: 'not-configured',
      requestedSha,
      state: 'blocked-capacity'
    });
  });

  test('treats blank optional running SHA fields as absent', () => {
    expect(sanitizePullRequestPreview({
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      runningSha: '',
      state: 'ready'
    }, 'DotNaos/project-space')).toMatchObject({
      requestedSha,
      runningSha: undefined,
      state: 'ready'
    });
  });

  test('rejects active records with missing or malformed identity evidence', () => {
    for (const record of [
      { pullRequestNumber: 263, repositoryFullName: 'DotNaos/project-space', state: 'ready' },
      { pullRequestNumber: 263, repositoryFullName: 'DotNaos/project-space', requestedSha: 'abc123', state: 'deploying' },
      { pullRequestNumber: 263, repositoryFullName: 'DotNaos/project-space', requestedSha, runningSha: 'bad', state: 'ready' },
      { pullRequestNumber: 263, repositoryFullName: 'someone/private', requestedSha, state: 'deploying' }
    ]) {
      expect(sanitizePullRequestPreview(record, 'DotNaos/project-space')).toBeUndefined();
    }
  });

  test('withholds unsafe URLs without returning their values', () => {
    for (const liveUrl of [
      'http://pr-263.projects.os-home.net',
      'https://user:secret@pr-263.projects.os-home.net',
      'https://localhost',
      'https://10.0.0.1',
      'https://evil.example',
      'https://pr-263.projects.os-home.net/unexpected',
      'https://pr-263.projects.os-home.net:4443/',
      'https://pr-263.projects.os-home.net/?token=secret'
    ]) {
      const result = sanitizePullRequestPreview({
        liveUrl,
        pullRequestNumber: 263,
        repositoryFullName: 'DotNaos/project-space',
        requestedSha,
        runningSha,
        state: 'ready'
      }, 'DotNaos/project-space');
      expect(result).toMatchObject({ liveUrl: undefined, liveUrlState: 'withheld' });
      expect(JSON.stringify(result)).not.toContain(liveUrl);
    }
  });

  test('exposes only bounded lease, storage, and failure evidence', () => {
    const result = sanitizePullRequestPreview({
      activityLeaseExpiresAt: '2026-07-31T10:00:00Z',
      lastActivityAt: '2026-07-31T09:00:00Z',
      message: 'Runtime health failed.',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      safeStorageBytes: 1024,
      state: 'failed'
    }, 'DotNaos/project-space');
    expect(result).toMatchObject({
      activeLeaseExpiresAt: '2026-07-31T10:00:00.000Z',
      lastActivityAt: '2026-07-31T09:00:00.000Z',
      message: 'Runtime health failed.',
      safeStorageBytes: 1024,
      state: 'failed'
    });
    expect(sanitizePullRequestPreview({
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      safeStorageBytes: Number.MAX_SAFE_INTEGER,
      state: 'ready'
    }, 'DotNaos/project-space')).toMatchObject({ safeStorageBytes: undefined });
  });

  test('binds correlated pull request links to the exact GitHub identity', () => {
    const result = {
      checkedAt: '2026-07-22T10:00:00.000Z',
      previews: [{
        liveUrlState: 'not-configured' as const,
        pullRequestNumber: 263,
        repositoryFullName: 'DotNaos/project-space',
        requestedSha,
        state: 'deploying' as const
      }],
      repositoryFullName: 'DotNaos/project-space',
      status: 'available' as const
    };
    const details = {
      branches: [],
      checkedAt: result.checkedAt,
      issues: [],
      pullRequests: [{
        headSha: requestedSha,
        linkedIssueNumbers: [381],
        number: 263,
        state: 'open' as const,
        title: 'Preview deployments',
        url: 'https://evil.example/pull/263'
      }],
      status: 'connected' as const
    };
    expect(correlatePullRequestPreviews(result, details).previews[0]?.linkedIssueNumbers)
      .toEqual([381]);
    expect(correlatePullRequestPreviews(result, details).previews[0]?.pullRequestUrl).toBeUndefined();
    details.pullRequests[0]!.url = 'https://github.com/DotNaos/project-space/pull/263';
    expect(correlatePullRequestPreviews(result, details).previews[0]?.pullRequestUrl)
      .toBe('https://github.com/DotNaos/project-space/pull/263');
  });

  test('uses the CLI all-status contract, filters one PR, and hides command failures', async () => {
    const calls: string[][] = [];
    const available = await getPullRequestPreviewStatus('DotNaos/project-space', 263, {
      cwd: '.',
      run: async (args) => {
        calls.push(args);
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ previews: [
          { pullRequestNumber: 263, repositoryFullName: 'DotNaos/project-space', requestedSha, state: 'deploying' },
          { pullRequestNumber: 264, repositoryFullName: 'DotNaos/project-space', requestedSha, state: 'deploying' }
        ] }) };
      }
    });
    expect(calls).toEqual([['deploy', 'preview', 'status', '--all', '--format', 'json']]);
    expect(available.previews.map((preview) => preview.pullRequestNumber)).toEqual([263]);

    const failed = await getPullRequestPreviewStatus('DotNaos/project-space', undefined, {
      cwd: '.',
      run: async () => ({ exitCode: 1, stderr: 'private host op://vault', stdout: 'secret' })
    });
    expect(failed).toMatchObject({ previews: [], status: 'unavailable' });
    expect(JSON.stringify(failed)).not.toMatch(/private host|op:\/\/vault|secret/);
  });

  test('reads the bounded production status registry without SSH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-status-registry-'));
    const previewDirectory = join(root, 'pr-528');
    await mkdir(previewDirectory);
    await writeFile(join(previewDirectory, 'runtime.json'), JSON.stringify({
      liveUrl: 'https://pr-528.projects.os-home.net',
      prototypeHealthy: true,
      prototypeMetaSha: requestedSha,
      prototypeUrl: 'https://pr-528.projects.os-home.net/prototype/desktop/',
      pullRequestNumber: 528,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      runningSha: requestedSha,
      state: 'online',
      verifiedAt: '2026-08-09T07:06:23Z'
    }));
    let calledCli = false;

    try {
      const result = await getPullRequestPreviewStatus('DotNaos/project-space', 528, {
        run: async () => {
          calledCli = true;
          return { exitCode: 1, stderr: '', stdout: '' };
        },
        statusRoot: root
      });

      expect(calledCli).toBe(false);
      expect(result.status).toBe('available');
      expect(result.previews[0]).toMatchObject({
        liveUrl: 'https://pr-528.projects.os-home.net/',
        pullRequestNumber: 528,
        requestedSha,
        runningSha: requestedSha,
        state: 'online'
      });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test('synthesizes a not-deployed placeholder for every open PR missing from the registry', () => {
    const result = {
      checkedAt: '2026-08-08T10:00:00.000Z',
      previews: [{
        liveUrlState: 'not-configured' as const,
        prototypeUrlState: 'not-configured' as const,
        pullRequestNumber: 100,
        repositoryFullName: 'DotNaos/project-space',
        requestedSha,
        runningSha,
        state: 'online' as const
      }],
      repositoryFullName: 'DotNaos/project-space',
      status: 'available' as const
    };
    const details = {
      branches: [],
      checkedAt: result.checkedAt,
      issues: [],
      pullRequests: [
        {
          headSha: requestedSha,
          number: 100,
          state: 'open' as const,
          title: 'Already deployed',
          url: 'https://github.com/DotNaos/project-space/pull/100'
        },
        {
          author: { login: 'octocat' },
          checksStatus: 'failing' as const,
          headBranch: 'issue-508-preview-redesign',
          headSha: runningSha,
          isDraft: true,
          number: 508,
          state: 'open' as const,
          title: 'Redesign PR Previews',
          updatedAt: '2026-08-07T00:00:00.000Z',
          url: 'https://github.com/DotNaos/project-space/pull/508'
        },
        {
          headSha: requestedSha,
          number: 509,
          state: 'closed' as const,
          title: 'Already merged, never previewed',
          url: 'https://github.com/DotNaos/project-space/pull/509'
        }
      ],
      status: 'connected' as const
    };

    // The generic correlate step (shared with the per-project Deployments widget) must NOT
    // grow extra rows: that widget's "no entry found" UX has its own dedicated copy.
    const correlated = correlatePullRequestPreviews(result, details);
    expect(correlated.previews.map((preview) => preview.pullRequestNumber)).toEqual([100]);

    // Only the opt-in Previews-hub helper adds a placeholder per open, undeployed PR.
    const withUndeployed = withUndeployedOpenPullRequests(correlated, details).previews;
    expect(withUndeployed.map((preview) => preview.pullRequestNumber)).toEqual([100, 508]);

    const synthesized = withUndeployed.find((preview) => preview.pullRequestNumber === 508);
    expect(synthesized).toMatchObject({
      author: { login: 'octocat' },
      checksStatus: 'failing',
      currentHeadSha: runningSha,
      headBranch: 'issue-508-preview-redesign',
      isDraft: true,
      pullRequestState: 'open',
      pullRequestTitle: 'Redesign PR Previews',
      pullRequestUrl: 'https://github.com/DotNaos/project-space/pull/508',
      requestedSha: runningSha,
      state: 'not-deployed'
    });
  });

  test('does not synthesize a placeholder for an open PR with an invalid head SHA', () => {
    const result = {
      checkedAt: '2026-08-08T10:00:00.000Z',
      previews: [],
      repositoryFullName: 'DotNaos/project-space',
      status: 'available' as const
    };
    const details = {
      branches: [],
      checkedAt: result.checkedAt,
      issues: [],
      pullRequests: [{
        headSha: 'not-a-real-sha',
        number: 42,
        state: 'open' as const,
        title: 'Missing head evidence',
        url: 'https://github.com/DotNaos/project-space/pull/42'
      }],
      status: 'connected' as const
    };
    const withUndeployed = withUndeployedOpenPullRequests(
      correlatePullRequestPreviews(result, details),
      details
    ).previews;
    expect(withUndeployed).toHaveLength(1);
    expect(withUndeployed[0]).toMatchObject({ requestedSha: undefined, state: 'not-deployed' });
  });

  test('does not turn a malformed record into a successful not-deployed result', async () => {
    const result = await getPullRequestPreviewStatus('DotNaos/project-space', 263, {
      cwd: '.',
      run: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ previews: [{
          pullRequestNumber: 263,
          repositoryFullName: 'DotNaos/project-space',
          requestedSha: 'short',
          state: 'ready'
        }] })
      })
    });
    expect(result).toMatchObject({ previews: [], status: 'unavailable' });
  });
});
