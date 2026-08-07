import { describe, expect, test } from 'bun:test';
import {
  validateReleasePullRequest,
  type ChangedReleaseFile,
} from '../apps/docs/lib/releases/pull-request-gate';
import {
  parseReleaseIntent,
  releaseIntentDirectory,
  releaseIntentEnforcementPath,
  releaseIntentEnforcementSource,
  releaseIntentSchema,
} from '../apps/docs/lib/releases/release-intent';

const intentPath =
  `${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`;

function intentSource(intent: 'none' | 'patch' | 'minor' | 'major') {
  return `${JSON.stringify({ schema: releaseIntentSchema, intent }, null, 2)}\n`;
}

function changed(
  path: string,
  overrides: Partial<ChangedReleaseFile> = {},
): ChangedReleaseFile {
  return {
    path,
    source: 'changed\n',
    status: 'modified',
    ...overrides,
  };
}

function gateInput(
  overrides: Partial<
    Parameters<typeof validateReleasePullRequest>[0]
  > = {},
) {
  return {
    basePackageVersion: '0.4.66',
    changedFiles: [
      changed('src/features/project-desktop/example.tsx'),
      changed(intentPath, {
        source: intentSource('none'),
        status: 'added',
      }),
    ],
    headPackageVersion: '0.4.66',
    pullRequestNumber: 473,
    ...overrides,
  };
}

describe('release intent parser', () => {
  test.each(['none', 'patch', 'minor', 'major'] as const)(
    'accepts the strict %s intent contract',
    (intent) => {
      expect(parseReleaseIntent(intentSource(intent))).toEqual({
        intent: { intent, schema: releaseIntentSchema },
        ok: true,
      });
    },
  );

  test.each([
    ['malformed JSON', '{'],
    ['an array', '[]'],
    ['a wrong schema', JSON.stringify({ schema: 'project-space.release-intent/v2', intent: 'none' })],
    ['an unsupported intent', JSON.stringify({ schema: releaseIntentSchema, intent: 'build' })],
    ['an extra field', JSON.stringify({ schema: releaseIntentSchema, intent: 'none', version: '0.4.67' })],
  ])('rejects %s', (_label, source) => {
    expect(parseReleaseIntent(source).ok).toBe(false);
  });
});

describe('pull request release gate', () => {
  test('accepts one newly added none intent for app-only changes', () => {
    expect(validateReleasePullRequest(gateInput())).toEqual({
      intent: 'none',
      ok: true,
    });
  });

  test.each(['patch', 'minor', 'major'] as const)(
    'accepts a %s intent for connector-sensitive changes without assigning a version',
    (intent) => {
      const result = validateReleasePullRequest(gateInput({
        changedFiles: [
          changed('server/connector-runtime.ts'),
          changed(intentPath, {
            source: intentSource(intent),
            status: 'added',
          }),
        ],
      }));

      expect(result).toEqual({ intent, ok: true });
    },
  );

  test('requires exactly one newly added canonical UUID intent file', () => {
    const cases = [
      gateInput({
        changedFiles: [changed('src/main.tsx')],
      }),
      gateInput({
        changedFiles: [
          changed(intentPath, {
            source: intentSource('none'),
            status: 'added',
          }),
          changed(
            `${releaseIntentDirectory}/6f2504e0-4f89-41d3-9a0c-0305e82c3301.json`,
            { source: intentSource('none'), status: 'added' },
          ),
        ],
      }),
      gateInput({
        changedFiles: [
          changed(intentPath, { source: intentSource('none') }),
        ],
      }),
      gateInput({
        changedFiles: [
          changed(`${releaseIntentDirectory}/release.json`, {
            source: intentSource('none'),
            status: 'added',
          }),
        ],
      }),
      gateInput({
        changedFiles: [
          changed(`${releaseIntentDirectory}/nested/${intentPath.split('/').at(-1)}`, {
            source: intentSource('none'),
            status: 'added',
          }),
        ],
      }),
    ];

    for (const input of cases) {
      expect(validateReleasePullRequest(input).ok).toBe(false);
    }
  });

  test('rejects malformed or ambiguous intent contents', () => {
    for (const source of [
      '',
      '{',
      JSON.stringify({ schema: releaseIntentSchema, intent: 'none', version: '0.4.67' }),
    ]) {
      const result = validateReleasePullRequest(gateInput({
        changedFiles: [
          changed(intentPath, { source, status: 'added' }),
        ],
      }));
      expect(result.ok).toBe(false);
    }
  });

  test('refuses concrete package version assignment in a pull request', () => {
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed('package.json'),
        changed(intentPath, {
          source: intentSource('patch'),
          status: 'added',
        }),
      ],
      headPackageVersion: '0.4.67',
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'must not change package.json version 0.4.66',
    );
  });

  test('keeps every historical release entry immutable', () => {
    const historical =
      'apps/docs/content/docs/releases/entries/486.mdx';
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed(historical),
        changed(intentPath, {
          source: intentSource('patch'),
          status: 'added',
        }),
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(historical);
  });

  test('allows only the exact one-time enforcement marker addition', () => {
    expect(validateReleasePullRequest(gateInput({
      changedFiles: [
        ...gateInput().changedFiles,
        changed(releaseIntentEnforcementPath, {
          source: releaseIntentEnforcementSource,
          status: 'added',
        }),
      ],
    }))).toEqual({ intent: 'none', ok: true });

    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        ...gateInput().changedFiles,
        changed(releaseIntentEnforcementPath, {
          source: 'changed\n',
          status: 'modified',
        }),
      ],
    }));
    expect(result.ok).toBe(false);
  });

  test('reports every exact connector-sensitive path rejected by none', () => {
    const sensitive = [
      'cmd/project/main.go',
      'packaging/macos/build-machine-tools.sh',
      'server/connector-runtime.ts',
    ];
    const result = validateReleasePullRequest(gateInput({
      changedFiles: [
        changed('src/features/project-desktop/example.tsx'),
        ...sensitive.map((path) => changed(path)),
        changed(intentPath, {
          source: intentSource('none'),
          status: 'added',
        }),
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain(
      'Release intent "none" cannot cover connector-sensitive changes',
    );
    for (const path of sensitive) {
      expect(result.errors.join('\n')).toContain(`- ${path}`);
    }
    expect(result.errors.join('\n')).not.toContain(
      '- src/features/project-desktop/example.tsx',
    );
  });
});
