import { AlertDialog, Button, Spinner } from '@heroui/react';
import { AlertTriangle } from 'lucide-react';

import type { IssueCreationRecoveryStage } from './issue-creation-workflow';

interface IssueCreationDiscardDialogProps {
  hasStoredAttachments: boolean;
  isOpen: boolean;
  onCancel(): void;
  onDiscard(): void;
}

interface IssueCreationRecoveryDialogProps {
  isBusy: boolean;
  isOpen: boolean;
  issueNumber: number;
  onCancel(): void;
  onFinish(): void;
  recoveryStage: IssueCreationRecoveryStage | null;
}

interface IssueCreationUncertainDialogProps {
  canCheck: boolean;
  isBusy: boolean;
  isOpen: boolean;
  onCancel(): void;
  onCheck(): void;
  repositoryKey: string;
}

export function IssueCreationDiscardDialog({
  hasStoredAttachments,
  isOpen,
  onCancel,
  onDiscard
}: IssueCreationDiscardDialogProps) {
  return (
    <AlertDialog
      isOpen={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
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
                ? 'Your title, description, and selected labels will be lost. Images GitHub may already have accepted can remain stored in the repository.'
                : 'Your title, description, selected labels, and pasted images will be lost.'}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus size="sm" variant="ghost" onPress={onCancel}>
                Keep editing
              </Button>
              <Button size="sm" variant="danger" onPress={onDiscard}>
                Discard draft
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

export function IssueCreationRecoveryDialog({
  isBusy,
  isOpen,
  issueNumber,
  onCancel,
  onFinish,
  recoveryStage
}: IssueCreationRecoveryDialogProps) {
  const recoveryCopy = recoveryStage === 'labels'
    ? 'The issue already exists on GitHub. Project Space will open it without any labels that GitHub could not apply. You can also keep editing and retry the selected labels.'
    : recoveryStage === 'attachments'
      ? 'The issue already exists on GitHub. Project Space will keep any images that were stored successfully, leave failed images out of the description, and open the issue. You can also keep editing and retry.'
      : 'The issue already exists on GitHub. Project Space will retry the description update before opening it. You can also keep editing and retry.';

  return (
    <AlertDialog
      isOpen={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) onCancel();
      }}
    >
      <AlertDialog.Backdrop
        isDismissable={false}
        isKeyboardDismissDisabled
        className="z-[170] bg-black/80"
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning">
                <AlertTriangle className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>Finish issue #{issueNumber}?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="text-sm leading-6 text-neutral-400">
              {recoveryCopy}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus isDisabled={isBusy} size="sm" variant="ghost" onPress={onCancel}>
                Keep editing
              </Button>
              <Button isDisabled={isBusy} size="sm" variant="primary" onPress={onFinish}>
                {isBusy ? <Spinner size="sm" /> : null}
                Finish and view
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

export function IssueCreationUncertainDialog({
  canCheck,
  isBusy,
  isOpen,
  onCancel,
  onCheck,
  repositoryKey
}: IssueCreationUncertainDialogProps) {
  return (
    <AlertDialog
      isOpen={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) onCancel();
      }}
    >
      <AlertDialog.Backdrop
        isDismissable={false}
        isKeyboardDismissDisabled
        className="z-[180] bg-black/80"
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning">
                <AlertTriangle className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>Check GitHub before leaving</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="text-sm leading-6 text-neutral-400">
              GitHub may already have created this issue in {repositoryKey}. Project Space keeps
              the same secure operation after a reload so checking again cannot intentionally
              create a second copy. Reconcile this result before closing the draft.
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus isDisabled={isBusy} size="sm" variant="ghost" onPress={onCancel}>
                Keep editing
              </Button>
              <Button
                isDisabled={isBusy || !canCheck}
                size="sm"
                variant="primary"
                onPress={onCheck}
              >
                {isBusy ? <Spinner size="sm" /> : null}
                Check GitHub again
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
