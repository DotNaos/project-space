export interface IssueCreationLabel {
  color?: string;
  description?: string;
  name: string;
}

interface IssueCreationLabelsBase {
  labels: readonly IssueCreationLabel[];
  repositoryKey: string | null;
}

export type IssueCreationLabelsState =
  | (IssueCreationLabelsBase & {
      requestId: null;
      status: 'idle';
    })
  | (IssueCreationLabelsBase & {
      repositoryKey: string;
      requestId: string;
      status: 'loading';
    })
  | (IssueCreationLabelsBase & {
      repositoryKey: string;
      requestId: string;
      status: 'ready';
    })
  | (IssueCreationLabelsBase & {
      error: string;
      repositoryKey: string;
      requestId: string;
      status: 'failed';
    });

export type IssueCreationSubmissionState =
  | { status: 'idle' }
  | {
      repositoryKey: string;
      requestId: string;
      status: 'submitting';
    }
  | {
      error: string;
      repositoryKey: string;
      requestId: string;
      status: 'failed';
    };

export interface IssueCreationState {
  body: string;
  discardConfirmationOpen: boolean;
  labels: IssueCreationLabelsState;
  repositoryConnected: boolean;
  repositoryKey: string | null;
  selectedLabels: readonly string[];
  submission: IssueCreationSubmissionState;
  title: string;
}

export type IssueCreationAction =
  | {
      connected: boolean;
      repositoryKey: string | null;
      type: 'repository-changed';
    }
  | { title: string; type: 'title-changed' }
  | { body: string; type: 'body-changed' }
  | {
      body: string;
      repositoryKey: string;
      selectedLabels: readonly string[];
      title: string;
      type: 'uncertain-draft-restored';
    }
  | { name: string; type: 'label-toggled' }
  | {
      repositoryKey: string;
      requestId: string;
      type: 'labels-load-started';
    }
  | {
      allowSelection?: boolean;
      labels: readonly IssueCreationLabel[];
      repositoryKey: string;
      requestId: string;
      type: 'labels-load-succeeded';
    }
  | {
      error: string;
      repositoryKey: string;
      requestId: string;
      type: 'labels-load-failed';
    }
  | { requestId: string; type: 'submission-started' }
  | {
      error: string;
      repositoryKey: string;
      requestId: string;
      type: 'submission-failed';
    }
  | {
      repositoryKey: string;
      requestId: string;
      type: 'submission-succeeded';
    }
  | { type: 'discard-requested' }
  | { type: 'discard-canceled' }
  | { type: 'discard-confirmed' }
  | { type: 'form-reset' };

export type IssueCreationCloseDecision = 'close' | 'confirm-discard';

function idleLabels(repositoryKey: string | null): IssueCreationLabelsState {
  return { labels: [], repositoryKey, requestId: null, status: 'idle' };
}

export function createInitialIssueCreationState({
  connected = false,
  repositoryKey = null
}: {
  connected?: boolean;
  repositoryKey?: string | null;
} = {}): IssueCreationState {
  const normalizedRepositoryKey = repositoryKey || null;

  return {
    body: '',
    discardConfirmationOpen: false,
    labels: idleLabels(normalizedRepositoryKey),
    repositoryConnected: Boolean(normalizedRepositoryKey) && connected,
    repositoryKey: normalizedRepositoryKey,
    selectedLabels: [],
    submission: { status: 'idle' },
    title: ''
  };
}

export function isIssueCreationDirty(state: IssueCreationState) {
  return state.title.length > 0 || state.body.length > 0 || state.selectedLabels.length > 0;
}

export function issueCreationCloseDecision(
  state: IssueCreationState
): IssueCreationCloseDecision {
  return isIssueCreationDirty(state) ? 'confirm-discard' : 'close';
}

function normalizedColor(color?: string) {
  const value = color?.trim().toLowerCase();

  return value && /^[0-9a-f]{6}$/.test(value) ? value : undefined;
}

function normalizeLabels(labels: readonly IssueCreationLabel[]) {
  const unique = new Map<string, IssueCreationLabel>();

  for (const label of labels) {
    const name = label.name.trim();
    const key = name.toLocaleLowerCase();

    if (!name || unique.has(key)) {
      continue;
    }

    const description = label.description?.trim();
    unique.set(key, {
      color: normalizedColor(label.color),
      description: description || undefined,
      name
    });
  }

  return Array.from(unique.values());
}

export function filterIssueCreationLabels(
  labels: readonly IssueCreationLabel[],
  query: string
) {
  const needle = query.trim().toLocaleLowerCase();

  if (!needle) {
    return labels;
  }

  return labels.filter((label) =>
    `${label.name}\n${label.description ?? ''}`.toLocaleLowerCase().includes(needle)
  );
}

function currentLabelNames(state: IssueCreationState) {
  if (state.labels.repositoryKey !== state.repositoryKey) {
    return new Set<string>();
  }

  return new Set(state.labels.labels.map((label) => label.name));
}

export function issueCreationSubmissionLabels(state: IssueCreationState) {
  const availableNames = currentLabelNames(state);

  return state.selectedLabels.filter((name) => availableNames.has(name));
}

export function visibleIssueCreationLabels(
  state: IssueCreationState,
  repositoryKey: string | null
): IssueCreationLabelsState {
  if (state.repositoryKey === repositoryKey) return state.labels;
  return repositoryKey
    ? {
        labels: [],
        repositoryKey,
        requestId: 'repository-transition',
        status: 'loading'
      }
    : idleLabels(null);
}

export function issueCreationRequest(state: IssueCreationState) {
  if (!canSubmitIssueCreation(state) || !state.repositoryKey) {
    return null;
  }

  return {
    body: state.body,
    fullName: state.repositoryKey,
    labels: issueCreationSubmissionLabels(state),
    title: state.title.trim()
  };
}

export function canSubmitIssueCreation(state: IssueCreationState) {
  return Boolean(
    state.repositoryConnected &&
      state.repositoryKey &&
      state.title.trim() &&
      state.submission.status !== 'submitting'
  );
}

export function matchesIssueCreationSubmission(
  state: IssueCreationState,
  repositoryKey: string,
  requestId: string
) {
  return (
    state.repositoryKey === repositoryKey &&
    state.submission.status === 'submitting' &&
    state.submission.repositoryKey === repositoryKey &&
    state.submission.requestId === requestId
  );
}

function isCurrentLabelRequest(
  state: IssueCreationState,
  repositoryKey: string,
  requestId: string
) {
  return (
    state.repositoryKey === repositoryKey &&
    state.labels.status === 'loading' &&
    state.labels.repositoryKey === repositoryKey &&
    state.labels.requestId === requestId
  );
}

function resetDraft(state: IssueCreationState): IssueCreationState {
  return {
    ...state,
    body: '',
    discardConfirmationOpen: false,
    selectedLabels: [],
    submission: { status: 'idle' },
    title: ''
  };
}

export function issueCreationReducer(
  state: IssueCreationState,
  action: IssueCreationAction
): IssueCreationState {
  switch (action.type) {
    case 'repository-changed': {
      const repositoryKey = action.repositoryKey || null;
      const repositoryConnected = Boolean(repositoryKey) && action.connected;

      if (repositoryKey === state.repositoryKey) {
        return { ...state, repositoryConnected };
      }

      return {
        ...state,
        discardConfirmationOpen: false,
        labels: idleLabels(repositoryKey),
        repositoryConnected,
        repositoryKey,
        selectedLabels: [],
        submission: { status: 'idle' }
      };
    }
    case 'title-changed':
      return { ...state, title: action.title };
    case 'body-changed':
      return { ...state, body: action.body };
    case 'uncertain-draft-restored':
      if (
        action.repositoryKey !== state.repositoryKey
        || !state.repositoryConnected
        || !action.title.trim()
      ) {
        return state;
      }
      return {
        ...state,
        body: action.body,
        discardConfirmationOpen: false,
        selectedLabels: Array.from(new Set(action.selectedLabels)),
        submission: {
          error: 'GitHub may already have created this issue. Check GitHub again before leaving. Pasted images cannot be restored after a reload and must be re-added before retrying.',
          repositoryKey: action.repositoryKey,
          requestId: 'restored-uncertain-operation',
          status: 'failed'
        },
        title: action.title
      };
    case 'labels-load-started':
      if (
        action.repositoryKey !== state.repositoryKey ||
        !state.repositoryConnected ||
        !action.requestId
      ) {
        return state;
      }

      return {
        ...state,
        labels: {
          labels:
            state.labels.repositoryKey === action.repositoryKey ? state.labels.labels : [],
          repositoryKey: action.repositoryKey,
          requestId: action.requestId,
          status: 'loading'
        }
      };
    case 'labels-load-succeeded': {
      if (!isCurrentLabelRequest(state, action.repositoryKey, action.requestId)) {
        return state;
      }

      const labels = normalizeLabels(action.labels);
      const names = new Set(labels.map((label) => label.name));

      return {
        ...state,
        labels: {
          labels,
          repositoryKey: action.repositoryKey,
          requestId: action.requestId,
          status: 'ready'
        },
        selectedLabels: action.allowSelection === false
          ? []
          : state.selectedLabels.filter((name) => names.has(name))
      };
    }
    case 'labels-load-failed':
      if (!isCurrentLabelRequest(state, action.repositoryKey, action.requestId)) {
        return state;
      }

      return {
        ...state,
        labels: {
          error: action.error || 'Could not load repository labels.',
          labels: state.labels.labels,
          repositoryKey: action.repositoryKey,
          requestId: action.requestId,
          status: 'failed'
        }
      };
    case 'label-toggled': {
      const selected = new Set(state.selectedLabels);

      if (selected.has(action.name)) {
        selected.delete(action.name);
      } else if (currentLabelNames(state).has(action.name)) {
        selected.add(action.name);
      }

      return { ...state, selectedLabels: Array.from(selected) };
    }
    case 'submission-started':
      if (!canSubmitIssueCreation(state) || !state.repositoryKey || !action.requestId) {
        return state;
      }

      return {
        ...state,
        discardConfirmationOpen: false,
        submission: {
          repositoryKey: state.repositoryKey,
          requestId: action.requestId,
          status: 'submitting'
        }
      };
    case 'submission-failed':
      if (!matchesIssueCreationSubmission(state, action.repositoryKey, action.requestId)) {
        return state;
      }

      return {
        ...state,
        submission: {
          error: action.error || 'Could not create issue.',
          repositoryKey: action.repositoryKey,
          requestId: action.requestId,
          status: 'failed'
        }
      };
    case 'submission-succeeded':
      return matchesIssueCreationSubmission(state, action.repositoryKey, action.requestId)
        ? resetDraft(state)
        : state;
    case 'discard-requested':
      return isIssueCreationDirty(state)
        ? { ...state, discardConfirmationOpen: true }
        : state;
    case 'discard-canceled':
      return { ...state, discardConfirmationOpen: false };
    case 'discard-confirmed':
    case 'form-reset':
      return resetDraft(state);
  }
}
