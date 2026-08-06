import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

const stateVersion = 1;
const defaultConnectTimeoutMs = 10 * 60_000;
const defaultCommandTimeoutMs = 15 * 60_000;
const meteredCredentialVariables = [
  'AZURE_OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY'
] as const;

export type CodexLoginKind = 'api-key' | 'chatgpt' | 'signed-out' | 'unknown';

export type CodespaceAgentState = {
  createdAt: string;
  issue: number;
  operationId: string;
  repository: string;
  sandbox: string;
  task: {
    branch: string;
    canonicalTaskUrl: string;
    connectorId: string;
    connectorName: string;
    issueUrl: string;
    machineId: string;
    machineName: string;
    threadId: string;
    worktreeId: string;
  };
  version: 1;
};

type StartResult = {
  apiVersion?: unknown;
  message?: unknown;
  operationId?: unknown;
  reason?: unknown;
  reconcile?: unknown;
  state?: unknown;
  task?: unknown;
};

export type ParsedStartResult =
  | { kind: 'blocked'; message: string; reason: string }
  | { kind: 'confirmed'; state: CodespaceAgentState }
  | { kind: 'uncertain'; message: string };

type RunnerOptions = {
  detach: boolean;
  help: boolean;
  issue?: number;
  repository?: string;
  status: boolean;
};

type CapturedCommand = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type LockRecord = {
  acquiredAt: string;
  issue: number;
  operationId: string;
  pid: number;
  repository: string;
  sandbox: string;
  token: string;
  version: 1;
};

export type CodespaceAgentLock = {
  path: string;
  release(): Promise<void>;
};

export function classifyCodexLoginStatus(output: string): CodexLoginKind {
  const normalized = output.toLowerCase();
  if (/api[ _-]?key/.test(normalized)) return 'api-key';
  if (normalized.includes('chatgpt')) return 'chatgpt';
  if (
    normalized.includes('not logged in') ||
    normalized.includes('not signed in') ||
    normalized.includes('logged out')
  ) {
    return 'signed-out';
  }
  return 'unknown';
}

export function sanitizeCodespaceAgentEnvironment(
  input: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const result = { ...input };
  for (const name of meteredCredentialVariables) delete result[name];
  return result;
}

export function codespaceAgentOperationId(input: {
  issue: number;
  repository: string;
  sandbox: string;
}) {
  const digest = createHash('sha256')
    .update(`${input.repository}\0${input.issue}\0${input.sandbox}`)
    .digest('hex');
  return `codespace:start:${digest.slice(0, 32)}`;
}

export function codespaceMachineName(sandbox: string) {
  const normalized = `codespace-${sandbox}`
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[ ._-]+$/, '');
  return normalized || 'codespace-agent';
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeRepositoryKey(repository: string) {
  return `${repository.toLowerCase().replace('/', '--')}-${shortHash(repository)}`;
}

export function codespaceAgentStatePath(input: {
  issue: number;
  repository: string;
  sandbox: string;
  stateHome?: string;
  userHome?: string;
}) {
  const stateHome = input.stateHome || join(input.userHome || homedir(), '.local', 'state');
  return join(
    stateHome,
    'project-space',
    'codespace-agent',
    safeRepositoryKey(input.repository),
    `${input.issue}-${shortHash(input.sandbox)}.json`
  );
}

export function codespaceAgentLockPath(input: {
  sandbox: string;
  stateHome?: string;
  userHome?: string;
}) {
  const stateHome = input.stateHome || join(input.userHome || homedir(), '.local', 'state');
  return join(
    stateHome,
    'project-space',
    'codespace-agent',
    `runner-${shortHash(input.sandbox)}.lock`
  );
}

export function codespaceAgentCommands(input: {
  issue: number;
  machineName: string;
  operationId: string;
  repository: string;
  state?: CodespaceAgentState;
}) {
  return {
    connect: [
      'project',
      'connect',
      '--connector-mode',
      'foreground',
      '--no-open',
      '--name',
      input.machineName,
      '--json'
    ],
    inspect: input.state
      ? [
          'project',
          'codex',
          'read',
          '--machine-id',
          input.state.task.machineId,
          '--connector',
          input.state.task.connectorId,
          '--thread',
          input.state.task.threadId,
          '--last',
          '1',
          '--format',
          'json'
        ]
      : undefined,
    start: [
      'project',
      'codex',
      'start',
      '--issue',
      String(input.issue),
      '--repository',
      input.repository,
      '--here',
      '--operation-id',
      input.operationId,
      '--format',
      'json'
    ]
  };
}

export function codespaceAgentTmuxCommands(input: {
  cwd: string;
  issue: number;
  repository?: string;
}) {
  const socketName = 'project-space-agent';
  const sessionName = `issue-${input.issue}`;
  const runner = ['bun', 'scripts/codespace-agent.ts', '--issue', String(input.issue)];
  if (input.repository) runner.push('--repository', input.repository);
  const logPath = join(input.cwd, '.project-space', 'runner', `${sessionName}.log`);
  const loggedRunner = `umask 077; set -o pipefail; ${shellCommand(runner)} 2>&1 | tee -a ${shellCommand([logPath])}`;
  const tmux = ['tmux', '-L', socketName];
  return {
    attach: [...tmux, 'attach-session', '-t', `=${sessionName}`],
    exists: [...tmux, 'has-session', '-t', `=${sessionName}`],
    logPath,
    sessionName,
    start: [
      ...tmux,
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      input.cwd,
      loggedRunner
    ]
  };
}

export function parseCodespaceAgentStartResult(
  output: string,
  expected: {
    issue: number;
    operationId: string;
    repository: string;
    sandbox: string;
  },
  createdAt = new Date().toISOString()
): ParsedStartResult {
  const parsed = parseLastJSONObject(output) as StartResult;
  if (parsed.apiVersion !== 1 || parsed.operationId !== expected.operationId) {
    throw new Error('Project returned a start result with an unexpected identity.');
  }
  const message = stringValue(parsed.message) || 'The Codex task requires attention.';
  if (parsed.state === 'blocked') {
    return {
      kind: 'blocked',
      message,
      reason: stringValue(parsed.reason) || 'unknown'
    };
  }
  if (parsed.state === 'uncertain') return { kind: 'uncertain', message };
  if (parsed.state !== 'confirmed' || !isRecord(parsed.task)) {
    throw new Error(`Project returned the unsupported Codex start state ${String(parsed.state)}.`);
  }

  const task = parsed.task;
  const connector = requiredRecord(task, 'connector');
  const physicalMachine = requiredRecord(task, 'physicalMachine');
  const issue = requiredRecord(task, 'issue');
  const repository = requiredRecord(task, 'repository');
  const worktree = requiredRecord(task, 'worktree');
  const actualIssue = requiredPositiveInteger(issue, 'number');
  const actualRepository = requiredString(repository, 'nameWithOwner');
  if (actualIssue !== expected.issue || actualRepository !== expected.repository) {
    throw new Error('Project confirmed a different issue or repository than requested.');
  }

  return {
    kind: 'confirmed',
    state: {
      createdAt,
      issue: expected.issue,
      operationId: expected.operationId,
      repository: expected.repository,
      sandbox: expected.sandbox,
      task: {
        branch: requiredString(worktree, 'branch'),
        canonicalTaskUrl: requiredString(task, 'canonicalTaskUrl'),
        connectorId: requiredString(connector, 'id'),
        connectorName: requiredString(connector, 'name'),
        issueUrl: requiredString(issue, 'url'),
        machineId: requiredString(physicalMachine, 'id'),
        machineName: requiredString(physicalMachine, 'name'),
        threadId: requiredString(task, 'threadId'),
        worktreeId: requiredString(worktree, 'id')
      },
      version: stateVersion
    }
  };
}

export async function acquireCodespaceAgentLock(
  path: string,
  input: Omit<LockRecord, 'acquiredAt' | 'pid' | 'token' | 'version'> & {
    now?: () => string;
    pid?: number;
    processAlive?: (pid: number) => boolean;
    token?: string;
  }
): Promise<CodespaceAgentLock> {
  const pid = input.pid ?? process.pid;
  const token = input.token ?? randomUUID();
  const processAlive = input.processAlive ?? isProcessAlive;
  const record: LockRecord = {
    acquiredAt: (input.now ?? (() => new Date().toISOString()))(),
    issue: input.issue,
    operationId: input.operationId,
    pid,
    repository: input.repository,
    sandbox: input.sandbox,
    token,
    version: stateVersion
  };
  await mkdir(dirname(path), { mode: 0o700, recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporaryPath = `${path}.${pid}.${token}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      await link(temporaryPath, path);
      await unlinkIfPresent(temporaryPath);
      return {
        path,
        release: async () => {
          const current = await readLock(path);
          if (current?.token === token && current.pid === pid) await unlinkIfPresent(path);
        }
      };
    } catch (error) {
      await unlinkIfPresent(temporaryPath);
      if (!hasCode(error, 'EEXIST')) throw error;
    }

    const existing = await readLock(path);
    if (existing && processAlive(existing.pid)) {
      throw new Error(
        `A Codespace agent runner is already active for ${existing.repository}#${existing.issue} (PID ${existing.pid}).`
      );
    }
    await quarantineStaleLock(path, token, attempt);
  }
  throw new Error('Could not acquire the Codespace agent runner lock after recovering stale state.');
}

export async function readCodespaceAgentState(path: string): Promise<CodespaceAgentState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      throw new Error(`No task state exists at ${path}. Start the issue runner first.`);
    }
    throw new Error(`The Codespace agent state at ${path} is invalid.`, { cause: error });
  }
  if (!isCodespaceAgentState(parsed)) {
    throw new Error(`The Codespace agent state at ${path} has an invalid schema.`);
  }
  return parsed;
}

export async function writeCodespaceAgentState(path: string, state: CodespaceAgentState) {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function runCodespaceAgent(
  argv: string[],
  runtime: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    error?: NodeJS.WritableStream;
    output?: NodeJS.WritableStream;
  } = {}
) {
  const options = parseOptions(argv);
  const output = runtime.output ?? process.stdout;
  const errorOutput = runtime.error ?? process.stderr;
  if (options.help) {
    output.write(usage());
    return 0;
  }
  if (!options.issue) throw new Error('--issue must be a positive GitHub issue number.');

  const cwd = runtime.cwd ?? process.cwd();
  const sourceEnvironment = runtime.env ?? process.env;
  const environment = sanitizeCodespaceAgentEnvironment(sourceEnvironment);
  if (options.detach) {
    const commands = codespaceAgentTmuxCommands({
      cwd,
      issue: options.issue,
      repository: options.repository
    });
    await mkdir(dirname(commands.logPath), { mode: 0o700, recursive: true });
    const existing = await runCapturedCommand(commands.exists, cwd, environment, 30_000);
    if (existing.exitCode === 0) {
      output.write(`tmux session ${commands.sessionName} is already running.\n`);
    } else {
      await requireCommand(commands.start, cwd, environment);
      output.write(`Started tmux session ${commands.sessionName}.\n`);
    }
    output.write(`Attach: ${shellCommand(commands.attach)}\nLog: ${commands.logPath}\n`);
    return 0;
  }
  const sandbox = codespaceIdentity(sourceEnvironment);
  await assertCommand(['gh', 'auth', 'status', '--hostname', 'github.com'], cwd, environment);
  const repository = options.repository
    ? validateRepository(options.repository)
    : validateRepository(
        (
          await requireCommand(
            ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
            cwd,
            environment
          )
        ).stdout.trim()
      );
  const operationId = codespaceAgentOperationId({ issue: options.issue, repository, sandbox });
  const statePath = codespaceAgentStatePath({
    issue: options.issue,
    repository,
    sandbox,
    stateHome: sourceEnvironment.XDG_STATE_HOME,
    userHome: sourceEnvironment.HOME
  });

  if (options.status) {
    await printStatus({ cwd, environment, operationId, output, repository, sandbox, statePath });
    return 0;
  }

  await assertChatGPTLogin('codex', 'interactive Codex CLI', cwd, environment);
  await assertChatGPTLogin(
    join(
      sourceEnvironment.HOME || homedir(),
      '.local',
      'bin',
      '.project-space-machine-tools',
      'current',
      'codex'
    ),
    'Project managed Codex runtime',
    cwd,
    environment
  );
  await assertCommand(['docker', 'info'], cwd, environment);
  await assertCommand(['project', '--version'], cwd, environment);
  await assertCommand(['project-space-connector', '--version'], cwd, environment);

  const lock = await acquireCodespaceAgentLock(
    codespaceAgentLockPath({
      sandbox,
      stateHome: sourceEnvironment.XDG_STATE_HOME,
      userHome: sourceEnvironment.HOME
    }),
    { issue: options.issue, operationId, repository, sandbox }
  );
  let connector: ChildProcess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const stopConnector = (signal: NodeJS.Signals) => {
    interrupted = signal;
    if (connector && connector.exitCode === null && connector.signalCode === null) {
      connector.kill('SIGTERM');
    }
  };
  const onInterrupt = () => stopConnector('SIGINT');
  const onTerminate = () => stopConnector('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    const machineName = codespaceMachineName(sandbox);
    const commands = codespaceAgentCommands({
      issue: options.issue,
      machineName,
      operationId,
      repository
    });
    output.write(
      `Starting the foreground Project connector for ${repository}#${options.issue}.\n` +
        'On the first run, open the Project Space approval URL printed below.\n'
    );
    connector = spawn(commands.connect[0]!, commands.connect.slice(1), {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    connector.stdout?.pipe(output);
    connector.stderr?.pipe(errorOutput);
    const connectorExit = childExit(connector);
    await waitForMachineOnline(cwd, environment, connectorExit);
    output.write('Connector online; requesting the Codex task start. This can take several minutes.\n');
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;

    const confirmed = await startIssueWithReplay({
      command: codespaceAgentCommands({
        issue: options.issue,
        machineName,
        operationId,
        repository
      }).start,
      cwd,
      environment,
      expected: { issue: options.issue, operationId, repository, sandbox }
    });
    await writeCodespaceAgentState(statePath, confirmed);
    printConfirmed(output, confirmed, statePath);
    const outcome = await connectorExit;
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
    throw new Error(connectorExitMessage(outcome));
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (connector && connector.exitCode === null && connector.signalCode === null) {
      connector.kill('SIGTERM');
    }
    await lock.release();
  }
}

function parseOptions(argv: string[]): RunnerOptions {
  const options: RunnerOptions = { detach: false, help: false, status: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--detach') {
      options.detach = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--status') {
      options.status = true;
    } else if (argument === '--issue' || argument.startsWith('--issue=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      const issue = Number(value);
      if (!Number.isSafeInteger(issue) || issue < 1) {
        throw new Error('--issue must be a positive GitHub issue number.');
      }
      options.issue = issue;
    } else if (argument === '--repository' || argument.startsWith('--repository=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!value) throw new Error('--repository requires an exact owner/name value.');
      options.repository = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: bun scripts/codespace-agent.ts --issue <number> [--repository <owner/name>]\n\n` +
    `Starts or resumes one issue-bound Codex task while keeping the Project connector in the foreground.\n\n` +
    `Options:\n` +
    `  --issue <number>          GitHub issue to implement (required)\n` +
      `  --detach                  Run the foreground connector inside a detached tmux session\n` +
    `  --repository <owner/name> Override the repository resolved by gh\n` +
    `  --status                  Print the saved task identity and inspection command\n` +
    `  --help                    Show this help\n`;
}

function codespaceIdentity(environment: NodeJS.ProcessEnv) {
  const value = environment.CODESPACE_NAME || environment.HOSTNAME || hostname();
  const normalized = value.trim();
  if (!normalized) throw new Error('Could not determine a stable Codespace identity.');
  return normalized;
}

function validateRepository(value: string) {
  const repository = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(value)}; expected exact owner/name.`);
  }
  return repository;
}

async function assertChatGPTLogin(
  binary: string,
  label: string,
  cwd: string,
  environment: NodeJS.ProcessEnv
) {
  const result = await runCapturedCommand([binary, 'login', 'status'], cwd, environment, 30_000);
  const combined = `${result.stdout}\n${result.stderr}`;
  const kind = classifyCodexLoginStatus(combined);
  if (result.exitCode === 0 && kind === 'chatgpt') return;
  if (kind === 'api-key') {
    throw new Error(
      `${label} is authenticated with an API key. This runner only permits ChatGPT subscription authentication; run "codex logout" and then "codex login --device-auth".`
    );
  }
  throw new Error(
    `${label} is not authenticated with ChatGPT. Run "codex login --device-auth", then verify "codex login status" before retrying.`
  );
}

async function assertCommand(command: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  await requireCommand(command, cwd, environment);
}

async function requireCommand(command: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  const result = await runCapturedCommand(command, cwd, environment, 60_000);
  if (result.exitCode !== 0 || result.timedOut) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${command[0]} ${command.slice(1).join(' ')} failed${detail ? `: ${detail}` : '.'}`
    );
  }
  return result;
}

async function runCapturedCommand(
  command: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CapturedCommand> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stderr, stdout, timedOut });
    });
  });
}

function childExit(child: ChildProcess) {
  return new Promise<{ code: number | null; error?: Error; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (value: { code: number | null; error?: Error; signal: NodeJS.Signals | null }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', (error) => finish({ code: null, error, signal: null }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

async function waitForMachineOnline(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  connectorExit: Promise<{ code: number | null; error?: Error; signal: NodeJS.Signals | null }>,
  timeoutMs = defaultConnectTimeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await Promise.race([
      runCapturedCommand(['project', 'status', '--json'], cwd, environment, 20_000).then(
        (result) => ({ kind: 'status' as const, result })
      ),
      connectorExit.then((outcome) => ({ kind: 'exit' as const, outcome }))
    ]);
    if (status.kind === 'exit') throw new Error(connectorExitMessage(status.outcome));
    if (status.result.exitCode === 0) {
      try {
        const parsed = parseLastJSONObject(status.result.stdout);
        if (parsed.status === 'online' && parsed.configured === true) return;
      } catch {
        // The connector remains the source of truth while registration is pending.
      }
    }
    await Promise.race([
      delay(2_000),
      connectorExit.then((outcome) => {
        throw new Error(connectorExitMessage(outcome));
      })
    ]);
  }
  throw new Error(
    'The Project connector did not become online within ten minutes. Complete the printed approval URL, then rerun the same command.'
  );
}

export function formatCodespaceAgentBlockedStart(reason: string, message: string) {
  const resolution = message === 'Select one exact physical machine.'
    ? 'This connector is online but is not assigned to a physical machine. In Project Space, open Settings → Machines, choose Add machine, select this Codespace connector, and save.'
    : message;
  return `Codex task start is blocked (${reason}): ${resolution} Rerun this exact command after resolving the blocker; the operation ID is stable.`;
}

async function startIssueWithReplay(input: {
  command: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  expected: { issue: number; operationId: string; repository: string; sandbox: string };
}) {
  let lastMessage = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runCapturedCommand(
      input.command,
      input.cwd,
      input.environment,
      defaultCommandTimeoutMs
    );
    let parsed: ParsedStartResult | undefined;
    try {
      parsed = parseCodespaceAgentStartResult(result.stdout, input.expected);
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (!result.timedOut && result.exitCode !== null && result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new Error(detail || lastMessage);
      }
    }
    if (parsed?.kind === 'confirmed') return parsed.state;
    if (parsed?.kind === 'blocked') {
      throw new Error(formatCodespaceAgentBlockedStart(parsed.reason, parsed.message));
    }
    if (parsed?.kind === 'uncertain') lastMessage = parsed.message;
    if (attempt < 3) await delay(2_000);
  }
  throw new Error(
    `The Codex start result remains uncertain after replaying the same operation ID. ${lastMessage}`.trim()
  );
}

async function printStatus(input: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  operationId: string;
  output: NodeJS.WritableStream;
  repository: string;
  sandbox: string;
  statePath: string;
}) {
  const state = await readCodespaceAgentState(input.statePath);
  if (
    state.operationId !== input.operationId ||
    state.repository !== input.repository ||
    state.sandbox !== input.sandbox
  ) {
    throw new Error('The saved task state does not belong to this repository and Codespace.');
  }
  const machineStatus = await runCapturedCommand(
    ['project', 'status', '--json'],
    input.cwd,
    input.environment,
    30_000
  );
  let status = 'unavailable';
  if (machineStatus.exitCode === 0) {
    try {
      status = stringValue(parseLastJSONObject(machineStatus.stdout).status) || status;
    } catch {
      status = 'invalid-response';
    }
  }
  const inspect = codespaceAgentCommands({
    issue: state.issue,
    machineName: state.task.machineName,
    operationId: state.operationId,
    repository: state.repository,
    state
  }).inspect!;
  input.output.write(
    `Task: ${state.repository}#${state.issue}\n` +
      `Operation: ${state.operationId}\n` +
      `Task URL: ${state.task.canonicalTaskUrl}\n` +
      `Thread: ${state.task.threadId}\n` +
      `Branch: ${state.task.branch}\n` +
      `Worktree: ${state.task.worktreeId}\n` +
      `Machine: ${state.task.machineName} / ${state.task.machineId} (${status})\n` +
      `Connector: ${state.task.connectorName} / ${state.task.connectorId}\n` +
      `Inspect: ${shellCommand(inspect)}\n` +
      `State file: ${input.statePath}\n`
  );
}

function printConfirmed(
  output: NodeJS.WritableStream,
  state: CodespaceAgentState,
  statePath: string
) {
  const inspect = codespaceAgentCommands({
    issue: state.issue,
    machineName: state.task.machineName,
    operationId: state.operationId,
    repository: state.repository,
    state
  }).inspect!;
  output.write(
    `\nCodex task confirmed: ${state.task.canonicalTaskUrl}\n` +
      `Task: ${state.repository}#${state.issue}\n` +
      `Operation: ${state.operationId}\n` +
      `Thread: ${state.task.threadId}\n` +
      `Branch: ${state.task.branch}\n` +
      `Worktree: ${state.task.worktreeId}\n` +
      `Machine: ${state.task.machineName} / ${state.task.machineId}\n` +
      `Connector: ${state.task.connectorName} / ${state.task.connectorId}\n` +
      `Inspect from another terminal: ${shellCommand(inspect)}\n` +
      `Saved non-secret state: ${statePath}\n` +
      'Keep this command running to keep the connector online; press Ctrl+C to stop it.\n'
  );
}

function shellCommand(command: string[]) {
  return command.map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

function parseLastJSONObject(output: string): Record<string, unknown> {
  const completeOutput = output.trim();
  if (completeOutput) {
    try {
      const parsed: unknown = JSON.parse(completeOutput);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall back to a single JSON line after human-readable output.
    }
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Continue past human-readable connector output.
    }
  }
  throw new Error('Project did not return a JSON result.');
}

function requiredRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Project start result is missing task.${key}.`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string) {
  const value = stringValue(record[key]);
  if (!value) throw new Error(`Project start result is missing ${key}.`);
  return value;
}

function requiredPositiveInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Project start result is missing ${key}.`);
  }
  return Number(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCodespaceAgentState(value: unknown): value is CodespaceAgentState {
  if (!isRecord(value) || !isRecord(value.task)) return false;
  const task = value.task;
  return (
    value.version === stateVersion &&
    typeof value.createdAt === 'string' &&
    Number.isSafeInteger(value.issue) &&
    Number(value.issue) > 0 &&
    typeof value.operationId === 'string' &&
    typeof value.repository === 'string' &&
    typeof value.sandbox === 'string' &&
    [
      'branch',
      'canonicalTaskUrl',
      'connectorId',
      'connectorName',
      'issueUrl',
      'machineId',
      'machineName',
      'threadId',
      'worktreeId'
    ].every((key) => typeof task[key] === 'string' && task[key] !== '')
  );
}

function isLockRecord(value: unknown): value is LockRecord {
  return (
    isRecord(value) &&
    value.version === stateVersion &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    typeof value.repository === 'string' &&
    Number.isSafeInteger(value.issue)
  );
}

async function readLock(path: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isLockRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

async function quarantineStaleLock(path: string, token: string, attempt: number) {
  const quarantine = `${path}.stale.${process.pid}.${token}.${attempt}`;
  try {
    await rename(path, quarantine);
    await unlinkIfPresent(quarantine);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

async function unlinkIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

function hasCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code;
}

function connectorExitMessage(outcome: {
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
}) {
  if (outcome.error) return `The foreground Project connector failed: ${outcome.error.message}`;
  if (outcome.signal) return `The foreground Project connector stopped with ${outcome.signal}.`;
  return `The foreground Project connector exited with status ${outcome.code ?? 'unknown'}.`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
