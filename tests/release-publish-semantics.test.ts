import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

const workflowPath = join(
  import.meta.dir,
  '..',
  '.github',
  'workflows',
  'release-publish.yml'
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function workflowSource() {
  return readFile(workflowPath, 'utf8');
}

async function inlinePython(label: string) {
  const workflow = await workflowSource();
  const opening = `<<'${label}'\n`;
  const start = workflow.indexOf(opening);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + opening.length;
  const closing = `\n          ${label}`;
  const end = workflow.indexOf(closing, bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return workflow
    .slice(bodyStart, end)
    .replace(/^ {10}/gm, '');
}

async function runInlinePython(label: string, arguments_: string[]) {
  const process = Bun.spawn(
    ['/usr/bin/python3', '-I', '-', ...arguments_],
    { stderr: 'pipe', stdin: 'pipe', stdout: 'pipe' }
  );
  process.stdin.write(await inlinePython(label));
  process.stdin.end();
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text()
  ]);
  return { exitCode, stderr, stdout };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'project-release-publish-'));
  temporaryDirectories.push(directory);
  return directory;
}

function ownerMarker(
  releaseRef: string,
  sourceSha: string,
  runId: string,
  attempt: string
) {
  return (
    `<!-- project-space-release-owner:v1:run=${runId}:` +
    `attempt=${attempt}:source=${sourceSha}:ref=${releaseRef} -->`
  );
}

describe('isolated GitHub release publication semantics', () => {
  test('accepts GitHub normalizing target_commitish to main for a verified existing tag', async () => {
    const directory = await temporaryDirectory();
    const responsePath = join(directory, 'created-release.json');
    const releaseRef = 'v0.4.5';
    const sourceSha = 'a'.repeat(40);
    const runId = '12345';
    const attempt = '2';
    await writeFile(
      responsePath,
      JSON.stringify({
        assets: [],
        body: `${ownerMarker(releaseRef, sourceSha, runId, attempt)}\nGenerated notes`,
        draft: true,
        id: 91,
        name: releaseRef,
        prerelease: false,
        tag_name: releaseRef,
        target_commitish: 'main'
      })
    );

    const result = await runInlinePython('PY_VALIDATE_CREATED', [
      responsePath,
      releaseRef,
      sourceSha,
      runId,
      attempt
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: '', stdout: '91\n' });
  });

  test('recognizes only a same-run and same-source prior-attempt draft for recovery', async () => {
    const directory = await temporaryDirectory();
    const releasesPath = join(directory, 'releases.json');
    const releaseRef = 'v0.4.5';
    const sourceSha = 'b'.repeat(40);
    const runId = '67890';
    await writeFile(
      releasesPath,
      JSON.stringify({
        assets: [{ id: 1, name: 'partial.bin' }],
        body: `${ownerMarker(releaseRef, sourceSha, runId, '1')}\nGenerated notes`,
        draft: true,
        id: 27,
        name: releaseRef,
        prerelease: false,
        published_at: null,
        tag_name: releaseRef,
        target_commitish: 'main'
      })
    );

    const recovered = await runInlinePython('PY_CLASSIFY_OWNED_DRAFT', [
      releasesPath,
      releaseRef,
      sourceSha,
      runId,
      '2'
    ]);
    expect(recovered).toMatchObject({
      exitCode: 0,
      stderr: '',
      stdout: 'draft:27\n'
    });

    const foreign = JSON.parse(await readFile(releasesPath, 'utf8'));
    foreign.body = ownerMarker(releaseRef, sourceSha, '99999', '1');
    await writeFile(releasesPath, JSON.stringify(foreign));
    const foreignResult = await runInlinePython('PY_CLASSIFY_OWNED_DRAFT', [
      releasesPath,
      releaseRef,
      sourceSha,
      runId,
      '2'
    ]);
    expect(foreignResult.exitCode).not.toBe(0);

    foreign.body = ownerMarker(releaseRef, sourceSha, runId, '1');
    foreign.draft = false;
    foreign.published_at = '2026-07-14T00:00:00Z';
    await writeFile(releasesPath, JSON.stringify(foreign));
    const publishedResult = await runInlinePython('PY_CLASSIFY_OWNED_DRAFT', [
      releasesPath,
      releaseRef,
      sourceSha,
      runId,
      '2'
    ]);
    expect(publishedResult.exitCode).not.toBe(0);

    const workflow = await workflowSource();
    const confirmation = workflow.indexOf(
      '[[ $confirmed_state == "draft:${recovery_id}" ]]'
    );
    const deletion = workflow.indexOf('--request DELETE', confirmation);
    expect(confirmation).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(confirmation);
  });

  test('uses exact-tag 200/404 lookups without paginated release discovery', async () => {
    const workflow = await workflowSource();
    expect(workflow).not.toContain('?per_page=100');
    expect(workflow.match(/\$release_api\/tags\/\$EXPECTED_REF/g)).toHaveLength(2);
    expect(workflow.match(/--write-out '%\{http_code\}'/g)).toHaveLength(2);
    expect(workflow.match(/404\) release_state=none/g)).toHaveLength(2);
    expect(workflow.match(/200\) release_state=/g)).toHaveLength(2);
    expect(workflow.split('\n').length - 1).toBeLessThanOrEqual(700);
  });

  test('requires the exact local sha256 digest at upload, draft, and published checks', async () => {
    const directory = await temporaryDirectory();
    const assetName = 'asset.bin';
    const assetPath = join(directory, assetName);
    const responsePath = join(directory, 'response.json');
    const namesPath = join(directory, 'assets.txt');
    const releaseRef = 'v0.4.5';
    const sourceSha = 'c'.repeat(40);
    const runId = '24680';
    const attempt = '2';
    const contents = Buffer.from('verified release asset');
    await writeFile(assetPath, contents);
    await writeFile(namesPath, `${assetName}\n`);
    const digest = `sha256:${createHash('sha256').update(contents).digest('hex')}`;

    const cases = [
      {
        arguments: [responsePath, assetPath, assetName],
        label: 'PY_VALIDATE_UPLOAD',
        response(digestValue: unknown) {
          return {
            digest: digestValue,
            name: assetName,
            size: contents.byteLength,
            state: 'uploaded'
          };
        }
      },
      {
        arguments: [
          responsePath,
          directory,
          namesPath,
          releaseRef,
          sourceSha,
          runId,
          attempt,
          'draft',
          '77'
        ],
        label: 'PY_VALIDATE_REMOTE',
        response(digestValue: unknown) {
          return {
            assets: [{
              digest: digestValue,
              name: assetName,
              size: contents.byteLength,
              state: 'uploaded'
            }],
            body: ownerMarker(releaseRef, sourceSha, runId, attempt),
            draft: true,
            id: 77,
            prerelease: false,
            published_at: null,
            tag_name: releaseRef
          };
        }
      },
      {
        arguments: [
          responsePath,
          directory,
          namesPath,
          releaseRef,
          sourceSha,
          runId,
          attempt,
          'published',
          '77'
        ],
        label: 'PY_VALIDATE_REMOTE',
        response(digestValue: unknown) {
          return {
            assets: [{
              digest: digestValue,
              name: assetName,
              size: contents.byteLength,
              state: 'uploaded'
            }],
            body: ownerMarker(releaseRef, sourceSha, runId, attempt),
            draft: false,
            id: 77,
            prerelease: false,
            published_at: '2026-07-14T00:00:00Z',
            tag_name: releaseRef
          };
        }
      }
    ];

    for (const contract of cases) {
      await writeFile(responsePath, JSON.stringify(contract.response(digest)));
      expect(
        await runInlinePython(contract.label, contract.arguments)
      ).toMatchObject({ exitCode: 0, stderr: '' });

      for (const rejected of [null, '', `sha256:${'0'.repeat(64)}`]) {
        await writeFile(responsePath, JSON.stringify(contract.response(rejected)));
        const result = await runInlinePython(contract.label, contract.arguments);
        expect(result.exitCode).not.toBe(0);
      }
    }

    expect(await workflowSource()).not.toContain('digest in (None, "")');
  });
});
