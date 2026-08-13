import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent
} from 'react';
import { Modal } from '@heroui/react';

import { loadGitHubIssueMetadata } from '@/api/github-issue-metadata-client';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubCatalogRepository, GitHubIssueRecord } from '@/shared/project-space-api';
import { mayHaveReachedRemote } from './issue-attachment-model';
import {
  canSubmitIssueCreation,
  createInitialIssueCreationState,
  issueCreationCloseDecision,
  issueCreationRequest,
  issueCreationReducer,
  matchesIssueCreationSubmission,
  visibleIssueCreationLabels
} from './issue-creation-model';
import {
  IssueCreationDiscardDialog,
  IssueCreationRecoveryDialog,
  IssueCreationUncertainDialog
} from './issue-creation-dialogs';
import {
  IssueCreationFormBody,
  IssueCreationFormFooter,
  IssueCreationFormHeader
} from './issue-creation-form-parts';
import {
  finishIssueCreationWithAvailableImages,
  runIssueCreationWorkflow,
  type IssueCreationRecoveryStage,
  type RepositoryIssueCapabilities,
  type ScopedCreatedIssue
} from './issue-creation-workflow';
import { useIssueAttachments } from './use-issue-attachments';
import { useIssueCreationCloseRequest } from './use-issue-creation-close-request';
import {
  clearIssueCreationUncertainty,
  loadIssueCreationUncertainty,
  saveIssueCreationUncertainty
} from './issue-creation-uncertainty';

interface IssueCreationOverlayProps {
  closeRequest?: number;
  onClose(): void;
  onIssueCreated(issue: GitHubIssueRecord, repositoryKey: string): void;
  open: boolean;
  repositories?: readonly GitHubCatalogRepository[];
  repository?: GitHubCatalogRepository;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function IssueCreationOverlay({
  closeRequest = 0,
  onClose,
  onIssueCreated,
  open,
  repositories = [],
  repository
}: IssueCreationOverlayProps) {
  const repositoryOptions = useMemo(() => {
    const options = new Map<string, GitHubCatalogRepository>();
    if (repository) options.set(repository.fullName, repository);
    for (const option of repositories) options.set(option.fullName, option);
    return [...options.values()].sort((left, right) =>
      left.fullName.localeCompare(right.fullName)
    );
  }, [repositories, repository]);
  const [selectedRepositoryKey, setSelectedRepositoryKey] = useState<string | null>(
    repository?.fullName ?? null
  );
  const selectedRepository = repositoryOptions.find(
    (option) => option.fullName === selectedRepositoryKey
  );
  const repositoryKey = selectedRepository?.fullName ?? null;
  const repositoryConnected = Boolean(selectedRepository);
  const [state, dispatch] = useReducer(
    issueCreationReducer,
    createInitialIssueCreationState({
      connected: repositoryConnected,
      repositoryKey
    })
  );
  const [titleTouched, setTitleTouched] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<RepositoryIssueCapabilities | null>(null);
  const [createdIssue, setCreatedIssue] = useState<ScopedCreatedIssue | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryStage, setRecoveryStage] = useState<IssueCreationRecoveryStage | null>(null);
  const [scopeRecoveryError, setScopeRecoveryError] = useState<string | null>(null);
  const [uncertainRepositoryKey, setUncertainRepositoryKey] = useState<string | null>(null);
  const [uncertainCloseOpen, setUncertainCloseOpen] = useState(false);
  const stateRef = useRef(state);
  const workflowBusyRef = useRef(false);
  const repositoryKeyRef = useRef(repositoryKey);
  const createdIssueRef = useRef<ScopedCreatedIssue | null>(null);
  const labelAbortRef = useRef<AbortController | null>(null);
  const creationOperationIdRef = useRef<string>(requestId());
  stateRef.current = state;
  repositoryKeyRef.current = repositoryKey;
  createdIssueRef.current = createdIssue;

  useEffect(() => {
    if (open) setSelectedRepositoryKey(repository?.fullName ?? null);
  }, [open, repository?.fullName]);

  const currentCapabilities = capabilities?.repositoryKey === repositoryKey
    ? capabilities
    : null;
  const attachmentWriteDenied = currentCapabilities?.attachmentWrite === 'denied';
  const labelWriteDenied = currentCapabilities?.labelWrite === 'denied';
  const creationUncertain = Boolean(uncertainRepositoryKey);

  const changeBody = useCallback((body: string) => {
    const action = { body, type: 'body-changed' as const };
    stateRef.current = issueCreationReducer(stateRef.current, action);
    dispatch(action);
  }, []);
  const attachments = useIssueAttachments({
    markdown: state.body,
    onMarkdownChange: changeBody,
    repositoryKey: uncertainRepositoryKey ?? repositoryKey,
    writeDenied: attachmentWriteDenied
  });

  useEffect(() => {
    const action = {
      connected: repositoryConnected,
      repositoryKey,
      type: 'repository-changed' as const
    };
    stateRef.current = issueCreationReducer(stateRef.current, action);
    dispatch(action);
  }, [repositoryConnected, repositoryKey]);

  useEffect(() => {
    if (!open || !repositoryKey) return;
    const recovered = loadIssueCreationUncertainty(repositoryKey);
    if (!recovered) return;

    creationOperationIdRef.current = recovered.operationId;
    attachments.resetAttachmentLifecycle(recovered.body);
    const action = {
      body: recovered.body,
      repositoryKey,
      selectedLabels: recovered.selectedLabels,
      title: recovered.title,
      type: 'uncertain-draft-restored' as const
    };
    stateRef.current = issueCreationReducer(stateRef.current, action);
    dispatch(action);
    setUncertainRepositoryKey(repositoryKey);
    setTitleTouched(true);
  }, [attachments.resetAttachmentLifecycle, open, repositoryKey]);

  useEffect(() => {
    if (!creationUncertain) return;
    const warnBeforeReload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeReload);
    return () => window.removeEventListener('beforeunload', warnBeforeReload);
  }, [creationUncertain]);

  useEffect(() => {
    if (createdIssue && createdIssue.repositoryKey !== repositoryKey) {
      setScopeRecoveryError(
        `Issue #${createdIssue.issue.number} was created in ${createdIssue.repositoryKey}. Finish and view it before creating an issue in another repository.`
      );
    } else if (uncertainRepositoryKey && uncertainRepositoryKey !== repositoryKey) {
      setScopeRecoveryError(
        `GitHub has not confirmed issue creation in ${uncertainRepositoryKey}. Return to that repository and check again before creating another issue.`
      );
    }
  }, [createdIssue, repositoryKey, uncertainRepositoryKey]);

  const loadLabels = useCallback(() => {
    if (!open || !repositoryKey) return;

    labelAbortRef.current?.abort();
    const controller = new AbortController();
    const id = requestId();
    labelAbortRef.current = controller;
    dispatch({ repositoryKey, requestId: id, type: 'labels-load-started' });

    void loadGitHubIssueMetadata(repositoryKey, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || repositoryKeyRef.current !== repositoryKey) return;

        if (result.status === 'connected') {
          setCapabilities({
            attachmentWrite: result.attachmentWrite ?? 'unverified',
            labelWrite: result.labelWrite ?? 'unverified',
            repositoryKey
          });
          dispatch({
            allowSelection: result.labelWrite !== 'denied',
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
        if (controller.signal.aborted || repositoryKeyRef.current !== repositoryKey) return;

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

  const resetForm = useCallback(() => {
    const uncertainScope = uncertainRepositoryKey ?? repositoryKeyRef.current;
    if (uncertainScope) {
      clearIssueCreationUncertainty(
        uncertainScope,
        creationOperationIdRef.current
      );
    }
    attachments.resetAttachmentLifecycle('');
    const action = { type: 'form-reset' as const };
    stateRef.current = issueCreationReducer(stateRef.current, action);
    dispatch(action);
    createdIssueRef.current = null;
    setCreatedIssue(null);
    setRecoveryOpen(false);
    setRecoveryStage(null);
    setScopeRecoveryError(null);
    setUncertainRepositoryKey(null);
    setUncertainCloseOpen(false);
    creationOperationIdRef.current = requestId();
    setTitleTouched(false);
  }, [attachments.resetAttachmentLifecycle, uncertainRepositoryKey]);

  const finishClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const revealIssue = useCallback((issue: GitHubIssueRecord, issueRepositoryKey: string) => {
    resetForm();
    onClose();
    onIssueCreated(issue, issueRepositoryKey);
  }, [onClose, onIssueCreated, resetForm]);

  const requestClose = useCallback(() => {
    if (workflowBusyRef.current || stateRef.current.submission.status === 'submitting') return;

    if (uncertainRepositoryKey) {
      setUncertainCloseOpen(true);
      return;
    }

    if (createdIssueRef.current) {
      setRecoveryOpen(true);
      return;
    }

    if (issueCreationCloseDecision(stateRef.current) === 'confirm-discard') {
      dispatch({ type: 'discard-requested' });
      return;
    }

    finishClose();
  }, [finishClose, uncertainRepositoryKey]);

  useIssueCreationCloseRequest({ closeRequest, onRequestClose: requestClose, open });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (workflowBusyRef.current) return;

    const snapshot = stateRef.current;
    const currentRepositoryKey = snapshot.repositoryKey;

    setTitleTouched(true);
    const draftRequest = issueCreationRequest(snapshot);
    const request = draftRequest
      ? { ...draftRequest, operationId: creationOperationIdRef.current }
      : null;
    if (
      !currentRepositoryKey ||
      currentRepositoryKey !== repositoryKeyRef.current ||
      !request ||
      (createdIssueRef.current !== null
        && createdIssueRef.current.repositoryKey !== currentRepositoryKey) ||
      (uncertainRepositoryKey !== null
        && uncertainRepositoryKey !== currentRepositoryKey) ||
      (attachmentWriteDenied && attachments.hasUnresolvedAttachments)
    ) return;

    workflowBusyRef.current = true;
    setWorkflowBusy(true);
    try {
      labelAbortRef.current?.abort();
      const id = requestId();
      const startAction = { requestId: id, type: 'submission-started' as const };
      stateRef.current = issueCreationReducer(stateRef.current, startAction);
      dispatch(startAction);
      const scopedExistingIssue = createdIssueRef.current?.repositoryKey === currentRepositoryKey
        ? createdIssueRef.current.issue
        : null;
      const outcome = await runIssueCreationWorkflow({
        createIssue: (createRequest) => projectSpaceClient.createGitHubIssue(createRequest),
        existingIssue: scopedExistingIssue,
        initialBody: attachments.markdownWithoutAttachments,
        onRemoteIssue: (issue) => {
          const scopedIssue = {
            issue,
            recoveryBody: issue.body ?? attachments.markdownWithoutAttachments,
            repositoryKey: currentRepositoryKey
          };
          createdIssueRef.current = scopedIssue;
          setCreatedIssue(scopedIssue);
        },
        request,
        updateIssue: (updateRequest) => projectSpaceClient.updateGitHubIssue(updateRequest),
        uploadAttachments: attachments.uploadPendingAttachments
      });

      if (
        repositoryKeyRef.current !== currentRepositoryKey ||
        !matchesIssueCreationSubmission(stateRef.current, currentRepositoryKey, id)
      ) return;

      if (outcome.status === 'complete') {
        clearIssueCreationUncertainty(
          currentRepositoryKey,
          creationOperationIdRef.current
        );
        const successAction = {
          repositoryKey: currentRepositoryKey,
          requestId: id,
          type: 'submission-succeeded' as const
        };
        stateRef.current = issueCreationReducer(stateRef.current, successAction);
        dispatch(successAction);
        revealIssue(outcome.issue, currentRepositoryKey);
        return;
      }

      const failureAction = {
        error: outcome.error,
        repositoryKey: currentRepositoryKey,
        requestId: id,
        type: 'submission-failed' as const
      };
      stateRef.current = issueCreationReducer(stateRef.current, failureAction);
      dispatch(failureAction);
      setScopeRecoveryError(null);
      setRecoveryStage(
        outcome.status === 'created-incomplete' ? outcome.stage : null
      );
      if (outcome.status === 'creation-failed') {
        if (outcome.creationState === 'uncertain') {
          const persisted = saveIssueCreationUncertainty({
            body: attachments.markdownWithoutAttachments,
            operationId: creationOperationIdRef.current,
            repositoryKey: currentRepositoryKey,
            selectedLabels: snapshot.selectedLabels,
            title: snapshot.title
          });
          setUncertainRepositoryKey(currentRepositoryKey);
          if (!persisted) {
            setScopeRecoveryError(
              `${outcome.error} Keep this page open: the browser could not preserve the recovery operation for a reload.`
            );
          }
        } else {
          clearIssueCreationUncertainty(
            currentRepositoryKey,
            creationOperationIdRef.current
          );
          creationOperationIdRef.current = requestId();
          setUncertainRepositoryKey(null);
        }
      } else {
        clearIssueCreationUncertainty(
          currentRepositoryKey,
          creationOperationIdRef.current
        );
        setUncertainRepositoryKey(null);
      }
      if (outcome.status === 'created-incomplete') {
        const scopedIssue = {
          issue: outcome.issue,
          recoveryBody: outcome.recoveryBody,
          repositoryKey: currentRepositoryKey
        };
        createdIssueRef.current = scopedIssue;
        setCreatedIssue(scopedIssue);
      }
      if (outcome.status === 'creation-failed' || outcome.stage === 'labels') loadLabels();
    } finally {
      workflowBusyRef.current = false;
      setWorkflowBusy(false);
    }
  };

  const finishAndView = async () => {
    const scopedIssue = createdIssueRef.current;
    if (!scopedIssue || workflowBusyRef.current) return;

    const currentRepositoryKey = scopedIssue.repositoryKey;
    workflowBusyRef.current = true;
    setWorkflowBusy(true);
    setRecoveryOpen(false);
    try {
      const recoveryBody = repositoryKeyRef.current === currentRepositoryKey
        ? attachments.markdownWithUploadedAttachments
        : scopedIssue.recoveryBody;
      const id = requestId();
      const startAction = { requestId: id, type: 'submission-started' as const };
      stateRef.current = issueCreationReducer(stateRef.current, startAction);
      dispatch(startAction);
      const outcome = await finishIssueCreationWithAvailableImages({
        body: recoveryBody,
        fullName: currentRepositoryKey,
        issue: scopedIssue.issue,
        onRemoteIssue: (issue) => {
          const nextScopedIssue = {
            issue,
            recoveryBody: issue.body ?? recoveryBody,
            repositoryKey: currentRepositoryKey
          };
          createdIssueRef.current = nextScopedIssue;
          setCreatedIssue(nextScopedIssue);
        },
        operationId: creationOperationIdRef.current,
        updateIssue: (updateRequest) => projectSpaceClient.updateGitHubIssue(updateRequest)
      });

      if (outcome.status === 'complete') {
        revealIssue(outcome.issue, currentRepositoryKey);
        return;
      }

      const failureAction = {
        error: outcome.error,
        repositoryKey: currentRepositoryKey,
        requestId: id,
        type: 'submission-failed' as const
      };
      if (matchesIssueCreationSubmission(stateRef.current, currentRepositoryKey, id)) {
        stateRef.current = issueCreationReducer(stateRef.current, failureAction);
        dispatch(failureAction);
      } else {
        setScopeRecoveryError(outcome.error);
      }
      setRecoveryStage('finalization');
      if (outcome.status === 'created-incomplete') {
        const nextScopedIssue = {
          issue: outcome.issue,
          recoveryBody: outcome.recoveryBody,
          repositoryKey: currentRepositoryKey
        };
        createdIssueRef.current = nextScopedIssue;
        setCreatedIssue(nextScopedIssue);
      }
    } finally {
      workflowBusyRef.current = false;
      setWorkflowBusy(false);
    }
  };

  const isSubmitting = state.submission.status === 'submitting';
  const isBusy = workflowBusy || isSubmitting || attachments.isUploading;
  const hasStoredAttachments = attachments.attachments.some(
    mayHaveReachedRemote
  ) || attachments.retainedStoredAttachmentCount > 0;
  const draftLocked = Boolean(createdIssue) || creationUncertain;
  const createdScopeMismatch = Boolean(
    createdIssue && createdIssue.repositoryKey !== repositoryKey
  );
  const attachmentPermissionError =
    attachmentWriteDenied && attachments.attachments.length > 0
      ? 'This repository is read-only for files. Remove pasted images to create the issue.'
      : null;
  const repositoryStateCurrent = state.repositoryKey === repositoryKey;
  const visibleLabelsState = visibleIssueCreationLabels(state, repositoryKey);
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
            placement="auto"
            scroll="inside"
            size="lg"
            className="p-0 sm:p-5"
          >
            <Modal.Dialog className="issue-rise-in flex h-[min(46rem,calc(var(--visual-viewport-height,100dvh)-0.75rem))] max-h-[calc(var(--visual-viewport-height,100dvh)-env(safe-area-inset-top)-0.75rem)] w-full max-w-none flex-col rounded-t-[1.75rem] rounded-b-none border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl sm:h-auto sm:max-h-[min(48rem,92dvh)] sm:max-w-5xl sm:rounded-2xl">
              <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-neutral-700 sm:hidden" />
              <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
                <IssueCreationFormHeader
                  busy={isBusy}
                  onClose={requestClose}
                  onRepositoryChange={setSelectedRepositoryKey}
                  repositories={repositoryOptions}
                  repositoryKey={repositoryKey}
                />

                <IssueCreationFormBody
                  attachmentPermissionError={attachmentPermissionError}
                  attachments={attachments}
                  bodyLocked={isBusy || draftLocked}
                  controlsBusy={isBusy}
                  createdIssueNumber={createdIssue?.issue.number}
                  creationUncertain={creationUncertain}
                  onTitleBlur={() => setTitleTouched(true)}
                  onTitleChange={(title) => dispatch({ title, type: 'title-changed' })}
                  repositoryAvailable={Boolean(repository)}
                  submissionError={
                    scopeRecoveryError ?? (repositoryStateCurrent
                      && state.submission.status === 'failed'
                      ? state.submission.error
                      : undefined)
                  }
                  title={state.title}
                  titleInvalid={titleInvalid}
                />
                <IssueCreationFormFooter
                  attachmentsUnresolved={attachments.hasUnresolvedAttachments}
                  createdIssueNumber={createdIssue?.issue.number}
                  disabled={
                    isBusy || !repositoryStateCurrent || !canSubmitIssueCreation(state)
                    || createdScopeMismatch
                    || (attachmentWriteDenied && attachments.hasUnresolvedAttachments)
                  }
                  isBusy={isBusy}
                  labelsDisabled={isBusy || draftLocked}
                  labelsState={visibleLabelsState}
                  labelWriteDenied={labelWriteDenied}
                  onCancel={requestClose}
                  onFinish={() => void finishAndView()}
                  onLabelsRetry={loadLabels}
                  onLabelToggle={(name) => dispatch({ name, type: 'label-toggled' })}
                  recoveryStage={recoveryStage}
                  retrying={state.submission.status === 'failed'}
                  creationUncertain={creationUncertain}
                  selectedLabels={state.selectedLabels}
                />
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <IssueCreationDiscardDialog
        hasStoredAttachments={hasStoredAttachments}
        isOpen={state.discardConfirmationOpen}
        onCancel={() => dispatch({ type: 'discard-canceled' })}
        onDiscard={finishClose}
      />
      <IssueCreationRecoveryDialog
        isBusy={isBusy}
        isOpen={recoveryOpen}
        issueNumber={createdIssue?.issue.number ?? 0}
        onCancel={() => setRecoveryOpen(false)}
        onFinish={() => void finishAndView()}
        recoveryStage={recoveryStage}
      />
      <IssueCreationUncertainDialog
        canCheck={uncertainRepositoryKey === repositoryKey}
        isBusy={isBusy}
        isOpen={uncertainCloseOpen}
        onCancel={() => setUncertainCloseOpen(false)}
        onCheck={() => {
          setUncertainCloseOpen(false);
          void submit();
        }}
        repositoryKey={uncertainRepositoryKey ?? repositoryKey ?? 'this repository'}
      />
    </>
  );
}
