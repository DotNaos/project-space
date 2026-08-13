import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('remote development architecture documentation', () => {
  test('records the current hierarchy and control boundaries', () => {
    const architecture = source('docs/remote-development-architecture.md');
    const docsPage = source(
      'apps/docs/content/docs/environments/architecture.mdx',
    );
    const navigation = source('apps/docs/content/docs/environments/meta.json');

    for (const term of [
      'Platform',
      'optional Host',
      'Environment Instance',
      'Workspace Runtime',
      'project inventory --format json',
      'project environment bootstrap',
      'SSH over approved private network',
      'runtime.register',
      'runtime.codex.v1',
      'project-hostd',
      'typed Host operations',
      '#643',
      'Connector is retired',
    ]) {
      expect(architecture).toContain(term);
    }

    expect(architecture).not.toContain('project connector install');
    expect(architecture).not.toContain('connector service start');
    expect(architecture).not.toContain('fallback');
    expect(architecture).not.toContain('compatibility window');
    expect(docsPage).toContain('project environment bootstrap');
    expect(docsPage).toContain('remote-development-architecture.md');
    expect(navigation).toContain('"architecture"');
  });
});
