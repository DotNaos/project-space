import { Check, RotateCcw } from 'lucide-react';
import { Modal } from '@heroui/react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { labelChipStyle } from './issue-board-model';

interface IssueFilterOverlayProps {
  activeLabels: ReadonlySet<string>;
  labels: string[];
  onActiveLabelsChange(labels: ReadonlySet<string>): void;
  onClose(): void;
  open: boolean;
}

export function IssueFilterOverlay({
  activeLabels,
  labels,
  onActiveLabelsChange,
  onClose,
  open
}: IssueFilterOverlayProps) {
  const toggleLabel = (label: string) => {
    const next = new Set(activeLabels);
    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }
    onActiveLabelsChange(next);
  };

  return (
    <Modal.Backdrop
      isDismissable
      isKeyboardDismissDisabled={false}
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      variant="blur"
      className="z-[120] bg-black/65"
    >
      <Modal.Container placement="auto" className="p-0 sm:p-6">
        <Modal.Dialog className="issue-rise-in flex max-h-[72dvh] w-full max-w-none flex-col rounded-t-[1.75rem] rounded-b-none border border-neutral-800 bg-neutral-950 p-0 shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-neutral-700 sm:hidden" />
        <Modal.Header className="flex-row items-center gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <Modal.Heading className="text-base font-semibold text-neutral-100">
              Filter issues
            </Modal.Heading>
            <Text className="mt-0.5 text-xs text-neutral-500">
              Match issues with any selected repository label.
            </Text>
          </div>
          <Modal.CloseTrigger className="text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" />
        </Modal.Header>

        <Modal.Body className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {labels.length > 0 ? (
            <div className="grid gap-2">
              {labels.map((label) => {
                const active = activeLabels.has(label);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleLabel(label)}
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-xl border px-3 text-left text-sm transition',
                      active
                        ? 'border-neutral-600 bg-neutral-900 text-neutral-100'
                        : 'border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                    )}
                  >
                    <span
                      style={labelChipStyle(label)}
                      className="min-w-0 flex-1 truncate rounded-full border px-2 py-0.5 text-xs font-medium"
                    >
                      {label}
                    </span>
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border',
                        active ? 'border-neutral-300 bg-neutral-100 text-neutral-950' : 'border-neutral-700'
                      )}
                    >
                      {active ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <Text className="py-6 text-center text-sm text-neutral-500">
              This repository has no issue labels yet.
            </Text>
          )}
        </Modal.Body>

        <Modal.Footer className="flex-row items-center justify-between gap-3 border-t border-neutral-800 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={activeLabels.size === 0}
            onPress={() => onActiveLabelsChange(new Set())}
          >
            <RotateCcw className="size-4" />
            Clear
          </Button>
          <Button size="sm" variant="primary" onPress={onClose}>
            Done
          </Button>
        </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
