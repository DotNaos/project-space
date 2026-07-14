import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repositoryRoot = join(import.meta.dir, '..');
const onePasswordCliVersion = '2.35.0';
const serviceAccountSecret = 'OP_SERVICE_ACCOUNT_TOKEN';
const reusableSignerWorkflows = [
  '.github/workflows/release-macos.yml',
  '.github/workflows/release-manifest-sign.yml'
] as const;

async function source(path: string) {
  return readFile(join(repositoryRoot, path), 'utf8');
}

function workflowContract(workflow: string) {
  const jobsMarker = '\njobs:\n';
  const jobsStart = workflow.indexOf(jobsMarker);
  if (jobsStart < 0) throw new Error('Workflow jobs section is missing.');
  return workflow.slice(0, jobsStart);
}

function jobBlocks(workflow: string) {
  const jobsMarker = '\njobs:\n';
  const jobsStart = workflow.indexOf(jobsMarker);
  if (jobsStart < 0) throw new Error('Workflow jobs section is missing.');
  const jobs = workflow.slice(jobsStart + jobsMarker.length);
  const matches = [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)];
  return matches.map((match, index) => ({
    name: match[1]!,
    source: jobs.slice(match.index!, matches[index + 1]?.index ?? jobs.length)
  }));
}

function onePasswordActionStep(job: string) {
  const action = 'uses: 1password/load-secrets-action@';
  const start = job.indexOf(action);
  if (start < 0) throw new Error('1Password secret-loading action is missing.');
  const nextStep = job.indexOf('\n      - name:', start + action.length);
  return nextStep < 0 ? job.slice(start) : job.slice(start, nextStep);
}

function hasPinnedOnePasswordCliVersion(action: string) {
  const versions = [...action.matchAll(/^\s*version:\s*['"]?([^'"\s]+)['"]?\s*$/gm)]
    .map((match) => match[1]);
  return versions.length === 1 && versions[0] === onePasswordCliVersion;
}

describe('release signing service-account secret boundary', () => {
  test('the caller cannot receive or forward the signing service-account token', async () => {
    const workflow = await source('.github/workflows/release.yml');
    const signerCalls = jobBlocks(workflow).filter(({ name }) =>
      ['macos-arm64', 'manifest-sign'].includes(name)
    );

    expect(workflow).not.toContain(serviceAccountSecret);
    expect(signerCalls.map(({ name }) => name)).toEqual(['macos-arm64', 'manifest-sign']);
    for (const call of signerCalls) {
      expect(call.source).not.toMatch(/^    secrets:/m);
      expect(call.source).not.toContain('secrets: inherit');
    }
  });

  test('reusable workflow contracts cannot accept the signing token from callers', async () => {
    for (const path of reusableSignerWorkflows) {
      const contract = workflowContract(await source(path));
      expect(contract).not.toContain(serviceAccountSecret);
      expect(contract).not.toMatch(/^    secrets:/m);
    }
  });

  test('every signing-token reference is confined to the approved no-checkout job', async () => {
    for (const path of reusableSignerWorkflows) {
      const workflow = await source(path);
      const secretJobs = jobBlocks(workflow).filter(({ source: block }) =>
        block.includes(serviceAccountSecret)
      );

      expect(secretJobs.map(({ name }) => name)).toEqual(['sign']);
      expect(workflow.match(/secrets\.OP_SERVICE_ACCOUNT_TOKEN/g)).toHaveLength(1);
      for (const job of secretJobs) {
        const secretAction = onePasswordActionStep(job.source);
        expect(job.source).toContain('environment: release-signing');
        expect(job.source).toContain(
          'OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}'
        );
        expect(job.source).not.toContain('actions/checkout@');
        expect(hasPinnedOnePasswordCliVersion(secretAction)).toBe(true);
        expect(secretAction).not.toMatch(/version:\s*['"]?latest(?:-beta)?['"]?/);
      }
    }
  });

  test('the signing action rejects mutable or missing CLI version channels', () => {
    for (const action of [
      'uses: 1password/load-secrets-action@pinned\nwith:\n  version: latest',
      "uses: 1password/load-secrets-action@pinned\nwith:\n  version: 'latest-beta'",
      'uses: 1password/load-secrets-action@pinned'
    ]) {
      expect(hasPinnedOnePasswordCliVersion(action)).toBe(false);
    }
  });
});
