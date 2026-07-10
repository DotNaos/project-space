import { Check } from 'lucide-react';
import { ListBox, ListBoxItem, Select } from '@/app/dotnaos-ui';
import type { CodexModelRecord } from '@/shared/project-space-api';
import { cn } from '@/lib/utils';

export function CodexModelSelect({
  disabled,
  models,
  onChange,
  value
}: {
  disabled: boolean;
  models: CodexModelRecord[];
  onChange(value: string): void;
  value: string;
}) {
  const selected = models.find((model) => model.model === value);

  if (disabled || models.length === 0) {
    return (
      <button
        type="button"
        disabled
        className="h-8 max-w-48 truncate rounded-lg border border-neutral-800 bg-neutral-950/80 px-2.5 text-xs text-neutral-500"
      >
        {models.length === 0 ? 'Models unavailable' : selected?.displayName ?? 'Loading models…'}
      </button>
    );
  }

  return (
    <Select
      aria-label="Codex model"
      value={value}
      onChange={(nextValue) => nextValue && onChange(nextValue)}
      className="max-w-52 shrink-0"
    >
      <Select.Trigger
        aria-label="Codex model"
        className="h-8 rounded-lg border border-neutral-800 bg-neutral-950/80 px-2.5 text-xs text-neutral-200 outline-none transition hover:border-neutral-700 hover:bg-neutral-900/70 focus-visible:border-neutral-500 focus-visible:ring-2 focus-visible:ring-neutral-800"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected?.displayName ?? 'Select model'}
        </span>
        <Select.Indicator className="size-3.5 shrink-0 text-neutral-500" />
      </Select.Trigger>
      <Select.Popover className="right-0 left-auto w-72 rounded-lg border border-neutral-800/80 bg-neutral-950 shadow-2xl shadow-black/50">
        <ListBox selectedKeys={new Set([value])} className="max-h-80 overflow-auto p-1">
          {models.map((model) => (
            <ListBoxItem
              key={model.id}
              id={model.model}
              textValue={model.displayName}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition',
                value === model.model
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900/80'
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium">{model.displayName}</span>
                {model.description ? (
                  <span className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-neutral-600">
                    {model.description}
                  </span>
                ) : null}
              </span>
              {value === model.model ? (
                <Check className="size-3.5 shrink-0 text-neutral-200" />
              ) : null}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
