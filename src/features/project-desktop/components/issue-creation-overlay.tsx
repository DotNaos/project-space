import { useCallback, useEffect, useReducer, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { loadGitHubIssueMetadata } from '@/api/github-issue-metadata-client';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubCatalogRepository, GitHubIssueRecord } from '@/shared/project-space-api';
import {
  canSubmitIssueCreation,
  createInitialIssueCreationState,
  issueCreationCloseDecision,
  issueCreationReducer,
  matchesIssueCreationSubmission
} from './issue-creation-model';

interface IssueCreationOverlayProps {
  onClose(): void;
  onIssueCreated(issue: GitHubIssueRecord): void;
  open: boolean;
  repository?: GitHubCatalogRepository;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function IssueCreationOverlay({
  onClose,
  onIssueCreated,
  open,
  repository
}: IssueCreationOverlayProps) {
  const [state, dispatch] = useReducer(
    issueCreationReducer,
    createInitialIssueCreationState({
      connected: Boolean(repository),
      repositoryKey: repository?.fullName ?? null
    })
  );
  const stateRef = useRef(state);
  const overlayRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  stateRef.current = state;

  useEffect(() => {
    dispatch({
      connected: Boolean(repository),
      repositoryKey: repository?.fullName ?? null,
      type: 'repository-changed'
    });
  }, [repository]);

  const loadLabels = useCallback(() => {
    if (!open || !repository) return () => undefined;
    const controller = new AbortController();
    const id = requestId();
    const repositoryKey = repository.fullName;
    dispatch({ repositoryKey, requestId: id, type: 'labels-load-started' });
    void loadGitHubIssueMetadata(repositoryKey, { signal: controller.signal })
      .then((result) => {
        if (result.status === 'connected') {
          dispatch({ labels: result.labels, repositoryKey, requestId: id, type: 'labels-load-succeeded' });
        } else {
          dispatch({
            error: result.message ?? 'Repository labels are unavailable.',
            repositoryKey,
            requestId: id,
            type: 'labels-load-failed'
          });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        dispatch({
          error: error instanceof Error ? error.message : 'Could not load repository labels.',
          repositoryKey,
          requestId: id,
          type: 'labels-load-failed'
        });
      });
    return () => controller.abort();
  }, [open, repository]);

  useEffect(() => loadLabels(), [loadLabels]);

  const close = useCallback(() => {
    if (issueCreationCloseDecision(stateRef.current) === 'confirm-discard') {
      dispatch({ type: 'discard-requested' });
      return;
    }
    dispatch({ type: 'form-reset' });
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    focusReturnRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => titleRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !overlayRef.current) return;
      const focusable = Array.from(
        overlayRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]'
        )
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      focusReturnRef.current?.focus();
    };
  }, [close, open]);

  const submit = async () => {
    const repositoryKey = state.repositoryKey;
    if (!repositoryKey || !canSubmitIssueCreation(state)) return;
    const id = requestId();
    const startAction = { requestId: id, type: 'submission-started' as const };
    stateRef.current = issueCreationReducer(stateRef.current, startAction);
    dispatch(startAction);
    const result = await projectSpaceClient.createGitHubIssue({
      body: state.body,
      fullName: repositoryKey,
      labels: [...state.selectedLabels],
      title: state.title.trim()
    }).catch((error) => ({
      message: error instanceof Error ? error.message : 'Could not create issue.',
      status: 'error' as const
    }));

    if (!matchesIssueCreationSubmission(stateRef.current, repositoryKey, id)) return;
    if (result.status !== 'connected' || !('issue' in result) || !result.issue) {
      dispatch({
        error: result.message ?? 'Could not create issue.',
        repositoryKey,
        requestId: id,
        type: 'submission-failed'
      });
      return;
    }
    dispatch({ repositoryKey, requestId: id, type: 'submission-succeeded' });
    onIssueCreated(result.issue);
  };

  if (!open || typeof document === 'undefined') return null;
  const isSubmitting = state.submission.status === 'submitting';

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" aria-label="Close new issue" onClick={close} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <section
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-issue-title"
        className="issue-rise-in relative z-10 flex max-h-[92dvh] w-full flex-col rounded-t-[1.75rem] border border-neutral-800 bg-neutral-950 shadow-2xl sm:max-h-[min(48rem,90dvh)] sm:max-w-3xl sm:rounded-2xl"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-neutral-700 sm:hidden" />
        <header className="flex items-start gap-3 border-b border-neutral-800 px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <Text id="new-issue-title" as="h2" className="text-lg font-semibold text-neutral-100">New issue</Text>
            <Text className="mt-0.5 block truncate text-xs text-neutral-500">
              {repository?.fullName ?? 'No connected repository'}
            </Text>
          </div>
          <button type="button" onClick={close} aria-label="Close new issue" className="flex size-9 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100">
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-neutral-300">Title</span>
            <input
              ref={titleRef}
              value={state.title}
              onChange={(event) => dispatch({ title: event.currentTarget.value, type: 'title-changed' })}
              placeholder="What needs to be done?"
              className="h-11 w-full rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 text-base text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
            />
          </label>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-medium text-neutral-300">Description</span>
            <textarea
              value={state.body}
              onChange={(event) => dispatch({ body: event.currentTarget.value, type: 'body-changed' })}
              placeholder="Add a Markdown description"
              rows={9}
              className="min-h-48 w-full resize-y rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 py-2.5 text-base leading-6 text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600 sm:text-sm"
            />
          </label>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <Text className="text-xs font-medium text-neutral-300">Labels</Text>
              {state.labels.status === 'failed' ? (
                <Button size="sm" variant="ghost" onPress={() => loadLabels()}><RefreshCw className="size-3.5" /> Retry</Button>
              ) : null}
            </div>
            {state.labels.status === 'loading' ? (
              <div className="flex items-center gap-2 py-3 text-xs text-neutral-500"><LoaderCircle className="size-4 animate-spin" /> Loading repository labels…</div>
            ) : state.labels.status === 'failed' ? (
              <Text className="block rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">{state.labels.error}</Text>
            ) : state.labels.status === 'ready' && state.labels.labels.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {state.labels.labels.map((label) => {
                  const selected = state.selectedLabels.includes(label.name);
                  return (
                    <button
                      key={label.name}
                      type="button"
                      aria-pressed={selected}
                      title={label.description}
                      onClick={() => dispatch({ name: label.name, type: 'label-toggled' })}
                      style={{ borderColor: `#${label.color || '525252'}80` }}
                      className={cn('inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition', selected ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')}
                    >
                      {selected ? <Check className="size-3.5" /> : null}{label.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <Text className="text-xs text-neutral-600">No repository labels.</Text>
            )}
          </div>

          {state.submission.status === 'failed' ? (
            <Text role="alert" className="mt-4 block rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">{state.submission.error}</Text>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-800 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
          <Button size="sm" variant="ghost" isDisabled={isSubmitting} onPress={close}>Cancel</Button>
          <Button size="sm" variant="primary" isDisabled={!canSubmitIssueCreation(state)} onPress={() => void submit()}>
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {isSubmitting ? 'Creating…' : 'Create issue'}
          </Button>
        </footer>
      </section>

      {state.discardConfirmationOpen ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-5">
          <section role="alertdialog" aria-modal="true" aria-labelledby="discard-issue-title" className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl">
            <AlertTriangle className="size-5 text-amber-300" />
            <Text id="discard-issue-title" as="h3" className="mt-3 text-base font-semibold text-neutral-100">Discard this issue draft?</Text>
            <Text className="mt-1 block text-sm text-neutral-400">Your title, description, and selected labels will be lost.</Text>
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => dispatch({ type: 'discard-canceled' })}>Keep editing</Button>
              <Button size="sm" variant="danger" onPress={() => { dispatch({ type: 'discard-confirmed' }); onClose(); }}>Discard</Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>,
    document.body
  );
}
