import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workflowPath = new URL('../.github/workflows/deploy-production.yml', import.meta.url);
const dockerIgnorePath = new URL('../.dockerignore', import.meta.url);

describe('production deployment workflow contract', () => {
  test('deploys main through one non-cancelling Production lane', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain(
      'run-name: Production · ${{ inputs.commit || github.sha }} · v${{ inputs.release_version }}',
    );
    expect(workflow).not.toContain('push:\n    branches: [main]');
    expect(workflow).not.toContain('release:\n    types: [published]');
    expect(workflow).toContain('group: project-space-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('name: Production');
    expect(workflow).toContain('--commit "$REQUESTED_COMMIT"');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).not.toContain('[[ "$GITHUB_REF" == refs/tags/v* ]]');
    expect(workflow).toContain('requested_commit: ${{ steps.requested-commit.outputs.commit }}');
    expect(workflow).not.toContain('"${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/commits/main"');
    expect(workflow).toContain('ref: ${{ steps.requested-commit.outputs.commit }}');
    expect(workflow).toContain('REQUESTED_COMMIT: ${{ needs.validate.outputs.requested_commit }}');
    expect(workflow).toContain('https://projects.os-home.net/api/app/meta');
    expect(workflow).toContain('Activate exact trusted Preview assets');
    expect(workflow).toContain('/opt/platform/apps/project-space/deploy/install-preview-assets.sh');
    expect(workflow).toContain('/opt/platform/share/project-space-preview-current/asset-commit');
    expect(workflow).toContain('[[ "$preview_asset_commit" == "$REQUESTED_COMMIT" ]]');
    expect(workflow).toContain('[[ "$remote_asset_hashes" == "$local_asset_hashes" ]]');
    const previewActivation = workflow.slice(
      workflow.indexOf('Activate exact trusted Preview assets'),
      workflow.indexOf('Fail the GitHub deployment when rollout failed')
    );
    for (const asset of [
      'preview-runner.sh',
      'preview-reaper.sh',
      'preview-runtime-verification.sh',
      'preview-storage-policy.sh',
      'preview-ssh-entrypoint.sh',
      'preview-status-entrypoint.sh',
      'preview.compose.yml'
    ]) {
      expect(previewActivation.split(asset)).toHaveLength(4);
    }
    expect(workflow).not.toContain('vercel');
  });

  test('keeps validation secretless and pins every action to a full SHA', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const validateJob = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  deploy:'));
    const actionReferences = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);

    expect(validateJob).not.toContain('environment:');
    expect(validateJob).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('needs: validate');
    expect(workflow).toContain('Verify the approved connector release is published');
    expect(workflow).toContain('/releases/download/${release_id}/project-space-release-manifest.json');
    expect(workflow).toContain('--max-filesize 2097152');
    expect(workflow).toContain("--write-out '%{http_code}'");
    expect(workflow).toContain('if [[ $http_status == 404 ]]');
    expect(workflow).toContain('[[ $http_status == 200 ]]');
    expect(workflow).toContain('Could not check approved connector release');
    expect(workflow).toContain("echo 'ready=false' >> \"$GITHUB_OUTPUT\"");
    expect(workflow).toContain('Production was untouched.');
    expect(workflow).toContain("echo 'ready=true' >> \"$GITHUB_OUTPUT\"");
    expect(workflow).toContain("steps.connector-release.outputs.ready == 'true'");
    expect(workflow).toContain("needs.validate.outputs.release_ready == 'true'");
    expect(workflow).toContain('for target in darwin-arm64 linux-x64 windows-x64');
    expect(workflow).toContain('bun packaging/release/release-manifest-cli.ts verify');
    expect(workflow).toContain(
      '--public-key packaging/release/trust-roots/release-manifest-signing-public-key.pem'
    );
    expect(workflow).toContain('.manifest.releaseId == $release_id');
    expect(workflow).toContain('.manifest.version == $build_version');
    expect(workflow).toContain("release_build_id=$(jq -er '.manifest.buildId'");
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$release_build_id" "$REQUESTED_COMMIT"'
    );
    expect(workflow).toContain(
      'git diff --no-renames --name-only -z "$release_build_id" "$REQUESTED_COMMIT"'
    );
    expect(workflow).toContain('| bun packaging/release/connector-release-drift.ts');
    expect(workflow).not.toContain('.manifest.buildId == $requested_commit');
    expect(workflow).not.toContain("            '.releaseId == $release_id");
    expect(workflow.indexOf('Verify the approved connector release is published')).toBeLessThan(
      workflow.indexOf('Validate the exact deployment plan')
    );
    expect(workflow.indexOf('Deploy, verify, and roll back on failure')).toBeLessThan(
      workflow.indexOf('Activate exact trusted Preview assets')
    );
    expect(workflow.indexOf('Activate exact trusted Preview assets')).toBeLessThan(
      workflow.indexOf('Independently confirm exact live commit')
    );
    expect(workflow).toContain('bun test --isolate');
    expect(workflow).toContain('go test ./...');
    expect(workflow).toContain("steps.current-main.outputs.superseded != 'true'");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('export-env: true');
    expect(workflow).toContain('-o "$RUNNER_TEMP/project"');
    expect(workflow).not.toContain('-o bin/project');
    expect(workflow).toContain("deploy-result.json | tee -a \"$GITHUB_STEP_SUMMARY\"");
    expect(workflow).toContain('deploy-error.sanitized.log');
    expect(workflow).toContain('deployment-transition.json');
    expect(workflow).toContain('deployment-evidence.json');
    expect(workflow).not.toContain(
      'path: |\n            deploy-result.json',
    );
    expect(workflow).toContain(
      '(.rollback | {status, commit, verifiedCommit})',
    );
    expect(workflow).toContain('production_${status}');
    expect(workflow).toContain('failure_class=expected_deferred');
    expect(workflow).toContain('failure_class=invalid_change');
    expect(workflow).toContain('failure_class=infrastructure_failure');
    expect(workflow).toContain('failure_class=application_regression');
    expect(workflow).toContain('Record expected production deferral');
    expect(workflow).toContain('Upload expected production deferral');
    expect(workflow).toContain('"production_deferred"');
    expect(workflow).toContain('"expected_deferred"');
    expect(workflow).toContain(
      '[[ "$DEPLOY_EXIT_CODE" == 0 && "$status" == success ]]',
    );
    expect(workflow).toContain('Upload sanitized production transition evidence');
    expect(actionReferences.length).toBeGreaterThanOrEqual(7);
    expect(actionReferences.every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    expect(workflow).toContain('StrictHostKeyChecking yes');
    expect(workflow).toContain('tag:ci-project-space-deploy');
  });

  test('keeps generated secrets out of every Docker build context', async () => {
    const dockerIgnore = await readFile(dockerIgnorePath, 'utf8');
    expect(dockerIgnore.split('\n')).toContain('.env');
    expect(dockerIgnore.split('\n')).toContain('.env.*');
  });

  test('loads and forwards every managed machine-power credential', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const deploy = await readFile(new URL('../deploy/deploy.yaml', import.meta.url), 'utf8');
    const parsed = parse(workflow) as {
      jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
    };
    const infisical = Object.values(parsed.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.uses?.startsWith('Infisical/secrets-action@'))
    );
    expect(workflow).toContain('project-slug: project-space-production');
    expect(workflow).toContain('env-slug: prod');
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(infisical).toHaveLength(1);
    expect(infisical[0]?.with).toEqual(expect.objectContaining({
      'export-type': 'env',
      'secret-path': '/',
      'include-imports': false,
      recursive: false
    }));
    for (const name of [
      'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_PASSWORD',
      'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_USERNAME',
      'PROJECT_SPACE_TOKEN_ENCRYPTION_KEY'
    ]) {
      expect(deploy).toContain(
        `${name}: infisical://467bbc88-262a-4ea0-a238-9666d6e7e359/prod/${name}`
      );
    }
    expect(deploy).not.toContain('PROJECT_GITHUB_TOKEN');
    expect(deploy).not.toMatch(/^\s+GITHUB_TOKEN:/m);
    expect(workflow).not.toContain('GITHUB_TOKEN: ${{ env.PROJECT_GITHUB_TOKEN }}');
  });
});
