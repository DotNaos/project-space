import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');

describe('Homebrew delivery boundary', () => {
  test('keeps the Project formula as a supported connector delivery', () => {
    const formula = readFileSync(
      resolve(repositoryRoot, 'Formula/project.rb'),
      'utf8',
    );

    expect(formula).toContain('go", "build"');
    expect(formula).toContain('package.json');
    expect(formula).toContain('build:connector:native');
    expect(formula).toContain('bin.install "dist/project-space-connector"');
    expect(formula).toContain('depends_on "bun"');
  });

  test('retains the standalone connector formula and service', () => {
    const formulaPath = resolve(
      repositoryRoot,
      'Formula/project-space-connector.rb',
    );

    expect(existsSync(formulaPath)).toBe(true);
    const formula = readFileSync(formulaPath, 'utf8');
    expect(formula).toContain('bin.install "project-space-connector"');
    expect(formula).toContain('service do');
  });
});
