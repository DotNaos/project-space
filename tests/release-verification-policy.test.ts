import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { releaseVerificationPolicy } from '../scripts/release-verification-policy';

const patch = {
  baseVersion: '0.4.49',
  changedPaths: ['src/features/project-desktop/example.tsx'],
  eventName: 'pull_request',
  headVersion: '0.4.50',
};

describe('release verification policy', () => {
  test('uses the measured Linux fast path for an ordinary patch', () => {
    expect(releaseVerificationPolicy(patch)).toEqual({
      fullMatrix: false,
      reason: 'ordinary patch uses Linux proof plus all shared quality gates',
    });
  });

  test.each([
    ['minor release', { ...patch, headVersion: '0.5.0' }],
    ['major release', { ...patch, headVersion: '1.0.0' }],
    ['non-sequential version', { ...patch, headVersion: '0.4.51' }],
    ['release workflow', { ...patch, changedPaths: ['.github/workflows/release.yml'] }],
    ['release quality action', { ...patch, changedPaths: ['.github/actions/release-quality/action.yml'] }],
    ['verification policy', { ...patch, changedPaths: ['scripts/release-verification-policy.ts'] }],
    ['verification policy test', { ...patch, changedPaths: ['tests/release-verification-policy.test.ts'] }],
    ['Windows source', { ...patch, changedPaths: ['cmd/project/example_windows.go'] }],
    ['connector source', { ...patch, changedPaths: ['server/connector-example.ts'] }],
    ['ambiguous paths', { ...patch, changedPaths: [] }],
    ['on-demand verification', { ...patch, eventName: 'workflow_dispatch' }],
    ['tag verification', { ...patch, eventName: 'push' }],
  ])('keeps the full platform matrix for %s', (_name, input) => {
    expect(releaseVerificationPolicy(input).fullMatrix).toBe(true);
  });

  test('wires and enforces the selected matrix', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const action = readFileSync(
      '.github/actions/release-quality/action.yml',
      'utf8',
    );
    const docs = readFileSync('docs/ci-reliability.md', 'utf8');
    const windows = workflow.slice(
      workflow.indexOf('  windows-x64:'),
      workflow.indexOf('  linux-x64:'),
    );
    const linux = workflow.slice(
      workflow.indexOf('  linux-x64:'),
      workflow.indexOf('  macos-arm64:'),
    );
    const macos = workflow.slice(
      workflow.indexOf('  macos-arm64:'),
      workflow.indexOf('  verification-policy:'),
    );

    expect(workflow).toContain(
      'group: release-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow).toContain(
      'full-matrix: ${{ steps.quality.outputs.full-matrix }}',
    );
    expect(windows).toContain(
      "if: needs.quality.outputs.full-matrix == 'true'",
    );
    expect(macos).toContain(
      "if: needs.quality.outputs.full-matrix == 'true'",
    );
    expect(linux).not.toContain('full-matrix');
    expect(workflow).toContain('name: Release verification policy');
    expect(workflow).toContain(
      '[[ "$WINDOWS_RESULT" == skipped && "$MACOS_RESULT" == skipped ]]',
    );
    expect(action).toContain('bun scripts/release-verification-policy.ts');
    expect(action).toContain('go test -race ./...');
    expect(docs).toContain(
      '| Ordinary sequential patch | required | required | required | skipped | skipped |',
    );
    expect(docs).toContain(
      '| Median runner use | 8.65 min | 4.35 min | -49.7% |',
    );
  });
});
