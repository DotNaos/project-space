import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  GitBranch,
  GitCommitHorizontal,
  MinusCircle,
  PlusCircle,
  RefreshCw,
  Upload
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitStatusEntry, MachineRecord, ProjectWorktreeRecord } from '@/shared/project-space-api';

interface WorktreeGitStatus {
  branchName: string;
  entries: GitStatusEntry[];
  isRepository: boolean;
  message?: string;
  repositoryRoot: string;
  upstream?: string;
}

export interface WorktreeGitStatusSnapshot {
  entries: GitStatusEntry[];
  isRepository: boolean;
  repositoryRoot: string;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function compactHomePath(path: string | undefined) {
  if (!path) {
    return '';
  }

  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function createStatusCommand(cwd: string) {
  return [
    `cd ${shellQuote(cwd)}`,
    'root="$(git rev-parse --show-toplevel 2>/dev/null)" || { printf "__PS_ERROR__\\tSelected worktree is not a Git repository.\\n"; exit 0; }',
    'cd "$root"',
    'branch="$(git branch --show-current 2>/dev/null || true)"',
    'upstream="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)"',
    'printf "__PS_META__\\t%s\\t%s\\t%s\\n" "$root" "$branch" "$upstream"',
    'git status --porcelain=v1'
  ].join('\n');
}

function createStageCommand(cwd: string, paths: string[]) {
  const pathArgs = paths.map(shellQuote);

  return [
    `cd ${shellQuote(cwd)}`,
    paths.length > 0 ? `git add -- ${pathArgs.join(' ')}` : 'git add -A'
  ].join('\n');
}

function createUnstageCommand(cwd: string, paths: string[]) {
  const pathArgs = paths.map(shellQuote);

  return [
    `cd ${shellQuote(cwd)}`,
    paths.length > 0 ? `git restore --staged -- ${pathArgs.join(' ')}` : 'git restore --staged .'
  ].join('\n');
}

function createCommitCommand(cwd: string, message: string) {
  return [`cd ${shellQuote(cwd)}`, `git commit -m ${shellQuote(message.trim())}`].join('\n');
}

function createPushCommand(cwd: string) {
  return [
    `cd ${shellQuote(cwd)}`,
    'branch="$(git branch --show-current)"',
    'if [ -z "$branch" ]; then echo "Cannot push a detached HEAD."; exit 1; fi',
    'if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then',
    '  git push',
    'else',
    '  git push -u origin "$branch"',
    'fi'
  ].join('\n');
}

function parseStatusOutput(stdout: string, fallbackPath: string): WorktreeGitStatus {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const errorLine = lines.find((line) => line.startsWith('__PS_ERROR__\t'));

  if (errorLine) {
    return {
      branchName: '',
      entries: [],
      isRepository: false,
      message: errorLine.split('\t').slice(1).join('\t'),
      repositoryRoot: fallbackPath
    };
  }

  const meta = lines.find((line) => line.startsWith('__PS_META__\t'));
  const [, repositoryRoot = fallbackPath, branchName = '', upstream = ''] = meta?.split('\t') ?? [];
  const entries = lines
    .filter((line) => !line.startsWith('__PS_META__\t'))
    .map((line) => {
      if (line.length < 4) {
        return null;
      }

      const indexStatus = line[0] ?? ' ';
      const worktreeStatus = line[1] ?? ' ';
      const path = line.slice(3).replace(/^"|"$/g, '');

      return {
        displayStatus: `${indexStatus}${worktreeStatus}`.trim() || 'clean',
        indexStatus,
        path,
        worktreeStatus
      };
    })
    .filter((entry): entry is GitStatusEntry => Boolean(entry));

  return {
    branchName: branchName || 'detached',
    entries,
    isRepository: Boolean(meta),
    repositoryRoot,
    upstream: upstream || undefined
  };
}

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

function isStaged(entry: GitStatusEntry) {
  return Boolean(entry.indexStatus.trim() && entry.indexStatus !== '?');
}

function canStage(entry: GitStatusEntry) {
  return entry.displayStatus === '??' || Boolean(entry.worktreeStatus.trim());
}

function StatusBadge({ entry }: { entry: GitStatusEntry }) {
  const staged = isStaged(entry);
  const untracked = entry.displayStatus === '??';

  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        untracked
          ? 'border-violet-400/25 bg-violet-400/10 text-violet-200'
          : staged
            ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
            : 'border-amber-400/25 bg-amber-400/10 text-amber-200'
      )}
    >
      {statusLabel(entry)}
    </span>
  );
}

export function WorktreeGitClientPanel({
  machine,
  onStatusChange,
  worktree
}: {
  machine?: MachineRecord;
  onStatusChange?(status?: WorktreeGitStatusSnapshot): void;
  worktree?: ProjectWorktreeRecord;
}) {
  const [status, setStatus] = useState<WorktreeGitStatus>();
  const [message, setMessage] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const targetPath = worktree?.path ?? '';
  const canRun = Boolean(
    machine && (machine.connector.status === 'local' || machine.connector.status === 'online')
  );

  const summary = useMemo(() => {
    const entries = status?.entries ?? [];

    return {
      changed: entries.length,
      staged: entries.filter(isStaged).length,
      unstaged: entries.filter(canStage).length
    };
  }, [status?.entries]);

  async function refreshStatus() {
    if (!machine || !targetPath || !canRun) {
      setStatus(undefined);
      onStatusChange?.(undefined);
      return;
    }

    setIsLoading(true);
    setMessage('');

    try {
      const result = await projectSpaceClient.runMachineTerminalCommand({
        command: createStatusCommand(targetPath),
        machineId: machine.id
      });

      if (result.exitCode !== 0) {
        const nextStatus = {
          branchName: '',
          entries: [],
          isRepository: false,
          message: result.stderr || result.stdout || 'Could not read Git status.',
          repositoryRoot: targetPath
        };
        setStatus(nextStatus);
        onStatusChange?.(nextStatus);
        return;
      }

      const nextStatus = parseStatusOutput(result.stdout, targetPath);
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
    } catch (error) {
      const nextStatus = {
        branchName: '',
        entries: [],
        isRepository: false,
        message: error instanceof Error ? error.message : 'Could not read Git status.',
        repositoryRoot: targetPath
      };
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine?.id, machine?.connector.status, targetPath]);

  async function runGitAction(action: string, command: string, successMessage: string) {
    if (!machine || !targetPath || !canRun) {
      return;
    }

    setBusyAction(action);
    setMessage('');

    try {
      const result = await projectSpaceClient.runMachineTerminalCommand({
        command,
        machineId: machine.id
      });

      if (result.exitCode !== 0) {
        setMessage(result.stderr || result.stdout || `${action} failed.`);
        return;
      }

      setMessage(successMessage);
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${action} failed.`);
    } finally {
      setBusyAction('');
    }
  }

  const isBusy = Boolean(busyAction);
  const entries = status?.entries ?? [];

  return (
    <Surface
      variant="tertiary"
      className="flex min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950/45"
    >
      <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <GitBranch className="size-4 shrink-0 text-neutral-400" />
            <Text className="shrink-0 text-sm font-semibold text-neutral-100">Git client</Text>
            {status?.branchName ? (
              <Chip
                size="sm"
                className="min-w-0 rounded-full bg-neutral-800 px-2 py-0.5 text-neutral-300"
              >
                <span className="truncate">{status.branchName}</span>
              </Chip>
            ) : null}
          </div>
          <Text className="mt-1 block truncate text-xs text-neutral-500">
            {status?.repositoryRoot ? compactHomePath(status.repositoryRoot) : compactHomePath(targetPath)}
            {status?.upstream ? ` -> ${status.upstream}` : ''}
          </Text>
        </div>
        <Button
          aria-label="Refresh Git status"
          isDisabled={isLoading || isBusy || !canRun || !targetPath}
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={() => void refreshStatus()}
        >
          <RefreshCw className={isLoading ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      {!targetPath ? (
        <Text className="px-4 py-4 text-sm text-neutral-500">Select a worktree first.</Text>
      ) : !canRun ? (
        <Text className="px-4 py-4 text-sm text-neutral-500">
          {machine ? `${machine.name} is ${machine.connector.status}.` : 'Select a machine first.'}
        </Text>
      ) : !status?.isRepository ? (
        <Text className="px-4 py-4 text-sm text-neutral-500">
          {isLoading ? 'Loading Git status...' : status?.message ?? 'This worktree is not a Git repository.'}
        </Text>
      ) : entries.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-4">
          <CheckCircle2 className="size-5 shrink-0 text-emerald-400/80" />
          <div>
            <Text className="block text-sm font-medium text-neutral-200">Working tree clean</Text>
            <Text className="text-xs text-neutral-500">Nothing to stage or commit.</Text>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 border-b border-neutral-800/70 px-4 py-3">
            <div>
              <Text className="block font-mono text-sm text-neutral-200">{summary.changed}</Text>
              <Text className="text-[10px] uppercase tracking-[0.14em] text-neutral-600">changed</Text>
            </div>
            <div>
              <Text className="block font-mono text-sm text-neutral-200">{summary.staged}</Text>
              <Text className="text-[10px] uppercase tracking-[0.14em] text-neutral-600">staged</Text>
            </div>
            <div>
              <Text className="block font-mono text-sm text-neutral-200">{summary.unstaged}</Text>
              <Text className="text-[10px] uppercase tracking-[0.14em] text-neutral-600">unstaged</Text>
            </div>
          </div>
          <div className="min-h-0 max-h-72 overflow-auto p-2">
            {entries.map((entry) => (
              <div
                key={`${entry.displayStatus}:${entry.path}`}
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm text-neutral-300"
              >
                <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                <StatusBadge entry={entry} />
                {canStage(entry) ? (
                  <Button
                    aria-label={`Stage ${entry.path}`}
                    isDisabled={isBusy}
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      void runGitAction(
                        'Stage',
                        createStageCommand(targetPath, [entry.path]),
                        `Staged ${entry.path}.`
                      )
                    }
                  >
                    <PlusCircle className="size-3.5" />
                  </Button>
                ) : null}
                {isStaged(entry) ? (
                  <Button
                    aria-label={`Unstage ${entry.path}`}
                    isDisabled={isBusy}
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      void runGitAction(
                        'Unstage',
                        createUnstageCommand(targetPath, [entry.path]),
                        `Unstaged ${entry.path}.`
                      )
                    }
                  >
                    <MinusCircle className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-neutral-800/70 px-4 py-3">
            <Button
              isDisabled={isBusy || summary.unstaged === 0}
              size="sm"
              variant="outline"
              onPress={() =>
                void runGitAction('Stage all', createStageCommand(targetPath, []), 'Staged all changes.')
              }
            >
              <PlusCircle className="size-3.5" />
              Stage all
            </Button>
            <Button
              isDisabled={isBusy || summary.staged === 0}
              size="sm"
              variant="outline"
              onPress={() =>
                void runGitAction(
                  'Unstage all',
                  createUnstageCommand(targetPath, []),
                  'Unstaged all changes.'
                )
              }
            >
              <MinusCircle className="size-3.5" />
              Unstage all
            </Button>
          </div>
        </>
      )}

      <div className="border-t border-neutral-800 px-4 py-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-600">
            Commit message
          </span>
          <textarea
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.currentTarget.value)}
            placeholder="Describe the change"
            className="mt-2 min-h-20 w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-base text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {message ? (
              <Text
                className={cn(
                  'block text-xs',
                  /failed|error|cannot/i.test(message) ? 'text-red-300' : 'text-neutral-500'
                )}
              >
                {message}
              </Text>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              isDisabled={isBusy || summary.staged === 0 || commitMessage.trim().length === 0}
              size="sm"
              variant="secondary"
              onPress={() =>
                void runGitAction(
                  'Commit',
                  createCommitCommand(targetPath, commitMessage),
                  'Created commit.'
                ).then(() => setCommitMessage(''))
              }
            >
              <GitCommitHorizontal className="size-3.5" />
              Commit
            </Button>
            <Button
              isDisabled={isBusy || !status?.isRepository || !status.branchName || status.branchName === 'detached'}
              size="sm"
              variant="primary"
              onPress={() => {
                if (
                  window.confirm(
                    `Push ${status?.branchName ?? 'this branch'} from ${machine?.name ?? 'this machine'}?`
                  )
                ) {
                  void runGitAction('Push', createPushCommand(targetPath), 'Pushed branch.');
                }
              }}
            >
              <Upload className="size-3.5" />
              Push
            </Button>
          </div>
        </div>
      </div>
    </Surface>
  );
}
