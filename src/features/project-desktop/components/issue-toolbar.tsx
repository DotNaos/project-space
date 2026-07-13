import { Columns3, List, ListChecks, Plus, Search, SlidersHorizontal } from 'lucide-react';
import {
  Button,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text,
  ToggleButton,
  ToggleButtonGroup
} from '@/app/dotnaos-ui';
import type { IssueViewMode } from './issue-board-model';

interface IssueToolbarProps {
  filteredCount: number;
  hasFilter: boolean;
  isCreateDisabled: boolean;
  onCreate(): void;
  onFilter(): void;
  onQueryChange(query: string): void;
  onViewModeChange(viewMode: IssueViewMode): void;
  query: string;
  totalCount: number;
  viewMode: IssueViewMode;
}

function ViewSwitch({
  onViewModeChange,
  viewMode
}: Pick<IssueToolbarProps, 'onViewModeChange' | 'viewMode'>) {
  return (
    <ToggleButtonGroup
      aria-label="Issue view"
      selectedKeys={new Set([viewMode])}
      onSelectionChange={(keys) => {
        const nextMode = Array.from(keys)[0];

        if (nextMode === 'list' || nextMode === 'board') {
          onViewModeChange(nextMode);
        }
      }}
      className="shrink-0 rounded-lg bg-neutral-900/70 p-1"
    >
      <ToggleButton id="list" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
        <List className="size-3.5" />
        List
      </ToggleButton>
      <ToggleButton id="board" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
        <Columns3 className="size-3.5" />
        Board
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

export function IssueToolbar(props: IssueToolbarProps) {
  return (
    <div className="mb-3 flex min-w-0 shrink-0 items-center gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <ListChecks className="size-4 shrink-0 text-neutral-400" />
        <Text className="text-sm font-semibold text-neutral-100">Issues</Text>
        <Text className="rounded-full border border-neutral-800 bg-neutral-900/70 px-2 py-0.5 font-mono text-[11px] tabular-nums text-neutral-400">
          {props.hasFilter ? `${props.filteredCount}/${props.totalCount}` : props.totalCount}
        </Text>
      </div>

      <div className="ml-auto hidden min-w-0 items-center gap-2 sm:flex">
        <SearchField
          aria-label="Search issues"
          value={props.query}
          onChange={props.onQueryChange}
          className="w-56 max-w-full rounded-lg bg-neutral-900/60 transition focus-within:bg-neutral-900 lg:w-72"
        >
          <SearchFieldGroup className="px-2.5 py-1.5">
            <SearchFieldSearchIcon />
            <SearchFieldInput placeholder="Search issues" className="text-sm" />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <Button size="sm" variant="ghost" onPress={props.onFilter}>
          <SlidersHorizontal className="size-4" />
          Filter
        </Button>
        <ViewSwitch viewMode={props.viewMode} onViewModeChange={props.onViewModeChange} />
        <Button
          size="sm"
          variant="secondary"
          isDisabled={props.isCreateDisabled}
          onPress={props.onCreate}
        >
          <Plus className="size-4" />
          New issue
        </Button>
      </div>

      <div className="ml-auto sm:hidden">
        <ViewSwitch viewMode={props.viewMode} onViewModeChange={props.onViewModeChange} />
      </div>
    </div>
  );
}

export function IssueMobileActionBar({
  isCreateDisabled,
  onCreate,
  onFilter,
  onQueryChange,
  query
}: Pick<
  IssueToolbarProps,
  'isCreateDisabled' | 'onCreate' | 'onFilter' | 'onQueryChange' | 'query'
>) {
  return (
    <div className="fixed inset-x-3 bottom-[calc(6.75rem+env(safe-area-inset-bottom))] z-40 sm:hidden">
      <div className="mx-auto flex h-14 max-w-md items-center gap-1.5 rounded-[1.75rem] border border-white/10 bg-neutral-950/90 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <button
          type="button"
          onClick={onFilter}
          aria-label="Filter issues"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-neutral-300 transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
        >
          <SlidersHorizontal className="size-5" />
        </button>
        <label className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
          <Search className="size-4 shrink-0 text-neutral-500" />
          <span className="sr-only">Search issues</span>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="Search Issues"
            enterKeyHint="search"
            className="min-w-0 flex-1 border-0 bg-transparent px-0 text-base text-neutral-100 outline-none placeholder:text-neutral-500"
          />
        </label>
        <button
          type="button"
          onClick={onCreate}
          disabled={isCreateDisabled}
          aria-label="Create issue"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-950 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus className="size-5" />
        </button>
      </div>
    </div>
  );
}
