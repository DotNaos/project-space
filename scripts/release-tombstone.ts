import { basename } from 'node:path';

export const releaseTombstoneDirectory = '.github/release-tombstones';
export const releaseTombstoneSchema =
  'project-space.unpublished-release-tombstone/v1';

export interface UnpublishedReleaseTombstone {
  exhaustedRunId: number;
  reason: 'windows-x64-source-incompatible';
  schema: typeof releaseTombstoneSchema;
  sourceCommit: string;
  tag: string;
  verificationRunId: number;
  workflowSha256: string;
}

export interface TombstoneWorkflowRun {
  conclusion: string | null;
  displayTitle: string;
  event: string;
  headBranch: string;
  headSha: string;
  id: number;
  runAttempt: number;
  status: string;
  workflowPath: string;
  workflowSha256: string;
}

export interface TombstoneWorkflowJob {
  conclusion: string | null;
  name: string;
  status: string;
}

export function parseReleaseTombstone(
  source: string,
  fileName: string,
): UnpublishedReleaseTombstone {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.json$/.test(
    basename(fileName),
  )) {
    throw new Error(`Release tombstone ${fileName} has an invalid filename.`);
  }
  if (!source || Buffer.byteLength(source, 'utf8') > 4096) {
    throw new Error(`Release tombstone ${fileName} has an invalid size.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Release tombstone ${fileName} is invalid JSON.`);
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    'exhaustedRunId',
    'reason',
    'schema',
    'sourceCommit',
    'tag',
    'verificationRunId',
    'workflowSha256',
  ])) {
    throw new Error(`Release tombstone ${fileName} has an invalid shape.`);
  }
  const expectedTag = basename(fileName, '.json');
  if (
    value.schema !== releaseTombstoneSchema ||
    value.reason !== 'windows-x64-source-incompatible' ||
    value.tag !== expectedTag ||
    !isCommit(value.sourceCommit) ||
    !isRunId(value.exhaustedRunId) ||
    !isRunId(value.verificationRunId) ||
    !isSha256(value.workflowSha256) ||
    value.exhaustedRunId === value.verificationRunId
  ) {
    throw new Error(`Release tombstone ${fileName} has invalid evidence.`);
  }
  return value as unknown as UnpublishedReleaseTombstone;
}

export function validateReleaseTombstoneProof(input: {
  exhaustedJobs: TombstoneWorkflowJob[];
  exhaustedRun: TombstoneWorkflowRun;
  releaseState: 'draft' | 'missing' | 'published';
  tagCommit: string | undefined;
  tombstone: UnpublishedReleaseTombstone;
  verificationJobs: TombstoneWorkflowJob[];
  verificationRun: TombstoneWorkflowRun;
}) {
  const { tombstone } = input;
  if (input.tagCommit !== tombstone.sourceCommit) {
    throw new Error(
      `Tombstoned tag ${tombstone.tag} no longer points at its exact source.`,
    );
  }
  if (input.releaseState !== 'missing') {
    throw new Error(
      `Tombstoned tag ${tombstone.tag} already has GitHub Release state ${input.releaseState}.`,
    );
  }
  validateRun(
    input.exhaustedRun,
    tombstone.exhaustedRunId,
    tombstone.sourceCommit,
    tombstone.tag,
    tombstone.workflowSha256,
    true,
  );
  validateRun(
    input.verificationRun,
    tombstone.verificationRunId,
    tombstone.sourceCommit,
    tombstone.tag,
    tombstone.workflowSha256,
    false,
  );
  if (input.exhaustedRun.runAttempt !== 2) {
    throw new Error(
      `Release tombstone ${tombstone.tag} does not prove an exhausted automatic retry.`,
    );
  }
  if (input.verificationRun.runAttempt !== 1) {
    throw new Error(
      `Release tombstone ${tombstone.tag} has ambiguous verification retry evidence.`,
    );
  }
  requireJob(
    input.exhaustedJobs,
    'Windows x64 machine tools / Build Windows x64 machine tools',
    'failure',
  );
  requireJob(input.exhaustedJobs, 'Publish GitHub release', 'skipped');
  requireJob(
    input.verificationJobs,
    'Windows x64 machine tools / Build Windows x64 machine tools',
    'failure',
  );
  for (const [name, conclusion] of [
    ['Linux x64 machine tools / Build Linux x64 machine tools', 'success'],
    ['macOS arm64 machine tools / Build macOS arm64 runtime', 'success'],
    ['macOS arm64 machine tools / Package verified macOS machine tools', 'success'],
    ['Cross-platform quality gates', 'success'],
    ['Publish GitHub release', 'skipped'],
  ] as const) {
    requireJob(input.verificationJobs, name, conclusion);
  }
}

export function validateReleaseTombstoneHistory(input: {
  commits: string[];
  path: string;
  status: string;
}) {
  if (input.commits.length !== 1 || !isCommit(input.commits[0])) {
    throw new Error(
      `Release tombstone ${input.path} must be added once and never modified or deleted.`,
    );
  }
  if (input.status !== `A\t${input.path}`) {
    throw new Error(`Release tombstone ${input.path} was not added immutably.`);
  }
}

export function validateReleaseTombstoneDirectoryHistory(input: {
  currentPaths: string[];
  deletedPaths: string[];
}) {
  if (input.deletedPaths.length > 0) {
    throw new Error(
      `Release tombstone history contains a deletion: ${input.deletedPaths[0]}.`,
    );
  }
  for (const path of input.currentPaths) {
    const relativePath = path.startsWith(`${releaseTombstoneDirectory}/`)
      ? path.slice(releaseTombstoneDirectory.length + 1)
      : '';
    if (!relativePath || relativePath.includes('/') || !relativePath.endsWith('.json')) {
      throw new Error(`Release tombstone directory contains unexpected path ${path}.`);
    }
  }
}

function validateRun(
  run: TombstoneWorkflowRun,
  expectedId: number,
  sourceCommit: string,
  tag: string,
  workflowSha256: string,
  requireSourceHead: boolean,
) {
  if (
    run.id !== expectedId || run.displayTitle !== `Release ${tag}` ||
    run.event !== 'workflow_dispatch' || run.headBranch !== 'main' ||
    !isCommit(run.headSha) ||
    (requireSourceHead && run.headSha !== sourceCommit) ||
    run.workflowPath !== '.github/workflows/release.yml' ||
    run.workflowSha256 !== workflowSha256 ||
    run.status !== 'completed' || run.conclusion !== 'failure' ||
    !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1
  ) {
    throw new Error(`Release tombstone ${tag} has invalid workflow evidence.`);
  }
}

function requireJob(
  jobs: TombstoneWorkflowJob[],
  name: string,
  conclusion: string,
) {
  const matches = jobs.filter((job) => job.name === name);
  if (
    matches.length !== 1 || matches[0].status !== 'completed' ||
    matches[0].conclusion !== conclusion
  ) {
    throw new Error(
      `Release tombstone evidence requires ${name} to be exactly ${conclusion}.`,
    );
  }
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isRunId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}
