import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  preCommitCheckIds,
  resolveQualityCheck,
  sharedCheckCommand,
} from '../scripts/quality-checks';
import { gitCheckoutIndexPrefix } from '../scripts/git-index-snapshot';

describe('shared local and CI quality checks', () => {
  test('keeps the pre-commit profile fast, read-only, and index exact', () => {
    expect(preCommitCheckIds).toEqual([
      'diff-hygiene',
      'package-manager-policy',
      'docs-specs',
    ]);
    expect(resolveQualityCheck('diff-hygiene', { staged: true }).command).toEqual([
      'git',
      'diff',
      '--cached',
      '--check',
    ]);
    expect(resolveQualityCheck('package-manager-policy', { staged: true }).command).toEqual([
      'bun',
      'run',
      'check:package-manager',
      '--staged',
    ]);
    expect(resolveQualityCheck('docs-specs', { staged: true }).command).toEqual([
      'bun',
      'run',
      'docs:specs:check',
      '--staged',
      '--base',
      'origin/main',
    ]);
  });

  test('preserves pinned tools and working directories in the registry', () => {
    expect(resolveQualityCheck('rust-clippy').command).toEqual([
      'rustup',
      'run',
      '1.90.0',
      'cargo',
      'clippy',
      '--manifest-path',
      'project-hostd/Cargo.toml',
      '--locked',
      '--',
      '-D',
      'warnings',
    ]);
    expect(resolveQualityCheck('docs-build')).toMatchObject({
      command: ['bun', 'run', 'build'],
      cwd: 'apps/docs',
    });
    expect(sharedCheckCommand('go-race')).toEqual([
      'bun',
      'run',
      'ci:check',
      '--',
      'go-race',
    ]);
  });

  test('normalizes the staged snapshot prefix for Git on every platform', () => {
    expect(gitCheckoutIndexPrefix('/private/tmp/index')).toBe('/private/tmp/index/');
    expect(gitCheckoutIndexPrefix('C:\\Temp\\index')).toBe('C:/Temp/index/');
  });

  test('wires Lefthook to the shared staged commands', () => {
    const config = readFileSync('lefthook.yml', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
      trustedDependencies: string[];
    };

    expect(config).toContain('min_version: 2.1.10');
    expect(config.match(/bun run ci:check -- --staged/g)).toHaveLength(3);
    expect(config).not.toContain('stage_fixed');
    expect(packageJson.devDependencies.lefthook).toBe('2.1.10');
    expect(packageJson.trustedDependencies).toContain('lefthook');
    expect(packageJson.scripts['check:pre-commit']).toBe(
      'bun run ci:check -- --pre-commit',
    );
  });
});
