import { describe, expect, test } from 'bun:test';

import {
  IssueCreationHistoryController,
  listenForIssueCreationRequests,
  requestIssueCreation,
  type IssueCreationHistoryAdapter,
  type IssueCreationHistoryLocation
} from '../src/features/project-desktop/components/issue-creation-history';
import {
  issueCreationPath,
  issueListPath
} from '../src/features/project-desktop/components/issue-creation-route';

const projectId = 'github:DotNaos/project-space';
const listPath = issueListPath(projectId);
const creationPath = issueCreationPath(projectId);

class FakeHistory implements IssueCreationHistoryAdapter {
  private index: number;

  constructor(
    private entries: Array<{ state: unknown; url: string }>,
    initialIndex = entries.length - 1
  ) {
    this.index = initialIndex;
  }

  back() {
    this.index = Math.max(0, this.index - 1);
  }

  forward() {
    this.index = Math.min(this.entries.length - 1, this.index + 1);
  }

  location(): IssueCreationHistoryLocation {
    const current = new URL(this.entries[this.index].url, 'https://project-space.test');
    return {
      hash: current.hash,
      pathname: current.pathname,
      search: current.search,
      state: this.entries[this.index].state
    };
  }

  push(state: unknown, url: string) {
    this.entries.splice(this.index + 1, this.entries.length, { state, url });
    this.index += 1;
  }

  replace(state: unknown, url: string) {
    this.entries[this.index] = { state, url };
  }

  snapshot() {
    return {
      index: this.index,
      paths: this.entries.map((entry) => new URL(
        entry.url,
        'https://project-space.test'
      ).pathname)
    };
  }
}

function setup(history: FakeHistory) {
  const events: string[] = [];
  const controller = new IssueCreationHistoryController(projectId, history, {
    onCloseRequest: () => events.push('close-requested'),
    onClosed: () => events.push('closed'),
    onOpen: () => events.push('opened')
  });
  return { controller, events };
}

describe('issue creation history', () => {
  test('routes shell creation requests only to the matching project', () => {
    const target = new EventTarget();
    const events: string[] = [];
    const stopProject = listenForIssueCreationRequests(
      projectId,
      () => events.push('project'),
      target
    );
    const stopOther = listenForIssueCreationRequests(
      'github:DotNaos/other',
      () => events.push('other'),
      target
    );

    requestIssueCreation(projectId, target);
    stopProject();
    requestIssueCreation(projectId, target);

    expect(events).toEqual(['project']);
    stopOther();
  });

  test('pushes creation and closes back onto the single existing list entry', () => {
    const history = new FakeHistory([{ state: { preserved: true }, url: `${listPath}?q=bug#issues` }]);
    const { controller, events } = setup(history);

    controller.openFromControl();
    expect(history.location()).toMatchObject({
      hash: '#issues',
      pathname: creationPath,
      search: '?q=bug'
    });

    controller.finishClose();
    controller.handlePopState();

    expect(history.snapshot()).toEqual({
      index: 0,
      paths: [listPath, creationPath]
    });
    expect(events).toEqual(['opened', 'closed']);
  });

  test('replaces a direct creation entry with the issue list', () => {
    const history = new FakeHistory([{ state: { preserved: true }, url: `${creationPath}?q=bug` }]);
    const { controller, events } = setup(history);

    expect(controller.isOpen()).toBe(true);
    controller.finishClose();

    expect(history.snapshot()).toEqual({ index: 0, paths: [listPath] });
    expect(history.location()).toMatchObject({ pathname: listPath, search: '?q=bug' });
    expect(history.location().state).toEqual({ preserved: true });
    expect(events).toEqual(['closed']);
  });

  test('restores a dirty Back target before asking the overlay to discard', () => {
    const history = new FakeHistory([{ state: null, url: listPath }]);
    const { controller, events } = setup(history);
    controller.openFromControl();

    history.back();
    controller.handlePopState();
    expect(history.location().pathname).toBe(creationPath);

    controller.handlePopState();
    expect(events).toEqual(['opened', 'close-requested']);
    expect(controller.isOpen()).toBe(true);

    // Canceling the overlay confirmation needs no history action and stays put.
    expect(history.location().pathname).toBe(creationPath);

    controller.finishClose();
    controller.handlePopState();
    expect(history.location().pathname).toBe(listPath);
    expect(events).toEqual(['opened', 'close-requested', 'closed']);
  });

  test('Forward reopens the same pushed creation entry after a clean close', () => {
    const history = new FakeHistory([{ state: null, url: listPath }]);
    const { controller, events } = setup(history);
    controller.openFromControl();
    controller.finishClose();
    controller.handlePopState();

    history.forward();
    controller.handlePopState();

    expect(history.location().pathname).toBe(creationPath);
    expect(controller.isOpen()).toBe(true);
    expect(events).toEqual(['opened', 'closed', 'opened']);
  });
});
