import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const deploymentWorkflowPath = new URL('../.github/workflows/deploy-preview.yml', import.meta.url);
const artifactWorkflowPath = new URL('../.github/workflows/build-preview-artifacts.yml', import.meta.url);
const cleanupWorkflowPath = new URL('../.github/workflows/cleanup-preview.yml', import.meta.url);
const promotionWorkflowPath = new URL('../.github/workflows/promote-preview-artifacts.yml', import.meta.url);
const reaperWorkflowPath = new URL('../.github/workflows/reap-previews.yml', import.meta.url);
const previewArtifactBakePath = new URL('../deploy/preview-artifact-bake.hcl', import.meta.url);
const previewDocsDockerfilePath = new URL('../deploy/preview.docs.Dockerfile', import.meta.url);

function actionReferences(workflow: string) {
  return [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
}

describe('trusted PR Preview workflow contract', () => {
  test('dispatches deploy or destroy from trusted main and cleans every closed PR', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');
    const cleanup = await readFile(cleanupWorkflowPath, 'utf8');

    expect(workflow).toContain('action:');
    expect(workflow).toContain('options: [build, start, stop, touch, deploy, destroy]');
    expect(workflow).toContain("steps.freshness.outputs.disposition == 'current' && inputs.action == 'deploy'");
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.action == 'destroy'");
    expect(workflow).toContain('workflow_run:\n    workflows: [Build PR preview artifacts]\n    types: [completed]');
    expect(cleanup).toContain('pull_request_target:\n    types: [closed]');
    expect(workflow).toContain('runner_command=register; runner_mode=register');
    expect(workflow).toContain('requested_head_sha');
    expect(workflow).toContain('replacement_head_sha');
    expect(workflow).toContain('Verify offline Preview registration');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain('^preview-[0-9a-f]{32}$');
    expect(workflow).toContain('github.event.workflow_run.pull_requests[0].number');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('queue:');
    expect(cleanup).toContain('ssh project-space-preview destroy');
    expect(cleanup).toContain('"state":"inactive"');
  });

  test('treats only positively superseded exact heads as neutral', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');

    expect(workflow).toContain(
      'REQUESTED_HEAD_SHA: ${{ inputs.requested_head_sha || github.event.workflow_run.head_sha }}',
    );
    expect(workflow).toContain("disposition=superseded");
    expect(workflow).toContain("needs.resolve.outputs.disposition == 'current'");
    expect(workflow).toContain(
      "if: needs.resolve.outputs.disposition == 'current' && github.event_name == 'workflow_dispatch' && contains(fromJSON('[\"start\",\"stop\",\"touch\"]'), inputs.action)",
    );
    expect(workflow).toContain('Classify exact-head state after runner handoff');
    expect(workflow).toContain('elif [[ "$RUNNER_EXIT_CODE" == 75 ]]');
    expect(workflow).toContain('transition_state=superseded');
    expect(workflow).toContain('steps.handoff.outcome }}" != success');
    expect(workflow).toContain('outputs.disposition }}" != current');
    expect(workflow).toContain('failure_class=none');
    expect(workflow).toContain('state=inactive');
    expect(workflow).toContain('preview_supersession_fence_failed');
    expect(workflow).toContain('Fail closed when the supersession fence is not proven');
  });

  test('builds untrusted PR recipes without Preview or registry credentials', async () => {
    const workflow = await readFile(artifactWorkflowPath, 'utf8');
    const bake = await readFile(previewArtifactBakePath, 'utf8');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).toContain('--file deploy/preview-artifact-bake.hcl');
    expect(workflow).toContain('--allow "fs.write=$ARTIFACT_DIR/images"');
    expect(workflow).toContain('attestations: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('environment:\n      name: Preview');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('docker/login-action');
    expect(bake).toContain('targets = ["web", "docs", "prototype"]');
    expect(bake).not.toContain('gateway');
    expect(bake).toContain('dockerfile = "${SOURCE_CONTEXT}/deploy/preview.prototype.Dockerfile"');
    expect(bake).toContain('trusted-assets = SOURCE_CONTEXT');
    expect(bake.match(/type=docker,dest=/g)).toHaveLength(3);
  });

  test('trusted promotion never checks out or executes PR source', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');
    const promote = await readFile(promotionWorkflowPath, 'utf8');

    expect(workflow).toContain('uses: ./.github/workflows/promote-preview-artifacts.yml');
    expect(promote).toContain('path: trusted');
    expect(workflow).toContain('trusted_sha: ${{ github.workflow_sha }}');
    expect(promote).toContain('ref: ${{ inputs.trusted_sha }}');
    expect(promote).not.toContain('path: source');
    expect(promote).not.toContain('needs.resolve.outputs.head_sha }}\n          persist-credentials');
    expect(promote).not.toContain('docker buildx bake');
    expect(promote).toContain('preview-artifact-contract.py safe-extract');
    expect(promote).toContain('preview-artifact-contract.py verify');
    expect(promote).toContain('gh attestation verify');
    expect(promote).toContain('--deny-self-hosted-runners');
    expect(promote).toContain('--source-ref "refs/pull/$PR_NUMBER/merge"');
    expect(promote).toContain('docker load --input');
    expect(promote).toContain('docker image inspect');
    expect(promote).toContain('Build the credential-bearing gateway only from trusted main');
    expect(promote).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(promote).not.toContain('SSH_PRIVATE_KEY');
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
    const bake = await readFile(previewArtifactBakePath, 'utf8');

    expect(workflow.match(/\.state == "open"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workflow.match(/\.base\.ref == "main"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workflow).toContain('.base.repo.full_name == $repository');
    expect(workflow).toContain('.head.repo.full_name == $repository');
    expect(workflow).toContain('.head.sha == $sha');
    expect(workflow).toContain('ghcr.io/dotnaos/project-space-preview-web@$WEB_DIGEST');
    expect(workflow).toContain('ghcr.io/dotnaos/project-space-preview-docs@$DOCS_DIGEST');
    expect(workflow).toContain('ghcr.io/dotnaos/project-space-preview-gateway@$GATEWAY_DIGEST');
    expect(bake).toContain('project-space-preview-prototype:pr-${PR_NUMBER}-${PR_HEAD_SHA}');
    expect(workflow).toContain(
      'ghcr.io/dotnaos/project-space-preview-prototype@$PROTOTYPE_DIGEST'
    );
    expect(workflow).toContain('prototypeImage:$prototype');
    expect(workflow).toContain('https://pr-${{ needs.resolve.outputs.pr_number }}.projects.os-home.net');
    expect(workflow).toContain('environment_url');
    expect(workflow).toContain('ssh project-space-preview "$runner_command" > preview-output.log');
    expect(workflow).toContain('ssh project-space-preview "$ACTION" | tee lifecycle-output.log');
    expect(workflow).toContain("jq -Rsce --arg prefix 'PROJECT_SPACE_PREVIEW_RECEIPT='");
    expect(workflow).toContain('ssh project-space-preview "$runner_command" > preview-output.log 2> preview-error.log');
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
    expect(workflow).toContain('The post-run exact-head fence could not be proven; success is forbidden.');
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

  test('keeps Preview credentials least-privileged and every external action pinned', async () => {
    const workflow = await readFile(deploymentWorkflowPath, 'utf8');
    const artifactWorkflow = await readFile(artifactWorkflowPath, 'utf8');
    const cleanup = await readFile(cleanupWorkflowPath, 'utf8');
    const promotionWorkflow = await readFile(promotionWorkflowPath, 'utf8');

    expect(workflow).toContain('name: Preview');
    expect(workflow).not.toContain('name: Production');
    expect(workflow).not.toContain('Project Space Production Deploy SSH');
    expect(workflow).not.toContain('PROJECT_CONNECTOR_REGISTRATION_TOKEN');
    expect(workflow).not.toContain('PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64');
    expect(workflow).not.toContain('CLERK_SECRET_KEY');
    expect(workflow.toLowerCase()).not.toContain('vercel');
    expect(cleanup).not.toContain('actions/checkout');
    expect(actionReferences(workflow).length).toBeGreaterThanOrEqual(7);
    expect(actionReferences(workflow).every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    expect(actionReferences(artifactWorkflow).every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    expect(actionReferences(cleanup).every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    expect(actionReferences(promotionWorkflow).every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
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
