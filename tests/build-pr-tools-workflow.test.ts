import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/build-pr-tools.yml', import.meta.url);

function actionReferences(workflow: string) {
  return [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
}

describe('manual PR development tools workflow', () => {
  test('can only be requested explicitly and cannot release or deploy', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\npermissions:'));
    expect(triggers).not.toContain('\n  pull_request:');
    expect(triggers).not.toContain('\n  push:');
    expect(triggers).not.toContain('\n  schedule:');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('requested_head_sha:');
    expect(workflow).toContain('linux_x64:');
    expect(workflow).toContain('macos_arm64:');
    expect(workflow).toContain('windows_x64:');
    expect(workflow).not.toContain('environment:');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('gh release');
    expect(workflow).not.toContain('project deploy');
    expect(workflow).not.toContain('docker push');
  });

  test('fails closed around an exact open same-repository PR head', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow.match(/\.state == "open"/g)).toHaveLength(3);
    expect(workflow.match(/\.base\.ref == "main"/g)).toHaveLength(3);
    expect(workflow.match(/\.head\.repo\.full_name == \$repository/g)).toHaveLength(3);
    expect(workflow.match(/\.head\.sha == \$sha/g)).toHaveLength(2);
    expect(workflow).toContain('ref: ${{ needs.resolve.outputs.source_sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('[[ $(git rev-parse HEAD) == "$SOURCE_SHA" ]]');
    expect(workflow).toContain('[[ "$source_sha" == "$INPUT_REQUESTED_HEAD_SHA" ]]');
    expect(workflow).toContain('Revalidate exact PR head before upload');
  });

  test('builds selected raw tools without production identity or signing', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('bun-linux-x64');
    expect(workflow).toContain('bun-darwin-arm64');
    expect(workflow).toContain('bun-windows-x64');
    expect(workflow).toContain('main.projectSpaceMachineBackendURL=$preview_url');
    expect(workflow).toContain('https://pr-${PR_NUMBER}.projects.os-home.net');
    expect(workflow).toContain('project-space.pr-dev-build/v1');
    expect(workflow).toContain('project-dev');
    expect(workflow).toContain('project-space-connector-dev');
    expect(workflow).toContain('productionSigned: false');
    expect(workflow).toContain('productionTrustRootsIncluded: false');
    expect(workflow).toContain('sha256sum');
    expect(workflow).toContain('retention-days: 7');
    expect(workflow).not.toContain('release-signing');
    expect(workflow).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(workflow).not.toContain('connector-command-signing-public-key.pem');
    expect(workflow).not.toContain('release-manifest-signing-public-key.pem');
    expect(workflow).not.toContain('codesign');
    expect(workflow).not.toContain('winget');
  });

  test('reuses only exact artifacts from successful runs of this workflow', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('actions/workflows/build-pr-tools.yml');
    expect(workflow).toContain('.workflow_id == $workflow_id');
    expect(workflow).toContain('.event == \\"workflow_dispatch\\"');
    expect(workflow).toContain('.conclusion == \\"success\\"');
    expect(workflow).toContain('Reused development builds');
  });

  test('pins every external action to an immutable revision', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const references = actionReferences(workflow);

    expect(references.length).toBeGreaterThanOrEqual(5);
    expect(references.every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
  });
});
