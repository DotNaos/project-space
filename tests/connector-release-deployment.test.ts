import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repositoryRoot = join(import.meta.dir, '..');
const releaseWorkflowPaths = [
  '.github/actions/release-quality/action.yml',
  '.github/workflows/release.yml',
  '.github/workflows/release-trust-roots.yml',
  '.github/workflows/release-quality.yml',
  '.github/workflows/release-linux.yml',
  '.github/workflows/release-macos.yml',
  '.github/workflows/release-windows.yml',
  '.github/workflows/release-manifest-sign.yml',
  '.github/workflows/release-publish.yml'
] as const;

async function source(path: string) {
  return readFile(join(repositoryRoot, path), 'utf8');
}

function jobBlock(workflow: string, job: string) {
  const startMarker = `\n  ${job}:\n`;
  const start = workflow.indexOf(startMarker);
  if (start < 0) throw new Error(`Workflow job is missing: ${job}`);
  const rest = workflow.slice(start + startMarker.length);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

function actionReferences(workflow: string) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1]!
  );
}

function expectNoRepositoryExecution(block: string) {
  for (const forbidden of [
    'actions/checkout@',
    'setup-bun@',
    'setup-go@',
    'bun install',
    'bun run',
    'go build',
    'swiftc ',
    'packaging/',
    'GITHUB_WORKSPACE'
  ]) {
    expect(block).not.toContain(forbidden);
  }
}

function embeddedPython(workflow: string, anchor: string) {
  const anchorIndex = workflow.indexOf(anchor);
  if (anchorIndex < 0) throw new Error(`Embedded script anchor is missing: ${anchor}`);
  const marker = "<<'PY'\n";
  const start = workflow.indexOf(marker, anchorIndex) + marker.length;
  const end = workflow.indexOf('\n          PY', start);
  if (start < marker.length || end < 0) throw new Error('Embedded Python script is invalid.');
  return workflow
    .slice(start, end)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

async function runPythonClassifier(code: string, release: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'project-release-cleanup-'));
  const input = join(root, 'releases.json');
  await writeFile(input, JSON.stringify(release));
  const process = Bun.spawn(
    ['python3', '-I', '-c', code, input, 'v0.4.5', 'a'.repeat(40), '1234', '2'],
    { stderr: 'pipe', stdout: 'pipe' }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  return { exitCode, stderr, stdout };
}

describe('connector release and production deployment contract', () => {
  test('pins the next immutable semantic release consistently', async () => {
    const packageJson = JSON.parse(await source('package.json'));
    const buildInfo = await source('server/connector-build-info.ts');
    const linuxCodexPreparation = await source('packaging/linux/prepare-codex-runtime.sh');
    const linuxCodexSmoke = await source('packaging/linux/smoke-codex-runtime.ts');
    const linuxReleaseWorkflow = await source('.github/workflows/release-linux.yml');
    const windowsPackaging = await source('packaging/windows/test-release-packaging.ps1');
    const windowsDocumentation = await source('docs/windows-installation.md');

    expect(packageJson.version).toBe('0.4.66');
    expect(buildInfo).toContain("const developmentVersion = '0.4.66';");
    expect(windowsPackaging).toContain("$version = '0.4.66'");
    expect(windowsPackaging).toContain('/releases/download/v0.4.66/');
    expect(windowsDocumentation).toContain('DotNaos\\Project\\0.4.66');
    expect(linuxCodexPreparation).toContain('codex_version=0.145.0');
    expect(linuxCodexPreparation).not.toMatch(/releases\/latest|\/latest\//);
    expect(linuxCodexSmoke).toContain("import { CodexStdioTransport }");
    expect(linuxCodexSmoke).toContain('launch: (path) => CodexStdioTransport.launch({');
    expect(linuxCodexSmoke).toContain('binaryPath: path');
    expect(linuxReleaseWorkflow).toContain('prepare-codex-runtime.sh "$(pwd -P)/dist/linux"');
    expect(linuxReleaseWorkflow).toContain(
      'bun packaging/linux/smoke-codex-runtime.ts "$(pwd -P)/dist/linux/codex"'
    );
    expect(packageJson.scripts['build:project-cli:macos-arm64']).toContain(
      'main.projectMachineClientReleaseID=v$npm_package_version'
    );
    expect(packageJson.scripts['build:project-cli:macos-arm64']).toContain(
      'main.projectMachineClientBuildID=$build_sha'
    );
  });

  test('pins every third-party action and permits only immutable reusable calls', async () => {
    for (const path of releaseWorkflowPaths) {
      for (const reference of actionReferences(await source(path))) {
        const isLocalWorkflow = reference.startsWith('./.github/');
        const isPinnedAction = /^[^@\s]+@[a-f0-9]{40}$/.test(reference);
        const isPinnedReusable =
          /^DotNaos\/project-space\/.github\/workflows\/[A-Za-z0-9._-]+@[a-f0-9]{40}$/.test(
            reference
          );
        expect(isLocalWorkflow || isPinnedAction || isPinnedReusable).toBe(true);
        expect(reference).not.toMatch(/@(main|master|v[0-9]+)$/);
      }
    }
  });

  test('orchestrates isolated platform builds and grants signer permissions explicitly', async () => {
    const workflow = await source('.github/workflows/release.yml');
    const classifier = await source('.github/actions/release-quality/action.yml');
    const linux = await source('.github/workflows/release-linux.yml');
    const macosWorkflow = await source('.github/workflows/release-macos.yml');
    const windows = await source('.github/workflows/release-windows.yml');
    const macos = jobBlock(workflow, 'macos-arm64');
    const manifestSign = jobBlock(workflow, 'manifest-sign');
    const publish = jobBlock(workflow, 'publish');

    expect(macos).toContain('release-macos.yml');
    expect(macos).toContain('actions: read');
    expect(macos).toContain('contents: read');
    expect(macos).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(manifestSign).toContain('release-manifest-sign.yml');
    expect(manifestSign).toContain('actions: read');
    expect(manifestSign).toContain('contents: read');
    expect(publish).toContain('release-publish.yml');
    expect(publish).toContain('contents: write');
    expect(publish).toContain('needs: [classify, release-finalize]');
    expect(workflow).toContain('group: project-space-release-publication');
    expect(workflow).toContain('Continue the serial release queue');
    expect(workflow).toContain(
      'gh workflow run release-from-main.yml --repo "$GITHUB_REPOSITORY" --ref main'
    );
    expect(classifier).toContain('version=${REF_NAME#v}');
    expect(classifier).not.toContain('does not match package.json version');
    expect(linux).not.toContain('package_version == "$RELEASE_VERSION"');
    expect(macosWorkflow).not.toContain('package_version == "$RELEASE_VERSION"');
    expect(macosWorkflow).toContain('RELEASE_ID: v${{ inputs.version }}');
    expect(macosWorkflow).toContain('VERSION: ${{ inputs.version }}');
    expect(windows).not.toContain('$packageVersion -ne');
    expect(windows).toContain("$releaseVersion = '${{ inputs.version }}'");
    expect(workflow).not.toContain('derive-trust-roots.ts derive');
    expect(workflow).not.toContain('release-manifest-cli.ts create');
    expect(workflow).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(workflow).not.toContain('PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64');
    expect(workflow).not.toContain('1password/load-secrets-action@');
  });

  test('materializes reviewed public roots without private keys or repository code', async () => {
    const workflow = await source('.github/workflows/release-trust-roots.yml');

    expect(workflow).not.toContain('actions/checkout@');
    expect(workflow).not.toContain('setup-bun@');
    expect(workflow).not.toContain('1password/');
    expect(workflow).not.toContain('PRIVATE_KEY');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).toContain(
      '502f8b9dbbabec58aa8d2c794c7c052d5974215e2180f9e47ed4d7cff4ee45c1'
    );
    expect(workflow).toContain(
      'aff71d44e194f87e7e958296306059d3d5b55d7c369963b61d57627e03f4a451'
    );

    const roots = [
      [
        'packaging/release/trust-roots/connector-command-signing-public-key.pem',
        '502f8b9dbbabec58aa8d2c794c7c052d5974215e2180f9e47ed4d7cff4ee45c1'
      ],
      [
        'packaging/release/trust-roots/release-manifest-signing-public-key.pem',
        'aff71d44e194f87e7e958296306059d3d5b55d7c369963b61d57627e03f4a451'
      ]
    ] as const;
    for (const [path, expected] of roots) {
      const bytes = await readFile(join(repositoryRoot, path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
      expect(bytes.toString('utf8')).toMatch(
        /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/
      );
    }
  });

  test('packages macOS tools without an approval helper or signing secret', async () => {
    const workflow = await source('.github/workflows/release-macos.yml');
    const runtime = jobBlock(workflow, 'runtime');
    const packageJob = jobBlock(workflow, 'package');

    expect(runtime).toContain('runs-on: macos-15');
    expect(runtime.indexOf('Capture the protected release test harness')).toBeLessThan(
      runtime.indexOf('Check out exact source')
    );
    expect(runtime.indexOf('Check out exact source')).toBeLessThan(
      runtime.indexOf('Use the protected recovery-compatible test harness')
    );
    expect(runtime).toContain(
      'install -m 0755 "$RUNNER_TEMP/test-release-packaging.sh" packaging/macos/test-release-packaging.sh'
    );
    expect(runtime).toContain('project-codex-host');
    expect(runtime).not.toContain('dist/project-space-connector');
    expect(runtime).not.toContain('project-approval-signer');
    expect(workflow).not.toContain('environment: release-signing');
    expect(workflow).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(workflow).not.toContain('1password/load-secrets-action@');
    expect(workflow).not.toContain('codesign');
    expect(workflow).not.toContain('project-approval-signer');
    expect(packageJob).toContain('needs: runtime');
    expect(packageJob).toContain('RUNTIME_ARTIFACT_ID');
    expect(packageJob).toContain('TRUST_ARTIFACT_ID');
    expect(packageJob).toContain('commits/v${RELEASE_VERSION}');
    expect(packageJob).toContain('compare/${RELEASE_SOURCE_SHA}...main');
    expect(packageJob.indexOf('Validate immutable artifact metadata and release source')).toBeLessThan(
      packageJob.indexOf('Check out exact source after artifact validation')
    );
  });

  test('signs the canonical manifest without checkout or repository execution', async () => {
    const workflow = await source('.github/workflows/release-manifest-sign.yml');
    const sign = jobBlock(workflow, 'sign');

    expect(sign).toContain('runs-on: ubuntu-24.04');
    expect(sign).toContain('environment: release-signing');
    expect(sign).toContain('Release tag must point at the exact queued merge.');
    expect(sign).toContain('Queued release commit must be reachable from current main.');
    expect(sign).toContain('workflow.get("id") == int(sys.argv[6])');
    expect(sign).toContain('Prepared release manifest is not the exact canonical signing payload.');
    expect(sign).toContain(
      'else ["codex.account.device-login.v1", "codex.runtime.v1", "runtime.restart", "runtime.update"]'
    );
    expect(sign).toContain('openssl pkeyutl -sign -rawin');
    expect(sign).toContain('signature-size=64');
    expect(sign).toContain('Remove dedicated signing key material');
    expect(sign.indexOf('Remove dedicated signing key material')).toBeLessThan(
      sign.indexOf('Upload signed manifest handoff')
    );
    expect(sign).toContain("steps.signature.outcome == 'success'");
    expectNoRepositoryExecution(sign);
    expect(sign).not.toContain('contents: write');
  });

  test('publishes only a verified draft handoff on a fresh no-checkout runner', async () => {
    const workflow = await source('.github/workflows/release-publish.yml');
    const publish = jobBlock(workflow, 'publish');

    expect(workflow).toContain('contents: write');
    expect(workflow).not.toContain('1password/');
    expect(workflow).not.toContain('PRIVATE_KEY');
    expectNoRepositoryExecution(publish);
    expect(publish).toContain('exact twelve-file allowlist');
    expect(publish).toContain('asset-count=10');
    expect(publish).toContain('"draft": True');
    expect(publish).toContain('Verify remote draft asset names and sizes');
    expect(publish).toContain('Release commit must be reachable from current main.');
    expect(publish).toContain('$api_root/compare/$EXPECTED_SHA...main');
    expect(publish).toContain('"draft":false');
    expect(publish).toContain('Delete incomplete draft release');
    expect(publish).toContain("steps.publish.outcome != 'success'");
    expect(publish).toContain('project-space-release-run:');
    expect(publish).toContain('release.get("draft") is False');
    expect(publish).toContain('confirmed_state == "draft:${release_id}"');
    expect(publish.indexOf('Create draft GitHub release')).toBeLessThan(
      publish.indexOf('Publish verified release')
    );
  });

  test('recovers a lost draft response but never deletes a release already published', async () => {
    const workflow = await source('.github/workflows/release-publish.yml');
    const classifier = embeddedPython(
      workflow,
      '/bin/cat > "$classifier"'
    );
    const marker = `<!-- project-space-release-run:1234:2:${'a'.repeat(40)} -->`;
    const draft = {
      body: `${marker}\nGenerated notes`,
      draft: true,
      id: 77,
      name: 'v0.4.5',
      prerelease: false,
      published_at: null,
      tag_name: 'v0.4.5',
      target_commitish: 'a'.repeat(40)
    };

    const lostCreateResponse = await runPythonClassifier(classifier, draft);
    expect(lostCreateResponse).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: 'draft:77\n'
    });

    const lostPublishResponse = await runPythonClassifier(classifier, {
      ...draft,
      draft: false,
      published_at: '2026-07-14T00:00:00Z'
    });
    expect(lostPublishResponse).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: 'published:77\n'
    });
  });

  test('normalizes and packages only fixed release inventories', async () => {
    const workflow = await source('.github/workflows/release.yml');
    const finalize = jobBlock(workflow, 'release-finalize');
    const normalize = await source('packaging/release/normalize-platform-artifacts.sh');
    const publish = await source('packaging/release/create-publish-handoff.sh');
    const macos = await source('packaging/macos/package-isolated-release-artifact.sh');

    for (const script of [normalize, publish, macos]) {
      expect(script).toContain('set -euo pipefail');
    }
    expect(normalize).toContain('-type l');
    expect(publish).toContain('-type l');
    expect(macos).toContain('! -L $path');
    expect(normalize).toContain('Expected $expected_count normalized platform assets');
    expect(normalize).toContain('stat -c %h');
    expect(publish).toContain('schema=project-space.github-release/v1');
    expect(publish).toContain('PUBLISH-SHA256SUMS.txt');
    expect(finalize).toContain(
      'manifest_path="$RUNNER_TEMP/project-space-release-manifest.json"'
    );
    expect(finalize).not.toContain(
      'manifest_path="$RUNNER_TEMP/release-assets/project-space-release-manifest.json"'
    );
    expect(finalize).toContain(
      '"$RUNNER_TEMP/release-assets" \\\n            "$manifest_path"'
    );
    expect(macos).toContain("stat -f '%l'");
    expect(macos).not.toContain('codesign');
    expect(macos).toContain(
      '/usr/bin/install -m 0755 /dev/null "$staging_directory/project-approval-signer"'
    );
    expect(macos).toContain('project-approval-signer:0:0');
    expect(macos).not.toContain('connector-command-signing-public-key.pem');
    expect(macos).toContain(
      'aff71d44e194f87e7e958296306059d3d5b55d7c369963b61d57627e03f4a451'
    );
  });

  test('deploys only the public root and derives the approved release without fetching it', async () => {
    const workflow = await source('.github/workflows/deploy-production.yml');
    const deployConfig = await source('deploy/deploy.yaml');
    const compose = await source('deploy/compose.yml');

    expect(workflow).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: op://projects/project-space-release-manifest-signing-key/public_key_b64'
    );
    expect(deployConfig).toContain(
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64: op://projects/project-space-release-manifest-signing-key/public_key_b64'
    );
    expect(compose).not.toContain('PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID:');
    expect(compose).not.toContain('PROJECT_CONNECTOR_REGISTRATION_TOKEN:');
    expect(compose).not.toContain('PROJECT_SPACE_CONNECTOR_BUNDLE_ASSET:');
    expect(workflow).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(deployConfig).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(compose).not.toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
  });
});
