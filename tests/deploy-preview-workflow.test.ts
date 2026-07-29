import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const deploymentWorkflowPath = new URL('../.github/workflows/deploy-preview.yml', import.meta.url);
const reaperWorkflowPath = new URL('../.github/workflows/reap-previews.yml', import.meta.url);

function actionReferences(workflow: string) {
  return [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
}

describe('trusted PR Preview workflow contract', () => {
  test('automatically deploys current PR heads, supports manual recovery, and cleans closed PRs', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');

    expect(workflow).toContain('action:');
    expect(workflow).toContain('options: [deploy, destroy]');
    expect(workflow).toContain(
      "(github.event_name == 'pull_request_target' && github.event.action != 'closed')"
    );
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.action == 'destroy'");
    expect(workflow).toContain(
      'pull_request_target:\n    types: [opened, reopened, synchronize, closed]'
    );
    expect(workflow).toContain('REQUESTED_PR: ${{ inputs.pr || github.event.pull_request.number }}');
    expect(workflow).toContain('EVENT_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).toContain('if [[ "$EVENT_NAME" == workflow_dispatch ]]');
    expect(workflow).toContain('"$head_sha" != "$EVENT_HEAD_SHA"');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain('^preview-[0-9a-f]{32}$');
    expect(workflow).toContain('group: project-space-preview-pr-${{ inputs.pr || github.event.pull_request.number }}');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('queue:');
    expect(workflow).toContain('ssh project-space-preview destroy');
    expect(workflow).toContain('"state":"inactive"');
  });

  test('executes PR-controlled validation without credentials', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');
    const validate = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  build:'));

    expect(validate).toContain('permissions: {}');
    expect(validate).toContain('git fetch --no-tags --depth=1 origin "$REQUESTED_SHA"');
    expect(validate).toContain('[[ "$(git rev-parse HEAD)" == "$REQUESTED_SHA" ]]');
    expect(validate).not.toContain('actions/checkout');
    expect(validate).not.toContain('github.token');
    expect(validate).not.toContain('environment:');
    expect(validate).not.toContain('secrets.');
    expect(validate).not.toContain('packages: write');
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
