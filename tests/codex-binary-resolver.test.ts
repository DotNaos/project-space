import { describe, expect, test } from 'bun:test';

import { resolveCodexBinary } from '../server/codex-sessions/binary-resolver';

describe('Codex binary discovery', () => {
  test('skips a present but broken PATH shim and reports no working binary', () => {
    const result = resolveCodexBinary({
      environment: { PATH: '/broken/bin' },
      executable: () => true,
      platform: 'linux',
      validate: () => false
    });
    expect(result).toEqual({ attempted: ['/broken/bin/codex'] });
  });

  test('honors only an absolute explicit working override', () => {
    expect(resolveCodexBinary({
      environment: { PROJECT_CODEX_CLI_PATH: 'relative/codex' },
      executable: () => true,
      validate: () => true
    })).toEqual({ attempted: ['PROJECT_CODEX_CLI_PATH (not absolute)'] });

    expect(resolveCodexBinary({
      environment: { PROJECT_CODEX_CLI_PATH: '/opt/codex' },
      executable: () => true,
      validate: () => true
    }).path).toBe('/opt/codex');
  });
});
