import { useState } from 'react';
import { Dropdown, Popover } from '@heroui/react';
import { Check, ChevronDown, ChevronRight, ChevronUp, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { CodexSessionModelSelection } from './codex-session-model-selection';

export function CodexSessionDesktopModelSelect(
  selection: CodexSessionModelSelection
) {
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<'quick' | 'advanced'>('quick');
  const selected = selection.models.find((model) => model.model === selection.value);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const tiers = selected?.serviceTiers ?? [];
  const fastTier = tiers.find((tier) => tier.id === selection.serviceTier) ?? tiers[0];
  const selectedEffort = selection.effort ?? selected?.defaultReasoningEffort;
  const effortLabel = settingLabel(selection.effort ?? selected?.defaultReasoningEffort);
  const summary = [selected?.displayName ?? selection.value, effortLabel]
    .filter(Boolean)
    .join(' ');

  return (
    <Popover
      isOpen={quickOpen}
      onOpenChange={(open) => {
        setQuickOpen(open);
        if (!open) setSettingsView('quick');
      }}
    >
      <Popover.Trigger
        aria-label="Codex model settings"
        className="flex h-9 max-w-64 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-neutral-300 outline-none transition hover:bg-neutral-800 hover:text-white focus-visible:ring-2 focus-visible:ring-neutral-700"
        data-codex-desktop-model-trigger="true"
      >
        {selection.serviceTier ? <Zap className="size-3.5 shrink-0 fill-current" /> : null}
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0 text-neutral-500" />
      </Popover.Trigger>
      <Popover.Content
        className="w-72 rounded-3xl border border-neutral-700/80 bg-neutral-900/98 p-3 text-neutral-100 shadow-2xl shadow-black/70 backdrop-blur-xl"
        offset={8}
        placement="top start"
      >
        <Popover.Dialog
          aria-label={settingsView === 'quick'
            ? 'Quick Codex settings'
            : 'Advanced Codex settings'}
          className="outline-none"
          data-codex-desktop-model-quick={settingsView === 'quick' || undefined}
          data-codex-desktop-model-settings={settingsView === 'advanced' || undefined}
        >
          {settingsView === 'quick' ? (
            <>
              <div className="flex items-center gap-1">
                <button
                  aria-label="Advanced Codex settings"
                  className="flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 text-xs font-medium text-neutral-200 outline-none transition hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-neutral-600"
                  onClick={() => setSettingsView('advanced')}
                  type="button"
                >
                  <span>Advanced</span>
                  <ChevronRight className="size-3.5 shrink-0 text-neutral-500" />
                </button>
                {fastTier ? (
                  <div className="group relative shrink-0">
                    <button
                      aria-label={selection.serviceTier
                        ? 'Use Standard speed'
                        : 'Use Fast responses'}
                      aria-pressed={Boolean(selection.serviceTier)}
                      className={cn(
                        'flex size-9 cursor-pointer items-center justify-center rounded-xl outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-600',
                        selection.serviceTier
                          ? 'bg-neutral-800 text-blue-500 hover:bg-neutral-700'
                          : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
                      )}
                      onClick={() => selection.onServiceTierChange(
                        selection.serviceTier ? null : fastTier.id
                      )}
                      type="button"
                    >
                      <Zap className={cn(
                        'size-4',
                        selection.serviceTier && 'fill-current'
                      )} />
                    </button>
                    <div
                      className="pointer-events-none absolute bottom-full right-0 z-10 mb-2 min-w-max rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-2 text-left opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      role="tooltip"
                    >
                      <p className="text-xs font-medium text-neutral-100">{fastTier.name}</p>
                      <p className="mt-0.5 text-[11px] text-neutral-400">
                        {fastTier.description ?? 'More usage'}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
              <ReasoningQuickSelect
                onChange={selection.onEffortChange}
                options={efforts}
                value={selectedEffort}
              />
            </>
          ) : (
            <AdvancedSettings
              onCollapse={() => setSettingsView('quick')}
              selection={selection}
            />
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function AdvancedSettings({
  onCollapse,
  selection
}: {
  onCollapse(): void;
  selection: CodexSessionModelSelection;
}) {
  const selected = selection.models.find((model) => model.model === selection.value);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const tiers = selected?.serviceTiers ?? [];

  return (
    <div className="space-y-1">
      <SettingsDropdown
        label="Model"
        onAction={(value) => selection.onChange(value)}
        options={selection.models.map((model) => ({
          description: model.description,
          id: model.model,
          label: model.displayName
        }))}
        value={selection.value}
      />
      {efforts.length ? (
        <SettingsDropdown
          label="Effort"
          onAction={selection.onEffortChange}
          options={efforts.map((effort) => ({
            description: effort.description,
            id: effort.reasoningEffort,
            label: settingLabel(effort.reasoningEffort) ?? effort.reasoningEffort
          }))}
          value={selection.effort}
        />
      ) : null}
      <SettingsDropdown
        label="Speed"
        onAction={(value) => selection.onServiceTierChange(
          value === standardTier ? null : value
        )}
        options={[
          { id: standardTier, label: 'Standard' },
          ...tiers.map((tier) => ({
            description: tier.description,
            id: tier.id,
            label: tier.name
          }))
        ]}
        value={selection.serviceTier ?? standardTier}
      />
      <button
        aria-label="Collapse advanced Codex settings"
        className="mt-2 flex h-9 w-full cursor-pointer items-center justify-between border-t border-neutral-700/70 px-2.5 pt-2 text-xs font-medium text-neutral-400 outline-none transition hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-600"
        onClick={onCollapse}
        type="button"
      >
        <span>Advanced</span>
        <ChevronUp className="size-3.5 shrink-0" />
      </button>
    </div>
  );
}

function ReasoningQuickSelect({
  onChange,
  options,
  value
}: {
  onChange(value: string): void;
  options: Array<{ description?: string; reasoningEffort: string }>;
  value?: string;
}) {
  if (options.length === 0) return null;

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.reasoningEffort === value)
  );
  const lastIndex = options.length - 1;
  const progress = lastIndex === 0 ? 50 : 8 + (selectedIndex / lastIndex) * 84;
  const selectedLabel = settingLabel(options[selectedIndex]?.reasoningEffort)
    ?? options[selectedIndex]?.reasoningEffort
    ?? '';
  const showElevatedFeedback = selectedIndex >= Math.min(2, lastIndex);
  const sparkleCount = showElevatedFeedback
    ? Math.min(reasoningSparkles.length, 3 + selectedIndex)
    : 0;

  return (
    <div
      className="group relative mt-2.5 pt-5"
      data-codex-desktop-reasoning-quick="true"
    >
      <span
        className={cn(
          'pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1 text-[10px] font-semibold leading-none text-neutral-100 shadow-lg transition-[left,opacity,transform] duration-200 ease-out',
          showElevatedFeedback
            ? 'translate-y-0 opacity-100'
            : 'translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100'
        )}
        data-codex-reasoning-label="true"
        style={{ left: `${progress}%` }}
      >
        {selectedLabel}
      </span>
      <div className="relative h-9 overflow-hidden rounded-full bg-neutral-800">
        <div
          className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-blue-600 transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        >
          {reasoningSparkles.slice(0, sparkleCount).map((sparkle) => (
            <span
              aria-hidden="true"
              className="absolute size-1 rounded-full bg-white/85 motion-safe:animate-pulse"
              key={`${sparkle.left}-${sparkle.top}`}
              style={{
                animationDelay: sparkle.delay,
                animationDuration: sparkle.duration,
                left: sparkle.left,
                top: sparkle.top
              }}
            />
          ))}
        </div>
        {options.map((option, index) => (
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 z-[1] size-1 -translate-x-1/2 -translate-y-1/2 rounded-full',
              index <= selectedIndex ? 'bg-blue-200/80' : 'bg-neutral-500'
            )}
            key={option.reasoningEffort}
            style={{ left: `${lastIndex === 0 ? 50 : 8 + (index / lastIndex) * 84}%` }}
          />
        ))}
        <span
          aria-hidden="true"
          className="absolute top-1/2 z-[2] size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-50 shadow-md shadow-black/30 transition-[left] duration-200 ease-out"
          style={{ left: `${progress}%` }}
        />
        <input
          aria-label="Reasoning effort"
          aria-valuetext={selectedLabel}
          className="absolute inset-0 z-[3] size-full cursor-pointer opacity-0"
          max={lastIndex}
          min={0}
          onInput={(event) => {
            const option = options[Number(event.currentTarget.value)];
            if (option) onChange(option.reasoningEffort);
          }}
          step={1}
          type="range"
          value={selectedIndex}
        />
      </div>
    </div>
  );
}

function SettingsDropdown({
  label,
  onAction,
  options,
  value
}: {
  label: string;
  onAction(value: string): void;
  options: Array<{ description?: string; id: string; label: string }>;
  value?: string;
}) {
  const selected = options.find((option) => option.id === value);
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={`${label}: ${selected?.label ?? 'Unchanged'}`}
        className="grid min-h-9 cursor-pointer grid-cols-[4.25rem_minmax(0,1fr)_0.875rem] items-center gap-2 rounded-xl px-3 !text-xs outline-none transition hover:bg-neutral-800/70 data-[focused]:bg-neutral-800"
      >
        <span className="font-medium text-neutral-100">{label}</span>
        <span className="min-w-0 truncate text-right font-normal text-neutral-400">
          {selected?.label ?? 'Unchanged'}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-neutral-500" />
      </Dropdown.Trigger>
      <Dropdown.Popover
        className="w-64 rounded-2xl border border-neutral-700/80 bg-neutral-900/98 p-1.5 text-neutral-100 shadow-2xl shadow-black/70 backdrop-blur-xl"
        offset={8}
        placement="right top"
      >
        <Dropdown.Menu
          aria-label={label}
          className="outline-none"
          onAction={(key) => onAction(String(key))}
        >
          {options.map((option) => (
            <Dropdown.Item
              className="flex min-h-9 cursor-pointer items-center gap-3 rounded-xl px-3 !text-xs !font-medium text-neutral-200 outline-none transition hover:bg-neutral-800/70 data-[focused]:bg-neutral-800"
              id={option.id}
              key={option.id}
              textValue={option.label}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.id === value ? <Check className="size-4 shrink-0" /> : null}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

const standardTier = '__standard__';
const reasoningSparkles = [
  { delay: '0ms', duration: '1800ms', left: '16%', top: '28%' },
  { delay: '420ms', duration: '2200ms', left: '34%', top: '64%' },
  { delay: '760ms', duration: '1900ms', left: '49%', top: '32%' },
  { delay: '160ms', duration: '2400ms', left: '61%', top: '70%' },
  { delay: '980ms', duration: '2100ms', left: '73%', top: '24%' },
  { delay: '560ms', duration: '2300ms', left: '82%', top: '62%' },
  { delay: '1250ms', duration: '2000ms', left: '91%', top: '38%' }
] as const;

function settingLabel(value?: string) {
  if (!value) return undefined;
  if (value === 'xhigh') return 'Extra High';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
