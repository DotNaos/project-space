import { describe, expect, test } from 'bun:test';
import { getDeployedEnvironmentStatus, sanitizeDeployedEnvironment } from '../server/deployed-environment-status';

const sha = 'a'.repeat(40);

describe('deployed environment status', () => {
  test('allows only verified running build data into the browser contract', () => {
    const result = sanitizeDeployedEnvironment({
      branch: 'main', buildCommit: sha, environment: 'prod', status: 'healthy',
      webUrl: 'https://projects.example.com',
      evidence: { composeHealthy: true, httpHealthy: true, liveOriginHealthy: true, remoteCheckoutCommit: sha, runningBuildCommit: sha }
    });
    expect(result).toEqual({
      deployedSha: sha, displayName: 'Production', id: 'prod',
      liveUrl: 'https://projects.example.com/', sourceRef: 'main', verification: 'healthy'
    });
    expect(JSON.stringify(result)).not.toMatch(/remotePath|containerImage|host|stderr|op:\/\//);
  });

  test('marks disagreeing evidence inconsistent and never accepts a short SHA', () => {
    expect(sanitizeDeployedEnvironment({
      buildCommit: sha, environment: 'dev', status: 'healthy',
      evidence: { composeHealthy: true, httpHealthy: true, liveOriginHealthy: true, remoteCheckoutCommit: 'b'.repeat(40), runningBuildCommit: sha }
    })).toMatchObject({ deployedSha: sha, verification: 'inconsistent' });
    expect(sanitizeDeployedEnvironment({ buildCommit: 'abc123', environment: 'beta', status: 'healthy' }))
      .toMatchObject({ deployedSha: undefined, verification: 'inconsistent' });
  });

  test('turns command failures into a fixed unavailable response without output leakage', async () => {
    const result = await getDeployedEnvironmentStatus('DotNaos/project-space', {
      cwd: '.', run: async () => ({ durationMs: 1, exitCode: 1, stdout: 'secret', stderr: 'deploy@private-host op://vault' })
    });
    expect(result).toMatchObject({ environments: [], status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-host');
  });

  test('refuses status belonging to another repository', async () => {
    const result = await getDeployedEnvironmentStatus('someone/private', {
      cwd: '.', run: async () => ({ durationMs: 1, exitCode: 0, stderr: '', stdout: JSON.stringify({ environments: [{ remoteRef: 'DotNaos/project-space' }] }) })
    });
    expect(result.status).toBe('unauthorized');
    expect(result.environments).toEqual([]);
  });

  test('filters mixed repository rows and rejects credential-bearing live URLs', async () => {
    const result = await getDeployedEnvironmentStatus('DotNaos/project-space', {
      cwd: '.', run: async () => ({ durationMs: 1, exitCode: 0, stderr: '', stdout: JSON.stringify({ environments: [
        { environment: 'prod', remoteRef: 'dotnaos/PROJECT-SPACE', status: 'unhealthy', webUrl: 'https://token:secret@internal.example/' },
        { environment: 'private', remoteRef: 'someone/private', status: 'unhealthy', webUrl: 'https://private.example/' }
      ] }) })
    });
    expect(result.environments.map((entry) => entry.id)).toEqual(['prod']);
    expect(result.environments[0]?.liveUrl).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private.example');
  });
});
