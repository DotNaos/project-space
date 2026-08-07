import { describe, expect, test } from 'bun:test';

import {
  connectorReleaseSensitivePaths,
  isConnectorReleaseSensitivePath
} from './connector-release-paths';

describe('connector release drift gate', () => {
  test('allows app-only descendants to reuse their signed ancestor release', () => {
    for (const path of [
      'docs/connector.md',
      'src/features/codex-sessions/codex-session-list.tsx',
      'tests/codex-inventory-truth-ui.test.tsx',
      '.github/workflows/deploy-production.yml'
    ]) {
      expect(isConnectorReleaseSensitivePath(path)).toBe(false);
    }
  });

  test('requires a new release for connector, CLI, shared contract, and packaging changes', () => {
    const paths = [
      'cmd/project/main.go',
      'internal/selfupdate/update.go',
      'server/web-server.ts',
      'src/shared/codex-sessions-api.ts',
      'packaging/macos/install.sh',
      'package.json',
      'bun.lock',
      'go.mod',
      'go.sum',
      'tsconfig.node.json',
      '.github/workflows/release-macos.yml'
    ];
    expect(connectorReleaseSensitivePaths(paths)).toEqual(paths);
  });

  test('rejects the sensitive source side of a move into an app-only directory', () => {
    expect(connectorReleaseSensitivePaths([
      'server/connector-runtime.ts',
      'src/features/connector-runtime.ts'
    ])).toEqual(['server/connector-runtime.ts']);
  });
});
