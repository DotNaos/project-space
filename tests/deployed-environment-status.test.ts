import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
      liveUrl: 'https://projects.example.com/', liveUrlState: 'available',
      sourceRef: 'main', verification: 'healthy'
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
    expect(result.environments[0]?.liveUrlState).toBe('withheld');
    expect(JSON.stringify(result)).not.toContain('private.example');
  });

  test('keeps every safe public URL across multiple environments', async () => {
    const environments = ['prod', 'dev', 'beta'].map((environment, index) => ({
      buildCommit: String(index + 1).repeat(40),
      environment,
      remoteRef: 'DotNaos/project-space',
      status: 'healthy',
      webUrl: `https://${environment}.projects.example.com`,
      evidence: {
        composeHealthy: true,
        httpHealthy: true,
        liveOriginHealthy: true,
        remoteCheckoutCommit: String(index + 1).repeat(40),
        runningBuildCommit: String(index + 1).repeat(40)
      }
    }));
    const result = await getDeployedEnvironmentStatus('DotNaos/project-space', {
      cwd: '.',
      run: async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ environments }) })
    });
    expect(result.environments.map((entry) => [entry.id, entry.liveUrl, entry.liveUrlState])).toEqual([
      ['prod', 'https://prod.projects.example.com/', 'available'],
      ['dev', 'https://dev.projects.example.com/', 'available'],
      ['beta', 'https://beta.projects.example.com/', 'available']
    ]);
  });

  test('withholds private, credential-bearing, and malformed URLs without leaking them', () => {
    const unsafeUrls = [
      'http://public.example.com',
      'https://user:secret@public.example.com',
      'https://localhost',
      'https://localhost.',
      'https://app.localhost',
      'https://service.local',
      'https://service.internal',
      'https://10.0.0.1',
      'https://172.31.0.1',
      'https://192.168.1.1',
      'https://169.254.1.1',
      'https://0.0.0.0',
      'https://100.64.0.1',
      'https://198.51.100.1',
      'https://[::1]',
      'https://[fc00::1]',
      'https://[fe80::1]',
      'https://public.example.com/?token=secret',
      'https://public.example.com/#credential',
      'not a url'
    ];
    for (const webUrl of unsafeUrls) {
      const result = sanitizeDeployedEnvironment({ environment: 'prod', webUrl });
      expect(result.liveUrl).toBeUndefined();
      expect(result.liveUrlState).toBe('withheld');
      expect(JSON.stringify(result)).not.toContain(webUrl);
    }
    expect(sanitizeDeployedEnvironment({ environment: 'prod', webUrl: 'https://public.example.com/private/path' }))
      .toMatchObject({ liveUrl: 'https://public.example.com/', liveUrlState: 'available' });
    expect(sanitizeDeployedEnvironment({ environment: 'prod' }).liveUrlState).toBe('not-configured');
  });

  test('does not promote an unhealthy current environment when the verified SHA matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-space-environment-'));
    const previous = {
      build: process.env.PROJECT_SPACE_BUILD_COMMIT,
      environment: process.env.PROJECT_DEPLOY_ENVIRONMENT,
      root: process.env.PROJECT_DEPLOY_STATE_ROOT
    };
    try {
      await mkdir(join(root, 'project-space-prod'), { recursive: true });
      await writeFile(join(root, 'project-space-prod', 'verified.sha'), `${sha}\n`);
      process.env.PROJECT_SPACE_BUILD_COMMIT = sha;
      process.env.PROJECT_DEPLOY_ENVIRONMENT = 'prod';
      process.env.PROJECT_DEPLOY_STATE_ROOT = root;
      const result = await getDeployedEnvironmentStatus('DotNaos/project-space', {
        cwd: '.',
        run: async () => ({ durationMs: 1, exitCode: 0, stderr: '', stdout: JSON.stringify({
          environments: [{
            buildCommit: sha, environment: 'prod', remoteRef: 'DotNaos/project-space', status: 'unhealthy',
            evidence: { remoteCheckoutCommit: sha, runningBuildCommit: sha }
          }]
        }) })
      });
      expect(result.environments[0]).toMatchObject({ deployedSha: sha, verification: 'unhealthy' });
    } finally {
      if (previous.build === undefined) delete process.env.PROJECT_SPACE_BUILD_COMMIT;
      else process.env.PROJECT_SPACE_BUILD_COMMIT = previous.build;
      if (previous.environment === undefined) delete process.env.PROJECT_DEPLOY_ENVIRONMENT;
      else process.env.PROJECT_DEPLOY_ENVIRONMENT = previous.environment;
      if (previous.root === undefined) delete process.env.PROJECT_DEPLOY_STATE_ROOT;
      else process.env.PROJECT_DEPLOY_STATE_ROOT = previous.root;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers current hosted verification when server-owned verified SHA matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-space-current-'));
    const state = join(root, 'project-space-prod');
    await mkdir(state, { recursive: true });
    await writeFile(join(state, 'verified.sha'), `${sha}\n`);
    const previous = {
      environment: process.env.PROJECT_DEPLOY_ENVIRONMENT,
      commit: process.env.PROJECT_SPACE_BUILD_COMMIT,
      root: process.env.PROJECT_DEPLOY_STATE_ROOT
    };
    process.env.PROJECT_DEPLOY_ENVIRONMENT = 'prod';
    process.env.PROJECT_SPACE_BUILD_COMMIT = sha;
    process.env.PROJECT_DEPLOY_STATE_ROOT = root;
    try {
      const result = await getDeployedEnvironmentStatus('DotNaos/project-space', {
        cwd: root,
        run: async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ environments: [{
          branch: 'main', environment: 'prod', remoteRef: 'DotNaos/project-space', status: 'unknown'
        }] }) })
      });
      expect(result.environments[0]).toMatchObject({ deployedSha: sha, verification: 'healthy' });
    } finally {
      if (previous.environment === undefined) delete process.env.PROJECT_DEPLOY_ENVIRONMENT; else process.env.PROJECT_DEPLOY_ENVIRONMENT = previous.environment;
      if (previous.commit === undefined) delete process.env.PROJECT_SPACE_BUILD_COMMIT; else process.env.PROJECT_SPACE_BUILD_COMMIT = previous.commit;
      if (previous.root === undefined) delete process.env.PROJECT_DEPLOY_STATE_ROOT; else process.env.PROJECT_DEPLOY_STATE_ROOT = previous.root;
      await rm(root, { recursive: true, force: true });
    }
  });
});
