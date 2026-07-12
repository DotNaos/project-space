import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  loadLocalProjectWorktrees,
  parseGitWorktreePorcelain,
  resolveLocalProjectWorktree
} from '../server/local-project-worktrees';

const temporaryDirectories: string[] = [];
const basePath = '/Users/oli/projects/project-space';
const commonDir = `${basePath}/.git`;
const head = '7d1acd5886f1758c2d9c109e86ebeee2e2ed7a96';

function porcelain(...blocks: string[][]) {
  return `${blocks.map((block) => block.join('\0')).join('\0\0')}\0\0`;
}

function parse(output: string, missingPaths: string[] = []) {
  const paths = output
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
  return parseGitWorktreePorcelain(output, {
    basePath,
    gitCommonDir: commonDir,
    pathHealth: (path) => (missingPaths.includes(path) ? 'missing' : 'present'),
    registrationKeys: new Map(paths.map((path, index) => [path, index === 0 ? 'main' : `linked-${index}`]))
  });
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Git-authoritative project worktree discovery', () => {
  test('keeps canonical Project-managed branch worktrees unchanged', () => {
    const records = parse(
      porcelain(
        ['worktree /Users/oli/projects/project-space', `HEAD ${head}`, 'branch refs/heads/main'],
        [
          'worktree /Users/oli/projects/.worktrees/project-space/feature',
          `HEAD ${head}`,
          'branch refs/heads/feature'
        ]
      )
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      branchName: 'main',
      detached: false,
      isBase: true,
      kind: 'project-managed',
      name: 'main',
      status: 'ready'
    });
    expect(records[1]).toMatchObject({
      branchName: 'feature',
      detached: false,
      isBase: false,
      kind: 'project-managed',
      name: 'feature',
      status: 'ready'
    });
  });

  test('shows current and legacy Codex-style detached worktrees with honest labels', () => {
    const records = parse(
      porcelain(
        ['worktree /Users/oli/projects/project-space', `HEAD ${head}`, 'branch refs/heads/main'],
        [
          'worktree /Users/oli/projects/.codex-worktrees/a281/project-space',
          `HEAD ${head}`,
          'detached'
        ],
        [
          'worktree /Users/oli/projects/.worktrees/dd15/project-space',
          `HEAD ${head}`,
          'detached'
        ],
        [
          'worktree /Users/oli/.codex/worktrees/87a9247f/project-space',
          `HEAD ${head}`,
          'detached'
        ]
      )
    );

    expect(records.filter((record) => record.kind === 'codex')).toEqual([
      expect.objectContaining({
        branchName: undefined,
        detached: true,
        name: 'Codex · 87a9247f · 7d1acd5',
        status: 'ready'
      }),
      expect.objectContaining({
        branchName: undefined,
        detached: true,
        name: 'Codex · a281 · 7d1acd5',
        status: 'ready'
      }),
      expect.objectContaining({
        branchName: undefined,
        detached: true,
        name: 'Codex · dd15 · 7d1acd5',
        status: 'ready'
      })
    ]);
  });

  test('keeps duplicate commits and repeated basenames distinct by opaque identity', () => {
    const records = parse(
      porcelain(
        ['worktree /Users/oli/projects/project-space', `HEAD ${head}`, 'branch refs/heads/main'],
        ['worktree /tmp/first/project-space', `HEAD ${head}`, 'detached'],
        ['worktree /var/second/project-space', `HEAD ${head}`, 'detached']
      )
    ).filter((record) => record.detached);

    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    expect(records.every((record) => /^wt_[a-f0-9]{24}$/.test(record.id))).toBe(true);
    expect(records.map((record) => record.name)).toEqual([
      'External · first/project-space · 7d1acd5',
      'External · second/project-space · 7d1acd5'
    ]);
  });

  test('reports locked, prunable, missing, and broken registrations as non-ready', () => {
    const locked = '/tmp/locked/project-space';
    const prunable = '/tmp/prunable/project-space';
    const missing = '/tmp/missing/project-space';
    const broken = '/tmp/broken/project-space';
    const records = parse(
      porcelain(
        ['worktree /Users/oli/projects/project-space', `HEAD ${head}`, 'branch refs/heads/main'],
        [`worktree ${locked}`, `HEAD ${head}`, 'detached', 'locked in use'],
        [
          `worktree ${prunable}`,
          `HEAD ${head}`,
          'detached',
          'prunable gitdir file points to non-existent location'
        ],
        [`worktree ${missing}`, `HEAD ${head}`, 'detached'],
        [`worktree ${broken}`, 'detached']
      ),
      [missing]
    );

    expect(Object.fromEntries(records.map((record) => [record.path, record.status]))).toMatchObject({
      [locked]: 'locked',
      [prunable]: 'prunable',
      [missing]: 'missing',
      [broken]: 'broken'
    });
    expect(records.find((record) => record.path === locked)).toMatchObject({
      locked: true,
      lockedReason: 'in use',
      prunable: false
    });
    expect(records.find((record) => record.path === prunable)).toMatchObject({
      locked: false,
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    });
    expect(records.filter((record) => record.status !== 'ready').every((record) => record.statusReason)).toBe(true);
  });

  test('rejects contradictory Git fields and reports unavailable inspection honestly', () => {
    const unavailable = '/tmp/unavailable/project-space';
    const invalidHead = '/tmp/invalid-head/project-space';
    const invalidBranch = '/tmp/invalid-branch/project-space';
    const contradictory = '/tmp/contradictory/project-space';
    const externalBranch = '/tmp/external/project-space';
    const output = porcelain(
      ['worktree /Users/oli/projects/project-space', `HEAD ${head}`, 'branch refs/heads/main'],
      [`worktree ${unavailable}`, `HEAD ${head}`, 'detached'],
      [`worktree ${invalidHead}`, 'HEAD short', 'detached'],
      [`worktree ${invalidBranch}`, `HEAD ${head}`, 'branch refs/tags/not-a-branch'],
      [`worktree ${contradictory}`, `HEAD ${head}`, 'branch refs/heads/topic', 'detached'],
      [`worktree ${externalBranch}`, `HEAD ${head}`, 'branch refs/heads/external']
    );
    const paths = output
      .split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => field.slice('worktree '.length));
    const records = parseGitWorktreePorcelain(output, {
      basePath,
      gitCommonDir: commonDir,
      pathHealth: (path) => (path === unavailable ? 'unavailable' : 'present'),
      registrationKeys: new Map(paths.map((path, index) => [path, index === 0 ? 'main' : `linked-${index}`]))
    });
    const statusByPath = Object.fromEntries(records.map((record) => [record.path, record.status]));

    expect(statusByPath).toMatchObject({
      [unavailable]: 'unavailable',
      [invalidHead]: 'broken',
      [invalidBranch]: 'broken',
      [contradictory]: 'broken'
    });
    expect(records.find((record) => record.path === externalBranch)).toMatchObject({
      branchName: 'external',
      detached: false,
      kind: 'external',
      name: 'external',
      status: 'ready'
    });
  });

  test('uses real Git registration for loading and re-resolves opaque IDs locally', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'project-worktrees-'));
    temporaryDirectories.push(scratch);
    const repository = join(scratch, 'repository');
    const linked = join(scratch, 'linked');
    const moved = join(scratch, 'moved');
    mkdirSync(repository);
    execFileSync('git', ['init', '-b', 'main', repository]);
    git(repository, 'config', 'user.email', 'test@example.com');
    git(repository, 'config', 'user.name', 'Project Space Test');
    writeFileSync(join(repository, 'README.md'), 'test\n');
    git(repository, 'add', 'README.md');
    git(repository, 'commit', '-m', 'Initial commit');
    git(repository, 'worktree', 'add', '-b', 'topic', linked);

    const worktrees = await loadLocalProjectWorktrees(repository);
    const topic = worktrees.find((record) => record.branchName === 'topic');

    expect(topic).toMatchObject({
      detached: false,
      headSha: git(repository, 'rev-parse', 'HEAD'),
      path: realpathSync(linked),
      status: 'ready'
    });
    expect(await resolveLocalProjectWorktree(repository, topic?.id || '')).toEqual(topic);
    expect(
      await resolveLocalProjectWorktree(repository, topic?.id || '', {
        expectedHeadSha: topic?.headSha
      })
    ).toEqual(topic);

    git(repository, 'worktree', 'move', linked, moved);
    const movedTopic = await resolveLocalProjectWorktree(repository, topic?.id || '');
    expect(movedTopic.id).toBe(topic?.id);
    expect(movedTopic.path).toBe(realpathSync(moved));

    expect(resolveLocalProjectWorktree(repository, linked)).rejects.toThrow('ID is invalid');
    expect(
      resolveLocalProjectWorktree(repository, 'wt_000000000000000000000000')
    ).rejects.toThrow('no longer registered');
    expect(
      resolveLocalProjectWorktree(repository, topic?.id || '', {
        expectedHeadSha: '0000000000000000000000000000000000000000'
      })
    ).rejects.toThrow('HEAD changed');

    writeFileSync(join(moved, '.git'), 'gitdir: /definitely/missing\n');
    const brokenTopic = (await loadLocalProjectWorktrees(repository)).find(
      (record) => record.id === topic?.id
    );
    expect(brokenTopic).toMatchObject({ path: realpathSync(moved), status: 'broken' });
    expect(resolveLocalProjectWorktree(repository, topic?.id || '')).rejects.toThrow(
      'broken and cannot be used'
    );
  });

  test('does not turn an unverified directory scan into an actionable worktree', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'project-worktree-scan-'));
    temporaryDirectories.push(scratch);
    mkdirSync(join(scratch, 'candidate'));
    writeFileSync(join(scratch, 'candidate', '.git'), 'gitdir: /missing/gitdir\n');

    expect(await loadLocalProjectWorktrees(scratch)).toEqual([]);
  });
});
