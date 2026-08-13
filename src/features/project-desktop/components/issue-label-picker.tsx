import { useMemo } from 'react';
import { Button, ScrollShadow, Spinner } from '@heroui/react';
import { RefreshCw } from 'lucide-react';

import type { IssueCreationLabelsState } from './issue-creation-model';
import { IssueLabelChip } from './issue-visuals';

interface IssueLabelPickerProps {
  disabled?: boolean;
  labelsState: IssueCreationLabelsState;
  onRetry(): void;
  onToggle(name: string): void;
  selectedLabels: readonly string[];
  writeDenied?: boolean;
}

export function IssueLabelPicker({
  disabled = false,
  labelsState,
  onRetry,
  onToggle,
  selectedLabels,
  writeDenied = false
}: IssueLabelPickerProps) {
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels]);
  const hasLabels = labelsState.labels.length > 0;
  const isLoading = labelsState.status === 'loading';

  return (
    <section
      aria-label="Labels"
      aria-busy={isLoading}
      className="flex min-w-0 items-center gap-2 sm:flex-1"
    >
      {isLoading && !hasLabels ? (
        <div className="flex min-h-9 items-center gap-2 text-xs text-neutral-400" role="status">
          <Spinner size="sm" />
          Loading labels…
        </div>
      ) : null}

      {labelsState.status === 'failed' && !hasLabels ? (
        <Button isDisabled={disabled} size="sm" variant="ghost" onPress={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry labels
        </Button>
      ) : null}

      {hasLabels ? (
        <ScrollShadow
          hideScrollBar
          orientation="horizontal"
          size={20}
          className="min-w-0 flex-1"
        >
          <div className="flex w-max items-center gap-2" role="group" aria-label="Repository labels">
            {labelsState.labels.map((label) => {
              const selected = selectedSet.has(label.name);

              return (
                <Button
                  key={label.name}
                  aria-label={
                    label.description
                      ? `${label.name}: ${label.description}`
                      : label.name
                  }
                  aria-pressed={selected}
                  isDisabled={disabled || writeDenied}
                  size="sm"
                  variant="ghost"
                  className="h-auto min-h-0 shrink-0 rounded-full p-0 shadow-none transition-[filter,opacity] hover:brightness-125 data-[pressed=true]:scale-100"
                  onPress={() => onToggle(label.name)}
                >
                  <IssueLabelChip
                    className="px-2.5 py-1 text-[11px]"
                    label={label.name}
                    selected={selected}
                  />
                </Button>
              );
            })}
          </div>
        </ScrollShadow>
      ) : labelsState.status === 'ready' ? (
        <p className="text-xs text-neutral-500">No labels</p>
      ) : null}

      {labelsState.status === 'failed' && hasLabels ? (
        <Button
          aria-label="Retry labels"
          isDisabled={disabled}
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={onRetry}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      ) : null}
    </section>
  );
}
