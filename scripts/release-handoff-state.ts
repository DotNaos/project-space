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
