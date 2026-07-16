import { Check } from 'lucide-react';
import { ListBox, ListBoxItem, Select } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { CodexModelRecord } from '@/shared/project-space-api';

export interface CodexSessionModelSelection {
  disabled: boolean;
  error?: string;
  models: CodexModelRecord[];
  onChange(value: string): void;
  override?: string;
  value: string;
}

export function CodexSessionModelSelect({
  disabled,
  error,
  models,
  onChange,
  value
}: CodexSessionModelSelection) {
  const selected = models.find((model) => model.model === value);
  const label = (selected?.displayName ?? value) || 'Models unavailable';

  if (disabled || models.length === 0) {
    return (
      <button
        aria-label="Codex model"
        className="h-9 max-w-48 truncate rounded-full px-2.5 text-xs font-medium text-neutral-500"
        disabled
        title={error}
        type="button"
      >
        {label}
      </button>
    );
  }

  return (
    <Select className="min-w-0 max-w-52" onChange={(next) => next && onChange(next)} value={value}>
      <Select.Trigger
        aria-label="Codex model"
        className="h-9 rounded-full px-2.5 text-xs font-medium text-neutral-400 outline-none transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-700"
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <Select.Indicator className="size-3.5 shrink-0" />
      </Select.Trigger>
      <Select.Popover
        className="w-72 rounded-2xl border border-neutral-700/80 bg-neutral-900 p-1 shadow-2xl shadow-black/60"
        style={{ bottom: '100%', left: 0, marginBottom: 8, marginTop: 0, top: 'auto' }}
      >
        <ListBox className="max-h-80 overflow-y-auto" selectedKeys={new Set([value])}>
          {models.map((model) => (
            <ListBoxItem
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2.5',
                model.model === value
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100'
              )}
              id={model.model}
              key={model.id}
              textValue={model.displayName}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium">{model.displayName}</span>
                {model.description ? (
                  <span className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-neutral-500">
                    {model.description}
                  </span>
                ) : null}
              </span>
              {model.model === value ? <Check className="size-3.5 shrink-0" /> : null}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
