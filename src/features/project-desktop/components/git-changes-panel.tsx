import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  CircleDot,
  FileDiff,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHistoryCommit,
  GitStatusEntry,
  GitStatusResult
} from '@/shared/project-space-api';
import { usePaneResize } from '../hooks/use-pane-resize';
import { DiffFileCard, DiffView, parseUnifiedDiff } from './diff-view';
import { buildGitBranchOptions, type GitBranchOption } from './git-graph-browser';
import { CommitSelect, DiffSourceSelect } from './git-source-selectors';
import { PaneResizeHandle } from './pane-resize-handle';

const BRANCH_SCAN_LIMIT = 300;
const COMMIT_LIST_LIMIT = 150;

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

function useCommitSource(targetPath: string) {
  const [branches, setBranches] = useState<GitBranchOption[]>([]);
  const [branchRef, setBranchRef] = useState('');
  const [commits, setCommits] = useState<GitHistoryCommit[]>([]);
  const [commitHash, setCommitHash] = useState('');
  const [diff, setDiff] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let canceled = false;

    setBranchRef('');
    setCommits([]);
    setCommitHash('');

    if (!targetPath) {
      setBranches([]);
      return;
    }

    projectSpaceClient
      .getGitHistory({ cwd: targetPath, limit: BRANCH_SCAN_LIMIT })
      .then((result) => {
        if (!canceled) {
          setBranches(result.isRepository ? buildGitBranchOptions(result.commits) : []);
        }
      })
      .catch(() => {
        if (!canceled) {
          setBranches([]);
        }
      });

    return () => {
      canceled = true;
    };
  }, [targetPath]);

  useEffect(() => {
    if (!branchRef || !targetPath) {
      setCommits([]);
      setCommitHash('');
      setMessage('');
      return;
    }

    let canceled = false;

    setIsLoading(true);
    setMessage('');
    projectSpaceClient
      .getGitHistory({ cwd: targetPath, limit: COMMIT_LIST_LIMIT, ref: branchRef })
      .then((result) => {
        if (canceled) {
          return;
        }

        setCommits(result.commits);
        setCommitHash(result.commits[0]?.hash ?? '');
        setMessage(result.commits.length === 0 ? result.message ?? 'No commits found.' : '');
      })
      .catch((error) => {
        if (!canceled) {
          setCommits([]);
          setCommitHash('');
          setMessage(error instanceof Error ? error.message : 'Could not load commits.');
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [branchRef, targetPath]);

  useEffect(() => {
    if (!commitHash || !targetPath) {
      setDiff('');
      return;
    }

    let canceled = false;

    setIsLoading(true);
    projectSpaceClient
      .getGitDiff({ commit: commitHash, cwd: targetPath })
      .then((result) => {
        if (!canceled) {
          setDiff(result.diff);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDiff(error instanceof Error ? error.message : 'Could not load the commit diff.');
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [commitHash, targetPath]);

  return {
    branchRef,
    branches,
    commitHash,
    commits,
    diff,
    isLoading,
    message,
    setBranchRef,
    setCommitHash
  };
}

function CommitFileList({
  files,
  onSelect,
  selectedPath
}: {
  files: ReturnType<typeof parseUnifiedDiff>;
  onSelect(path: string): void;
  selectedPath: string;
}) {
  return (
    <div className="p-2">
      <button
        type="button"
        onClick={() => onSelect('')}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition',
          selectedPath === ''
            ? 'bg-neutral-800/80 text-neutral-100'
            : 'text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-200'
        )}
      >
        <FileDiff className="size-3 shrink-0 text-neutral-600" />
        <span className="min-w-0 flex-1 truncate">All files</span>
        <span className="shrink-0 font-mono text-[10px] text-neutral-500">{files.length}</span>
      </button>
      {files.map((file) => {
        const path = file.newPath || file.oldPath;

        return (
          <button
            key={path}
            type="button"
            onClick={() => onSelect(path)}
            className={cn(
              'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition',
              selectedPath === path
                ? 'bg-neutral-800/80 text-neutral-100'
                : 'text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-200'
            )}
          >
            <CircleDot
              className={cn(
                'size-3 shrink-0',
                file.kind === 'added' && 'text-emerald-500',
                file.kind === 'deleted' && 'text-red-500',
                (file.kind === 'modified' || file.kind === 'renamed') && 'text-neutral-600'
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{path}</span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
              {file.additions > 0 ? (
                <span className="text-emerald-400">+{file.additions}</span>
              ) : null}
              {file.deletions > 0 ? <span className="text-red-400">-{file.deletions}</span> : null}
            </span>
          </button>
        );
      })}
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
  const [selectedCommitFile, setSelectedCommitFile] = useState('');
  const [isFileListCollapsed, setIsFileListCollapsed] = useState(false);
  const filesPane = usePaneResize({ axis: 'x', initialSize: 300, maxSize: 560, minSize: 200 });
  const source = useCommitSource(targetPath);
  const isCommitMode = source.branchRef !== '';

  const entries = status?.entries ?? [];
  const selectedEntry = entries.find((entry) => entry.path === selectedPath) ?? entries[0];
  const summary = {
    changed: entries.length,
    staged: entries.filter((entry) => entry.indexStatus.trim() && entry.indexStatus !== '?')
      .length,
    untracked: entries.filter((entry) => entry.displayStatus === '??').length
  };

  const commitFiles = useMemo(() => parseUnifiedDiff(source.diff), [source.diff]);
  const selectedCommit = source.commits.find((commit) => commit.hash === source.commitHash);
  const selectedCommitFileEntry = commitFiles.find(
    (file) => (file.newPath || file.oldPath) === selectedCommitFile
  );

  useEffect(() => {
    setSelectedCommitFile('');
  }, [source.commitHash]);

  useEffect(() => {
    setSelectedPath((current) => {
      if (entries.some((entry) => entry.path === current)) {
        return current;
      }

      return entries[0]?.path ?? '';
    });
  }, [entries]);

  useEffect(() => {
    if (isCommitMode || !targetPath || !selectedEntry) {
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
  }, [isCommitMode, selectedEntry, targetPath]);

  const showWorkingClean = !isCommitMode && entries.length === 0;

  return (
    <Surface
      variant="tertiary"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiff className="size-4 shrink-0 text-neutral-400" />
          <Text className="truncate text-sm font-semibold text-neutral-100">Changes</Text>
          {status?.isRepository && !isCommitMode ? (
            <Text className="shrink-0 text-xs text-neutral-500">
              {status.branchName}
              {status.upstream ? ` - ${status.upstream}` : ''}
            </Text>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <DiffSourceSelect
            branchRef={source.branchRef}
            branches={source.branches}
            onChange={source.setBranchRef}
          />
          {isCommitMode ? (
            <CommitSelect
              commitHash={source.commitHash}
              commits={source.commits}
              onChange={source.setCommitHash}
            />
          ) : null}
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
      </div>

      {!status?.isRepository ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">
          {isLoading ? 'Loading changes...' : 'Selected target is not a git repository.'}
        </Text>
      ) : showWorkingClean ? (
        <div className="flex flex-1 items-center justify-center px-4 py-8 text-center">
          <div>
            <CheckCircle2 className="mx-auto size-8 text-emerald-400/70" />
            <Text className="mt-3 block text-sm font-medium text-neutral-200">
              Working tree clean
            </Text>
            <Text className="mt-1 block text-xs text-neutral-500">
              No staged, modified, or untracked files. Pick a branch above to inspect commits.
            </Text>
          </div>
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 overflow-hidden"
          style={{
            gridTemplateColumns: `${isFileListCollapsed ? 44 : filesPane.size}px minmax(0,1fr)`
          }}
        >
          {isFileListCollapsed ? (
            <div className="flex min-h-0 flex-col items-center gap-2 border-r border-neutral-800/70 py-2">
              <Button
                aria-label="Expand file list"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => setIsFileListCollapsed(false)}
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            </div>
          ) : (
          <div className="relative min-h-0 min-w-0">
            <div className="flex h-full flex-col overflow-hidden border-r border-neutral-800/70">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-800/70 py-1.5 pl-4 pr-1.5">
                <Text className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                  Files
                </Text>
                <Button
                  aria-label="Collapse file list"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() => setIsFileListCollapsed(true)}
                >
                  <PanelLeftClose className="size-3.5" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
              {isCommitMode ? (
                source.message ? (
                  <Text className="block px-4 py-4 text-xs text-neutral-500">{source.message}</Text>
                ) : (
                  <CommitFileList
                    files={commitFiles}
                    onSelect={setSelectedCommitFile}
                    selectedPath={selectedCommitFile}
                  />
                )
              ) : (
                <>
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
                </>
              )}
              </div>
            </div>
            <PaneResizeHandle axis="x" onStart={filesPane.startResize} />
          </div>
          )}

          <div className="flex min-h-0 flex-col">
            <div className="shrink-0 border-b border-neutral-800/70 px-4 py-3">
              {isCommitMode ? (
                <>
                  <Text className="block truncate text-sm font-medium text-neutral-200">
                    {selectedCommitFile || selectedCommit?.subject || 'Select a commit'}
                  </Text>
                  <Text className="text-xs text-neutral-600">
                    {selectedCommit
                      ? `${selectedCommit.hash.slice(0, 10)} · ${selectedCommit.author} · ${selectedCommit.date}`
                      : ''}
                  </Text>
                </>
              ) : (
                <>
                  <Text className="block truncate text-sm font-medium text-neutral-200">
                    {selectedEntry?.path}
                  </Text>
                  <Text className="text-xs text-neutral-600">
                    {selectedEntry ? statusLabel(selectedEntry) : ''}
                  </Text>
                </>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {isCommitMode ? (
                source.isLoading ? (
                  <Text className="block px-4 py-6 text-sm text-neutral-500">Loading diff...</Text>
                ) : selectedCommitFileEntry ? (
                  <div className="p-3">
                    <DiffFileCard file={selectedCommitFileEntry} />
                  </div>
                ) : (
                  <DiffView
                    diff={source.diff}
                    emptyMessage="This commit has no textual changes."
                  />
                )
              ) : isDiffLoading ? (
                <Text className="block px-4 py-6 text-sm text-neutral-500">Loading diff...</Text>
              ) : (
                <DiffView
                  diff={diff}
                  emptyMessage={
                    selectedEntry?.displayStatus === '??'
                      ? 'Untracked file - no diff to show yet.'
                      : 'No diff for this selection.'
                  }
                />
              )}
            </div>
          </div>
        </div>
      )}
    </Surface>
  );
}
