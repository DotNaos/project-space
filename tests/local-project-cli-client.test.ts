import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { projectBinary } from '../server/local-project-cli-client';

function executable(path: string) {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('project CLI binary resolution', () => {
  test('prefers the explicit absolute connector bundle path', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-cli-path-'));
    const configured = executable(join(root, 'project'));

    expect(
      projectBinary({
        environment: { PROJECT_CLI_PATH: configured },
        homeDirectory: root,
        repositoryBinary: join(root, 'missing-repository-project')
      })
    ).toBe(configured);
  });

  test('rejects relative or non-executable explicit paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-cli-invalid-'));
    const nonExecutable = join(root, 'project');
    writeFileSync(nonExecutable, 'not executable');

    expect(() =>
      projectBinary({
        environment: { PROJECT_CLI_PATH: './project' },
        homeDirectory: root,
        repositoryBinary: join(root, 'missing')
      })
    ).toThrow('absolute path');
    expect(() =>
      projectBinary({
        environment: { PROJECT_CLI_PATH: nonExecutable },
        homeDirectory: root,
        repositoryBinary: join(root, 'missing')
      })
    ).toThrow('not executable');
  });

  test('uses the installed user binary when no repository binary exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-cli-home-'));
    const installDirectory = join(root, '.local', 'bin');
    mkdirSync(installDirectory, { recursive: true });
    const installed = executable(join(installDirectory, 'project'));

    expect(
      projectBinary({
        environment: {},
        homeDirectory: root,
        repositoryBinary: join(root, 'missing-repository-project')
      })
    ).toBe(installed);
  });
});
