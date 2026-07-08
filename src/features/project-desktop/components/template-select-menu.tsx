import { Check } from 'lucide-react';
import { ListBox, ListBoxItem, Select, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';

export interface TemplateSelectOption<T extends string = string> {
  detail?: string;
  isDisabled?: boolean;
  label: string;
  triggerDetail?: string;
  triggerValueHighlight?: string;
  triggerLabel?: string;
  triggerValue?: string;
  value: T;
}

export function TemplateSelectMenu<T extends string>({
  ariaLabel,
  className,
  'data-testid': dataTestId,
  onChange,
  options,
  value
}: {
  ariaLabel: string;
  className?: string;
  'data-testid'?: string;
  onChange(value: T): void;
  options: Array<TemplateSelectOption<T>>;
  value: T;
}) {
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const selectedValue = selectedOption?.value ?? value;
  const selectedDetail = selectedOption?.triggerDetail ?? selectedOption?.detail;
  const selectedTriggerLabel = selectedOption?.triggerLabel;
  const selectedTriggerValue = selectedOption?.triggerValue;
  const selectedTriggerValueHighlight = selectedOption?.triggerValueHighlight;
  const highlightedTriggerValueParts =
    selectedTriggerValue && selectedTriggerValueHighlight
      ? selectedTriggerValue.split(selectedTriggerValueHighlight)
      : undefined;

  return (
    <Select
      aria-label={ariaLabel}
      data-testid={dataTestId}
      value={selectedValue}
      onChange={(nextValue) => {
        const nextOption = options.find((option) => option.value === nextValue);

        if (nextValue !== null && !nextOption?.isDisabled) {
          onChange(nextValue as T);
        }
      }}
      className={cn('min-w-0', className)}
    >
      <Select.Trigger className="flex min-h-12 w-full min-w-0 items-center rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-sm text-neutral-100 outline-none transition hover:border-neutral-700 hover:bg-neutral-900/70 focus-visible:border-neutral-500 focus-visible:ring-2 focus-visible:ring-neutral-800">
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-medium">{selectedOption?.label ?? 'Select'}</span>
          {selectedTriggerLabel && selectedTriggerValue ? (
            <span className="mt-0.5 block truncate text-xs text-neutral-500">
              {selectedTriggerLabel}{' '}
              <span className="font-semibold text-neutral-300">
                {highlightedTriggerValueParts
                  ? highlightedTriggerValueParts.map((part, index) => (
                      <span key={`${part}-${index}`}>
                        {part}
                        {index < highlightedTriggerValueParts.length - 1 ? (
                          <span className="text-sky-200">{selectedTriggerValueHighlight}</span>
                        ) : null}
                      </span>
                    ))
                  : selectedTriggerValue}
              </span>
            </span>
          ) : selectedDetail ? (
            <span className="mt-0.5 block truncate text-xs text-neutral-500">
              {selectedDetail}
            </span>
          ) : null}
        </span>
        <Select.Indicator className="size-4 shrink-0 text-neutral-500" />
      </Select.Trigger>
      <Select.Popover className="w-full min-w-64 rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/50">
        <ListBox selectedKeys={new Set([selectedValue])} className="max-h-80 overflow-auto p-1">
          {options.map((option) => {
            const isSelected = option.value === selectedValue;
            const isDisabled = Boolean(option.isDisabled);

            return (
              <ListBoxItem
                key={option.value}
                id={option.value}
                isDisabled={isDisabled}
                textValue={option.label}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left transition',
                  isDisabled
                    ? 'cursor-not-allowed text-neutral-600 opacity-70'
                    : isSelected
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-900/80'
                )}
              >
                <span className="min-w-0 flex-1">
                  <Text className="block truncate text-sm font-medium">{option.label}</Text>
                  {option.detail ? (
                    <Text className="block truncate text-xs text-neutral-600">
                      {option.detail}
                    </Text>
                  ) : null}
                </span>
                {isSelected ? <Check className="size-3.5 shrink-0 text-neutral-200" /> : null}
              </ListBoxItem>
            );
          })}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
