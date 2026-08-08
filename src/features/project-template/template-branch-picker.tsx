import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, GitBranch } from 'lucide-react';
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
import type { GitHubBranchRecord } from '@/shared/project-space-api';

export function TemplateBranchPicker({
  branches,
  isDisabled = false,
  onSelect,
  selected
}: {
  branches: readonly GitHubBranchRecord[];
  isDisabled?: boolean;
  onSelect(name: string): void;
  selected: string;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return branches.filter((branch) => !normalized || branch.name.toLowerCase().includes(normalized));
  }, [branches, query]);

  return (
    <Dropdown>
      <DropdownTrigger
        aria-label="Branch"
        className="h-9 min-w-0 max-w-full gap-2 rounded-full border-neutral-800 bg-neutral-900/80 px-3 text-neutral-200 hover:bg-neutral-900"
        isDisabled={isDisabled}
        onClick={() => setQuery('')}
      >
        <GitBranch className="size-3.5 shrink-0 text-neutral-500" />
        <Text className="min-w-0 truncate text-sm font-medium text-current">{selected}</Text>
        <ChevronsUpDown className="size-3.5 shrink-0 text-neutral-500" strokeWidth={1.9} />
      </DropdownTrigger>
      <DropdownPopover
        className="left-0 right-auto rounded-2xl"
        offset={6}
        style={{ minWidth: '20rem', width: '20rem' }}
      >
        <SearchField
          aria-label="Search branches"
          className="border-b border-neutral-800/70 p-1 pb-1.5"
          onChange={setQuery}
          value={query}
        >
          <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
            <SearchFieldSearchIcon />
            <SearchFieldInput autoFocus className="text-sm" placeholder="Search branches" spellCheck={false} />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <DropdownMenu aria-label="Branches" className="max-h-[50vh] w-full overflow-y-auto p-1">
          {visible.length === 0 ? (
            <Text className="block px-3 py-2 text-sm text-neutral-600">No branch matches.</Text>
          ) : (
            visible.map((branch) => {
              const isActive = branch.name === selected;
              return (
                <DropdownItem
                  className={cn(
                    'rounded-xl px-3 py-2 text-neutral-300',
                    isActive && 'bg-neutral-800/90 text-neutral-50'
                  )}
                  key={branch.name}
                  onPress={() => {
                    if (!isActive) onSelect(branch.name);
                  }}
                  textValue={branch.name}
                >
                  <span className="flex w-full items-center gap-2">
                    <GitBranch className="size-3.5 shrink-0 text-neutral-600" />
                    <span className="min-w-0 flex-1 truncate text-sm">{branch.name}</span>
                    {branch.isDefault ? (
                      <span className="shrink-0 text-[11px] text-neutral-600">default</span>
                    ) : null}
                    <span className="flex w-4 shrink-0 justify-center">
                      {isActive ? <Check className="size-3.5" strokeWidth={2.2} /> : null}
                    </span>
                  </span>
                </DropdownItem>
              );
            })
          )}
        </DropdownMenu>
      </DropdownPopover>
    </Dropdown>
  );
}
