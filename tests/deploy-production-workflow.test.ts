import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/deploy-production.yml', import.meta.url);
const dockerIgnorePath = new URL('../.dockerignore', import.meta.url);

describe('production deployment workflow contract', () => {
  test('deploys main through one non-cancelling Production lane', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('release:\n    types: [published]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('group: project-space-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('name: Production');
    expect(workflow).toContain('--commit "$REQUESTED_COMMIT"');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/tags/v* ]]');
    expect(workflow).toContain('requested_commit: ${{ steps.requested-commit.outputs.commit }}');
    expect(workflow).toContain('"${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/commits/main"');
    expect(workflow).toContain('ref: ${{ steps.requested-commit.outputs.commit }}');
    expect(workflow).toContain('REQUESTED_COMMIT: ${{ needs.validate.outputs.requested_commit }}');
    expect(workflow).toContain('https://projects.os-home.net/api/app/meta');
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
    expect(workflow).toContain('bun test --isolate');
    expect(workflow).toContain('go test ./...');
    expect(workflow).toContain("steps.current-main.outputs.superseded != 'true'");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('export-env: true');
    expect(workflow).toContain('-o "$RUNNER_TEMP/project"');
    expect(workflow).not.toContain('-o bin/project');
    expect(workflow).toContain("deploy-result.json | tee -a \"$GITHUB_STEP_SUMMARY\"");
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
    const credentials = [
      {
        name: 'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_PASSWORD',
        reference: 'op://projects/project-space-mqtt-jetkvm-b46e1a936ac89a4e-client/password'
      },
      {
        name: 'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_USERNAME',
        reference: 'op://projects/project-space-mqtt-jetkvm-b46e1a936ac89a4e-client/username'
      }
    ] as const;

    for (const credential of credentials) {
      expect(workflow).toContain(`${credential.name}: ${credential.reference}`);
      expect(workflow).toContain(
        `${credential.name}: \${{ steps.deploy-secrets.outputs.${credential.name} }}`
      );
    }
  });
});
