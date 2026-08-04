import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const contract = new URL('../scripts/preview-artifact-contract.py', import.meta.url).pathname;
const sha = 'a'.repeat(40);
const repository = 'DotNaos/project-space';
const repositoryId = '1184611708';
const pr = '405';
const runId = '123456';
const runAttempt = '2';
const workflowRef = `${repository}/.github/workflows/build-preview-artifacts.yml@refs/pull/${pr}/merge`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'preview-contract-'));
  temporaryDirectories.push(root);
  const source = join(root, 'source');
  const artifact = join(root, 'artifact');
  await mkdir(join(source, 'deploy'), { recursive: true });
  await mkdir(join(artifact, 'images'), { recursive: true });
  for (const recipe of [
    'preview-artifact-bake.hcl',
    'preview.web.Dockerfile',
    'preview.docs.Dockerfile',
    'preview.prototype.Dockerfile',
    'preview.prototype.nginx.conf',
  ]) {
    await writeFile(join(source, 'deploy', recipe), `PR recipe ${recipe}\n`);
  }
  for (const image of ['web', 'docs', 'prototype']) {
    await writeFile(join(artifact, 'images', `${image}.tar`), `immutable ${image} image\n`);
  }
  return { root, source, artifact };
}

function contractArgs(command: 'create' | 'verify', root: string) {
  return [
    contract,
    command,
    '--root', root,
    '--repository', repository,
    '--repository-id', repositoryId,
    '--pr', pr,
    '--head-sha', sha,
    '--workflow-ref', workflowRef,
    '--run-id', runId,
    '--run-attempt', runAttempt,
  ];
}

describe('Preview artifact contract', () => {
  test('binds exact repository, PR, head, workflow run, recipes, and image archives', async () => {
    const { source, artifact } = await fixture();
    const create = spawnSync('python3', [
      ...contractArgs('create', source),
      '--output', join(artifact, 'manifest.json'),
    ], { encoding: 'utf8' });
    expect(create.status).toBe(0);

    const verify = spawnSync('python3', contractArgs('verify', artifact), { encoding: 'utf8' });
    expect(verify.status).toBe(0);
    const manifest = JSON.parse(verify.stdout);
    expect(manifest.repository).toEqual({ id: Number(repositoryId), fullName: repository });
    expect(manifest.pullRequestNumber).toBe(Number(pr));
    expect(manifest.headSha).toBe(sha);
    expect(manifest.source).toEqual({
      event: 'pull_request',
      workflowRef,
      runId: Number(runId),
      runAttempt: Number(runAttempt),
    });
    expect(Object.keys(manifest.recipes)).toHaveLength(5);
    expect(Object.keys(manifest.images)).toEqual(['docs', 'prototype', 'web']);
  });

  test('rejects a changed archive and a mismatched trusted identity', async () => {
    const { source, artifact } = await fixture();
    expect(spawnSync('python3', [
      ...contractArgs('create', source),
      '--output', join(artifact, 'manifest.json'),
    ]).status).toBe(0);

    await writeFile(join(artifact, 'images/web.tar'), 'changed image\n');
    const changed = spawnSync('python3', contractArgs('verify', artifact), { encoding: 'utf8' });
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain('does not match its manifest');

    await writeFile(join(artifact, 'images/web.tar'), 'immutable web image\n');
    const wrongHead = spawnSync('python3', [
      ...contractArgs('verify', artifact).map((value) => value === sha ? 'b'.repeat(40) : value),
    ], { encoding: 'utf8' });
    expect(wrongHead.status).not.toBe(0);
    expect(wrongHead.stderr).toContain('head SHA does not match');
  });

  test('validates a PR-built artifact even when trusted main has an incompatible old recipe', async () => {
    const { root, source, artifact } = await fixture();
    await writeFile(
      join(source, 'deploy/preview.prototype.Dockerfile'),
      'COPY apps/mobile/bun.lock ./apps/mobile/\n',
    );
    const trustedMain = join(root, 'trusted-main');
    await mkdir(join(trustedMain, 'deploy'), { recursive: true });
    await writeFile(
      join(trustedMain, 'deploy/preview.prototype.Dockerfile'),
      'COPY apps/mobile/pnpm-lock.yaml ./apps/mobile/\n',
    );
    expect(spawnSync('python3', [
      ...contractArgs('create', source),
      '--output', join(artifact, 'manifest.json'),
    ]).status).toBe(0);

    const verify = spawnSync('python3', contractArgs('verify', artifact), { encoding: 'utf8' });
    expect(verify.status).toBe(0);
    expect(await readFile(join(trustedMain, 'deploy/preview.prototype.Dockerfile'), 'utf8'))
      .toContain('pnpm-lock.yaml');
  });

  test('checks the raw GitHub archive digest and extracts only the exact bounded inventory', async () => {
    const { root, source, artifact } = await fixture();
    expect(spawnSync('python3', [
      ...contractArgs('create', source),
      '--output', join(artifact, 'manifest.json'),
    ]).status).toBe(0);
    const archive = join(root, 'artifact.zip');
    const zip = spawnSync('python3', ['-c', [
      'import pathlib, sys, zipfile',
      'root = pathlib.Path(sys.argv[1])',
      'with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_STORED) as bundle:',
      '  for name in ("manifest.json", "images/web.tar", "images/docs.tar", "images/prototype.tar"):',
      '    bundle.write(root / name, name)',
    ].join('\n'), artifact, archive], { encoding: 'utf8' });
    expect(zip.status).toBe(0);
    const archiveBytes = await Bun.file(archive).arrayBuffer();
    const digest = createHash('sha256').update(new Uint8Array(archiveBytes)).digest('hex');
    const size = (await stat(archive)).size;
    const extracted = join(root, 'extracted');

    const extract = spawnSync('python3', [
      contract, 'safe-extract',
      '--archive', archive,
      '--destination', extracted,
      '--expected-digest', `sha256:${digest}`,
      '--expected-size', String(size),
    ], { encoding: 'utf8' });
    expect(extract.status).toBe(0);
    expect(await readFile(join(extracted, 'manifest.json'), 'utf8'))
      .toBe(await readFile(join(artifact, 'manifest.json'), 'utf8'));
  });

  test('rejects traversal members before extracting any artifact content', async () => {
    const { root } = await fixture();
    const archive = join(root, 'malicious.zip');
    expect(spawnSync('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "w") as bundle:',
      '  bundle.writestr("../escape", b"bad")',
    ].join('\n'), archive]).status).toBe(0);
    const bytes = await Bun.file(archive).arrayBuffer();
    const digest = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    const extract = spawnSync('python3', [
      contract, 'safe-extract',
      '--archive', archive,
      '--destination', join(root, 'bad-output'),
      '--expected-digest', digest,
      '--expected-size', String((await stat(archive)).size),
    ], { encoding: 'utf8' });
    expect(extract.status).not.toBe(0);
    expect(extract.stderr).toContain('unsafe or duplicate artifact member');
  });
});
