import { describe, expect, test } from 'bun:test';

import {
  CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX,
  codexRuntimeVersionCapability,
  codexRuntimeVersionFromCapabilities,
  codexRuntimeVersionFromCapability
} from '../src/shared/codex-runtime-release-contract';

describe('Codex runtime release contract', () => {
  test('round-trips one exact semantic version capability', () => {
    const capability = codexRuntimeVersionCapability('0.145.0');

    expect(capability).toBe(
      `${CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX}0.145.0`
    );
    expect(codexRuntimeVersionFromCapability(capability)).toBe('0.145.0');
    expect(codexRuntimeVersionFromCapabilities([
      'codex.runtime.v1',
      capability,
      'runtime.update'
    ])).toBe('0.145.0');
  });

  test('rejects ambiguous and non-canonical version markers', () => {
    for (const version of ['1', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta']) {
      expect(() => codexRuntimeVersionCapability(version)).toThrow();
    }
    expect(codexRuntimeVersionFromCapability(
      `${CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX}01.2.3`
    )).toBeUndefined();
    expect(codexRuntimeVersionFromCapabilities([
      `${CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX}1.2.3`,
      `${CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX}1.2.4`
    ])).toBeUndefined();
  });
});
