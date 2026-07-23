import { describe, expect, test } from 'bun:test';
import {
  correlatePullRequestPreviews,
  getPullRequestPreviewStatus,
  sanitizePullRequestPreview
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
        number: 263,
        state: 'open' as const,
        title: 'Preview deployments',
        url: 'https://evil.example/pull/263'
      }],
      status: 'connected' as const
    };
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
