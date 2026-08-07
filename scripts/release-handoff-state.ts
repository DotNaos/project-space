export interface HandoffRun {
  conclusion: string | null;
  displayTitle: string;
  headBranch: string;
  headSha: string;
  id: number;
  runAttempt: number;
  status: string;
}

export type RecoveryDecision =
  | { kind: 'complete'; run: HandoffRun }
  | { kind: 'dispatch' }
  | { kind: 'error'; reason: 'retry-exhausted' | 'success-without-result' }
  | { kind: 'rerun'; run: HandoffRun }
  | { kind: 'wait'; run: HandoffRun };

export interface ReleaseTagFenceInput {
  additionCommit: string;
  firstParentHistory: boolean;
  identityUnchanged: boolean;
  releaseState: 'draft' | 'missing' | 'published';
  signedManifestMatches: boolean;
  tag: string;
  tagCommit?: string;
}

export const historicalReleaseTarget = {
  additionCommit: '14b272577786d585256109fe8acc2b3b43cf43da',
  publishedCommit: '3624efc2b6e2be9754026a9142050392ce057b0c',
  tag: 'v0.4.65',
} as const;

export function releaseTagFenceDecision(input: ReleaseTagFenceInput) {
  if (!input.tagCommit) {
    if (input.releaseState === 'published') {
      throw new Error(`Published GitHub Release ${input.tag} has no Git tag.`);
    }
    return 'missing' as const;
  }
  if (input.tagCommit === input.additionCommit) return 'exact' as const;
  const approvedHistoricalTarget =
    input.tag === historicalReleaseTarget.tag &&
    input.additionCommit === historicalReleaseTarget.additionCommit &&
    input.tagCommit === historicalReleaseTarget.publishedCommit;
  if (
    approvedHistoricalTarget && input.releaseState === 'published' &&
    input.firstParentHistory && input.identityUnchanged &&
    input.signedManifestMatches
  ) {
    return 'historical' as const;
  }
  throw new Error(
    `Tag ${input.tag} identifies ${input.tagCommit}, not its main addition commit ${input.additionCommit}.`,
  );
}

export function releaseRecoveryDecision(
  releaseState: 'draft' | 'missing',
  runs: HandoffRun[],
): RecoveryDecision {
  if (releaseState === 'draft') {
    throw new Error(
      'A draft GitHub Release already exists; ownership must be resolved before recovery.',
    );
  }
  const decision = workflowRecoveryDecision(runs);
  return decision.kind === 'complete'
    ? { kind: 'error', reason: 'success-without-result' }
    : decision;
}

export function workflowRecoveryDecision(
  runs: HandoffRun[],
): RecoveryDecision {
  const active = runs.find((run) => run.status !== 'completed');
  if (active) return { kind: 'wait', run: active };
  const successful = runs.find(
    (run) => run.status === 'completed' && run.conclusion === 'success',
  );
  if (successful) return { kind: 'complete', run: successful };
  const failed = runs.find((run) => run.status === 'completed');
  if (!failed) return { kind: 'dispatch' };
  return failed.runAttempt > 1
    ? { kind: 'error', reason: 'retry-exhausted' }
    : { kind: 'rerun', run: failed };
}

export function exactProductionRuns(
  runs: HandoffRun[],
  commit: string,
) {
  return runs.filter((run) =>
    run.headSha === commit &&
    run.headBranch === 'main' &&
    run.displayTitle === `Production · ${commit}`);
}
