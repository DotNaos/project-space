import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Chip,
  ScrollShadow,
  Surface,
  Tab,
  TabIndicator,
  TabList,
  TabSeparator,
  Tabs,
  Text
} from '@/lib/heroui-compat';
import { Bot, Check, GitBranch, Play, RefreshCw, Terminal } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  CodexStatusResult,
  GitActionResult,
  GitDiffResult,
  GitStatusEntry,
  GitStatusResult,
  TerminalCommandResult
} from '@/shared/project-space-api';
import { cn } from '@/lib/utils';

type WorkspaceToolView = 'terminal' | 'git' | 'codex';

interface ProjectWorkspaceToolsProps {
  targetPath: string;
}

const defaultGitStatus: GitStatusResult = {
  branchName: '',
  entries: [],
  isRepository: false,
  repositoryRoot: '',
  summary: {
    changed: 0,
    staged: 0,
    untracked: 0
  }
};

function commandOutput(result?: TerminalCommandResult) {
  if (!result) {
    return 'Run a command to see output here.';
  }

  return [
    `$ ${result.command}`,
    result.stdout.trim(),
    result.stderr.trim(),
    '',
    `exit ${result.exitCode ?? 'unknown'} in ${result.durationMs}ms`
  ]
    .filter(Boolean)
    .join('\n');
}

function formatGitAction(action?: GitActionResult) {
  if (!action) {
    return '';
  }

  return [action.message, action.stdout?.trim(), action.stderr?.trim()].filter(Boolean).join('\n');
}

function statusTone(entry: GitStatusEntry) {
  if (entry.displayStatus === '??') {
    return 'text-sky-300';
  }

  if (entry.indexStatus.trim()) {
    return 'text-emerald-300';
  }

  return 'text-amber-300';
}

function TerminalPanel({ targetPath }: ProjectWorkspaceToolsProps) {
  const [command, setCommand] = useState('pwd && git status --short');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<TerminalCommandResult>();

  async function runCommand() {
    if (!targetPath || !command.trim()) {
      return;
    }

    setIsRunning(true);
    try {
      setResult(
        await projectSpaceClient.runTerminalCommand({
          command,
          cwd: targetPath
        })
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="grid min-h-0 gap-3">
      <div className="flex min-w-0 gap-2">
        <input
          value={command}
          onChange={(event) => {
            setCommand(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void runCommand();
            }
          }}
          className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 font-mono text-sm text-slate-100 outline-none transition focus:border-slate-500"
        />
        <Button
          variant="secondary"
          isDisabled={!targetPath || isRunning}
          onPress={() => {
            void runCommand();
          }}
        >
          <Play className="size-4" />
          Run
        </Button>
      </div>
      <pre className="min-h-[190px] overflow-auto rounded-lg border border-slate-800 bg-black/40 p-3 font-mono text-xs leading-5 text-slate-200">
        {commandOutput(result)}
      </pre>
    </div>
  );
}

function GitFileRow({
  entry,
  isSelected,
  onSelect
}: {
  entry: GitStatusEntry;
  isSelected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'grid w-full grid-cols-[3rem_minmax(0,1fr)] items-center rounded-md px-2 py-1.5 text-left font-mono text-xs transition',
        isSelected ? 'bg-slate-700/70 text-slate-50' : 'text-slate-300 hover:bg-slate-800/80'
      )}
    >
      <span className={cn('font-semibold', statusTone(entry))}>{entry.displayStatus}</span>
      <span className="truncate">{entry.path}</span>
    </button>
  );
}

function GitPanel({ targetPath }: ProjectWorkspaceToolsProps) {
  const [status, setStatus] = useState<GitStatusResult>(defaultGitStatus);
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState<GitDiffResult>();
  const [commitMessage, setCommitMessage] = useState('');
  const [actionResult, setActionResult] = useState<GitActionResult>();
  const [isBusy, setIsBusy] = useState(false);

  async function refresh(nextSelectedPath = selectedPath) {
    if (!targetPath) {
      setStatus(defaultGitStatus);
      return;
    }

    const nextStatus = await projectSpaceClient.getGitStatus(targetPath);
    setStatus(nextStatus);

    const availablePath =
      nextSelectedPath && nextStatus.entries.some((entry) => entry.path === nextSelectedPath)
        ? nextSelectedPath
        : nextStatus.entries[0]?.path ?? '';

    setSelectedPath(availablePath);

    if (availablePath) {
      setDiff(
        await projectSpaceClient.getGitDiff({
          cwd: targetPath,
          path: availablePath
        })
      );
    } else {
      setDiff(undefined);
    }
  }

  useEffect(() => {
    void refresh('');
  }, [targetPath]);

  async function runGitAction(action: 'stage' | 'unstage' | 'commit') {
    setIsBusy(true);
    try {
      const paths = selectedPath ? [selectedPath] : [];
      const result =
        action === 'stage'
          ? await projectSpaceClient.stageGitPaths({ cwd: targetPath, paths })
          : action === 'unstage'
            ? await projectSpaceClient.unstageGitPaths({ cwd: targetPath, paths })
            : await projectSpaceClient.commitGitChanges({
                cwd: targetPath,
                message: commitMessage
              });

      setActionResult(result);
      await refresh(selectedPath);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="grid min-h-0 gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Surface variant="secondary" className="min-h-0 rounded-lg border border-slate-800 bg-slate-950/40">
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <div className="min-w-0">
            <Text className="truncate text-sm font-semibold text-slate-100">
              {status.isRepository ? status.branchName : 'No repository'}
            </Text>
            <Text className="truncate text-xs text-slate-500">
              {status.isRepository ? status.repositoryRoot : targetPath}
            </Text>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              void refresh();
            }}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
        <div className="flex gap-2 px-3 py-2">
          <Chip size="sm" variant="secondary">
            {status.summary.changed} changed
          </Chip>
          <Chip size="sm" variant="secondary">
            {status.summary.staged} staged
          </Chip>
        </div>
        <ScrollShadow className="max-h-[250px] px-2 pb-2" hideScrollBar>
          {status.entries.length > 0 ? (
            status.entries.map((entry) => (
              <GitFileRow
                key={`${entry.displayStatus}:${entry.path}`}
                entry={entry}
                isSelected={entry.path === selectedPath}
                onSelect={() => {
                  setSelectedPath(entry.path);
                  void projectSpaceClient
                    .getGitDiff({ cwd: targetPath, path: entry.path })
                    .then(setDiff);
                }}
              />
            ))
          ) : (
            <Text className="px-2 py-4 text-sm text-slate-500">
              {status.isRepository ? 'Working tree is clean.' : 'Select a git repository.'}
            </Text>
          )}
        </ScrollShadow>
      </Surface>

      <div className="grid min-h-0 gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!status.isRepository || isBusy}
            onPress={() => {
              void runGitAction('stage');
            }}
          >
            Stage
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={!status.isRepository || isBusy}
            onPress={() => {
              void runGitAction('unstage');
            }}
          >
            Unstage
          </Button>
          <input
            value={commitMessage}
            placeholder="Commit message"
            onChange={(event) => {
              setCommitMessage(event.target.value);
            }}
            className="min-w-56 flex-1 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-slate-500"
          />
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!status.isRepository || !commitMessage.trim() || isBusy}
            onPress={() => {
              void runGitAction('commit');
            }}
          >
            <Check className="size-4" />
            Commit
          </Button>
        </div>
        {actionResult ? (
          <pre className="max-h-20 overflow-auto rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-300">
            {formatGitAction(actionResult)}
          </pre>
        ) : null}
        <pre className="min-h-[210px] overflow-auto rounded-lg border border-slate-800 bg-black/40 p-3 font-mono text-xs leading-5 text-slate-200">
          {diff?.diff ?? 'Select a changed file to inspect its diff.'}
        </pre>
      </div>
    </div>
  );
}

function CodexPanel({ targetPath }: ProjectWorkspaceToolsProps) {
  const [status, setStatus] = useState<CodexStatusResult>();
  const [message, setMessage] = useState('');

  async function refresh() {
    setStatus(await projectSpaceClient.getCodexStatus());
  }

  useEffect(() => {
    void refresh();
  }, []);

  const rows = useMemo(
    () => [
      ['CLI', status?.cliAvailable ? status.cliPath : 'Not found'],
      ['App', status?.appInstalled ? status.appPath : 'Not found'],
      ['App server', status?.appServerOrigin ?? 'No server URL configured'],
      ['Skills', status?.skillsPath],
      ['Config', status?.configPath],
      ['Thread', status?.currentThreadId ?? 'No active thread id']
    ],
    [status]
  );

  async function openCodex() {
    const result = await projectSpaceClient.openCodexTarget({ cwd: targetPath });
    setMessage(result.status === 'error' ? result.message ?? 'Could not open Codex.' : 'Opened Codex target.');
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <Surface
            key={label}
            variant="secondary"
            className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
          >
            <Text className="block text-[11px] uppercase tracking-[0.16em] text-slate-500">
              {label}
            </Text>
            <Text className="block truncate pt-1 text-sm text-slate-200">{value}</Text>
          </Surface>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isDisabled={!targetPath} onPress={() => void openCodex()}>
          <Bot className="size-4" />
          Open Codex
        </Button>
        <Button variant="outline" onPress={() => void refresh()}>
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>
      {message ? (
        <Text className="text-sm text-slate-400">{message}</Text>
      ) : null}
    </div>
  );
}

export function ProjectWorkspaceTools({ targetPath }: ProjectWorkspaceToolsProps) {
  const [view, setView] = useState<WorkspaceToolView>('terminal');
  const items: Array<{
    icon: typeof Terminal;
    label: string;
    value: WorkspaceToolView;
  }> = [
    { icon: Terminal, label: 'Terminal', value: 'terminal' },
    { icon: GitBranch, label: 'Git', value: 'git' },
    { icon: Bot, label: 'Codex', value: 'codex' }
  ];

  return (
    <Surface
      variant="secondary"
      className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-slate-950/55"
    >
      <div className="border-b border-slate-800 px-3 py-2">
        <Tabs
          selectedKey={view}
          variant="primary"
          onSelectionChange={(key) => {
            if (key === 'terminal' || key === 'git' || key === 'codex') {
              setView(key);
            }
          }}
        >
          <TabList className="grid max-w-md grid-cols-3">
            {items.map((item) => {
              const Icon = item.icon;

              return (
                <Tab key={item.value} id={item.value} className="gap-2 text-xs">
                  <TabSeparator />
                  <Icon className="size-4" />
                  {item.label}
                  <TabIndicator />
                </Tab>
              );
            })}
          </TabList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 p-3">
        {view === 'terminal' ? <TerminalPanel targetPath={targetPath} /> : null}
        {view === 'git' ? <GitPanel targetPath={targetPath} /> : null}
        {view === 'codex' ? <CodexPanel targetPath={targetPath} /> : null}
      </div>
    </Surface>
  );
}
