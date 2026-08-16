import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  fastCiSelection,
  releaseVerificationPolicy,
} from '../scripts/release-verification-policy';

const patch = {
  baseVersion: '0.4.49',
  changedPaths: ['src/features/project-desktop/example.tsx'],
  eventName: 'pull_request',
  headVersion: '0.4.49',
};

describe('release verification policy', () => {
  test('uses changed-path extras for an ordinary unversioned pull request', () => {
    expect(releaseVerificationPolicy(patch)).toEqual({
      fullMatrix: false,
      reason: 'ordinary pull request keeps the current version and uses changed-path extras',
    });
    expect(fastCiSelection([
      ...patch.changedPaths,
      '.github/release-intents/4a35123b-2783-4f15-a29b-05da1aa6630a.json',
    ], false)).toEqual({
      cliDocs: false,
      docs: false,
      go: false,
      mobile: false,
      rust: false,
      workflow: false,
    });
  });

  test.each([
    ['patch release', { ...patch, headVersion: '0.4.50' }],
    ['minor release', { ...patch, headVersion: '0.5.0' }],
    ['major release', { ...patch, headVersion: '1.0.0' }],
    ['non-sequential version', { ...patch, headVersion: '0.4.51' }],
    ['release workflow', { ...patch, changedPaths: ['.github/workflows/release.yml'] }],
    ['release quality action', { ...patch, changedPaths: ['.github/actions/release-quality/action.yml'] }],
    ['verification policy', { ...patch, changedPaths: ['scripts/release-verification-policy.ts'] }],
    ['release queue', { ...patch, changedPaths: ['scripts/release-queue-state.ts'] }],
    ['release queue evidence', { ...patch, changedPaths: ['scripts/release-queue-evidence.ts'] }],
    ['release tombstone', { ...patch, changedPaths: ['scripts/release-tombstone.ts'] }],
    ['release tombstone GitHub proof', { ...patch, changedPaths: ['scripts/release-tombstone-github.ts'] }],
    ['release tombstone verifier', { ...patch, changedPaths: ['scripts/verify-release-tombstone.ts'] }],
    ['verification policy test', { ...patch, changedPaths: ['tests/release-verification-policy.test.ts'] }],
    ['Windows source', { ...patch, changedPaths: ['cmd/project/example_windows.go'] }],
    ['Windows test', { ...patch, changedPaths: ['cmd/project/prepare_windows_test.go'] }],
    ['Darwin architecture source', { ...patch, changedPaths: ['cmd/project/example_darwin_arm64.go'] }],
    ['connector source', { ...patch, changedPaths: ['server/connector-example.ts'] }],
    ['hostd source', { ...patch, changedPaths: ['project-hostd/src/main.rs'] }],
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
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
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

    expect(workflow).toContain('on:\n  workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toContain('group: project-space-release-publication');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain(
      'full-matrix: ${{ steps.classify.outputs.full-matrix }}',
    );
    expect(workflow).toContain(
      'uses: ./.github/workflows/release-quality.yml',
    );
    expect(ci).toContain('bun scripts/release-verification-policy.ts');
    expect(ci).toContain(
      'BASE_SHA: ${{ github.event.pull_request.base.sha || inputs.base_sha }}',
    );
    expect(ci).toContain(
      'HEAD_SHA: ${{ github.event.pull_request.head.sha || inputs.requested_head_sha }}',
    );
    expect(ci).toContain('EVENT_NAME: pull_request');
    expect(ci).toContain('name: Windows CLI compatibility');
    expect(ci).toContain("if: needs.fast-ci.outputs.go == 'true'");
    expect(ci).toContain(
      "go test ./cmd/project -run '^TestWindows' -count=1",
    );
    expect(ci).toContain(
      "go test ./internal/machineconnect ./internal/selfupdate -run '^$'",
    );
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
    const go = quality.slice(quality.indexOf('  go:'), quality.indexOf('  rust:'));
    const rust = quality.slice(quality.indexOf('  rust:'));
    expect(typescript).not.toContain('needs:');
    expect(mobile).not.toContain('needs:');
    expect(go).not.toContain('needs:');
    expect(rust).not.toContain('needs:');
    expect(typescript).toContain('bun run ci:check -- typecheck tests web-build');
    expect(mobile).toContain('bun run ci:check -- mobile-dependencies');
    expect(mobile).toContain("hashFiles('apps/mobile/bun.lock')");
    expect(mobile).toContain('bun run ci:check -- mobile-build');
    expect(go).toContain('bun run ci:check -- go-race go-vet');
    expect(rust).toContain('bun run ci:check -- rust-format rust-clippy rust-tests');

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

    expect(docs).toContain('An ordinary pull request has two merge-relevant results:');
    expect(docs).toContain('The expected feedback target under normal runner availability is two to five');
    expect(docs).toContain('`release.yml` is manual tag-dispatch');
  });
});
