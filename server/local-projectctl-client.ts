import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  ProjectctlInspectResult,
  ProjectctlOverviewResult,
  ProjectctlPlanResult
} from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);
const projectctlSourceCandidates = [
  join(homedir(), 'projects/fullstack-template'),
  join(homedir(), 'projects/.worktrees/fullstack-template-projectctl-json')
];

interface ProjectctlCommand {
  argsPrefix: string[];
  command: string;
  cwd?: string;
  label: string;
}

interface ProjectctlRunResult<T> {
  payload: T;
  toolPath: string;
}

function localBinaryCandidates(): ProjectctlCommand[] {
  const commands: ProjectctlCommand[] = [];

  if (process.env.PROJECTCTL_PATH) {
    commands.push({
      argsPrefix: [],
      command: process.env.PROJECTCTL_PATH,
      label: process.env.PROJECTCTL_PATH
    });
  }

  commands.push(
    { argsPrefix: [], command: 'projectctl', label: 'projectctl' },
    { argsPrefix: [], command: '/tmp/projectctl-json', label: '/tmp/projectctl-json' },
    {
      argsPrefix: [],
      command: join(homedir(), '.local/bin/projectctl'),
      label: join(homedir(), '.local/bin/projectctl')
    }
  );

  for (const sourceRoot of projectctlSourceCandidates) {
    if (existsSync(join(sourceRoot, 'cmd/projectctl/main.go'))) {
      commands.push({
        argsPrefix: ['run', './cmd/projectctl'],
        command: 'go',
        cwd: sourceRoot,
        label: `${sourceRoot} via go run`
      });
    }
  }

  return commands;
}

function extractProcessOutput(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'stdout' in error &&
    typeof error.stdout === 'string'
  ) {
    return {
      stderr:
        'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : error instanceof Error
            ? error.message
            : '',
      stdout: error.stdout
    };
  }

  return {
    stderr: error instanceof Error ? error.message : 'projectctl failed.',
    stdout: ''
  };
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

async function runProjectctlJson<T>(args: string[]): Promise<ProjectctlRunResult<T>> {
  const errors: string[] = [];

  for (const candidate of localBinaryCandidates()) {
    try {
      const { stdout } = await execFileAsync(candidate.command, [...candidate.argsPrefix, ...args], {
        cwd: candidate.cwd,
        windowsHide: true
      });

      return {
        payload: parseJson<T>(stdout),
        toolPath: candidate.label
      };
    } catch (error) {
      const output = extractProcessOutput(error);

      if (output.stdout.trim().startsWith('{')) {
        return {
          payload: parseJson<T>(output.stdout),
          toolPath: candidate.label
        };
      }

      errors.push(`${candidate.label}: ${output.stderr.trim() || 'no JSON output'}`);
    }
  }

  throw new Error(`projectctl is not available. ${errors.join(' | ')}`);
}

export async function getProjectctlOverview(projectPath: string): Promise<ProjectctlOverviewResult> {
  try {
    const inspect = await runProjectctlJson<ProjectctlInspectResult>([
      'inspect',
      '--json',
      projectPath
    ]);
    const status = await runProjectctlJson<ProjectctlPlanResult>(['status', '--json', projectPath])
      .then((result) => result.payload)
      .catch(() => undefined);

    return {
      available: true,
      inspect: inspect.payload,
      status,
      toolPath: inspect.toolPath
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : 'projectctl is not available.'
    };
  }
}

export async function getProjectctlPreview(projectPath: string): Promise<ProjectctlPlanResult> {
  return (await runProjectctlJson<ProjectctlPlanResult>(['preview', '--json', projectPath])).payload;
}
