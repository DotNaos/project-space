import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  prepareReleaseEntryIdentity,
  prepareReleaseIdentityBundle,
  readReleaseIdentitySources,
  releaseIdentityPaths,
  releaseIdentityState,
  validateReleaseIdentityBundle,
} from '../scripts/release-identity';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('atomic release preparation', () => {
  test('prepares every coupled identity together and accepts the exact rerun state', () => {
    const current = readReleaseIdentitySources();
    const currentVersion = packageVersion();
    const intendedVersion = nextPatch(currentVersion);
    const prepared = prepareReleaseIdentityBundle(current, currentVersion, intendedVersion);

    expect(releaseIdentityState(current, currentVersion, intendedVersion)).toBe('current');
    expect(releaseIdentityState(prepared, currentVersion, intendedVersion)).toBe('prepared');
    expect(validateReleaseIdentityBundle(prepared, intendedVersion)).toEqual([]);
    expect([...prepared.keys()]).toEqual(releaseIdentityPaths);
  });

  test.each(releaseIdentityPaths)(
    'refuses a partial bundle with stale %s',
    (stalePath) => {
      const current = readReleaseIdentitySources();
      const currentVersion = packageVersion();
      const intendedVersion = nextPatch(currentVersion);
      const partial = prepareReleaseIdentityBundle(current, currentVersion, intendedVersion);
      partial.set(stalePath, current.get(stalePath)!);

      expect(releaseIdentityState(partial, currentVersion, intendedVersion)).toBe('partial');
      expect(validateReleaseIdentityBundle(partial, intendedVersion).join('\n')).toContain(
        stalePath,
      );
    },
  );

  test('fills only authored release-entry identity tokens and is idempotent', () => {
    const template = readFileSync(
      'apps/docs/content/docs/releases/entry-template.mdx.template',
      'utf8',
    )
      .replace('version: "0.0.0"', 'version: "__VERSION__"')
      .replace('pullRequest: 0', 'pullRequest: __PR_NUMBER__')
      .replace('Short user-facing release title', 'Make PR revisions green')
      .replace('Concisely explain what changed for Project Space users.', 'Agents can prove one coherent revision locally before CI.')
      .replace('Describe one concrete user-visible change.', 'Added one canonical local preflight and atomic release preparation.')
      .replace('Describe one concrete check in the exact PR Preview.', 'Run the preflight and inspect its machine-readable report.');
    const once = prepareReleaseEntryIdentity(template, 435, '0.4.56');
    const twice = prepareReleaseEntryIdentity(once, 435, '0.4.56');

    expect(twice).toBe(once);
    expect(parseReleaseEntryMdx(once, '435.mdx').ok).toBe(true);
  });

  test.each([
    ['an extra version token', '__VERSION__'],
    ['an extra pull-request token', '__PR_NUMBER__'],
  ])('refuses %s outside the release-entry identity fields', (_label, token) => {
    const template = readFileSync(
      'apps/docs/content/docs/releases/entry-template.mdx.template',
      'utf8',
    )
      .replace('version: "0.0.0"', 'version: "__VERSION__"')
      .replace('pullRequest: 0', 'pullRequest: __PR_NUMBER__')
      .replace(
        'Concisely explain what changed for Project Space users.',
        `This authored body accidentally retained ${token}.`,
      );

    expect(() => prepareReleaseEntryIdentity(template, 435, '0.4.56')).toThrow(
      'must each occur exactly once in their release-entry identity field',
    );
  });

  test('the CLI refuses partial or unrelated input before its transaction', () => {
    const source = readFileSync('scripts/prepare-release-pr.ts', 'utf8');

    expect(source).toContain('partial release bundles are refused');
    expect(source).toContain('Unrelated worktree changes are not allowed');
    expect(source).toContain('Staged input is ambiguous');
    expect(source).toContain("writeFileSync(temp, source, { flag: 'wx' })");
    expect(source).toContain('status: \'already-prepared\' | \'prepared\'');
  });

  test('executes preparation and an exact idempotent rerun in a temporary repository', () => {
    const fixture = createRepositoryFixture();
    const first = runPreparation(fixture.root, fixture.version, false);
    const second = runPreparation(fixture.root, fixture.version, false);

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).status).toBe('prepared');
    if (second.exitCode !== 0) throw new Error(second.stderr);
    expect(JSON.parse(second.stdout).status).toBe('already-prepared');
    expect(
      validateReleaseIdentityBundle(
        readReleaseIdentitySources(fixture.root),
        fixture.version,
      ),
    ).toEqual([]);
  });

  test('rolls every file back byte-for-byte when post-write validation refuses', () => {
    const fixture = createRepositoryFixture();
    const paths = [...releaseIdentityPaths, fixture.entryPath];
    const before = new Map(
      paths.map((path) => [path, readFileSync(join(fixture.root, path), 'utf8')]),
    );
    const result = runPreparation(fixture.root, fixture.version, true);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('synthetic post-write refusal');
    for (const [path, source] of before) {
      expect(readFileSync(join(fixture.root, path), 'utf8')).toBe(source);
    }
  });

  test('refuses an ancestor passed as base instead of the fetched origin main', () => {
    const fixture = createRepositoryFixture();
    const result = runPreparation(
      fixture.root,
      fixture.version,
      false,
      fixture.staleBase,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is not the fetched origin/main');
  });
});

const repositoryRoot = resolve(import.meta.dir, '..');
const prepareScript = join(repositoryRoot, 'scripts/prepare-release-pr.ts');

function packageVersion() {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
}

function nextPatch(version: string) {
  const parts = version.split('.').map(Number);
  return `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
}

function createRepositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-release-preparation-'));
  temporaryRoots.push(root);
  for (const path of releaseIdentityPaths) copy(path, root);
  cpSync(
    join(repositoryRoot, 'apps/docs/content/docs/releases/entries'),
    join(root, 'apps/docs/content/docs/releases/entries'),
    { recursive: true },
  );
  runGit(root, ['init', '-b', 'main']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Release test']);
  writeFileSync(join(root, '.bootstrap'), 'bootstrap\n');
  runGit(root, ['add', '.bootstrap']);
  runGit(root, ['commit', '-m', 'bootstrap']);
  const staleBase = runGit(root, ['rev-parse', 'HEAD']).trim();
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'fixture']);
  runGit(root, ['remote', 'add', 'origin', '.']);

  const pullRequest = 999999;
  const entryPath = `apps/docs/content/docs/releases/entries/${pullRequest}.mdx`;
  const entry = readFileSync(
    join(repositoryRoot, 'apps/docs/content/docs/releases/entry-template.mdx.template'),
    'utf8',
  )
    .replace('version: "0.0.0"', 'version: "__VERSION__"')
    .replace('pullRequest: 0', 'pullRequest: __PR_NUMBER__')
    .replace('Short user-facing release title', 'Prepare one coherent revision')
    .replace(
      'Concisely explain what changed for Project Space users.',
      'Pull request revisions can be prepared atomically before CI.',
    )
    .replace(
      'Describe one concrete user-visible change.',
      'Added exact local checks and atomic release identity preparation.',
    )
    .replace(
      'Describe one concrete check in the exact PR Preview.',
      'Run the preflight and inspect the exact revision report.',
    );
  writeFileSync(join(root, entryPath), entry);
  return {
    entryPath,
    root,
    staleBase,
    version: nextPatch(packageVersion()),
  };

  function copy(path: string, targetRoot: string) {
    const target = join(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repositoryRoot, path), target);
  }
}

function runPreparation(
  root: string,
  version: string,
  refuseAfterWrite: boolean,
  base = 'origin/main',
) {
  const expression = `
    import { prepareReleasePullRequest } from ${JSON.stringify(prepareScript)};
    try {
      const result = await prepareReleasePullRequest(
        { base: ${JSON.stringify(base)}, format: 'json', pullRequest: 999999, version: ${JSON.stringify(version)} },
        {
          assertUniqueRelease: async () => {},
          ${refuseAfterWrite ? "validateWritten: async () => { throw new Error('synthetic post-write refusal'); }," : ''}
        },
      );
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  `;
  const child = Bun.spawnSync(['bun', '-e', expression], {
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: child.exitCode,
    stderr: child.stderr.toString(),
    stdout: child.stdout.toString().trim(),
  };
}

function runGit(root: string, args: string[]) {
  const child = Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe', stdout: 'pipe' });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString();
}
