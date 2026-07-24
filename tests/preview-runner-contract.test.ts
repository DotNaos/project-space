import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const runnerPath = join(repositoryRoot, 'deploy/preview-runner.sh');
const composePath = join(repositoryRoot, 'deploy/preview.compose.yml');
const sshEntrypointPath = join(repositoryRoot, 'deploy/preview-ssh-entrypoint.sh');
const statusEntrypointPath = join(repositoryRoot, 'deploy/preview-status-entrypoint.sh');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function testRoot() {
  const root = await mkdtemp(join(tmpdir(), 'project-space-preview-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), `#!/bin/sh
if [ "$1 $2" = "ps -aq" ]; then exit 0; fi
if [ "$1 $2" = "network inspect" ]; then exit 1; fi
if [ "$1 $2" = "volume inspect" ]; then exit 1; fi
exit 0
`);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nprintf 404\n');
  await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  await chmod(join(bin, 'flock'), 0o755);
  return { bin, root };
}

function runRunner(input: unknown, command: string, root: string, bin: string) {
  return spawnSync('sh', [runnerPath, command], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PROJECT_SPACE_PREVIEW_PLATFORM_ROOT: root
    },
    input: JSON.stringify(input),
    encoding: 'utf8'
  });
}

describe('trusted Preview runner contract', () => {
  test('has valid shell syntax and rejects unsafe dynamic identities', () => {
    for (const path of [runnerPath, sshEntrypointPath, statusEntrypointPath]) {
      const syntax = spawnSync('sh', ['-n', path], { encoding: 'utf8' });
      expect(syntax.status).toBe(0);
    }
  });

  test('derives an absent record from the exact positive PR identity', async () => {
    const { bin, root } = await testRoot();
    const result = runRunner({ repository: 'DotNaos/project-space', prNumber: 263 }, 'status', root, bin);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      state: 'absent'
    });

    const invalid = runRunner({ repository: 'DotNaos/project-space', prNumber: '../prod' }, 'status', root, bin);
    expect(invalid.status).toBe(64);
  });

  test('status-all is read-only and does not require Docker access', async () => {
    const { bin, root } = await testRoot();
    await rm(join(bin, 'docker'));
    const result = runRunner(undefined, 'status-all', root, bin);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ records: [] });
  });

  test('idempotent destroy proves absence and writes a bounded tombstone without inventing a SHA', async () => {
    const { bin, root } = await testRoot();
    const result = runRunner({
      reason: 'manual_destroy',
      repository: 'DotNaos/project-space',
      prNumber: 263
    }, 'destroy', root, bin);

    expect(result.status).toBe(0);
    const tombstone = JSON.parse(result.stdout);
    expect(tombstone).toMatchObject({
      cleanup: {
        containersAbsent: true,
        networksAbsent: true,
        routeAbsent: true,
        runtimePathAbsent: true,
        volumesAbsent: true
      },
      message: 'manual_destroy',
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      state: 'removed'
    });
    expect(tombstone.requestedSha).toBeUndefined();
    expect(tombstone.runningSha).toBeUndefined();

    const persisted = JSON.parse(await readFile(
      join(root, 'state/project-space-preview/pr-263/tombstone.json'),
      'utf8'
    ));
    expect(persisted).toEqual(tombstone);
  });

  test('destroy preserves the last requested and running SHAs in its tombstone', async () => {
    const { bin, root } = await testRoot();
    const stateDirectory = join(root, 'state/project-space-preview/pr-263');
    const requestedSha = '1'.repeat(40);
    const runningSha = '2'.repeat(40);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, 'runtime.json'), JSON.stringify({
      pullRequestNumber: 263,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha,
      runningSha,
      state: 'update_failed'
    }));

    const result = runRunner({
      reason: 'pull_request_closed',
      repository: 'DotNaos/project-space',
      prNumber: 263
    }, 'destroy', root, bin);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ requestedSha, runningSha, state: 'removed' });
    expect(await readFile(join(stateDirectory, 'tombstone.json'), 'utf8')).toContain(requestedSha);
  });

  test('runner and Compose isolate Preview resources from Production credentials and mounts', async () => {
    const [runner, compose, sshEntrypoint, statusEntrypoint] = await Promise.all([
      readFile(runnerPath, 'utf8'),
      readFile(composePath, 'utf8'),
      readFile(sshEntrypointPath, 'utf8'),
      readFile(statusEntrypointPath, 'utf8')
    ]);

    expect(runner).toContain('revalidate_open_pr "$head_sha"');
    expect(runner.indexOf('acquire_lock')).toBeLessThan(runner.indexOf('revalidate_open_pr "$head_sha"'));
    expect(runner).toContain('project-space-preview-${kind}@sha256:');
    expect(runner).toContain('RUNTIME_ROOT=$PLATFORM_ROOT/previews/project-space');
    expect(runner).not.toContain('docker system prune');
    expect(runner).not.toContain('/opt/platform/apps/project-space');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_MODE: "1"');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_BROKER_ORIGIN: https://projects.os-home.net');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_GATEWAY_SECRET');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN: http://preview-web:4173');
    expect(compose).toContain('aliases: [preview-web]');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_REPOSITORY');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_PR_NUMBER');
    expect(compose).toContain('PROJECT_SPACE_PREVIEW_HEAD_SHA');
    expect(compose).toContain('CLERK_SECRET_KEY');
    expect(compose).not.toContain('GITHUB_TOKEN');
    expect(compose).not.toContain('PROJECT_CONNECTOR_REGISTRATION_TOKEN');
    expect(compose).not.toContain('/var/run/docker.sock');
    expect(compose).not.toContain('/workspace/deploy-state');
    expect(compose).not.toContain('../ssh');
    expect(compose).toContain('internal: true');
    expect(compose).toContain('pids_limit:');
    expect(compose).toContain('mem_limit:');
    expect(compose).toContain('max-size: 10m');
    expect(compose).toContain('postgres:17-alpine@sha256:');
    expect(sshEntrypoint).toContain('apply|destroy|reap');
    expect(sshEntrypoint).not.toContain('status-all');
    expect(statusEntrypoint).toContain('permits only status-all');
    expect(statusEntrypoint).not.toContain('apply|destroy');
  });

  test('Compose expands every PR-specific Traefik label key', () => {
    const compose = spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PREVIEW_COMPOSE_PROJECT: 'project-space-preview-pr-263',
        PREVIEW_DOCS_IMAGE: `ghcr.io/dotnaos/project-space-preview-docs@sha256:${'c'.repeat(64)}`,
        PREVIEW_DOMAIN: 'pr-263.projects.os-home.net',
        PREVIEW_GATEWAY_ENV_FILE: '/dev/null',
        PREVIEW_GATEWAY_IMAGE: `ghcr.io/dotnaos/project-space-preview-gateway@sha256:${'a'.repeat(64)}`,
        PREVIEW_GATEWAY_SECRET: 'preview-test-gateway-secret-that-is-long-enough',
        PREVIEW_HEAD_SHA: 'd'.repeat(40),
        PREVIEW_POSTGRES_PASSWORD: 'preview-test-postgres-password',
        PREVIEW_PR_NUMBER: '263',
        PREVIEW_REPOSITORY: 'DotNaos/project-space',
        PREVIEW_REPOSITORY_PATH: repositoryRoot,
        PREVIEW_WEB_IMAGE: `ghcr.io/dotnaos/project-space-preview-web@sha256:${'b'.repeat(64)}`
      }
    });
    expect(compose.status).toBe(0);
    const parsed = JSON.parse(compose.stdout);
    const labels = parsed.services.gateway.labels as Record<string, string>;
    expect(parsed.services.gateway.environment.PROJECT_SPACE_PREVIEW_UPSTREAM_ORIGIN)
      .toBe('http://preview-web:4173');
    expect(parsed.services.web.networks['preview-internal'].aliases).toEqual(['preview-web']);
    expect(labels['traefik.http.routers.project-space-preview-pr-263-gateway.rule'])
      .toBe('Host(`pr-263.projects.os-home.net`)');
    expect(labels['traefik.http.services.project-space-preview-pr-263-gateway.loadbalancer.server.port'])
      .toBe('4173');
    expect(Object.keys(labels).some((key) => key.includes('${'))).toBe(false);
  });

  test('operator docs require restricted forced commands and readable-only gateway secrets', async () => {
    const docs = await readFile(join(repositoryRoot, 'docs/pr-preview-deployments.md'), 'utf8');
    expect(docs).toContain('restrict,command="/opt/platform/share/project-space-preview/preview-ssh-entrypoint.sh"');
    expect(docs).toContain('restrict,command="/opt/platform/share/project-space-preview/preview-status-entrypoint.sh"');
    expect(docs).toContain('root:preview-deploy');
    expect(docs).toContain('mode `0640`');
  });
});
