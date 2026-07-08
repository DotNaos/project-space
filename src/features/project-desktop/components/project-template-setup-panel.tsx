import { useEffect, useMemo, useState } from 'react';
import { FileCheck2, GitBranch, Play, RefreshCw, Server } from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  MachineRecord,
  ProjectCliCommand,
  ProjectCliCommandResult,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import { TemplateSelectMenu } from './template-select-menu';

interface ProjectTemplateSetupPanelProps {
  connectorOverview: ConnectorOverviewResult;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onTemplateRelativePathChange(relativePath: string): void;
  onTemplateChanged(): void;
  preferredMachineId?: string;
  project: ProjectSpaceRecord;
  relativePath: string;
  resolvedTargetPath: string;
  selectedExplorerTarget: ExplorerTarget;
  showMachineSelector?: boolean;
  targetRootPath: string;
  worktrees: ProjectWorktreeRecord[];
}

function commandOutput(result?: ProjectCliCommandResult) {
  if (!result) {
    return '';
  }

  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n') || '[no output]';
}

function projectMachineId(project: ProjectSpaceRecord) {
  const [machineId] = project.id.split(':');

  return project.id.includes(':') ? machineId : '';
}

function machineStatusLabel(machine: MachineRecord) {
  if (machine.connector.status === 'local') {
    return 'local';
  }

  return machine.connector.status;
}

function worktreeBranchLabel(project: ProjectSpaceRecord, worktree?: ProjectWorktreeRecord) {
  return (
    worktree?.branchName ||
    (worktree?.isBase ? project.gitStatus?.branchName : '') ||
    worktree?.name ||
    project.gitStatus?.branchName ||
    project.name
  );
}

export function ProjectTemplateSetupPanel({
  connectorOverview,
  onSelectWorkspace,
  onTemplateRelativePathChange,
  onSelectWorktree,
  onTemplateChanged,
  preferredMachineId,
  project,
  relativePath,
  resolvedTargetPath,
  selectedExplorerTarget,
  showMachineSelector = true,
  targetRootPath,
  worktrees
}: ProjectTemplateSetupPanelProps) {
  const [isRunning, setIsRunning] = useState<ProjectCliCommand | ''>('');
  const [result, setResult] = useState<ProjectCliCommandResult>();
  const [error, setError] = useState('');
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const activeTargetId =
    selectedExplorerTarget.kind === 'workspace'
      ? 'workspace'
      : `worktree:${selectedExplorerTarget.worktreeId}`;
  const machines = connectorOverview.machines;
  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);
  const canRunWrite = selectedMachine?.connector.status === 'local';
  const targetOptions = useMemo(
    () => [
      {
        id: 'workspace',
        branch: project.gitStatus?.branchName || project.name,
        label: `${project.gitStatus?.branchName || project.name} · main worktree`,
        path: project.rootPath
      },
      ...worktrees
        .filter((worktree) => !worktree.isBase)
        .map((worktree) => ({
          branch: worktreeBranchLabel(project, worktree),
          id: `worktree:${worktree.id}`,
          label: `${worktreeBranchLabel(project, worktree)} · ${worktree.name}`,
          path: worktree.path
        }))
    ],
    [project, worktrees]
  );
  const machineOptions = useMemo(
    () =>
      machines.length > 0
        ? machines.map((machine) => ({
            detail: machineStatusLabel(machine),
            label: machine.name,
            value: machine.id
          }))
        : [{ detail: 'No connector machines', label: 'Unavailable', value: '' }],
    [machines]
  );
  const selectTargetOptions = useMemo(
    () =>
      targetOptions.map((target) => ({
        detail: target.branch,
        label: target.label,
        value: target.id
      })),
    [targetOptions]
  );

  useEffect(() => {
    if (!showMachineSelector && preferredMachineId && selectedMachineId !== preferredMachineId) {
      setSelectedMachineId(preferredMachineId);
      return;
    }

    if (selectedMachineId || machines.length === 0) {
      return;
    }

    const projectPreferredMachineId = preferredMachineId || projectMachineId(project);
    const preferredMachine = projectPreferredMachineId
      ? machines.find((machine) => machine.id === projectPreferredMachineId)
      : undefined;
    const localMachine = machines.find((machine) => machine.connector.status === 'local');
    const onlineMachine = machines.find((machine) => machine.connector.status === 'online');
    const nextMachine = preferredMachine ?? localMachine ?? onlineMachine ?? machines[0];

    setSelectedMachineId(nextMachine.id);
  }, [machines, preferredMachineId, project, selectedMachineId, showMachineSelector]);

  async function runTemplateCommand(command: ProjectCliCommand) {
    if (!resolvedTargetPath || !selectedMachine || !canRunWrite) {
      return;
    }

    setIsRunning(command);
    setError('');

    try {
      const nextResult = await projectSpaceClient.runProjectCliCommand({
        command,
        cwd: resolvedTargetPath,
        machineId: selectedMachine.id
      });
      setResult(nextResult);
      if (nextResult.exitCode === 0) {
        onTemplateChanged();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Template command failed.');
    } finally {
      setIsRunning('');
    }
  }

  return (
    <Surface
      variant="tertiary"
      className="grid gap-3 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileCheck2 className="size-4 shrink-0 text-neutral-400" />
          <div className="min-w-0">
            <Text className="block truncate text-sm font-semibold text-neutral-100">
              Template setup
            </Text>
            <Text className="block truncate text-xs text-neutral-500">
              Choose the dev machine, Git worktree, and path before writing template state.
            </Text>
          </div>
        </div>
        {result ? (
          <Chip
            size="sm"
            className={result.exitCode === 0 ? 'text-emerald-300' : 'text-red-300'}
          >
            exit {result.exitCode ?? 'unknown'}
          </Chip>
        ) : null}
      </div>

      <div
        className={cn(
          'grid gap-3',
          showMachineSelector
            ? 'lg:grid-cols-[minmax(10rem,16rem)_minmax(12rem,20rem)_minmax(10rem,18rem)_auto_auto]'
            : 'lg:grid-cols-[minmax(12rem,20rem)_minmax(10rem,18rem)_auto_auto]'
        )}
      >
        {showMachineSelector ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium text-neutral-500">Machine</span>
            <TemplateSelectMenu
              ariaLabel="Template machine"
              options={machineOptions}
              value={selectedMachineId}
              onChange={setSelectedMachineId}
            />
          </label>
        ) : null}

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500">Git worktree</span>
          <TemplateSelectMenu
            ariaLabel="Template Git worktree"
            options={selectTargetOptions}
            value={activeTargetId}
            onChange={(value) => {
              if (value === 'workspace') {
                onSelectWorkspace();
                return;
              }
              if (value.startsWith('worktree:')) {
                onSelectWorktree(value.slice('worktree:'.length));
              }
            }}
          />
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500">Path below</span>
          <input
            value={relativePath}
            onChange={(event) => onTemplateRelativePathChange(event.target.value)}
            placeholder="."
            className="min-h-10 rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
          />
        </label>

        <Button
          isDisabled={!resolvedTargetPath || !canRunWrite || Boolean(isRunning)}
          onPress={() => void runTemplateCommand('template-init')}
        >
          {isRunning === 'template-init' ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <GitBranch className="size-4" />
          )}
          Initialize
        </Button>

        <Button
          variant="outline"
          isDisabled={!resolvedTargetPath || !canRunWrite || Boolean(isRunning)}
          onPress={() => void runTemplateCommand('template-sync-apply')}
        >
          {isRunning === 'template-sync-apply' ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Sync snapshot
        </Button>

        <div className={cn('min-w-0', showMachineSelector ? 'lg:col-span-5' : 'lg:col-span-4')}>
          <Text
            className="block truncate font-mono text-xs text-neutral-500"
            title={resolvedTargetPath}
          >
            {resolvedTargetPath || targetRootPath || 'No worktree selected'}
          </Text>
        </div>
      </div>

      {!canRunWrite ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <Server className="mt-0.5 size-4 shrink-0" />
          <span>
            Template writes need a local dev connector. Validation below stays read-only for the
            selected path.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {result ? (
        <pre className="max-h-44 overflow-auto rounded-lg border border-neutral-900 bg-neutral-950/80 p-3 font-mono text-xs leading-relaxed text-neutral-300">
          {commandOutput(result)}
        </pre>
      ) : null}
    </Surface>
  );
}
