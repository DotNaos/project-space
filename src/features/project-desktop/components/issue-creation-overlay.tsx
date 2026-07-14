import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent
} from 'react';
import {
  AlertDialog,
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Spinner,
  TextArea,
  TextField
} from '@heroui/react';
import { AlertTriangle, X } from 'lucide-react';

import { loadGitHubIssueMetadata } from '@/api/github-issue-metadata-client';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubCatalogRepository, GitHubIssueRecord } from '@/shared/project-space-api';
import {
  canSubmitIssueCreation,
  createInitialIssueCreationState,
  issueCreationCloseDecision,
  issueCreationRequest,
  issueCreationReducer,
  matchesIssueCreationSubmission
} from './issue-creation-model';
import { IssueAttachmentStatus } from './issue-attachment-status';
import { IssueLabelPicker } from './issue-label-picker';
import { useIssueAttachments } from './use-issue-attachments';

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
  const repositoryKey = repository?.fullName ?? null;
  const repositoryConnected = Boolean(repository);
  const [state, dispatch] = useReducer(
    issueCreationReducer,
    createInitialIssueCreationState({
      connected: repositoryConnected,
      repositoryKey
    })
  );
  const [titleTouched, setTitleTouched] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const stateRef = useRef(state);
  const workflowBusyRef = useRef(false);
  const repositoryKeyRef = useRef(repositoryKey);
  const labelAbortRef = useRef<AbortController | null>(null);
  stateRef.current = state;
  repositoryKeyRef.current = repositoryKey;

  const changeBody = useCallback((body: string) => {
    const action = { body, type: 'body-changed' as const };
    stateRef.current = issueCreationReducer(stateRef.current, action);
    dispatch(action);
  }, []);
  const attachments = useIssueAttachments({
    markdown: state.body,
    onMarkdownChange: changeBody,
    repositoryKey
  });

  useEffect(() => {
    dispatch({
      connected: repositoryConnected,
      repositoryKey,
      type: 'repository-changed'
    });
  }, [repositoryConnected, repositoryKey]);

  const loadLabels = useCallback(() => {
    if (!open || !repositoryKey) return;

    labelAbortRef.current?.abort();
    const controller = new AbortController();
    const id = requestId();
    labelAbortRef.current = controller;
    dispatch({ repositoryKey, requestId: id, type: 'labels-load-started' });

    void loadGitHubIssueMetadata(repositoryKey, { signal: controller.signal })
      .then((result) => {
        if (result.status === 'connected') {
          dispatch({
            labels: result.labels,
            repositoryKey,
            requestId: id,
            type: 'labels-load-succeeded'
          });
          return;
        }

        dispatch({
          error: result.message ?? 'Repository labels are unavailable.',
          repositoryKey,
          requestId: id,
          type: 'labels-load-failed'
        });
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
  }, [open, repositoryKey]);

  useEffect(() => {
    loadLabels();

    return () => {
      labelAbortRef.current?.abort();
    };
  }, [loadLabels]);

  const finishClose = useCallback(() => {
    const action = { type: 'form-reset' as const };
    stateRef.current = issueCreationReducer(stateRef.current, action);
    dispatch(action);
    setTitleTouched(false);
    onClose();
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (workflowBusyRef.current || stateRef.current.submission.status === 'submitting') return;

    if (issueCreationCloseDecision(stateRef.current) === 'confirm-discard') {
      dispatch({ type: 'discard-requested' });
      return;
    }

    finishClose();
  }, [finishClose]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (workflowBusyRef.current) return;

    const snapshot = stateRef.current;
    const currentRepositoryKey = snapshot.repositoryKey;

    setTitleTouched(true);
    if (
      !currentRepositoryKey ||
      currentRepositoryKey !== repositoryKeyRef.current ||
      !issueCreationRequest(snapshot)
    ) return;

    workflowBusyRef.current = true;
    setWorkflowBusy(true);
    try {
      const uploaded = await attachments.uploadPendingAttachments();
      if (!uploaded.completed || repositoryKeyRef.current !== currentRepositoryKey) return;

      const bodyAction = { body: uploaded.markdown, type: 'body-changed' as const };
      const uploadedSnapshot = issueCreationReducer(stateRef.current, bodyAction);
      stateRef.current = uploadedSnapshot;
      dispatch(bodyAction);
      const request = issueCreationRequest(uploadedSnapshot);
      if (!request || repositoryKeyRef.current !== currentRepositoryKey) return;

      labelAbortRef.current?.abort();
      const id = requestId();
      const startAction = { requestId: id, type: 'submission-started' as const };
      stateRef.current = issueCreationReducer(uploadedSnapshot, startAction);
      dispatch(startAction);
      const result = await projectSpaceClient.createGitHubIssue(request).catch((error) => ({
        message: error instanceof Error ? error.message : 'Could not create issue.',
        status: 'error' as const
      }));

      if (
        repositoryKeyRef.current !== currentRepositoryKey ||
        !matchesIssueCreationSubmission(stateRef.current, currentRepositoryKey, id)
      ) return;

      if (result.status === 'connected' && 'issue' in result && result.issue) {
        dispatch({
          repositoryKey: currentRepositoryKey,
          requestId: id,
          type: 'submission-succeeded'
        });
        setTitleTouched(false);
        onClose();
        onIssueCreated(result.issue);
        return;
      }

      dispatch({
        error: result.message ?? 'Could not create issue.',
        repositoryKey: currentRepositoryKey,
        requestId: id,
        type: 'submission-failed'
      });
      loadLabels();
    } finally {
      workflowBusyRef.current = false;
      setWorkflowBusy(false);
    }
  };

  const isSubmitting = state.submission.status === 'submitting';
  const isBusy = workflowBusy || isSubmitting || attachments.isUploading;
  const hasStoredAttachments = attachments.attachments.some(
    (attachment) => attachment.status === 'uploaded'
  );
  const repositoryStateCurrent = state.repositoryKey === repositoryKey;
  const visibleLabelsState = repositoryStateCurrent
    ? state.labels
    : repositoryKey
      ? {
          labels: [],
          repositoryKey,
          requestId: 'repository-transition',
          status: 'loading' as const
        }
      : {
          labels: [],
          repositoryKey: null,
          requestId: null,
          status: 'idle' as const
        };
  const titleInvalid = titleTouched && state.title.trim().length === 0;

  return (
    <>
      <Modal
        isOpen={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) requestClose();
        }}
      >
        <Modal.Backdrop
          isDismissable={!isBusy}
          isKeyboardDismissDisabled={isBusy}
          variant="blur"
          className="z-[140] bg-black/75"
        >
          <Modal.Container
            placement="center"
            scroll="inside"
            size="lg"
            className="p-0 sm:p-5"
          >
            <Modal.Dialog className="h-[100dvh] max-h-[100dvh] w-full rounded-none border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl sm:h-auto sm:max-h-[min(48rem,92dvh)] sm:max-w-5xl sm:rounded-2xl">
              <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
                <Modal.Header className="flex flex-row items-start gap-4 border-b border-neutral-800 px-5 py-4 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <Modal.Heading className="text-lg font-semibold text-neutral-50">
                      New issue
                    </Modal.Heading>
                    <p className="mt-1 truncate text-xs text-neutral-500">
                      {repositoryKey ?? 'No connected repository'}
                    </p>
                  </div>
                  <Button
                    aria-label="Close new issue"
                    isDisabled={isBusy}
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={requestClose}
                  >
                    <X className="size-4" />
                  </Button>
                </Modal.Header>

                <Modal.Body className="mt-0 min-h-0 px-5 py-5 sm:px-6">
                  <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)]">
                    <div className="min-w-0">
                      <TextField
                        fullWidth
                        isDisabled={isBusy}
                        isInvalid={titleInvalid}
                        isRequired
                        name="issue-title"
                        value={state.title}
                        variant="secondary"
                        onChange={(title) => dispatch({ title, type: 'title-changed' })}
                      >
                        <Label>Title</Label>
                        <Input
                          autoFocus
                          placeholder="What needs to be done?"
                          onBlur={() => setTitleTouched(true)}
                        />
                        <FieldError>Enter a title.</FieldError>
                      </TextField>

                      <TextField
                        className="mt-5"
                        fullWidth
                        isDisabled={isBusy}
                        name="issue-body"
                        value={attachments.markdown}
                        variant="secondary"
                        onChange={attachments.handleMarkdownChange}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <Label>Description</Label>
                          <span className="text-[11px] text-neutral-500">Markdown supported</span>
                        </div>
                        <TextArea
                          className="min-h-72 resize-y font-mono text-sm leading-6 sm:min-h-80"
                          placeholder="Describe the problem, context, and expected outcome…"
                          rows={13}
                          onPaste={attachments.handlePaste}
                        />
                      </TextField>
                      <IssueAttachmentStatus
                        attachments={attachments.attachments}
                        disabled={isBusy}
                        error={attachments.error}
                        onRemove={attachments.removeAttachment}
                      />
                    </div>

                    <IssueLabelPicker
                      disabled={isBusy}
                      labelsState={visibleLabelsState}
                      onRetry={loadLabels}
                      onToggle={(name) => dispatch({ name, type: 'label-toggled' })}
                      repositoryKey={repositoryKey}
                      selectedLabels={state.selectedLabels}
                    />
                  </div>

                  {!repository ? (
                    <div
                      className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5 text-xs text-amber-200"
                      role="status"
                    >
                      Connect a GitHub repository before creating an issue.
                    </div>
                  ) : null}

                  {repositoryStateCurrent && state.submission.status === 'failed' ? (
                    <div
                      className="mt-5 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2.5"
                      role="alert"
                    >
                      <p className="text-xs font-medium text-red-200">Issue creation failed.</p>
                      <p className="mt-1 text-xs leading-5 text-neutral-400">
                        {state.submission.error}
                      </p>
                    </div>
                  ) : null}
                </Modal.Body>

                <Modal.Footer className="mt-0 flex items-center justify-between gap-3 border-t border-neutral-800 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
                  <p className="hidden text-xs text-neutral-500 sm:block">
                    Labels and images are optional.
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      isDisabled={isBusy}
                      size="sm"
                      variant="ghost"
                      onPress={requestClose}
                    >
                      Cancel
                    </Button>
                    <Button
                      isDisabled={
                        isBusy || !repositoryStateCurrent || !canSubmitIssueCreation(state)
                      }
                      size="sm"
                      type="submit"
                      variant="primary"
                    >
                      {isBusy ? <Spinner size="sm" /> : null}
                      {workflowBusy && !isSubmitting
                        ? attachments.hasUnresolvedAttachments
                          ? 'Storing images…'
                          : 'Preparing…'
                        : isSubmitting
                        ? 'Creating…'
                        : state.submission.status === 'failed'
                          ? 'Retry creation'
                          : 'Create issue'}
                    </Button>
                  </div>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AlertDialog
        isOpen={state.discardConfirmationOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) dispatch({ type: 'discard-canceled' });
        }}
      >
        <AlertDialog.Backdrop
          isDismissable={false}
          isKeyboardDismissDisabled
          className="z-[160] bg-black/80"
        >
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
              <AlertDialog.Header>
                <AlertDialog.Icon status="warning">
                  <AlertTriangle className="size-5" />
                </AlertDialog.Icon>
                <AlertDialog.Heading>Discard this issue draft?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body className="text-sm leading-6 text-neutral-400">
                {hasStoredAttachments
                  ? 'Your title, description, and selected labels will be lost. Images already stored with a repository commit will remain there.'
                  : 'Your title, description, selected labels, and pasted images will be lost.'}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  autoFocus
                  size="sm"
                  variant="ghost"
                  onPress={() => dispatch({ type: 'discard-canceled' })}
                >
                  Keep editing
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onPress={() => {
                    dispatch({ type: 'discard-confirmed' });
                    setTitleTouched(false);
                    onClose();
                  }}
                >
                  Discard draft
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>
  );
}
