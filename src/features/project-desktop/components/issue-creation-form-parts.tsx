import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Spinner,
  TextArea,
  TextField
} from '@heroui/react';
import { X } from 'lucide-react';

import type { IssueCreationRecoveryStage } from './issue-creation-workflow';
import type { IssueCreationLabelsState } from './issue-creation-model';
import { IssueAttachmentStatus } from './issue-attachment-status';
import { IssueLabelPicker } from './issue-label-picker';
import type { IssueAttachmentsController } from './use-issue-attachments';

interface IssueCreationFormBodyProps {
  attachmentPermissionError: string | null;
  attachments: IssueAttachmentsController;
  bodyLocked: boolean;
  controlsBusy: boolean;
  createdIssueNumber?: number;
  creationUncertain: boolean;
  labelsState: IssueCreationLabelsState;
  labelWriteDenied: boolean;
  onLabelsRetry(): void;
  onLabelToggle(name: string): void;
  onTitleBlur(): void;
  onTitleChange(title: string): void;
  repositoryAvailable: boolean;
  repositoryKey: string | null;
  selectedLabels: readonly string[];
  submissionError?: string;
  title: string;
  titleInvalid: boolean;
}

interface IssueCreationFormHeaderProps {
  busy: boolean;
  onClose(): void;
  repositoryKey: string | null;
}

interface IssueCreationFormFooterProps {
  attachmentsUnresolved: boolean;
  createdIssueNumber?: number;
  creationUncertain: boolean;
  disabled: boolean;
  isBusy: boolean;
  onCancel(): void;
  onFinish(): void;
  recoveryStage: IssueCreationRecoveryStage | null;
  retrying: boolean;
}

export function IssueCreationFormHeader({
  busy,
  onClose,
  repositoryKey
}: IssueCreationFormHeaderProps) {
  return (
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
        isDisabled={busy}
        isIconOnly
        size="sm"
        variant="ghost"
        onPress={onClose}
      >
        <X className="size-4" />
      </Button>
    </Modal.Header>
  );
}

export function IssueCreationFormBody({
  attachmentPermissionError,
  attachments,
  bodyLocked,
  controlsBusy,
  createdIssueNumber,
  creationUncertain,
  labelsState,
  labelWriteDenied,
  onLabelsRetry,
  onLabelToggle,
  onTitleBlur,
  onTitleChange,
  repositoryAvailable,
  repositoryKey,
  selectedLabels,
  submissionError,
  title,
  titleInvalid
}: IssueCreationFormBodyProps) {
  return (
    <Modal.Body className="mt-0 min-h-0 px-5 py-5 sm:px-6">
      <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)]">
        <div className="min-w-0">
          <TextField
            fullWidth
            isDisabled={bodyLocked}
            isInvalid={titleInvalid}
            isRequired
            name="issue-title"
            value={title}
            variant="secondary"
            onChange={onTitleChange}
          >
            <Label>Title</Label>
            <Input
              autoFocus={!bodyLocked}
              placeholder="What needs to be done?"
              onBlur={onTitleBlur}
            />
            <FieldError>Enter a title.</FieldError>
          </TextField>

          <TextField
            className="mt-5"
            fullWidth
            isDisabled={bodyLocked}
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
            disabled={controlsBusy}
            error={attachmentPermissionError ?? attachments.error}
            onRemoveAll={attachments.removeAllAttachments}
            onRemove={attachments.removeAttachment}
            previewUrls={attachments.previewUrls}
            retainedStoredAttachmentCount={attachments.retainedStoredAttachmentCount}
          />
        </div>

        <IssueLabelPicker
          disabled={bodyLocked}
          labelsState={labelsState}
          onRetry={onLabelsRetry}
          onToggle={onLabelToggle}
          repositoryKey={repositoryKey}
          selectedLabels={selectedLabels}
          writeDenied={labelWriteDenied}
        />
      </div>

      {!repositoryAvailable ? (
        <div
          className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5 text-xs text-amber-200"
          role="status"
        >
          Connect a GitHub repository before creating an issue.
        </div>
      ) : null}

      {submissionError ? (
        <div
          className="mt-5 rounded-xl border border-red-400/20 bg-red-400/5 px-3 py-2.5"
          role="alert"
        >
          <p className="text-xs font-medium text-red-200">
            {createdIssueNumber
              ? `Issue #${createdIssueNumber} was created, but setup is incomplete.`
              : creationUncertain
                ? 'GitHub has not confirmed issue creation.'
                : 'Issue creation failed.'}
          </p>
          <p className="mt-1 text-xs leading-5 text-neutral-400">{submissionError}</p>
        </div>
      ) : null}
    </Modal.Body>
  );
}

export function IssueCreationFormFooter({
  attachmentsUnresolved,
  createdIssueNumber,
  creationUncertain,
  disabled,
  isBusy,
  onCancel,
  onFinish,
  recoveryStage,
  retrying
}: IssueCreationFormFooterProps) {
  const buttonLabel = isBusy
    ? createdIssueNumber
      ? recoveryStage === 'labels'
        ? 'Applying labels…'
        : attachmentsUnresolved
          ? 'Storing images…'
          : 'Finishing…'
      : 'Creating…'
    : createdIssueNumber
      ? recoveryStage === 'attachments'
        ? 'Retry images'
        : recoveryStage === 'labels'
          ? 'Retry labels'
          : 'Retry finalization'
      : creationUncertain
        ? 'Check GitHub again'
        : retrying
        ? 'Retry creation'
        : 'Create issue';

  return (
    <Modal.Footer className="mt-0 flex items-center justify-between gap-3 border-t border-neutral-800 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
      <p className="hidden text-xs text-neutral-500 sm:block">
        {createdIssueNumber
          ? `Issue #${createdIssueNumber} already exists on GitHub.`
          : 'Labels and images are optional.'}
      </p>
      <div className="ml-auto flex items-center gap-2">
        {createdIssueNumber ? (
          <Button isDisabled={isBusy} size="sm" variant="ghost" onPress={onFinish}>
            Finish and view
          </Button>
        ) : (
          <Button isDisabled={isBusy} size="sm" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        )}
        <Button isDisabled={disabled} size="sm" type="submit" variant="primary">
          {isBusy ? <Spinner size="sm" /> : null}
          {buttonLabel}
        </Button>
      </div>
    </Modal.Footer>
  );
}
