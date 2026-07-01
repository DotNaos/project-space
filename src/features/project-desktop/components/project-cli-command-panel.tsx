import { useMemo, useState } from 'react';
import { Play, RefreshCw, TerminalSquare } from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ProjectCliCommand,
  ProjectCliCommandResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';

interface ProjectCliCommandPanelProps {
  project?: ProjectSpaceRecord;
  targetPath?: string;
}

interface CommandOption {
  command: ProjectCliCommand;
  description: string;
  label: string;
  needsModule?: boolean;
}

const commandOptions: CommandOption[] = [
  {
    command: 'validate',
    description: 'Check the project against its local template snapshot.',
    label: 'Validate'
  },
  {
    command: 'module-list',
    description: 'List available and installed template modules.',
    label: 'Modules'
  },
  {
    command: 'module-show',
    description: 'Show details for one module.',
    label: 'Module details',
    needsModule: true
  },
  {
    command: 'template-sync',
    description: 'Preview template snapshot sync.',
    label: 'Template sync'
  },
  {
    command: 'template-update',
    description: 'Preview template update.',
    label: 'Template update'
  },
  {
    command: 'deploy-status',
    description: 'Inspect deployment status.',
    label: 'Deploy status'
  }
];

function formatDuration(ms?: number) {
  if (typeof ms !== 'number') {
    return '';
  }

  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function resultOutput(result?: ProjectCliCommandResult) {
  if (!result) {
    return 'Run a command to inspect this project through the connector.';
  }

  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n\n') || '[no output]';
}

export function ProjectCliCommandPanel({
  project,
  targetPath
}: ProjectCliCommandPanelProps) {
  const [selectedCommand, setSelectedCommand] = useState<ProjectCliCommand>('validate');
  const [moduleName, setModuleName] = useState('core.repo');
  const [result, setResult] = useState<ProjectCliCommandResult>();
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const cwd = targetPath || project?.rootPath || '';
  const selectedOption = useMemo(
    () => commandOptions.find((option) => option.command === selectedCommand) ?? commandOptions[0],
    [selectedCommand]
  );

  async function runCommand() {
    if (!cwd) {
      return;
    }

    setIsRunning(true);
    setError('');

    try {
      const nextResult = await projectSpaceClient.runProjectCliCommand({
        command: selectedCommand,
        cwd,
        moduleName: selectedOption.needsModule ? moduleName : undefined
      });
      setResult(nextResult);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Project command failed.');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <Surface
      data-testid="project-cli-command-panel"
      variant="tertiary"
      className="rounded-lg border border-neutral-800 bg-black/20 p-4"
    >
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare className="size-4 shrink-0 text-neutral-400" />
          <div className="min-w-0">
            <Text className="block truncate text-sm font-semibold text-neutral-100">
              Project CLI
            </Text>
            <Text className="block truncate text-xs text-neutral-500">
              {cwd || 'Select a project to run commands'}
            </Text>
          </div>
        </div>
        {result ? (
          <Chip
            size="sm"
            className={result.exitCode === 0 ? 'text-emerald-300' : 'text-red-300'}
          >
            exit {result.exitCode ?? 'unknown'} {formatDuration(result.durationMs)}
          </Chip>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_auto]">
        <select
          data-testid="project-cli-command-select"
          value={selectedCommand}
          onChange={(event) => setSelectedCommand(event.target.value as ProjectCliCommand)}
          className="min-h-10 rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 text-sm text-neutral-100 outline-none focus:border-neutral-500"
        >
          {commandOptions.map((option) => (
            <option key={option.command} value={option.command}>
              {option.label}
            </option>
          ))}
        </select>

        {selectedOption.needsModule ? (
          <input
            value={moduleName}
            onChange={(event) => setModuleName(event.target.value)}
            placeholder="module name"
            className="min-h-10 rounded-lg border border-neutral-800 bg-neutral-950/80 px-3 text-sm text-neutral-100 outline-none focus:border-neutral-500"
          />
        ) : (
          <Text className="flex min-h-10 items-center text-sm text-neutral-500">
            {selectedOption.description}
          </Text>
        )}

        <Button
          data-testid="project-cli-command-run"
          isDisabled={!cwd || isRunning || (selectedOption.needsModule && !moduleName.trim())}
          onPress={() => void runCommand()}
        >
          {isRunning ? <RefreshCw className="size-4 animate-spin" /> : <Play className="size-4" />}
          Run
        </Button>
      </div>

      {error ? (
        <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <pre
        data-testid="project-cli-command-output"
        className="mt-3 max-h-80 overflow-auto rounded-lg border border-neutral-900 bg-neutral-950/80 p-3 font-mono text-xs leading-relaxed text-neutral-300"
      >
        {resultOutput(result)}
      </pre>
    </Surface>
  );
}
