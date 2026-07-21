import { useMemo, useState } from 'react';
import { Label, SearchField } from '@heroui/react';
import { CircleCheck, CircleDot, Hash, RefreshCw } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import { filterRoadmapIssues } from './roadmap-issue-picker-model';

export function RoadmapIssuePicker({
  error,
  excludedNumbers = new Set<number>(),
  isDisabled = false,
  isLoading,
  issues,
  onSelect,
  onUseExactNumber,
  title = 'Find an existing issue'
}: {
  error?: string;
  excludedNumbers?: ReadonlySet<number>;
  isDisabled?: boolean;
  isLoading?: boolean;
  issues: readonly GitHubIssueRecord[];
  onSelect(issue: GitHubIssueRecord): void;
  onUseExactNumber?(issueNumber: number): void;
  title?: string;
}) {
  const [query, setQuery] = useState('');
  const [exactNumber, setExactNumber] = useState('');
  const matches = useMemo(() => filterRoadmapIssues(issues, query, excludedNumbers), [
    excludedNumbers,
    issues,
    query
  ]);
  return (
    <div className="grid min-w-0 gap-3">
      <SearchField fullWidth isDisabled={isDisabled} name="roadmap-issue-search" onChange={setQuery} value={query} variant="secondary">
        <Label className="text-xs font-medium text-neutral-300">{title}</Label>
        <SearchField.Group className="border-neutral-700 bg-neutral-950">
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Search by title, label, or number" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-950/55 p-1">
        {matches.map((issue) => (
          <button
            className="flex min-h-12 w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-neutral-800/80 focus-visible:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-300"
            key={issue.number}
            disabled={isDisabled}
            onClick={() => onSelect(issue)}
            type="button"
          >
            {issue.state === 'closed'
              ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-neutral-500" />
              : <CircleDot className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <Text className="shrink-0 font-mono text-[11px] text-neutral-500">#{issue.number}</Text>
                <Text className="line-clamp-2 text-xs font-medium leading-4 text-neutral-100">
                  {issue.title}
                </Text>
              </span>
              {issue.labels.length > 0 ? (
                <Text className="mt-1 block truncate text-[10px] text-neutral-500">
                  {issue.labels.slice(0, 4).join(' · ')}
                </Text>
              ) : null}
            </span>
          </button>
        ))}
        {!isLoading && matches.length === 0 ? (
          <Text className="block px-3 py-5 text-center text-xs text-neutral-500">
            {query ? 'No matching unplanned issues.' : 'No issues are available to add.'}
          </Text>
        ) : null}
        {isLoading ? (
          <span className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-neutral-500">
            <RefreshCw className="size-3.5 animate-spin" /> Loading issues…
          </span>
        ) : null}
      </div>
      {error ? <Text role="alert" className="text-xs text-rose-300">{error}</Text> : null}
      {onUseExactNumber ? (
        <form
          className="flex min-w-0 items-end gap-2 border-t border-neutral-800 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(exactNumber);
            if (Number.isSafeInteger(value) && value > 0) onUseExactNumber(value);
          }}
        >
          <label className="grid min-w-0 flex-1 gap-1 text-[11px] text-neutral-400">
            Use an exact issue number
            <span className="flex min-h-10 items-center rounded-lg border border-neutral-700 bg-neutral-950 px-3">
              <Hash className="size-3.5 text-neutral-500" />
              <input
                className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none"
                disabled={isDisabled}
                min="1"
                onChange={(event) => setExactNumber(event.target.value)}
                placeholder="273"
                type="number"
                value={exactNumber}
              />
            </span>
          </label>
          <Button isDisabled={isDisabled || !exactNumber} type="submit" variant="secondary">Use</Button>
        </form>
      ) : null}
    </div>
  );
}
