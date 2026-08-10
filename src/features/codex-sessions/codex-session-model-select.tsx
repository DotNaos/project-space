import { useState, type ReactNode } from 'react';
import { Drawer, Popover } from '@heroui/react';
import { Check, ChevronRight, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { ListBox, ListBoxItem, Select } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  CodexModelRecord,
  CodexReasoningEffortOptionRecord
} from '@/shared/project-space-api';
import { CodexSessionDesktopModelSelect } from './codex-session-desktop-model-select';
import type { CodexSessionModelSelection } from './codex-session-model-selection';

const standardTier = '__standard__';
const unchangedSetting = '__unchanged__';

export type { CodexSessionModelSelection } from './codex-session-model-selection';

export function CodexSessionModelSelect(selection: CodexSessionModelSelection) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const selected = selection.models.find((model) => model.model === selection.value);
  const modelLabel = (selected?.displayName ?? selection.value)
    || (selection.loading ? 'Loading models…' : 'Model catalogue unavailable');
  const summary = [
    selection.usesCatalogueDefault ? `Default: ${modelLabel}` : modelLabel,
    selection.effort ? settingLabel(selection.effort) : undefined
  ].filter(Boolean).join(' ');

  if (selection.disabled || selection.models.length === 0) {
    return (
      <button
        aria-label={selection.onRetry ? 'Retry Codex model catalogue' : 'Codex model settings'}
        className="inline-flex h-9 max-w-60 items-center gap-1.5 truncate rounded-full px-2.5 text-xs font-medium text-neutral-500 enabled:hover:bg-neutral-800 enabled:hover:text-neutral-200"
        disabled={!selection.onRetry}
        onClick={selection.onRetry}
        title={selection.error}
        type="button"
      >
        <span className="truncate">{summary}</span>
        {selection.onRetry ? <RefreshCw className="size-3 shrink-0" /> : null}
      </button>
    );
  }

  return (
    <>
      <div className="hidden md:block">
        <CodexSessionDesktopModelSelect {...selection} />
      </div>
      <div className="md:hidden">
        <Popover isOpen={quickOpen} onOpenChange={setQuickOpen}>
          <Popover.Trigger
            aria-label="Codex model settings"
            className="flex h-9 max-w-52 min-w-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-neutral-400 outline-none transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-700"
          >
            <span className="min-w-0 truncate">{summary}</span>
            <ChevronRight className="size-3.5 shrink-0" />
          </Popover.Trigger>
          <Popover.Content
            className="w-[min(22rem,calc(100vw-2rem))] rounded-[1.75rem] border border-neutral-700/80 bg-neutral-900/95 p-2 shadow-2xl shadow-black/70 backdrop-blur-xl"
            offset={10}
            placement="top"
          >
            <Popover.Dialog className="outline-none">
              <button
                className="flex w-full items-center justify-center gap-1 rounded-2xl px-3 py-3 text-sm font-semibold text-neutral-100 transition hover:bg-neutral-800"
                onClick={() => {
                  setQuickOpen(false);
                  setAdvancedOpen(true);
                }}
                type="button"
              >
                <span className="truncate">{summary}</span>
                <ChevronRight className="size-4 shrink-0 text-neutral-400" />
              </button>
              <ReasoningQuickSelect
                onChange={selection.onEffortChange}
                options={selected?.supportedReasoningEfforts ?? []}
                value={selection.effort}
              />
            </Popover.Dialog>
          </Popover.Content>
        </Popover>

        <ModelSettingsDrawer
          {...selection}
          isOpen={advancedOpen}
          onOpenChange={setAdvancedOpen}
          selected={selected}
        />
      </div>
    </>
  );
}

function ReasoningQuickSelect({
  onChange,
  options,
  value
}: {
  onChange(value: string): void;
  options: CodexReasoningEffortOptionRecord[];
  value?: string;
}) {
  if (options.length === 0) {
    return (
      <p className="px-3 pb-3 text-center text-[11px] text-neutral-500">
        This model returned no intelligence choices.
      </p>
    );
  }

  return (
    <div
      aria-label="Intelligence"
      className="grid gap-1 rounded-full bg-neutral-800/90 p-1"
      data-codex-reasoning-quick="true"
      role="group"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const selected = option.reasoningEffort === value;
        return (
          <button
            aria-label={`Intelligence ${settingLabel(option.reasoningEffort)}`}
            aria-pressed={selected}
            className={cn(
              'min-w-0 rounded-full px-0.5 py-2 text-[9px] font-semibold transition',
              selected
                ? 'bg-neutral-100 text-neutral-900 shadow-sm'
                : 'text-neutral-500 hover:bg-neutral-700/80 hover:text-neutral-200'
            )}
            key={option.reasoningEffort}
            onClick={() => onChange(option.reasoningEffort)}
            title={option.description}
            type="button"
          >
            <span className="block whitespace-nowrap">{settingLabel(option.reasoningEffort)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ModelSettingsDrawer({
  effort,
  isOpen,
  models,
  onChange,
  onEffortChange,
  onOpenChange,
  onServiceTierChange,
  selected,
  serviceTier,
  value
}: CodexSessionModelSelection & {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  selected?: CodexModelRecord;
}) {
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const tiers = selected?.serviceTiers ?? [];
  const effortValue = effort ?? unchangedSetting;
  const tierValue = serviceTier === undefined
    ? unchangedSetting
    : serviceTier === null ? standardTier : serviceTier;

  return (
    <Drawer.Backdrop
      className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-md"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      variant="blur"
    >
      <Drawer.Content
        className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-xl"
        placement="bottom"
      >
        <Drawer.Dialog className="max-h-[min(38rem,calc(100dvh-1rem))] overflow-visible rounded-t-[2rem] border border-b-0 border-neutral-700/80 bg-neutral-900/95 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-neutral-100 shadow-2xl shadow-black/80 backdrop-blur-xl outline-none sm:rounded-[2rem] sm:border-b sm:mb-3">
          <Drawer.Handle className="mx-auto mt-2 h-1 w-16 rounded-full bg-neutral-600" />
          <Drawer.Header className="flex items-center justify-center gap-2 px-2 py-5">
            <SlidersHorizontal className="size-4 text-neutral-400" />
            <Drawer.Heading className="text-base font-semibold">Advanced</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body className="overflow-visible p-0">
            <div className="divide-y divide-neutral-700/70 rounded-[1.75rem] bg-neutral-800/80 px-4">
              <SettingRow label="Model">
                <ModelSelect models={models} onChange={onChange} value={value} />
              </SettingRow>
              {efforts.length > 0 ? (
                <SettingRow label="Intelligence">
                  <SimpleSettingsSelect
                    ariaLabel="Intelligence"
                    onChange={(next) => next !== unchangedSetting && onEffortChange(next)}
                    options={[
                      { id: unchangedSetting, label: 'Unchanged' },
                      ...efforts.map((option) => ({
                        description: option.description,
                        id: option.reasoningEffort,
                        label: settingLabel(option.reasoningEffort)
                      }))
                    ]}
                    value={effortValue}
                  />
                </SettingRow>
              ) : null}
            </div>
            {tiers.length > 0 ? (
              <div className="mt-5 rounded-[1.75rem] bg-neutral-800/80 px-4">
                <SettingRow label="Speed">
                  <SimpleSettingsSelect
                    ariaLabel="Speed"
                    onChange={(next) => {
                      if (next === standardTier) onServiceTierChange(null);
                      else if (next !== unchangedSetting) onServiceTierChange(next);
                    }}
                    options={[
                      { id: unchangedSetting, label: 'Unchanged' },
                      { id: standardTier, label: 'Standard' },
                      ...tiers.map((tier) => ({
                        description: tier.description,
                        id: tier.id,
                        label: tier.name
                      }))
                    ]}
                    value={tierValue}
                  />
                </SettingRow>
              </div>
            ) : null}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function SettingRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-3 py-2">
      <span className="text-sm font-medium text-neutral-200">{label}</span>
      {children}
    </div>
  );
}

function ModelSelect({
  models,
  onChange,
  value
}: Pick<CodexSessionModelSelection, 'models' | 'onChange' | 'value'>) {
  const selected = models.find((model) => model.model === value);
  return (
    <Select className="min-w-0 max-w-64" onChange={(next) => next && onChange(next)} value={value}>
      <Select.Trigger aria-label="Model" className="h-10 justify-end rounded-full px-2 text-sm font-semibold text-neutral-100 outline-none hover:bg-neutral-700/70 focus-visible:ring-2 focus-visible:ring-neutral-600">
        <span className="min-w-0 truncate">{selected?.displayName ?? value}</span>
        <Select.Indicator className="size-3.5 shrink-0 text-neutral-400" />
      </Select.Trigger>
      <Select.Popover
        className="right-0 left-auto z-[140] w-80 rounded-2xl border border-neutral-700 bg-neutral-900 p-1 shadow-2xl shadow-black/70"
        style={{ bottom: 'calc(100% + 0.5rem)', marginTop: 0, top: 'auto' }}
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

function SimpleSettingsSelect({
  ariaLabel,
  onChange,
  options,
  value
}: {
  ariaLabel: string;
  onChange(value: string): void;
  options: Array<{ description?: string; id: string; label: string }>;
  value: string;
}) {
  const selected = options.find((option) => option.id === value);
  return (
    <Select className="min-w-0 max-w-52" onChange={(next) => next && onChange(next)} value={value}>
      <Select.Trigger aria-label={ariaLabel} className="h-10 justify-end rounded-full px-2 text-sm font-semibold text-neutral-100 outline-none hover:bg-neutral-700/70 focus-visible:ring-2 focus-visible:ring-neutral-600">
        <span className="truncate">{selected?.label ?? value}</span>
        <Select.Indicator className="size-3.5 shrink-0 text-neutral-400" />
      </Select.Trigger>
      <Select.Popover
        className="right-0 left-auto z-[140] w-64 rounded-2xl border border-neutral-700 bg-neutral-900 p-1 shadow-2xl shadow-black/70"
        style={{ bottom: 'calc(100% + 0.5rem)', marginTop: 0, top: 'auto' }}
      >
        <ListBox selectedKeys={new Set([value])}>
          {options.map((option) => (
            <ListBoxItem
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-xs',
                option.id === value
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100'
              )}
              id={option.id}
              key={option.id}
              textValue={option.label}
              title={option.description}
            >
              <span className="flex-1 truncate">{option.label}</span>
              {option.id === value ? <Check className="size-3.5 shrink-0" /> : null}
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function settingLabel(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
