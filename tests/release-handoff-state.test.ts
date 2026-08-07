import { describe, expect, test } from 'bun:test';
import {
  exactProductionRuns,
  historicalReleaseTarget,
  releaseRecoveryDecision,
  releaseTagFenceDecision,
  workflowRecoveryDecision,
  type HandoffRun,
} from '../scripts/release-handoff-state';

const commit = 'a'.repeat(40);

function run(overrides: Partial<HandoffRun> = {}): HandoffRun {
  return {
    conclusion: 'failure',
    displayTitle: 'Release',
    headBranch: 'v1.0.0',
    headSha: commit,
    id: 100,
    runAttempt: 1,
    status: 'completed',
    ...overrides,
  };
}

describe('durable delivery recovery decisions', () => {
  test('dispatches only when the release and exact run are missing', () => {
    expect(releaseRecoveryDecision('missing', [])).toEqual({ kind: 'dispatch' });
  });

  test('waits for an active exact run', () => {
    const active = run({ conclusion: null, status: 'in_progress' });
    expect(releaseRecoveryDecision('missing', [active])).toEqual({
      kind: 'wait',
      run: active,
    });
  });

  test('fails closed when a successful run has no published release', () => {
    expect(releaseRecoveryDecision('missing', [
      run({ conclusion: 'success' }),
    ])).toEqual({ kind: 'error', reason: 'success-without-result' });
  });

  test('reruns failed attempt one exactly once', () => {
    const failed = run();
    expect(releaseRecoveryDecision('missing', [failed])).toEqual({
      kind: 'rerun',
      run: failed,
    });
  });

  test('fails closed after the automatic recovery attempt', () => {
    expect(releaseRecoveryDecision('missing', [
      run({ runAttempt: 2 }),
    ])).toEqual({ kind: 'error', reason: 'retry-exhausted' });
  });

  test('never treats an existing draft as missing', () => {
    expect(() => releaseRecoveryDecision('draft', [])).toThrow(
      'A draft GitHub Release already exists',
    );
  });

  test('binds Production recovery to its requested exact commit title', () => {
    const exact = run({
      displayTitle: `Production · ${commit}`,
      headBranch: 'main',
    });
    const olderInput = run({
      displayTitle: `Production · ${'b'.repeat(40)}`,
      headBranch: 'main',
      id: 101,
    });
    expect(exactProductionRuns([olderInput, exact], commit)).toEqual([exact]);
    expect(workflowRecoveryDecision([exact])).toEqual({
      kind: 'rerun',
      run: exact,
    });
  });
});

describe('published release tag fencing', () => {
  const historical = {
    additionCommit: historicalReleaseTarget.additionCommit,
    firstParentHistory: true,
    identityUnchanged: true,
    releaseState: 'published' as const,
    signedManifestMatches: true,
    tag: historicalReleaseTarget.tag,
    tagCommit: historicalReleaseTarget.publishedCommit,
  };

  test('accepts the normal exact addition commit', () => {
    expect(releaseTagFenceDecision({
      ...historical,
      additionCommit: commit,
      tag: 'v1.0.0',
      tagCommit: commit,
    })).toBe('exact');
  });

  test('accepts only the fully proven immutable v0.4.65 history', () => {
    expect(releaseTagFenceDecision(historical)).toBe('historical');
  });

  test.each([
    ['missing release', { releaseState: 'missing' as const }],
    ['draft release', { releaseState: 'draft' as const }],
    ['wrong addition commit', { additionCommit: 'b'.repeat(40) }],
    ['wrong published commit', { tagCommit: 'c'.repeat(40) }],
    ['arbitrary future tag', { tag: 'v0.4.66' }],
    ['non-main history', { firstParentHistory: false }],
    ['changed release identity', { identityUnchanged: false }],
    ['mismatched signed manifest', { signedManifestMatches: false }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => releaseTagFenceDecision({ ...historical, ...overrides }))
      .toThrow('not its main addition commit');
  });

  test('keeps a genuinely missing unpublished tag eligible for creation', () => {
    expect(releaseTagFenceDecision({
      ...historical,
      additionCommit: commit,
      releaseState: 'missing',
      tag: 'v1.0.0',
      tagCommit: undefined,
    })).toBe('missing');
  });

  test('rejects a published release whose tag disappeared', () => {
    expect(() => releaseTagFenceDecision({
      ...historical,
      tagCommit: undefined,
    })).toThrow('has no Git tag');
  });
});
