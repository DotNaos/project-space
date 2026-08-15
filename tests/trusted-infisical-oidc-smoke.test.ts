import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';

const workflowPath = new URL(
  '../.github/workflows/trusted-infisical-oidc-smoke.yml',
  import.meta.url,
);
const infisicalAction =
  'Infisical/secrets-action@8a06c1bdcd5b8635d510c52d4b57a92c1ccef785';
const checkoutAction =
  'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10';
const trustedJobCondition =
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'DotNaos/project-space'";
const trustedShell = '/bin/bash --noprofile --norc -euo pipefail {0}';

const boundaries = {
  preview: {
    environment: 'Preview',
    identity: '5eaeaafe-2b13-4ca2-9506-4c914924e5b6',
    project: 'project-space-preview',
    infisicalEnvironment: 'staging',
    names: ['SSH_PRIVATE_KEY', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'],
  },
  production: {
    environment: 'Production',
    identity: '454fcc36-3e86-4c9f-b25d-e581d342bc36',
    project: 'project-space-production',
    infisicalEnvironment: 'prod',
    names: [
      'CLERK_PUBLISHABLE_KEY',
      'CLERK_SECRET_KEY',
      'GITHUB_OAUTH_CLIENT_ID',
      'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64',
      'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_PASSWORD',
      'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_USERNAME',
      'PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET',
      'SSH_PRIVATE_KEY',
      'TS_OAUTH_CLIENT_ID',
      'TS_OAUTH_SECRET',
      'VITE_CLERK_PUBLISHABLE_KEY',
    ],
  },
  'release-signing': {
    environment: 'release-signing',
    identity: '577f6b4c-943b-4bf5-94ac-07140f1e5b2d',
    project: 'project-space-release-signing',
    infisicalEnvironment: 'prod',
    names: ['PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64'],
  },
} as const;

type WorkflowStep = {
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  environment?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
};

function sorted(values: readonly string[]) {
  return [...values].sort();
}

function expectedNames(run: string) {
  const block = run.match(/readonly expected_names=\(\n([\s\S]*?)\n\s*\)/)?.[1] ?? '';
  return [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s*$/gm)].map((match) => match[1]);
}

function policyViolations(source: string) {
  const violations: string[] = [];
  const secretNames = Object.values(boundaries).flatMap((boundary) => boundary.names);
  const workflow = parse(source) as Workflow;
  const triggers = Object.keys(workflow.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
    violations.push('trigger must be manual-only');
  }
  if (Object.keys(workflow.permissions ?? {}).length !== 0) {
    violations.push('workflow permissions must default to none');
  }

  const jobs = workflow.jobs ?? {};
  if (sorted(Object.keys(jobs)).join(',') !== sorted(Object.keys(boundaries)).join(',')) {
    violations.push('job boundary set changed');
  }

  const actionReferences: string[] = [];
  for (const [jobName, expected] of Object.entries(boundaries)) {
    const job = jobs[jobName];
    if (!job) continue;
    if (job.if !== trustedJobCondition) violations.push(`${jobName} repository or main binding changed`);
    if (job.environment !== expected.environment) violations.push(`${jobName} environment binding changed`);

    const expectedPermissions = jobName === 'release-signing'
      ? { contents: 'read', 'id-token': 'write' }
      : { 'id-token': 'write' };
    if (JSON.stringify(job.permissions) !== JSON.stringify(expectedPermissions)) {
      violations.push(`${jobName} permissions changed`);
    }

    const steps = job.steps ?? [];
    actionReferences.push(...steps.flatMap((step) => step.uses ? [step.uses] : []));
    const infisical = steps.find((step) => step.uses?.startsWith('Infisical/secrets-action@'));
    if (infisical?.uses !== infisicalAction) violations.push(`${jobName} Infisical action changed`);
    if (infisical?.with?.method !== 'oidc') violations.push(`${jobName} authentication method changed`);
    if (infisical?.with?.['identity-id'] !== expected.identity) violations.push(`${jobName} identity binding changed`);
    if (infisical?.with?.['oidc-audience'] !== 'https://github.com/DotNaos') {
      violations.push(`${jobName} OIDC audience changed`);
    }
    if (infisical?.with?.domain !== 'https://eu.infisical.com') violations.push(`${jobName} domain changed`);
    if (infisical?.with?.['project-slug'] !== expected.project) violations.push(`${jobName} project binding changed`);
    if (infisical?.with?.['env-slug'] !== expected.infisicalEnvironment) {
      violations.push(`${jobName} Infisical environment changed`);
    }
    if (
      infisical?.with?.['export-type'] !== 'env'
      || infisical.with['secret-path'] !== '/'
      || infisical.with['include-imports'] !== false
      || infisical.with.recursive !== false
    ) {
      violations.push(`${jobName} secret export scope changed`);
    }

    const validation = steps.find((step) => step.run?.includes('expected_names=('));
    if (jobName !== 'release-signing' && sorted(expectedNames(validation?.run ?? '')).join(',') !== sorted(expected.names).join(',')) {
      violations.push(`${jobName} expected secret names changed`);
    }

    for (const step of steps) {
      const run = step.run ?? '';
      if (run && step.shell !== trustedShell) {
        violations.push(`${jobName} run step shell changed`);
      }
      if (/\b(?:printenv|declare\s+-p|export\s+-p|set\s+-x)\b/.test(run)) {
        violations.push(`${jobName} can enumerate or trace secret values`);
      }
      if (/^\s*(?:\/usr\/bin\/)?(?:env|set)\s*$/m.test(run)) {
        violations.push(`${jobName} can enumerate secret values`);
      }
      for (const line of run.split('\n')) {
        const referencesSecret = line.includes('${!')
          || secretNames.some((name) => new RegExp(`\\$\\{?${name}\\b`).test(line));
        if (!referencesSecret || !/\b(?:echo|printf)\b/.test(line)) continue;
        const isPipeOnlyPublicDerivation = jobName === 'release-signing'
          && line.includes('<(printf')
          && line.includes('| base64 --decode | openssl pkey -pubout -outform DER)');
        if (!isPipeOnlyPublicDerivation) violations.push(`${jobName} can print a secret value`);
      }
      if (/GITHUB_(?:ENV|OUTPUT|STEP_SUMMARY)|actions\/(?:upload-artifact|cache)@|\btee\b/.test(run)) {
        violations.push(`${jobName} can persist a secret value`);
      }
    }
  }

  const expectedActions = [checkoutAction, infisicalAction, infisicalAction, infisicalAction];
  if (sorted(actionReferences).join(',') !== sorted(expectedActions).join(',')) {
    violations.push('external action set changed');
  }
  if (actionReferences.some((reference) => !/@[0-9a-f]{40}$/.test(reference))) {
    violations.push('external action is not pinned to a full commit');
  }

  const signing = jobs['release-signing'];
  const checkout = signing?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
  if (checkout?.uses !== checkoutAction || checkout.with?.ref !== '${{ github.sha }}' || checkout.with?.['persist-credentials'] !== false) {
    violations.push('trusted checkout binding changed');
  }
  const signingRun = signing?.steps?.find((step) => step.run?.includes('openssl pkey -pubout'))?.run ?? '';
  if (!signingRun.includes('packaging/release/trust-roots/release-manifest-signing-public-key.pem')) {
    violations.push('committed signing trust root changed');
  }
  if (!signingRun.includes('<(printf') || /PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64[^\n]*(?:>|\btee\b)/.test(signingRun)) {
    violations.push('private signing material can be persisted');
  }
  if (/\b(?:project\s+deploy|gh\s+release|docker\s+push|infisical\s+(?:identity|token|secret)\s+create)\b/i.test(source)) {
    violations.push('workflow can deploy, release, or create credentials');
  }

  return violations;
}

describe('trusted Infisical OIDC smoke workflow', () => {
  test('keeps the checked-in workflow inside every trusted non-deploying boundary', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(policyViolations(workflow)).toEqual([]);
  });

  test.each([
    ['pull-request trigger', (source: string) => source.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n')],
    ['mutable action tag', (source: string) => source.replace(infisicalAction, 'Infisical/secrets-action@v1')],
    ['secret printing', (source: string) => source.replace("printf '%s\\n' 'The Preview boundary contains every expected value.'", 'echo "$SSH_PRIVATE_KEY"')],
    ['indirect secret printing', (source: string) => source.replace("printf '%s\\n' 'The Preview boundary contains every expected value.'", 'printf \'%s\\n\' "${!name}"')],
    ['environment enumeration', (source: string) => source.replace("printf '%s\\n' 'The Preview boundary contains every expected value.'", 'env')],
    ['shell tracing', (source: string) => source.replace(trustedShell, '/bin/bash --noprofile --norc -euxo pipefail {0}')],
    ['repository binding', (source: string) => source.replace("github.repository == 'DotNaos/project-space'", "github.repository_owner == 'DotNaos'")],
    ['GitHub environment binding', (source: string) => source.replace('environment: Preview', 'environment: Preview-or-Production')],
    ['Infisical project binding', (source: string) => source.replace('project-slug: project-space-preview', 'project-slug: project-space')],
    ['Infisical imported project scope', (source: string) => source.replace('include-imports: false', 'include-imports: true')],
    ['OIDC identity binding', (source: string) => source.replace('5eaeaafe-2b13-4ca2-9506-4c914924e5b6', '00000000-0000-4000-8000-000000000000')],
  ])('rejects a widened or unsafe %s', async (_label, mutate) => {
    const workflow = await readFile(workflowPath, 'utf8');
    expect(policyViolations(mutate(workflow))).not.toEqual([]);
  });
});
