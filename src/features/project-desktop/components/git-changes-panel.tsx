import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDot, FileDiff, RefreshCw } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitStatusEntry, GitStatusResult } from '@/shared/project-space-api';

function statusLabel(entry: GitStatusEntry) {
  if (entry.displayStatus === '??') {
    return 'untracked';
  }

  if (entry.indexStatus.trim() && entry.worktreeStatus.trim()) {
    return 'staged + modified';
  }

  if (entry.indexStatus.trim()) {
    return 'staged';
  }

  if (entry.worktreeStatus.trim()) {
    return 'modified';
  }

  return entry.displayStatus;
}

function statusTone(entry: GitStatusEntry) {
  if (entry.displayStatus === '??') {
    return 'border-violet-400/25 bg-violet-400/10 text-violet-200';
  }

  if (entry.indexStatus.trim()) {
    return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200';
  }

  return 'border-amber-400/25 bg-amber-400/10 text-amber-200';
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <Text className="block font-mono text-sm text-neutral-200">{value}</Text>
      <Text className="text-[10px] uppercase tracking-[0.14em] text-neutral-600">{label}</Text>
    </div>
  );
}

export function GitChangesPanel({
  isLoading,
  refresh,
  status,
  targetPath
}: {
  isLoading: boolean;
  refresh(): Promise<void>;
  status?: GitStatusResult;
  targetPath: string;
}) {
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState('');
  const [isDiffLoading, setIsDiffLoading] = useState(false);

  const entries = status?.entries ?? [];
  const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? entries[0];
  const summary = {
    changed: entries.length,
    staged: entries.filter((entry) => entry.indexStatus.trim() && entry.indexStatus !== '?')
      .length,
    untracked: entries.filter((entry) => entry.displayStatus === '??').length
  };

  useEffect(() => {
    setSelectedPath((current) => {
      if (entries.some((entry) => entry.path === current)) {
        return current;
      }

      return entries[0]?.path ?? '';
    });
  }, [entries]);

  useEffect(() => {
    if (!targetPath || !selectedEntry) {
      setDiff('');
      return;
    }

    let canceled = false;

    setIsDiffLoading(true);
    projectSpaceClient
      .getGitDiff({
        cwd: targetPath,
        path: selectedEntry.path,
        staged: Boolean(selectedEntry.indexStatus.trim())
      })
      .then((result) => {
        if (!canceled) {
          setDiff(result.diff);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDiff(error instanceof Error ? error.message : 'Could not load diff.');
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsDiffLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [selectedEntry, targetPath]);

  return (
    <Surface
      variant="tertiary"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiff className="size-4 shrink-0 text-neutral-400" />
          <Text className="truncate text-sm font-semibold text-neutral-100">Changes</Text>
          {status?.isRepository ? (
            <Text className="shrink-0 text-xs text-neutral-500">
              {status.branchName}
              {status.upstream ? ` - ${status.upstream}` : ''}
            </Text>
          ) : null}
        </div>
        <Button
          aria-label="Refresh changes"
          size="sm"
          variant="ghost"
          isDisabled={isLoading}
          onPress={() => void refresh()}
        >
          <RefreshCw className={isLoading ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      {!status?.isRepository ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">
          {isLoading ? 'Loading changes...' : 'Selected target is not a git repository.'}
        </Text>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-8 text-center">
          <div>
            <CheckCircle2 className="mx-auto size-8 text-emerald-400/70" />
            <Text className="mt-3 block text-sm font-medium text-neutral-200">
              Working tree clean
            </Text>
            <Text className="mt-1 block text-xs text-neutral-500">
              No staged, modified, or untracked files.
            </Text>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,0.65fr)_minmax(0,1fr)] overflow-hidden">
          <div className="min-h-0 overflow-auto border-r border-neutral-800/70">
            <div className="grid grid-cols-3 gap-2 border-b border-neutral-800/70 px-4 py-3">
              <Stat label="changed" value={summary.changed} />
              <Stat label="staged" value={summary.staged} />
              <Stat label="untracked" value={summary.untracked} />
            </div>
            <div className="p-2">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => setSelectedPath(entry.path)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition',
                    selectedEntry?.path === entry.path
                      ? 'bg-neutral-800/80 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-200'
                  )}
                >
                  <CircleDot className="size-3 shrink-0 text-neutral-600" />
                  <span className="min-w-0 flex-1 truncate text-sm">{entry.path}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]',
                      statusTone(entry)
                    )}
                  >
                    {statusLabel(entry)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 overflow-auto">
            <div className="border-b border-neutral-800/70 px-4 py-3">
              <Text className="block truncate text-sm font-medium text-neutral-200">
                {selectedEntry?.path}
              </Text>
              <Text className="text-xs text-neutral-600">
                {selectedEntry ? statusLabel(selectedEntry) : ''}
              </Text>
            </div>
            <pre className="min-h-full whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-5 text-neutral-300">
              {isDiffLoading ? 'Loading diff...' : diff}
            </pre>
          </div>
        </div>
      )}
    </Surface>
  );
}
