import { useEffect, useMemo, useState } from 'react';
import { Button, Chip, SearchField, Spinner } from '@heroui/react';
import { RefreshCw, X } from 'lucide-react';

import {
  filterIssueCreationLabels,
  type IssueCreationLabelsState
} from './issue-creation-model';

interface IssueLabelPickerProps {
  disabled?: boolean;
  labelsState: IssueCreationLabelsState;
  onRetry(): void;
  onToggle(name: string): void;
  repositoryKey: string | null;
  selectedLabels: readonly string[];
  writeDenied?: boolean;
}

function labelStyle(color?: string, selected = false) {
  if (!color) return undefined;

  return {
    backgroundColor: selected ? `#${color}20` : `#${color}0d`,
    borderColor: `#${color}70`
  };
}

function ColorDot({ color }: { color?: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full bg-neutral-500"
      style={color ? { backgroundColor: `#${color}` } : undefined}
    />
  );
}

export function IssueLabelPicker({
  disabled = false,
  labelsState,
  onRetry,
  onToggle,
  repositoryKey,
  selectedLabels,
  writeDenied = false
}: IssueLabelPickerProps) {
  const [query, setQuery] = useState('');

  useEffect(() => setQuery(''), [repositoryKey]);

  const visibleLabels = useMemo(
    () => filterIssueCreationLabels(labelsState.labels, query),
    [labelsState.labels, query]
  );
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels]);
  const selectedOptions = labelsState.labels.filter((label) => selectedSet.has(label.name));
  const hasLabels = labelsState.labels.length > 0;
  const isLoading = labelsState.status === 'loading';

  return (
    <section
      aria-busy={isLoading}
      aria-labelledby="new-issue-labels-heading"
      className="min-w-0 border-t border-neutral-800 pt-5 md:border-l md:border-t-0 md:pl-5 md:pt-0"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3
            id="new-issue-labels-heading"
            className="text-sm font-semibold text-neutral-100"
          >
            Labels
          </h3>
          <p className="mt-0.5 text-xs text-neutral-500">Choose existing repository labels.</p>
        </div>
        {labelsState.status === 'failed' ? (
          <Button isDisabled={disabled} size="sm" variant="ghost" onPress={onRetry}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        ) : null}
      </div>

      {selectedOptions.length > 0 ? (
        <div className="mt-4" aria-label="Selected labels">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Selected
          </p>
          <div className="flex flex-wrap gap-2">
            {selectedOptions.map((label) => (
              <Chip
                key={label.name}
                size="sm"
                variant="tertiary"
                style={labelStyle(label.color, true)}
                className="gap-1 border text-neutral-100"
              >
                <ColorDot color={label.color} />
                <Chip.Label>{label.name}</Chip.Label>
                <Button
                  aria-label={`Remove ${label.name}`}
                  isDisabled={disabled}
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="ml-0.5 size-5 min-h-5 min-w-5 rounded-full p-0 text-neutral-400"
                  onPress={() => onToggle(label.name)}
                >
                  <X className="size-3" />
                </Button>
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      {writeDenied ? (
        <div
          className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5"
          role="status"
        >
          <p className="text-xs font-medium text-amber-200">Labels cannot be changed.</p>
          <p className="mt-1 text-xs leading-5 text-neutral-400">
            This repository is read-only. You can still create the issue without labels.
          </p>
        </div>
      ) : null}

      {isLoading && !hasLabels ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-neutral-400" role="status">
          <Spinner size="sm" />
          Loading repository labels…
        </div>
      ) : null}

      {labelsState.status === 'failed' ? (
        <div
          className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5"
          role="status"
        >
          <p className="text-xs font-medium text-amber-200">Labels could not be refreshed.</p>
          <p className="mt-1 text-xs leading-5 text-neutral-400">{labelsState.error}</p>
          {!hasLabels ? (
            <p className="mt-1 text-xs leading-5 text-neutral-500">
              You can still create this issue without labels.
            </p>
          ) : null}
        </div>
      ) : null}

      {hasLabels ? (
        <>
          <SearchField
            aria-label="Search repository labels"
            className="mt-4"
            fullWidth
            isDisabled={disabled || writeDenied}
            value={query}
            variant="secondary"
            onChange={setQuery}
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Search labels" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>

          {isLoading ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500" role="status">
              <Spinner size="sm" />
              Refreshing labels…
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Repository labels">
            {visibleLabels.map((label) => {
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
                  style={labelStyle(label.color, selected)}
                  className="min-h-8 rounded-full border px-2.5 text-xs text-neutral-300 data-[pressed=true]:scale-100"
                  onPress={() => onToggle(label.name)}
                >
                  <ColorDot color={label.color} />
                  <span className="min-w-0 truncate">{label.name}</span>
                </Button>
              );
            })}
          </div>

          {visibleLabels.length === 0 ? (
            <p className="mt-4 text-xs text-neutral-500">No labels match “{query.trim()}”.</p>
          ) : null}
        </>
      ) : labelsState.status === 'ready' ? (
        <p className="mt-5 text-xs text-neutral-500">This repository has no labels.</p>
      ) : null}
    </section>
  );
}
