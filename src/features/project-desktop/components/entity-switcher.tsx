import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';

export interface SwitcherEntry {
  id: string;
  label: string;
  sublabel?: string;
}

interface EntitySwitcherProps {
  ariaLabel: string;
  currentLabel: string;
  entries: SwitcherEntry[];
  onSelect(id: string): void;
  selectedId: string;
}

export function EntitySwitcher({
  ariaLabel,
  currentLabel,
  entries,
  onSelect,
  selectedId
}: EntitySwitcherProps) {
  const [query, setQuery] = useState('');
  const [isMobilePickerOpen, setIsMobilePickerOpen] = useState(false);
  const filteredEntries = useMemo(() => {
    const trimmed = query.trim().toLowerCase();

    if (!trimmed) {
      return entries;
    }

    return entries.filter((entry) =>
      `${entry.label} ${entry.sublabel ?? ''}`.toLowerCase().includes(trimmed)
    );
  }, [entries, query]);

  function selectEntry(entry: SwitcherEntry) {
    if (entry.id !== selectedId) {
      onSelect(entry.id);
    }

    setIsMobilePickerOpen(false);
  }

  function renderEntryList({ mobile }: { mobile: boolean }) {
    if (filteredEntries.length === 0) {
      return (
        <Text className="block px-3 py-2 text-sm text-neutral-500">No matches.</Text>
      );
    }

    return filteredEntries.map((entry) => {
      const isActive = entry.id === selectedId;

      if (mobile) {
        return (
          <button
            key={entry.id}
            type="button"
            data-selected={isActive || undefined}
            onClick={() => selectEntry(entry)}
            className={cn(
              'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-50',
              isActive && 'bg-neutral-800/90 text-neutral-50'
            )}
          >
            <span className="min-w-0 flex-1">
              <Text className="block truncate text-sm font-medium text-current">
                {entry.label}
              </Text>
              {entry.sublabel ? (
                <Text className="block truncate text-xs text-neutral-500">
                  {entry.sublabel}
                </Text>
              ) : null}
            </span>
            <span className="flex w-4 justify-center">
              {isActive ? (
                <Check className="size-3.5 text-neutral-300" strokeWidth={2.2} />
              ) : null}
            </span>
          </button>
        );
      }

      return (
        <DropdownItem
          key={entry.id}
          data-selected={isActive || undefined}
          onPress={() => {
            if (!isActive) {
              onSelect(entry.id);
            }
          }}
          className={cn(
            'rounded-xl px-3 py-2 text-neutral-300 data-[hover=true]:bg-neutral-800/90 data-[hover=true]:text-neutral-50',
            isActive && 'bg-neutral-800/90 text-neutral-50'
          )}
          textValue={entry.label}
        >
          <div className="flex w-full items-center gap-3">
            <div className="min-w-0 flex-1">
              <Text className="block truncate text-sm font-medium text-current">
                {entry.label}
              </Text>
              {entry.sublabel ? (
                <Text className="block truncate text-xs text-neutral-500">
                  {entry.sublabel}
                </Text>
              ) : null}
            </div>
            <span className="flex w-4 justify-center">
              {isActive ? (
                <Check className="size-3.5 text-neutral-300" strokeWidth={2.2} />
              ) : null}
            </span>
          </div>
        </DropdownItem>
      );
    });
  }

  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => {
          setQuery('');
          setIsMobilePickerOpen(true);
        }}
        className="app-no-drag inline-flex h-8 min-w-0 max-w-[13rem] items-center gap-1.5 rounded-lg px-2 text-neutral-300 hover:text-neutral-50 sm:hidden"
      >
        <Text className="min-w-0 truncate text-[15px] font-semibold text-current">
          {currentLabel}
        </Text>
        <ChevronsUpDown className="size-3.5 shrink-0 text-neutral-500" strokeWidth={1.9} />
      </button>

      <span className="hidden sm:inline-flex">
      <Dropdown>
        <DropdownTrigger
          aria-label={ariaLabel}
          className="app-no-drag h-8 min-w-0 max-w-[16rem] gap-1.5 rounded-lg px-2 text-neutral-300 hover:text-neutral-50"
          onClick={() => {
            setQuery('');
            requestAnimationFrame(() => {
              document
                .querySelector('[role="menu"] [data-selected="true"]')
                ?.scrollIntoView({ block: 'center' });
            });
          }}
        >
          <Text className="min-w-0 truncate text-[15px] font-semibold text-current">
            {currentLabel}
          </Text>
          <ChevronsUpDown className="size-3.5 shrink-0 text-neutral-500" strokeWidth={1.9} />
        </DropdownTrigger>
        <DropdownPopover
          offset={6}
          placement="bottom start"
          className="rounded-2xl"
          style={{ minWidth: '18rem', width: '18rem' }}
        >
          <SearchField
            aria-label={`${ariaLabel} search`}
            value={query}
            onChange={setQuery}
            className="border-b border-neutral-800/70 p-1 pb-1.5"
          >
            <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
              <SearchFieldSearchIcon />
              <SearchFieldInput
                autoFocus
                className="text-sm"
                placeholder="Search..."
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && filteredEntries.length > 0) {
                    event.preventDefault();
                    const firstItem = event.currentTarget
                      .closest('[role="dialog"], .absolute')
                      ?.querySelector<HTMLButtonElement>('[role="menuitem"]');

                    firstItem?.click();
                  }
                }}
              />
              <SearchFieldClearButton />
            </SearchFieldGroup>
          </SearchField>
          <DropdownMenu
            aria-label={ariaLabel}
            className="max-h-[50vh] w-full overflow-y-auto p-1"
          >
            {renderEntryList({ mobile: false })}
          </DropdownMenu>
        </DropdownPopover>
      </Dropdown>
      </span>

      {isMobilePickerOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-end bg-black/70 px-3 py-4 sm:hidden"
          onClick={() => setIsMobilePickerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            className="flex max-h-[min(36rem,calc(100vh-2rem))] w-full flex-col rounded-t-2xl border border-neutral-800 bg-neutral-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-neutral-900 px-4 py-3">
              <div className="min-w-0">
                <Text className="block truncate text-sm font-semibold text-neutral-100">
                  {ariaLabel}
                </Text>
                <Text className="mt-0.5 block truncate text-xs text-neutral-500">
                  {currentLabel}
                </Text>
              </div>
              <button
                type="button"
                aria-label="Close switcher"
                onClick={() => setIsMobilePickerOpen(false)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
              >
                <X className="size-4" />
              </button>
            </div>
            <SearchField
              aria-label={`${ariaLabel} search`}
              value={query}
              onChange={setQuery}
              className="border-b border-neutral-900 p-3"
            >
              <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
                <SearchFieldSearchIcon />
                <SearchFieldInput
                  autoFocus
                  placeholder="Search..."
                  spellCheck={false}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && filteredEntries[0]) {
                      event.preventDefault();
                      selectEntry(filteredEntries[0]);
                    }
                  }}
                />
                <SearchFieldClearButton />
              </SearchFieldGroup>
            </SearchField>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {renderEntryList({ mobile: true })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
