import { describe, expect, test } from 'bun:test';

import {
  canSubmitIssueCreation,
  createInitialIssueCreationState,
  filterIssueCreationLabels,
  isIssueCreationDirty,
  issueCreationCloseDecision,
  issueCreationRequest,
  issueCreationReducer,
  issueCreationSubmissionLabels,
  matchesIssueCreationSubmission,
  type IssueCreationAction,
  type IssueCreationState
} from '../src/features/project-desktop/components/issue-creation-model';

function reduce(state: IssueCreationState, ...actions: IssueCreationAction[]) {
  return actions.reduce(issueCreationReducer, state);
}

function connectedDraft(repositoryKey = 'DotNaos/project-space') {
  return reduce(
    createInitialIssueCreationState({ connected: true, repositoryKey }),
    { title: '  A useful issue  ', type: 'title-changed' },
    { body: 'Markdown details', type: 'body-changed' }
  );
}

function loadLabels(
  state: IssueCreationState,
  labels = [
    { color: 'd73a4a', description: 'Something is broken', name: 'bug' },
    { color: 'a2eeef', description: 'New feature or request', name: 'enhancement' }
  ]
) {
  const repositoryKey = state.repositoryKey ?? 'DotNaos/project-space';

  return reduce(
    state,
    { repositoryKey, requestId: 'labels-1', type: 'labels-load-started' },
    {
      labels,
      repositoryKey,
      requestId: 'labels-1',
      type: 'labels-load-succeeded'
    }
  );
}

describe('issue creation state', () => {
  test('requires a connected repository and a trimmed title', () => {
    const disconnected = reduce(
      createInitialIssueCreationState({ repositoryKey: 'DotNaos/project-space' }),
      { title: 'Issue', type: 'title-changed' }
    );
    expect(canSubmitIssueCreation(disconnected)).toBe(false);

    const whitespace = reduce(
      createInitialIssueCreationState({
        connected: true,
        repositoryKey: 'DotNaos/project-space'
      }),
      { title: '   ', type: 'title-changed' }
    );
    expect(canSubmitIssueCreation(whitespace)).toBe(false);
    expect(canSubmitIssueCreation(connectedDraft())).toBe(true);
  });

  test('normalizes real labels and never submits invented labels', () => {
    let state = loadLabels(connectedDraft(), [
      { color: 'FF0000', name: 'bug' },
      { color: 'not-a-color', name: ' enhancement ' },
      { name: 'BUG' },
      { name: '  ' }
    ]);

    state = reduce(
      state,
      { name: 'invented', type: 'label-toggled' },
      { name: 'bug', type: 'label-toggled' }
    );

    expect(state.labels.labels).toEqual([
      { color: 'ff0000', name: 'bug' },
      { color: undefined, name: 'enhancement' }
    ]);
    expect(state.selectedLabels).toEqual(['bug']);
    expect(issueCreationSubmissionLabels(state)).toEqual(['bug']);
    expect(issueCreationRequest(state)).toEqual({
      body: 'Markdown details',
      fullName: 'DotNaos/project-space',
      labels: ['bug'],
      title: 'A useful issue'
    });
  });

  test('searches label names and descriptions without changing selection', () => {
    const state = loadLabels(connectedDraft());
    const labels = state.labels.labels;

    expect(filterIssueCreationLabels(labels, 'BROK')).toEqual([labels[0]]);
    expect(filterIssueCreationLabels(labels, 'feature')).toEqual([labels[1]]);
    expect(filterIssueCreationLabels(labels, '   ')).toEqual(labels);
    expect(state.selectedLabels).toEqual([]);
  });

  test('rejects stale label success and failure responses', () => {
    let state = connectedDraft();
    state = issueCreationReducer(state, {
      repositoryKey: 'DotNaos/project-space',
      requestId: 'labels-old',
      type: 'labels-load-started'
    });
    state = issueCreationReducer(state, {
      repositoryKey: 'DotNaos/project-space',
      requestId: 'labels-new',
      type: 'labels-load-started'
    });

    const beforeStaleResponses = state;
    state = reduce(
      state,
      {
        labels: [{ name: 'stale' }],
        repositoryKey: 'DotNaos/project-space',
        requestId: 'labels-old',
        type: 'labels-load-succeeded'
      },
      {
        error: 'also stale',
        repositoryKey: 'DotNaos/project-space',
        requestId: 'labels-old',
        type: 'labels-load-failed'
      }
    );
    expect(state).toBe(beforeStaleResponses);

    state = issueCreationReducer(state, {
      error: 'Try again',
      repositoryKey: 'DotNaos/project-space',
      requestId: 'labels-new',
      type: 'labels-load-failed'
    });
    expect(state.labels.status).toBe('failed');
  });

  test('keeps the draft usable without labels when the first load fails', () => {
    let state = connectedDraft();
    state = reduce(
      state,
      {
        repositoryKey: 'DotNaos/project-space',
        requestId: 'labels-1',
        type: 'labels-load-started'
      },
      {
        error: 'GitHub labels are unavailable.',
        repositoryKey: 'DotNaos/project-space',
        requestId: 'labels-1',
        type: 'labels-load-failed'
      }
    );

    expect(state.title).toBe('  A useful issue  ');
    expect(state.body).toBe('Markdown details');
    expect(state.labels.status).toBe('failed');
    expect(issueCreationSubmissionLabels(state)).toEqual([]);
    expect(canSubmitIssueCreation(state)).toBe(true);
  });

  test('preserves same-repository selections across a failed refresh', () => {
    let state = loadLabels(connectedDraft());
    state = reduce(
      state,
      { name: 'bug', type: 'label-toggled' },
      {
        repositoryKey: 'DotNaos/project-space',
        requestId: 'labels-2',
        type: 'labels-load-started'
      },
      {
        error: 'Refresh failed.',
        repositoryKey: 'DotNaos/project-space',
        requestId: 'labels-2',
        type: 'labels-load-failed'
      }
    );

    expect(state.labels.status).toBe('failed');
    expect(state.labels.labels.map((label) => label.name)).toEqual(['bug', 'enhancement']);
    expect(state.selectedLabels).toEqual(['bug']);
    expect(issueCreationSubmissionLabels(state)).toEqual(['bug']);
    expect(canSubmitIssueCreation(state)).toBe(true);
  });

  test('preserves the portable draft and invalidates repository-specific state on switch', () => {
    let state = loadLabels(connectedDraft('DotNaos/first'));
    state = reduce(
      state,
      { name: 'bug', type: 'label-toggled' },
      { requestId: 'create-first', type: 'submission-started' },
      { connected: true, repositoryKey: 'DotNaos/second', type: 'repository-changed' }
    );

    expect(state.title).toBe('  A useful issue  ');
    expect(state.body).toBe('Markdown details');
    expect(state.selectedLabels).toEqual([]);
    expect(state.labels).toEqual({
      labels: [],
      repositoryKey: 'DotNaos/second',
      requestId: null,
      status: 'idle'
    });
    expect(state.submission.status).toBe('idle');
    expect(canSubmitIssueCreation(state)).toBe(true);

    const staleResult = issueCreationReducer(state, {
      repositoryKey: 'DotNaos/first',
      requestId: 'create-first',
      type: 'submission-succeeded'
    });
    expect(staleResult).toBe(state);
  });

  test('closes clean forms immediately and confirms before discarding dirty forms', () => {
    const clean = createInitialIssueCreationState({
      connected: true,
      repositoryKey: 'DotNaos/project-space'
    });
    expect(issueCreationCloseDecision(clean)).toBe('close');

    let dirty = connectedDraft();
    expect(isIssueCreationDirty(dirty)).toBe(true);
    expect(issueCreationCloseDecision(dirty)).toBe('confirm-discard');

    dirty = issueCreationReducer(dirty, { type: 'discard-requested' });
    expect(dirty.discardConfirmationOpen).toBe(true);
    dirty = issueCreationReducer(dirty, { type: 'discard-canceled' });
    expect(dirty.discardConfirmationOpen).toBe(false);
    dirty = issueCreationReducer(dirty, { type: 'discard-confirmed' });
    expect(isIssueCreationDirty(dirty)).toBe(false);
    expect(issueCreationCloseDecision(dirty)).toBe('close');
  });

  test('retains values after failure, permits retry, and resets only for current success', () => {
    let state = loadLabels(connectedDraft());
    state = reduce(state, { name: 'bug', type: 'label-toggled' });
    state = issueCreationReducer(state, {
      requestId: 'create-1',
      type: 'submission-started'
    });
    expect(matchesIssueCreationSubmission(state, 'DotNaos/project-space', 'create-1')).toBe(
      true
    );
    expect(canSubmitIssueCreation(state)).toBe(false);

    state = issueCreationReducer(state, {
      error: 'GitHub is unavailable',
      repositoryKey: 'DotNaos/project-space',
      requestId: 'create-1',
      type: 'submission-failed'
    });
    expect(state.submission.status).toBe('failed');
    expect(state.title).toBe('  A useful issue  ');
    expect(state.body).toBe('Markdown details');
    expect(state.selectedLabels).toEqual(['bug']);
    expect(canSubmitIssueCreation(state)).toBe(true);

    state = issueCreationReducer(state, {
      requestId: 'create-2',
      type: 'submission-started'
    });
    const beforeStaleSuccess = state;
    state = issueCreationReducer(state, {
      repositoryKey: 'DotNaos/project-space',
      requestId: 'create-1',
      type: 'submission-succeeded'
    });
    expect(state).toBe(beforeStaleSuccess);

    state = issueCreationReducer(state, {
      repositoryKey: 'DotNaos/project-space',
      requestId: 'create-2',
      type: 'submission-succeeded'
    });
    expect(state.title).toBe('');
    expect(state.body).toBe('');
    expect(state.selectedLabels).toEqual([]);
    expect(state.submission.status).toBe('idle');
    expect(isIssueCreationDirty(state)).toBe(false);
  });
});
