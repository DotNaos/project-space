import {
  isIssueCreationPath,
  issueCreationPath,
  issueListPath
} from './issue-creation-route';

const issueCreationStateKey = 'projectSpaceIssueCreation';

interface IssueCreationHistoryMarker {
  projectId: string;
  version: 1;
}

export interface IssueCreationHistoryLocation {
  hash: string;
  pathname: string;
  search: string;
  state: unknown;
}

export interface IssueCreationHistoryAdapter {
  back(): void;
  forward(): void;
  location(): IssueCreationHistoryLocation;
  push(state: unknown, url: string): void;
  replace(state: unknown, url: string): void;
}

export interface IssueCreationHistoryCallbacks {
  onCloseRequest(): void;
  onClosed(): void;
  onOpen(): void;
}

type EntryKind = 'direct' | 'pushed';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function markerFor(state: unknown): IssueCreationHistoryMarker | null {
  const marker = record(record(state)?.[issueCreationStateKey]);

  return marker?.version === 1 && typeof marker.projectId === 'string'
    ? { projectId: marker.projectId, version: 1 }
    : null;
}

function stateWithMarker(state: unknown, projectId: string) {
  return {
    ...(record(state) ?? {}),
    [issueCreationStateKey]: { projectId, version: 1 }
  };
}

function stateWithoutMarker(state: unknown) {
  const current = record(state);
  if (!current || !(issueCreationStateKey in current)) return state;

  const { [issueCreationStateKey]: _removed, ...rest } = current;
  return rest;
}

function pathWithCurrentSuffix(path: string, location: IssueCreationHistoryLocation) {
  return `${path}${location.search}${location.hash}`;
}

export function browserIssueCreationHistory(): IssueCreationHistoryAdapter {
  return {
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    location: () => ({
      hash: window.location.hash,
      pathname: window.location.pathname,
      search: window.location.search,
      state: window.history.state
    }),
    push: (state, url) => window.history.pushState(state, '', url),
    replace: (state, url) => window.history.replaceState(state, '', url)
  };
}

/**
 * Keeps the creation overlay and browser history in lockstep. A browser Back
 * first restores the guarded creation entry so the overlay can ask whether a
 * dirty draft should be discarded; a confirmed close then resumes that Back.
 */
export class IssueCreationHistoryController {
  private browserBackPending = false;
  private closingTraversal = false;
  private entryKind: EntryKind;
  private open: boolean;
  private restoringTraversal = false;

  constructor(
    private readonly projectId: string,
    private readonly history: IssueCreationHistoryAdapter,
    private readonly callbacks: IssueCreationHistoryCallbacks
  ) {
    const location = history.location();
    this.open = isIssueCreationPath(location.pathname, projectId);
    this.entryKind = this.hasOwnedMarker(location.state) ? 'pushed' : 'direct';
  }

  isOpen() {
    return this.open;
  }

  openFromControl() {
    if (this.open) return;

    const location = this.history.location();
    const nextPath = pathWithCurrentSuffix(issueCreationPath(this.projectId), location);
    this.history.push(stateWithMarker(location.state, this.projectId), nextPath);
    this.entryKind = 'pushed';
    this.open = true;
    this.callbacks.onOpen();
  }

  finishClose() {
    if (!this.open || this.closingTraversal) return;

    const location = this.history.location();
    const shouldResumeBack = this.browserBackPending;
    const shouldReturnToList =
      this.entryKind === 'pushed' && this.hasOwnedMarker(location.state);

    this.browserBackPending = false;
    if (shouldResumeBack || shouldReturnToList) {
      this.closingTraversal = true;
      this.history.back();
      return;
    }

    this.history.replace(
      stateWithoutMarker(location.state),
      pathWithCurrentSuffix(issueListPath(this.projectId), location)
    );
    this.completeClose();
  }

  handlePopState() {
    const location = this.history.location();
    const atCreationRoute = isIssueCreationPath(location.pathname, this.projectId);

    if (this.closingTraversal) {
      if (atCreationRoute) {
        // Skip a stale duplicate creation entry left by an older app version.
        this.history.back();
        return;
      }

      this.closingTraversal = false;
      this.completeClose();
      return;
    }

    if (this.restoringTraversal) {
      this.restoringTraversal = false;
      if (atCreationRoute) {
        this.entryKind = this.hasOwnedMarker(location.state) ? 'pushed' : 'direct';
        this.browserBackPending = true;
        this.callbacks.onCloseRequest();
      } else {
        this.open = false;
        this.callbacks.onClosed();
      }
      return;
    }

    if (this.open && !atCreationRoute) {
      this.restoringTraversal = true;
      this.history.forward();
      return;
    }

    if (!this.open && atCreationRoute) {
      this.open = true;
      this.entryKind = this.hasOwnedMarker(location.state) ? 'pushed' : 'direct';
      this.callbacks.onOpen();
    }
  }

  private completeClose() {
    this.open = false;
    this.restoringTraversal = false;
    this.callbacks.onClosed();
  }

  private hasOwnedMarker(state: unknown) {
    return markerFor(state)?.projectId === this.projectId;
  }
}
