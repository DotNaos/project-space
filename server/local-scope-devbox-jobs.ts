import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { getConnectorOverview } from './local-machine-registry';
import type {
  MachineRecord,
  ScopeDevboxJobRecord,
  ScopeDevboxOverviewResult,
  ScopeDevboxStartRequest
} from '../src/shared/project-space-api';

const projectSpaceDirectory = join(homedir(), '.project-space');
const jobsStateFile = join(projectSpaceDirectory, 'scope-jobs.json');
const jobLogDirectory = join(projectSpaceDirectory, 'scope-job-logs');
const projectsRoot = join(homedir(), 'projects');
const devboxRepoPath = join(projectsRoot, 'llm-scope-devbox');

const controlFileNames = ['access_request.md', 'breach_request.md', 'result.md'];

function now() {
  return new Date().toISOString();
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function yamlScalar(value: string) {
  return JSON.stringify(value);
}

function normalizeRepoPath(path: string) {
  return path.split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((entry) => {
      return !entry.startsWith('/') && !entry.startsWith('../') && !entry.includes('/../');
    });
}

function readJobs(): ScopeDevboxJobRecord[] {
  try {
    return JSON.parse(readFileSync(jobsStateFile, 'utf-8')) as ScopeDevboxJobRecord[];
  } catch {
    return [];
  }
}

function writeJobs(jobs: ScopeDevboxJobRecord[]) {
  mkdirSync(projectSpaceDirectory, { recursive: true });
  writeFileSync(jobsStateFile, `${JSON.stringify(jobs.slice(0, 50), null, 2)}\n`);
}

function upsertJob(job: ScopeDevboxJobRecord) {
  const jobs = readJobs();
  const nextJobs = [job, ...jobs.filter((entry) => entry.id !== job.id)];
  writeJobs(nextJobs);
}

function rejectJob(request: ScopeDevboxStartRequest, message: string, machine?: MachineRecord) {
  const timestamp = now();
  const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const job: ScopeDevboxJobRecord = {
    agent: request.agent,
    createdAt: timestamp,
    id,
    logPath: '',
    machineId: request.machineId,
    machineName: machine?.name,
    message,
    model: request.model,
    repoPath: request.repoPath,
    scopePath: '',
    status: 'rejected',
    task: request.task,
    updatedAt: timestamp,
    writableFiles: normalizeRepoPath(request.writableFiles.join('\n'))
  };

  upsertJob(job);
  return job;
}

function assertProjectPath(repoPath: string) {
  const resolved = resolve(repoPath);
  const root = resolve(projectsRoot);

  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error('Repo path must stay under ~/projects.');
  }

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('Repo path does not exist.');
  }

  if (!existsSync(join(resolved, '.git'))) {
    throw new Error('Selected target is not a git repository. Choose a repo or worktree target.');
  }

  return resolved;
}

function writeScopeFiles(job: ScopeDevboxJobRecord) {
  const jobDir = join(job.repoPath, '.llm', 'project-space-jobs', job.id);
  const instructionsDir = join(jobDir, 'instructions');
  const relativeJobDir = relative(job.repoPath, jobDir).replace(/\\/g, '/');
  const taskPath = `${relativeJobDir}/TASK.md`;
  const instructionsPath = `${relativeJobDir}/instructions`;
  const lockPath = `${relativeJobDir}/test-lock.json`;
  const writableFiles = [
    ...job.writableFiles,
    ...controlFileNames.map((fileName) => `${relativeJobDir}/${fileName}`)
  ];
  const scopePath = join(jobDir, 'scope.yml');

  mkdirSync(instructionsDir, { recursive: true });
  writeFileSync(join(jobDir, 'TASK.md'), `${job.task.trim()}\n`);
  writeFileSync(
    join(instructionsDir, 'README.md'),
    [
      '# Project Space scoped job',
      '',
      'Stay inside the current scope. If the scope is insufficient, write a request to the breach or access request file and stop.',
      ''
    ].join('\n')
  );
  writeFileSync(join(jobDir, 'test-lock.json'), `${JSON.stringify({
    createdAt: job.createdAt,
    files: [],
    scope: job.id,
    version: 1,
    workspace: '.'
  }, null, 2)}\n`);

  for (const fileName of controlFileNames) {
    writeFileSync(join(jobDir, fileName), '');
  }

  writeFileSync(
    scopePath,
    [
      `name: ${yamlScalar(job.id)}`,
      'workspace: "."',
      `task: ${yamlScalar(taskPath)}`,
      'instructions:',
      `  dir: ${yamlScalar(instructionsPath)}`,
      'controller:',
      '  tests: []',
      '  gates: []',
      `  lock: ${yamlScalar(lockPath)}`,
      'writable:',
      '  files:',
      ...writableFiles.map((filePath) => `    - ${yamlScalar(filePath)}`),
      'capabilities:',
      '  network: false',
      ''
    ].join('\n')
  );

  return {
    resultFile: `${relativeJobDir}/result.md`,
    scopePath,
    taskFile: taskPath
  };
}

function agentCommand(job: ScopeDevboxJobRecord, taskFile: string, resultFile: string) {
  const taskInContainer = `/workspace/${taskFile}`;
  const resultInContainer = `/workspace/${resultFile}`;

  if (job.agent === 'gemini') {
    return [
      `gemini --model ${shellQuote(job.model)}`,
      '--skip-trust --yolo',
      `"$(cat ${shellQuote(taskInContainer)})"`,
      `| tee ${shellQuote(resultInContainer)}`
    ].join(' ');
  }

  return [
    `cat ${shellQuote(taskInContainer)}`,
    '|',
    `codex exec -m ${shellQuote(job.model)}`,
    '--cd /workspace',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    `-o ${shellQuote(resultInContainer)}`,
    '-'
  ].join(' ');
}

function launchLocalJob(job: ScopeDevboxJobRecord, scopePath: string, taskFile: string, resultFile: string) {
  mkdirSync(jobLogDirectory, { recursive: true });
  const logStream = createWriteStream(job.logPath, { flags: 'a' });
  const scopeRelativePath = relative(job.repoPath, scopePath).replace(/\\/g, '/');
  const command = [
    'set -e',
    'if ! docker image inspect llm-scope-devbox:latest >/dev/null 2>&1; then bun run scope:build; fi',
    [
      'bun run scripts/scope-run.ts',
      `--repo-root ${shellQuote(job.repoPath)}`,
      `--scope ${shellQuote(scopeRelativePath)}`,
      '--agent-network',
      '--git-write',
      job.agent === 'gemini'
        ? '--gemini-home-dir .devbox-home/gemini'
        : '--codex-home-dir .devbox-home/codex --sync-host-codex-auth',
      '--',
      'bash',
      '-lc',
      shellQuote(agentCommand(job, taskFile, resultFile))
    ].join(' ')
  ].join('\n');

  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd: devboxRepoPath,
    env: process.env
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on('close', (exitCode) => {
    logStream.end();
    upsertJob({
      ...job,
      exitCode,
      message: exitCode === 0 ? 'Job completed.' : `Job exited with code ${exitCode}.`,
      status: exitCode === 0 ? 'passed' : 'failed',
      updatedAt: now()
    });
  });

  child.on('error', (error) => {
    logStream.end();
    upsertJob({
      ...job,
      message: error.message,
      status: 'failed',
      updatedAt: now()
    });
  });
}

export async function getScopeDevboxOverview(): Promise<ScopeDevboxOverviewResult> {
  return {
    defaultAgent: 'codex',
    defaultModel: 'gpt-5.3-codex-spark',
    devboxRepo: {
      exists: existsSync(devboxRepoPath),
      path: devboxRepoPath
    },
    jobs: readJobs()
  };
}

export async function startScopeDevboxJob(
  request: ScopeDevboxStartRequest
): Promise<ScopeDevboxJobRecord> {
  const connector = await getConnectorOverview();
  const machine = connector.machines.find((entry) => entry.id === request.machineId);

  if (!machine) {
    return rejectJob(request, 'Selected machine was not found.');
  }

  if (machine.connector.status !== 'local') {
    return rejectJob(request, 'Remote machine connectors are selectable, but only the local connector can launch jobs in this MVP.', machine);
  }

  if (!existsSync(devboxRepoPath)) {
    return rejectJob(request, 'llm-scope-devbox repo is missing from ~/projects.', machine);
  }

  let repoPath: string;
  try {
    repoPath = assertProjectPath(request.repoPath);
  } catch (error) {
    return rejectJob(request, error instanceof Error ? error.message : String(error), machine);
  }

  const timestamp = now();
  const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const job: ScopeDevboxJobRecord = {
    agent: request.agent === 'gemini' ? 'gemini' : 'codex',
    createdAt: timestamp,
    id,
    logPath: join(jobLogDirectory, `${id}.log`),
    machineId: machine.id,
    machineName: machine.name,
    message: 'Scoped job started.',
    model: request.model || (request.agent === 'gemini' ? 'gemini-3-pro' : 'gpt-5.3-codex-spark'),
    repoPath,
    scopePath: '',
    status: 'running',
    task: request.task.trim() || `Work on ${basename(repoPath)} inside the current scope.`,
    updatedAt: timestamp,
    writableFiles: normalizeRepoPath(request.writableFiles.join('\n'))
  };
  const scope = writeScopeFiles(job);
  const runningJob = {
    ...job,
    scopePath: scope.scopePath
  };

  upsertJob(runningJob);
  launchLocalJob(runningJob, scope.scopePath, scope.taskFile, scope.resultFile);

  return runningJob;
}
