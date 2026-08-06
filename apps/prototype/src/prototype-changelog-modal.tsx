import { useEffect, useMemo, useState } from 'react';
import { Modal, Tabs } from '@heroui/react';
import {
  FileClock,
  GitBranch,
  GitPullRequest,
  RefreshCw,
  ScrollText
} from 'lucide-react';

import { PullRequestChangelogSummary } from '../../../src/features/pr-preview-changelog/pull-request-changelog-summary';
import { pullRequestChangelogSnapshotFor } from '../../../src/features/pr-preview-changelog/pull-request-changelog-snapshot';
import {
  isPullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from '../../../src/shared/pr-preview-changelog-api';
import type { PrototypeTheme } from '../../../src/shared/prototype-canvas';
import {
  isPrototypeReviewLocalChangelogSnapshot,
  type PrototypeReviewChecklistItem,
  type PrototypeReviewLocalChangelogSnapshot
} from '../../../src/shared/prototype-review-local-changelog-api';
import { PrototypeReleaseEntryContent } from './prototype-release-entry-content';
import { PrototypeWipReview } from './prototype-wip-review';
import type { MockTask } from './project-space-pages/task-model';

const localChangelogPath = '/api/prototype-review/local-changelog';

export function PrototypeChangelogModal({
  isOpen,
  mockTask,
  onOpenChange,
  theme
}: {
  isOpen: boolean;
  mockTask?: MockTask;
  onOpenChange(open: boolean): void;
  theme: PrototypeTheme;
}) {
  return mockTask
    ? <MockTaskChangelogModal isOpen={isOpen} onOpenChange={onOpenChange} task={mockTask} theme={theme} />
    : <RepositoryChangelogModal isOpen={isOpen} onOpenChange={onOpenChange} theme={theme} />;
}

function RepositoryChangelogModal({
  isOpen,
  onOpenChange,
  theme,
}: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  theme: PrototypeTheme;
}) {
  const [tab, setTab] = useState('changelog');
  const local = useLocalChangelog(isOpen);
  const deployedIdentity = useMemo(identityFromLocation, []);
  const localSnapshot = local.state === 'ready' ? local.snapshot : undefined;
  const showWip = Boolean(localSnapshot?.review.writable);
  const reviewedPreviews = localSnapshot?.review.items.filter((item) => item.reviewed).length ?? 0;

  useEffect(() => {
    if (!showWip && tab === 'wip') setTab('changelog');
  }, [showWip, tab]);

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop className="z-[90] bg-black/75" variant="blur">
        <Modal.Container className="p-3" placement="center" scroll="inside" size="lg">
          <Modal.Dialog className={`flex max-h-[min(46rem,92dvh)] flex-col overflow-hidden ${
            theme === 'dark'
              ? 'bg-neutral-950 text-neutral-100'
              : 'bg-stone-50 text-neutral-900'
          }`}>
            <Modal.CloseTrigger aria-label="Close pull request changelog" />
            <Modal.Header className={`block border-b px-5 pb-4 pr-12 pt-5 ${
              theme === 'dark' ? 'border-neutral-800' : 'border-stone-200'
            }`}>
              <Modal.Heading className="flex items-center gap-2 text-base font-semibold">
                <ScrollText aria-hidden className="size-4" />
                Pull request changelog
              </Modal.Heading>
              <ChangelogIdentity snapshot={localSnapshot} identity={deployedIdentity} />
            </Modal.Header>

            <Modal.Body className="min-h-0 p-0">
              <Tabs
                className="flex min-h-0 flex-1 flex-col"
                selectedKey={tab}
                variant="secondary"
                onSelectionChange={(key) => setTab(String(key))}
              >
                <Tabs.ListContainer className={`shrink-0 border-b px-5 ${
                  theme === 'dark' ? 'border-neutral-800' : 'border-stone-200'
                }`}>
                  <Tabs.List aria-label="Changelog views">
                    <Tabs.Tab id="changelog">
                      Changelog
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    {showWip ? (
                      <Tabs.Tab id="wip">
                        Review
                        <span className="ml-1 text-[10px] text-neutral-500">
                          {reviewedPreviews}/{localSnapshot?.review.items.length ?? 0}
                        </span>
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    ) : null}
                  </Tabs.List>
                </Tabs.ListContainer>

                <Tabs.Panel className="min-h-0 flex-1 overflow-y-auto px-5 py-5" id="changelog">
                  <ChangelogPanel
                    deployedIdentity={deployedIdentity}
                    local={local}
                    snapshot={localSnapshot}
                  />
                </Tabs.Panel>

                {showWip && localSnapshot ? (
                  <Tabs.Panel className="min-h-0 flex-1 overflow-y-auto px-5 py-5" id="wip">
                    <PrototypeWipReview
                      error={local.saveError}
                      saving={local.saving}
                      snapshot={localSnapshot}
                      onSave={local.save}
                    />
                  </Tabs.Panel>
                ) : null}
              </Tabs>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function MockTaskChangelogModal({
  isOpen,
  onOpenChange,
  task,
  theme,
}: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  task: MockTask;
  theme: PrototypeTheme;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop className="z-[90] bg-black/75" variant="blur">
        <Modal.Container className="p-3" placement="center" scroll="inside" size="lg">
          <Modal.Dialog className={`flex max-h-[min(42rem,92dvh)] flex-col overflow-hidden ${theme === 'dark' ? 'bg-neutral-950 text-neutral-100' : 'bg-stone-50 text-neutral-900'}`}>
            <Modal.CloseTrigger aria-label="Close task changelog" />
            <Modal.Header className={`block border-b px-5 pb-4 pr-12 pt-5 ${theme === 'dark' ? 'border-neutral-800' : 'border-stone-200'}`}>
              <Modal.Heading className="flex items-center gap-2 text-base font-semibold">
                <ScrollText aria-hidden className="size-4" /> Task changelog
              </Modal.Heading>
              <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-neutral-500">
                {task.pullRequest ? <GitPullRequest className="size-3.5" /> : <GitBranch className="size-3.5" />}
                <span>Task #{task.number}</span>
                {task.pullRequest ? <><span>·</span><span>PR #{task.pullRequest.number}</span><span>·</span><span>{task.pullRequest.revision}</span></> : null}
              </p>
            </Modal.Header>
            <Modal.Body className="min-h-0 overflow-y-auto px-5 py-5">
              <h2 className="text-lg font-semibold tracking-[-.02em]">{task.title}</h2>
              <p className="mt-2 text-sm leading-6 text-neutral-500">{task.body}</p>
              <div className="mt-6 divide-y divide-neutral-800 border-y border-neutral-800">
                {[...task.events].reverse().map((event) => (
                  <article className="py-4" key={event.id}>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-medium">{event.title}</h3>
                      <span className="text-[10px] text-neutral-600">{event.time}</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-neutral-500">{event.detail}</p>
                  </article>
                ))}
              </div>
              <p className="mt-4 text-[10px] leading-4 text-neutral-600">Mock lifecycle data for this Task. No repository file is changed by these actions.</p>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function ChangelogIdentity({
  identity,
  snapshot
}: {
  identity?: PullRequestChangelogIdentity;
  snapshot?: PrototypeReviewLocalChangelogSnapshot;
}) {
  if (snapshot) {
    return (
      <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-neutral-500">
        {snapshot.pullRequestNumber ? (
          <GitPullRequest aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <GitBranch aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">
          {snapshot.pullRequestNumber
            ? `PR #${snapshot.pullRequestNumber}`
            : snapshot.branchName}
        </span>
        <span aria-hidden>·</span>
        <span>{snapshot.headSha.slice(0, 8)}</span>
      </p>
    );
  }
  return identity ? (
    <p className="mt-1.5 text-xs text-neutral-500">
      PR #{identity.pullRequestNumber} · {identity.headSha.slice(0, 8)}
    </p>
  ) : null;
}

function ChangelogPanel({
  deployedIdentity,
  local,
  snapshot
}: {
  deployedIdentity?: PullRequestChangelogIdentity;
  local: ReturnType<typeof useLocalChangelog>;
  snapshot?: PrototypeReviewLocalChangelogSnapshot;
}) {
  if (local.state === 'loading') {
    return <MessageState icon={RefreshCw} spinning title="Reading release MDX…" />;
  }
  if (snapshot) {
    if (snapshot.entry.state === 'available') {
      return <PrototypeReleaseEntryContent entry={snapshot.entry.entry} />;
    }
    if (snapshot.entry.state === 'invalid') {
      return (
        <MessageState
          icon={FileClock}
          title="The release MDX is invalid"
          message={snapshot.entry.errors.join(' ')}
        />
      );
    }
    if (snapshot.entry.state === 'unavailable') {
      return (
        <MessageState
          icon={FileClock}
          title="Pull request discovery is unavailable"
          message="The local server could not identify the pull request for this branch."
        />
      );
    }
    return snapshot.entry.reason === 'no-pull-request' ? (
      <MessageState
        icon={GitBranch}
        title="This branch has no pull request yet"
        message={`The changelog will appear here as soon as this branch has a pull request and its apps/docs/content/docs/releases/entries/<PR>.mdx file. Preview review is already available locally.`}
      />
    ) : (
      <MessageState
        icon={FileClock}
        title={`Release MDX for PR #${snapshot.pullRequestNumber} is missing`}
        message={`Expected ${snapshot.entry.path}. This view never substitutes Preview scenarios for missing changelog content.`}
      />
    );
  }
  if (deployedIdentity) {
    return (
      <PullRequestChangelogSummary
        expectedIdentity={deployedIdentity}
        showDocsLink
        snapshot={pullRequestChangelogSnapshotFor(deployedIdentity)}
      />
    );
  }
  return (
    <MessageState
      icon={FileClock}
      title="Changelog unavailable"
      message={local.state === 'unavailable'
        ? local.error ?? 'A local development server or verified pull request identity is required.'
        : 'A local development server or verified pull request identity is required.'}
    />
  );
}

function MessageState({
  icon: Icon,
  message,
  spinning = false,
  title
}: {
  icon: typeof FileClock;
  message?: string;
  spinning?: boolean;
  title: string;
}) {
  return (
    <section className="grid min-h-64 place-items-center px-6 text-center">
      <div className="max-w-md">
        <Icon aria-hidden className={`mx-auto size-6 text-neutral-700 ${spinning ? 'animate-spin' : ''}`} />
        <h2 className="mt-4 text-sm font-medium text-neutral-200">{title}</h2>
        {message ? <p className="mt-2 text-xs leading-5 text-neutral-500">{message}</p> : null}
      </div>
    </section>
  );
}

function useLocalChangelog(enabled: boolean) {
  const [state, setState] = useState<
    | { state: 'idle' }
    | { state: 'loading' }
    | { error?: string; state: 'unavailable' }
    | { snapshot: PrototypeReviewLocalChangelogSnapshot; state: 'ready' }
  >({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ state: 'loading' });
    void fetch(localChangelogPath, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('The local changelog API is unavailable.');
        const payload: unknown = await response.json();
        if (!isPrototypeReviewLocalChangelogSnapshot(payload)) {
          throw new Error('The local changelog response is invalid.');
        }
        setState({ snapshot: payload, state: 'ready' });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          error: error instanceof Error ? error.message : undefined,
          state: 'unavailable'
        });
      });
    return () => controller.abort();
  }, [enabled]);

  const save = async (items: readonly PrototypeReviewChecklistItem[]) => {
    if (state.state !== 'ready') return;
    const previous = state.snapshot;
    setState({
      snapshot: { ...previous, review: { ...previous.review, items } },
      state: 'ready'
    });
    setSaving(true);
    setSaveError(undefined);
    try {
      const response = await fetch(localChangelogPath, {
        body: JSON.stringify({ items }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT'
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isPrototypeReviewLocalChangelogSnapshot(payload)) {
        throw new Error(
          payload && typeof payload === 'object' && 'error' in payload
            ? String(payload.error)
            : 'The Preview review could not be saved.'
        );
      }
      setState({ snapshot: payload, state: 'ready' });
    } catch (error) {
      setState({ snapshot: previous, state: 'ready' });
      setSaveError(error instanceof Error ? error.message : 'The Preview review could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return { ...state, save, saveError, saving };
}

function identityFromLocation(): PullRequestChangelogIdentity | undefined {
  const params = new URLSearchParams(window.location.search);
  const identity = {
    headSha: params.get('head') ?? '',
    pullRequestNumber: Number(params.get('pr') ?? params.get('pullRequestNumber')),
    repositoryFullName: params.get('repository') ?? params.get('repositoryFullName') ?? ''
  };
  return isPullRequestChangelogIdentity(identity) ? identity : undefined;
}
