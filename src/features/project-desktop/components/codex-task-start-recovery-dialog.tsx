import { AlertDialog, Button, Spinner } from '@heroui/react';
import { AlertTriangle } from 'lucide-react';

interface CodexTaskStartRecoveryDialogProps {
  isBusy: boolean;
  isOpen: boolean;
  machineName: string;
  onCancel(): void;
  onRetry(): void;
}

export function CodexTaskStartRecoveryDialog({
  isBusy,
  isOpen,
  machineName,
  onCancel,
  onRetry
}: CodexTaskStartRecoveryDialogProps) {
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
              <AlertDialog.Heading>Check {machineName} before retrying</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="text-sm leading-6 text-neutral-400">
              Project Space could not prove whether the earlier start reached this machine. Confirm
              that no Codex task was created there. Retrying removes only that unresolved start and
              sends a new one.
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus isDisabled={isBusy} size="sm" variant="ghost" onPress={onCancel}>
                Keep blocked
              </Button>
              <Button isDisabled={isBusy} size="sm" variant="primary" onPress={onRetry}>
                {isBusy ? <Spinner size="sm" /> : null}
                Retry start
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
