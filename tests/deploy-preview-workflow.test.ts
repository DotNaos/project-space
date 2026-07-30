import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const deploymentWorkflowPath = new URL('../.github/workflows/deploy-preview.yml', import.meta.url);
const reaperWorkflowPath = new URL('../.github/workflows/reap-previews.yml', import.meta.url);

function actionReferences(workflow: string) {
  return [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
}

describe('trusted PR Preview workflow contract', () => {
  test('dispatches deploy or destroy from trusted main and cleans every closed PR', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');

    expect(workflow).toContain('action:');
    expect(workflow).toContain('options: [deploy, destroy]');
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.action == 'deploy'");
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.action == 'destroy'");
    expect(workflow).toContain('pull_request_target:\n    types: [closed]');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain('^preview-[0-9a-f]{32}$');
    expect(workflow).toContain('group: project-space-preview-pr-${{ inputs.pr || github.event.pull_request.number }}');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('queue:');
    expect(workflow).toContain('ssh project-space-preview destroy');
    expect(workflow).toContain('"state":"inactive"');
  });

  test('separates PR source from main-owned build and runtime assets', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');
    const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  deploy:'));

    expect(build).toContain('path: trusted');
    expect(build).toContain('ref: ${{ github.workflow_sha }}');
    expect(build).toContain('path: source');
    expect(build).toContain('ref: ${{ needs.resolve.outputs.head_sha }}');
    expect(build).toContain('file: trusted/deploy/preview.web.Dockerfile');
    expect(build).toContain('file: trusted/deploy/preview.docs.Dockerfile');
    expect(build).toContain('file: trusted/deploy/preview.prototype.Dockerfile');
    expect(build).toContain('file: trusted/deploy/preview.gateway.Dockerfile');
    expect(build).toContain('trusted-assets=trusted');
    expect(build).toContain('context: trusted');
    expect(build).toContain('VITE_CLERK_PUBLISHABLE_KEY=${{ vars.VITE_CLERK_PUBLISHABLE_KEY }}');
    expect(workflow).not.toContain('file: source/deploy/');
    expect(workflow).not.toContain('./bin/project');
  });

  test('revalidates exact same-repository head and passes only immutable digests to the runner', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');

    expect(workflow.match(/\.state == "open"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workflow.match(/\.base\.ref == "main"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workflow).toContain('.base.repo.full_name == $repository');
    expect(workflow).toContain('.head.repo.full_name == $repository');
    expect(workflow).toContain('.head.sha == $sha');
    expect(workflow).toContain('ghcr.io/dotnaos/project-space-preview-web@$WEB_DIGEST');
    expect(workflow).toContain('ghcr.io/dotnaos/project-space-preview-docs@$DOCS_DIGEST');
    expect(workflow).toContain('ghcr.io/dotnaos/project-space-preview-gateway@$GATEWAY_DIGEST');
    expect(workflow).toContain(
      'ghcr.io/dotnaos/project-space-preview-prototype:pr-${{ needs.resolve.outputs.pr_number }}-${{ needs.resolve.outputs.head_sha }}'
    );
    expect(workflow).toContain(
      'ghcr.io/dotnaos/project-space-preview-prototype@$PROTOTYPE_DIGEST'
    );
    expect(workflow).toContain('prototypeImage:$prototype');
    expect(workflow).toContain('https://pr-${{ needs.resolve.outputs.pr_number }}.projects.os-home.net');
    expect(workflow).toContain('environment_url');
    expect(workflow).toContain('ssh project-space-preview apply > preview-output.log');
    expect(workflow).toContain("sed -n '/^{/,$p' preview-output.log > preview-result.json");
    expect(workflow).toContain('.repositoryFullName == $repository');
    expect(workflow).toContain('.pullRequestNumber == $pr');
    expect(workflow).toContain('.requestedSha == $sha');
    expect(workflow).toContain('.runningSha == $sha');
    expect(workflow).toContain('.prototypeMetaSha == $sha');
  });

  test('keeps trusted runner progress outside the final JSON receipt', () => {
    const receipt = {
      prototypeMetaSha: 'a'.repeat(40),
      pullRequestNumber: 396,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha: 'a'.repeat(40),
      runningSha: 'a'.repeat(40),
      state: 'ready'
    };
    const progress = ` Image project-space-preview-web Pulling
 Container project-space-preview-pr-396-web-1 Healthy
${JSON.stringify(receipt, null, 2)}
`;
    const normalized = spawnSync('sed', ['-n', '/^{/,$p'], {
      encoding: 'utf8',
      input: progress
    });

    expect(normalized.status).toBe(0);
    expect(JSON.parse(normalized.stdout)).toEqual(receipt);
  });

  test('isolates slow and module-mocking tests from the bulk validation process', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');

    expect(workflow).toContain('-e tests/preview-runner-contract.test.ts');
    expect(workflow).toContain('bun test --timeout 10000 tests/preview-runner-contract.test.ts');
    expect(workflow).toContain('-e tests/codex-operation-snapshot-store.test.ts');
    expect(workflow).toContain('bun test --timeout 10000 tests/codex-operation-snapshot-store.test.ts');
  });

  test('keeps Preview credentials least-privileged and every external action pinned', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');
    const cleanup = workflow.slice(workflow.indexOf('  cleanup:'), workflow.indexOf('  manual-destroy:'));

    expect(workflow).toContain('name: Preview');
    expect(workflow).not.toContain('name: Production');
    expect(workflow).not.toContain('Project Space Production Deploy SSH');
    expect(workflow).not.toContain('PROJECT_CONNECTOR_REGISTRATION_TOKEN');
    expect(workflow).not.toContain('PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64');
    expect(workflow).not.toContain('CLERK_SECRET_KEY');
    expect(workflow.toLowerCase()).not.toContain('vercel');
    expect(cleanup).not.toContain('actions/checkout');
    expect(actionReferences(workflow).length).toBeGreaterThanOrEqual(10);
    expect(actionReferences(workflow).every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
  });

  test('reaper uses the authoritative registry and marks removed deployments inactive', async () => {
    const workflow = await readFile(reaperWorkflowPath, 'utf8');

    expect(workflow).toContain("cron: '23 3 * * *'");
    expect(workflow).toContain('state=open&per_page=100');
    expect(workflow).toContain('ssh project-space-preview reap');
    expect(workflow).toContain('.removedPullRequests');
    expect(workflow).toContain('"state":"inactive"');
    expect(workflow).toContain('jq -n');
    expect(workflow).not.toContain('<<JSON');
    expect(workflow).not.toContain('actions/checkout');
    expect(workflow).not.toContain('Production');
    expect(workflow.toLowerCase()).not.toContain('vercel');
    expect(actionReferences(workflow).every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
  });
});
