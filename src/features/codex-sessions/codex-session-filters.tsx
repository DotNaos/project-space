import { Search } from 'lucide-react';
import {
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  Text,
  ToggleButton,
  ToggleButtonGroup
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  CodexConnectorFilterOption,
  CodexFilterAvailability,
  CodexMachineFilterOption
} from './codex-session-list-model';

const availabilityLabel: Record<CodexFilterAvailability, string> = {
  checking: 'Checking',
  connected: 'Connected',
  offline: 'Offline',
  unavailable: 'Unavailable'
};

function isConnectorOption(
  option: CodexMachineFilterOption | CodexConnectorFilterOption
): option is CodexConnectorFilterOption {
  return !('connectorIds' in option);
}

function AvailabilityDot({ availability }: { availability: CodexFilterAvailability }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full bg-neutral-600',
        availability === 'checking' && 'animate-pulse bg-sky-400',
        availability === 'connected' && 'bg-emerald-400',
        availability === 'offline' && 'bg-neutral-600',
        availability === 'unavailable' && 'bg-red-400'
      )}
    />
  );
}

function FilterRow<T extends CodexMachineFilterOption | CodexConnectorFilterOption>({
  label,
  onSelectionChange,
  options,
  selectedKey
}: {
  label: string;
  onSelectionChange(key: string): void;
  options: readonly T[];
  selectedKey: string;
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
      <Text className="whitespace-nowrap text-[9px] font-medium uppercase tracking-[0.12em] text-neutral-600">
        {label}
      </Text>
      <div className="min-w-0 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ToggleButtonGroup
          aria-label={`${label} filter`}
          className="min-w-max gap-1.5"
          disallowEmptySelection
          isDetached
          onSelectionChange={(keys) => {
            const key = [...keys][0];
            if (key) onSelectionChange(key);
          }}
          selectedKeys={new Set([selectedKey])}
          selectionMode="single"
          size="sm"
        >
          {options.map((option) => {
            const connector = isConnectorOption(option) ? option : undefined;
            const status = availabilityLabel[option.availability];
            const context = connector?.machineLabel
              ? `${connector.machineLabel}, ${option.label}`
              : option.label;
            return (
              <ToggleButton
                aria-label={`${context}, ${connector?.location ? `${connector.location}, ` : ''}${status}`}
                aria-pressed={selectedKey === option.key}
                className={cn(
                  'h-7 max-w-64 gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 px-2.5 py-0 text-[10px] text-neutral-400',
                  'hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500',
                  selectedKey === option.key && 'border-neutral-600 bg-neutral-800 text-neutral-100'
                )}
                id={option.key}
                key={option.key}
                title={`${context} · ${status}`}
                variant="outline"
              >
                <AvailabilityDot availability={option.availability} />
                {connector?.machineLabel ? (
                  <span className="max-w-24 truncate text-neutral-500">{connector.machineLabel}</span>
                ) : null}
                <span className="max-w-40 truncate">{option.label}</span>
                {connector?.location ? (
                  <span className="text-[9px] text-neutral-600">{connector.location}</span>
                ) : null}
              </ToggleButton>
            );
          })}
        </ToggleButtonGroup>
      </div>
    </div>
  );
}

export function CodexSessionFilters({
  connectorOptions,
  machineOptions,
  onConnectorChange,
  onMachineChange,
  query,
  selectedConnectorKey,
  selectedMachineKey,
  setQuery
}: {
  connectorOptions: readonly CodexConnectorFilterOption[];
  machineOptions: readonly CodexMachineFilterOption[];
  onConnectorChange(key: string): void;
  onMachineChange(key: string): void;
  query: string;
  selectedConnectorKey: string;
  selectedMachineKey: string;
  setQuery(value: string): void;
}) {
  return (
    <div className="mt-3 space-y-1.5">
      <FilterRow
        label="Machines"
        onSelectionChange={onMachineChange}
        options={machineOptions}
        selectedKey={selectedMachineKey}
      />
      <FilterRow
        label="Connectors"
        onSelectionChange={onConnectorChange}
        options={connectorOptions}
        selectedKey={selectedConnectorKey}
      />
      <SearchField
        aria-label="Search Codex tasks"
        className="rounded-lg border border-neutral-800 bg-neutral-900/60"
        onChange={setQuery}
        value={query}
      >
        <SearchFieldGroup className="h-8">
          <Search className="size-3.5 shrink-0 text-neutral-500" />
          <SearchFieldInput
            aria-label="Search by task, project, machine, connector, directory, or model"
            placeholder="Search tasks"
          />
          <SearchFieldClearButton />
        </SearchFieldGroup>
      </SearchField>
    </div>
  );
}
