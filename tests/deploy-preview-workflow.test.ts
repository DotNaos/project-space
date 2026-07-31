import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const deploymentWorkflowPath = new URL('../.github/workflows/deploy-preview.yml', import.meta.url);
const reaperWorkflowPath = new URL('../.github/workflows/reap-previews.yml', import.meta.url);
const previewDocsDockerfilePath = new URL('../deploy/preview.docs.Dockerfile', import.meta.url);

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

  test('keeps the Project Space version available to Preview docs at runtime', async () => {
    const dockerfile = await readFile(previewDocsDockerfilePath, 'utf8');
    const build = dockerfile.slice(
      dockerfile.indexOf('FROM oven/bun:1 AS build'),
      dockerfile.indexOf('FROM oven/bun:1 AS runner')
    );
    const runner = dockerfile.slice(dockerfile.indexOf('FROM oven/bun:1 AS runner'));

    expect(build).toContain('COPY package.json /workspace/package.json');
    expect(runner).toContain('COPY --from=build /workspace/package.json /workspace/package.json');
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
    expect(workflow).toContain('ssh project-space-preview apply > preview-output.log 2> preview-error.log');
    expect(workflow).toContain("jq -Rsce --arg prefix 'PROJECT_SPACE_PREVIEW_RECEIPT='");
    expect(workflow).toContain('select(length == 1)');
    expect(workflow).toContain('RUNNER_RECEIPT_VALID: ${{ steps.apply.outputs.receipt_valid }}');
    expect(workflow).toContain('.repositoryFullName == $repository');
    expect(workflow).toContain('.pullRequestNumber == $pr');
    expect(workflow).toContain('.requestedSha == $sha');
    expect(workflow).toContain('.runningSha == $sha');
    expect(workflow).toContain('.prototypeMetaSha == $sha');
    expect(workflow).toContain('.state == "blocked_capacity"');
    expect(workflow).toContain('.errorCode == "preview_quota_full"');
    expect(workflow).toContain('.errorCode == "preview_storage_low"');
    expect(workflow).toContain('state=pending');
    expect(workflow).toContain('preview-transition.json');
    expect(workflow).toContain('failure_class=invalid_change');
    expect(workflow).toContain('failure_class=infrastructure_failure');
    expect(workflow).toContain('failure_class=capacity_block');
    expect(workflow).toContain('Upload sanitized Preview transition evidence');
  });

  test('extracts exactly one framed receipt from the real Preview update output path', () => {
    const receipt = {
      prototypeMetaSha: 'a'.repeat(40),
      pullRequestNumber: 396,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha: 'a'.repeat(40),
      runningSha: 'a'.repeat(40),
      state: 'ready'
    };
    const progress = ` Container project-space-preview-pr-396-web-1 Recreate
{"status":"unrelated transport progress"}
 Container project-space-preview-pr-396-web-1 Healthy
PROJECT_SPACE_PREVIEW_RECEIPT=${JSON.stringify(receipt)}
Connection to project-space-preview closed.
`;
    const normalized = spawnSync('jq', [
      '-Rsce',
      '--arg',
      'prefix',
      'PROJECT_SPACE_PREVIEW_RECEIPT=',
      `split("\\n")
        | map(select(startswith($prefix)) | ltrimstr($prefix))
        | select(length == 1)
        | .[0]
        | fromjson
        | select(type == "object")`
    ], {
      encoding: 'utf8',
      input: progress
    });

    expect(normalized.status).toBe(0);
    expect(JSON.parse(normalized.stdout)).toEqual(receipt);
  });

  test('fails closed when the framed Preview receipt is missing, malformed, or duplicated', () => {
    const filter = `split("\\n")
      | map(select(startswith($prefix)) | ltrimstr($prefix))
      | select(length == 1)
      | .[0]
      | fromjson
      | select(type == "object")`;
    const extract = (input: string) => spawnSync('jq', [
      '-Rsce',
      '--arg',
      'prefix',
      'PROJECT_SPACE_PREVIEW_RECEIPT=',
      filter
    ], { encoding: 'utf8', input });

    expect(extract('Container healthy\n').status).not.toBe(0);
    expect(extract('PROJECT_SPACE_PREVIEW_RECEIPT=not-json\n').status).not.toBe(0);
    expect(extract([
      'PROJECT_SPACE_PREVIEW_RECEIPT={"state":"ready"}',
      'PROJECT_SPACE_PREVIEW_RECEIPT={"state":"ready"}'
    ].join('\n')).status).not.toBe(0);
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
