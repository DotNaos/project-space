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
    ['Windows test', { ...patch, changedPaths: ['cmd/project/prepare_windows_test.go'] }],
    ['Darwin architecture source', { ...patch, changedPaths: ['cmd/project/example_darwin_arm64.go'] }],
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
    const quality = readFileSync(
      '.github/workflows/release-quality.yml',
      'utf8',
    );
    const linux = readFileSync(
      '.github/workflows/release-linux.yml',
      'utf8',
    );
    const windows = readFileSync(
      '.github/workflows/release-windows.yml',
      'utf8',
    );
    const docs = readFileSync('docs/ci-reliability.md', 'utf8');
    const windowsCall = workflow.slice(
      workflow.indexOf('  windows-x64:'),
      workflow.indexOf('  linux-x64:'),
    );
    const linuxCall = workflow.slice(
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
      'full-matrix: ${{ steps.classify.outputs.full-matrix }}',
    );
    expect(workflow).toContain(
      'uses: ./.github/workflows/release-quality.yml',
    );
    for (const reachableCriticalPath of [
      "'.github/actions/release-quality/**'",
      "'internal/approvalsigner/**'",
      "'scripts/ci-preflight.ts'",
      "'scripts/prepare-release-pr.ts'",
      "'scripts/release-identity.ts'",
      "'scripts/release-verification-policy.ts'",
    ]) {
      expect(workflow).toContain(reachableCriticalPath);
    }
    expect(windowsCall).toContain(
      "if: needs.classify.outputs.full-matrix == 'true'",
    );
    expect(windowsCall).toContain('uses: ./.github/workflows/release-windows.yml');
    expect(macos).toContain(
      "if: needs.classify.outputs.full-matrix == 'true'",
    );
    expect(linuxCall).not.toContain('full-matrix');
    expect(linuxCall).toContain('uses: ./.github/workflows/release-linux.yml');
    expect(workflow).toContain('name: Cross-platform quality gates');
    expect(workflow).toContain(
      'SHARED_QUALITY_RESULT: ${{ needs.shared-quality.result }}',
    );
    expect(workflow).toContain('[[ "$SHARED_QUALITY_RESULT" == success ]]');
    expect(workflow).toContain('name: Release verification policy');
    expect(workflow).toContain('QUALITY_RESULT: ${{ needs.quality.result }}');
    expect(workflow).toContain('[[ "$QUALITY_RESULT" == success ]]');
    expect(workflow).toContain(
      '[[ "$WINDOWS_RESULT" == skipped && "$MACOS_RESULT" == skipped ]]',
    );

    expect(action).toContain('bun scripts/release-verification-policy.ts');
    expect(action).not.toContain('bun install');
    expect(action).not.toContain('bun test');
    expect(action).not.toContain('go test');
    expect(action).not.toContain('go vet');

    const typescript = quality.slice(
      quality.indexOf('  typescript:'),
      quality.indexOf('  mobile:'),
    );
    const mobile = quality.slice(
      quality.indexOf('  mobile:'),
      quality.indexOf('  go:'),
    );
    const go = quality.slice(quality.indexOf('  go:'));
    expect(typescript).not.toContain('needs:');
    expect(mobile).not.toContain('needs:');
    expect(go).not.toContain('needs:');
    expect(typescript).toContain('bun run check');
    expect(typescript).toContain('bun test --isolate');
    expect(typescript).toContain('bun run build:web');
    expect(mobile).toContain(
      'bun install --frozen-lockfile',
    );
    expect(mobile).toContain("hashFiles('apps/mobile/bun.lock')");
    expect(mobile).toContain('bun run build:prototype');
    expect(go).toContain('go test -race ./...');
    expect(go).toContain('go vet ./...');

    const exactCacheKey =
      "key: bun-${{ runner.os }}-${{ runner.arch }}-1.3.14-${{ hashFiles('bun.lock') }}";
    for (const cachedWorkflow of [quality, linux, windows]) {
      expect(cachedWorkflow).toContain(
        'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830',
      );
      expect(cachedWorkflow).toContain(exactCacheKey);
      expect(cachedWorkflow).not.toContain('restore-keys:');
    }
    expect(linux).toContain('packaging/linux/test-release-packaging.sh "$VERSION"');
    expect(linux).not.toContain('go test ');
    expect(linux).not.toContain('go vet ');
    expect(windows).toContain('bun test tests/windows-release-version.test.ts');
    expect(windows).not.toContain('bun run check');
    expect(windows).toContain('packaging\\windows\\test-release-packaging.ps1');
    expect(windows).toContain('winget validate --ignore-warnings');

    expect(docs).toContain(
      '| Ordinary sequential patch | required | required | required | required | required | skipped | skipped |',
    );
    expect(docs).toContain(
      '| Median runner use | 8.65 min | 4.35 min | -49.7% |',
    );
  });
});
