import { useEffect, useRef, useState } from 'react';
import {
  Button,
  ComboBox,
  Input,
  ListBox,
  Modal,
  Spinner
} from '@heroui/react';
import { X } from 'lucide-react';

import type { GitHubCatalogRepository } from '@/shared/project-space-api';

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
  onTitleBlur(): void;
  onTitleChange(title: string): void;
  repositoryAvailable: boolean;
  submissionError?: string;
  title: string;
  titleInvalid: boolean;
}

interface IssueCreationFormHeaderProps {
  busy: boolean;
  onClose(): void;
  onRepositoryChange(repositoryKey: string): void;
  repositories: readonly GitHubCatalogRepository[];
  repositoryKey: string | null;
}

interface IssueCreationFormFooterProps {
  attachmentsUnresolved: boolean;
  createdIssueNumber?: number;
  creationUncertain: boolean;
  disabled: boolean;
  isBusy: boolean;
  labelsDisabled: boolean;
  labelsState: IssueCreationLabelsState;
  labelWriteDenied: boolean;
  onCancel(): void;
  onFinish(): void;
  onLabelsRetry(): void;
  onLabelToggle(name: string): void;
  recoveryStage: IssueCreationRecoveryStage | null;
  retrying: boolean;
  selectedLabels: readonly string[];
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.305-5.466-1.334-5.466-5.93 0-1.31.468-2.381 1.235-3.221-.123-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 6.098c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.119 3.176.77.84 1.233 1.911 1.233 3.221 0 4.609-2.805 5.624-5.475 5.921.43.371.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .321.216.694.825.576C20.565 22.092 24 17.598 24 12.297 24 5.67 18.627.297 12 .297Z" />
    </svg>
  );
}

export function IssueCreationFormHeader({
  busy,
  onClose,
  onRepositoryChange,
  repositories,
  repositoryKey
}: IssueCreationFormHeaderProps) {
  const selectedRepository = repositories.find(
    (repository) => repository.fullName === repositoryKey
  );
  const selectedRepositoryName = selectedRepository?.fullName ?? '';
  const [repositoryQuery, setRepositoryQuery] = useState(selectedRepositoryName);

  useEffect(() => {
    setRepositoryQuery(selectedRepositoryName);
  }, [selectedRepositoryName]);

  return (
    <Modal.Header className="flex flex-row items-center gap-3 border-b border-neutral-800 px-5 pt-3 pb-4 sm:px-6 sm:pt-4">
      <Modal.Heading className="sr-only">New issue</Modal.Heading>
      <ComboBox
        aria-label="Repository"
        className="min-w-0 flex-1"
        inputValue={repositoryQuery}
        isDisabled={busy || repositories.length === 0}
        menuTrigger="focus"
        selectedKey={repositoryKey}
        onInputChange={setRepositoryQuery}
        onSelectionChange={(nextRepositoryKey) => {
          if (!nextRepositoryKey) return;
          const nextRepositoryName = String(nextRepositoryKey);
          setRepositoryQuery(nextRepositoryName);
          onRepositoryChange(nextRepositoryName);
        }}
      >
        <ComboBox.InputGroup className="relative h-9 rounded-full border-0 bg-neutral-900 shadow-none transition-colors hover:bg-neutral-800 focus-within:ring-2 focus-within:ring-neutral-700">
          <GitHubMark className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-neutral-300" />
          <Input
            aria-label="Search repositories"
            className="h-9 rounded-full border-0 bg-transparent pr-10 pl-10 text-sm font-medium text-neutral-200 shadow-none outline-none placeholder:text-neutral-500 focus-visible:border-0 focus-visible:ring-0"
            placeholder="Search repositories…"
            onBlur={() => setRepositoryQuery(selectedRepositoryName)}
          />
          <ComboBox.Trigger className="right-1 flex size-8 items-center justify-center text-neutral-500" />
        </ComboBox.InputGroup>
        <ComboBox.Popover className="z-[140] w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-neutral-800 bg-neutral-950 p-1 shadow-2xl shadow-black/70">
          <ListBox>
            {repositories.map((repository) => (
              <ListBox.Item
                className="flex min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-neutral-300 hover:bg-neutral-900 hover:text-neutral-50"
                id={repository.fullName}
                key={repository.id}
                textValue={repository.fullName}
              >
                <GitHubMark className="size-4 shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1 truncate">{repository.fullName}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>
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
  onTitleBlur,
  onTitleChange,
  repositoryAvailable,
  submissionError,
  title,
  titleInvalid
}: IssueCreationFormBodyProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  return (
    <Modal.Body className="mt-0 min-h-0 px-5 py-5 sm:px-6">
      <div className="min-w-0">
        <div className="min-w-0">
          <input
            ref={titleRef}
            aria-label="Issue title"
            autoFocus={!bodyLocked}
            aria-describedby={titleInvalid ? 'new-issue-title-error' : undefined}
            aria-invalid={titleInvalid}
            className="block h-12 w-full border-0 border-b border-transparent bg-transparent px-0 text-lg font-semibold text-neutral-100 outline-none placeholder:font-medium placeholder:text-neutral-500 focus:border-transparent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-red-500 sm:text-xl"
            disabled={bodyLocked}
            name="issue-title"
            placeholder="Task name"
            required
            value={title}
            onBlur={onTitleBlur}
            onChange={(event) => onTitleChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              descriptionRef.current?.focus();
            }}
          />
          {titleInvalid ? (
            <p id="new-issue-title-error" className="mt-1 text-xs text-red-400">
              Enter a title.
            </p>
          ) : null}
        </div>

        <textarea
          ref={descriptionRef}
          aria-label="Issue description"
          className="mt-5 min-h-72 w-full resize-none border-0 bg-transparent px-0 font-mono text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-80"
          disabled={bodyLocked}
          name="issue-body"
          placeholder="Describe the problem, context, and expected outcome…"
          rows={13}
          value={attachments.markdown}
          onChange={(event) => attachments.handleMarkdownChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== 'Backspace'
              || event.nativeEvent.isComposing
              || event.currentTarget.value.length > 0
            ) {
              return;
            }

            event.preventDefault();
            titleRef.current?.focus();
            titleRef.current?.setSelectionRange(title.length, title.length);
          }}
          onPaste={attachments.handlePaste}
        />
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
  labelsDisabled,
  labelsState,
  labelWriteDenied,
  onCancel,
  onFinish,
  onLabelsRetry,
  onLabelToggle,
  recoveryStage,
  retrying,
  selectedLabels
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
    <Modal.Footer className="mt-0 flex shrink-0 flex-col items-stretch gap-3 border-t border-neutral-800 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pb-4">
      <IssueLabelPicker
        disabled={labelsDisabled}
        labelsState={labelsState}
        onRetry={onLabelsRetry}
        onToggle={onLabelToggle}
        selectedLabels={selectedLabels}
        writeDenied={labelWriteDenied}
      />
      <div className="flex w-full shrink-0 flex-col-reverse gap-2 sm:ml-auto sm:w-auto sm:flex-row sm:items-center">
        {createdIssueNumber ? (
          <Button className="rounded-full sm:w-auto" fullWidth isDisabled={isBusy} size="sm" variant="ghost" onPress={onFinish}>
            Finish and view
          </Button>
        ) : (
          <Button className="rounded-full sm:w-auto" fullWidth isDisabled={isBusy} size="sm" variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        )}
        <Button className="rounded-full sm:w-auto" fullWidth isDisabled={disabled} size="sm" type="submit" variant="primary">
          {isBusy ? <Spinner size="sm" /> : null}
          {buttonLabel}
        </Button>
      </div>
    </Modal.Footer>
  );
}
