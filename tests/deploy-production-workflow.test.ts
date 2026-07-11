import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/deploy-production.yml', import.meta.url);
const dockerIgnorePath = new URL('../.dockerignore', import.meta.url);

describe('production deployment workflow contract', () => {
  test('deploys main through one non-cancelling Production lane', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('group: project-space-production');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('name: Production');
    expect(workflow).toContain('--commit "$REQUESTED_COMMIT"');
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
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
    expect(workflow).toContain('bun test');
    expect(workflow).toContain('go test ./...');
    expect(workflow).toContain("steps.current-main.outputs.superseded != 'true'");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('export-env: true');
    expect(workflow).toContain('-o "$RUNNER_TEMP/project"');
    expect(workflow).not.toContain('-o bin/project');
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
});
