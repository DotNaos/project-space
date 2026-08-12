import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, constants, realpathSync } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import type {
  CodexDaemonConnectorResult,
  CodexDaemonEvidence,
  CodexDaemonOperation
} from '../../src/shared/codex-daemon-api';
import { codexDaemonResultStateForEvidence } from '../../src/shared/codex-daemon-api';
import { resolveCodexBinary } from '../codex-sessions/binary-resolver';
import type { CodexSessionManager } from '../codex-sessions/manager';
import { CodexOperationUncertainError } from '../codex-sessions/operation-ledger';
import {
  CodexWebSocketTransport,
  codexAppServerSocketPath,
  resolveCodexHome
} from '../codex-sessions/websocket-transport';

type CommandResult = { exitCode: number | null; stdout: string };
type ManagedProcess = {
  arguments: string[];
  executable: string;
  processStartTime: string;
};
type ManagedReleaseTransaction = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

const processArgumentLimit = 64 * 1024;
const processStopTimeoutMs = 10_000;
const processStopPollMs = 50;

export interface CodexDaemonManagerOptions {
  connectTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  manager: Pick<CodexSessionManager, 'executeManagedOperation'>;
  now?(): number;
  platform?: NodeJS.Platform;
  processExists?(pid: number): boolean;
  readManagedProcess?(pid: number): Promise<ManagedProcess | undefined>;
  resolveBinary?(): string | undefined;
  rpcTimeoutMs?: number;
  run?(binaryPath: string, args: string[], environment: NodeJS.ProcessEnv): Promise<CommandResult>;
  sleep?(milliseconds: number): Promise<void>;
  terminateProcess?(pid: number): void;
}

type LifecycleStatus = {
  appServerVersion?: string;
  backend?: string;
  cliVersion?: string;
  managedCodexVersion?: string;
  remoteControlEnabled?: boolean;
  socketPath?: string;
  status?: string;
};

export class CodexDaemonManager {
  private readonly environment: NodeJS.ProcessEnv;
  private mutationTail = Promise.resolve();
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly processExists: NonNullable<CodexDaemonManagerOptions['processExists']>;
  private readonly readManagedProcess: NonNullable<CodexDaemonManagerOptions['readManagedProcess']>;
  private readonly resolveBinary: () => string | undefined;
  private readonly run: NonNullable<CodexDaemonManagerOptions['run']>;
  private readonly sleep: NonNullable<CodexDaemonManagerOptions['sleep']>;
  private readonly terminateProcess: NonNullable<CodexDaemonManagerOptions['terminateProcess']>;

  constructor(private readonly options: CodexDaemonManagerOptions) {
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.processExists = options.processExists ?? processExists;
    this.readManagedProcess = options.readManagedProcess ?? readLinuxManagedProcess;
    this.resolveBinary = options.resolveBinary ?? (() => resolveCodexBinary({
      environment: this.environment,
      platform: this.platform
    }).path);
    this.run = options.run ?? runCodexCommand;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.terminateProcess = options.terminateProcess ?? ((pid) => process.kill(pid, 'SIGTERM'));
  }

  async execute(
    operation: CodexDaemonOperation,
    operationId: string
  ): Promise<CodexDaemonConnectorResult> {
    if (operation === 'status') return this.result(operation, operationId, await this.inspect());
    const fingerprint = createHash('sha256')
      .update(`codex-daemon:${operation}`)
      .digest('hex');
    return this.options.manager.executeManagedOperation(operationId, fingerprint, async () => {
      const evidence = await this.serializeMutation(() => operation === 'ensure'
        ? this.ensure()
        : this.restart());
      return this.result(operation, operationId, evidence);
    });
  }

  async inspect(): Promise<CodexDaemonEvidence> {
    const checkedAt = new Date(this.now()).toISOString();
    if (this.platform === 'win32') return baseEvidence(checkedAt, 'unsupported');
    const binaryPath = this.resolveBinary();
    if (!binaryPath) return baseEvidence(checkedAt, 'missing');
    const lifecycle = await this.lifecycle(binaryPath, 'version');
    if (!lifecycle) {
      const managedInstalled = await this.managedBinaryInstalled();
      return {
        ...baseEvidence(checkedAt, managedInstalled ? 'stopped' : 'missing'),
        cliVersion: await this.binaryVersion(binaryPath),
        installed: managedInstalled
      };
    }
    const running = lifecycle.status === 'running' ||
      lifecycle.status === 'alreadyRunning' ||
      Boolean(lifecycle.appServerVersion);
    const managedInstalled = await this.managedBinaryInstalled();
    const managedRunning = lifecycle.backend === 'pid' &&
      Boolean(lifecycle.managedCodexVersion);
    const compatible = Boolean(
      lifecycle.cliVersion &&
      lifecycle.appServerVersion &&
      lifecycle.managedCodexVersion &&
      lifecycle.cliVersion === lifecycle.appServerVersion &&
      lifecycle.managedCodexVersion === lifecycle.appServerVersion
    );
    if (!running) {
      return {
        ...baseEvidence(checkedAt, managedInstalled ? 'stopped' : 'missing'),
        cliVersion: lifecycle.cliVersion,
        installed: managedInstalled
      };
    }
    if (!managedRunning) {
      return {
        ...baseEvidence(checkedAt, 'uncertain'),
        appServerVersion: lifecycle.appServerVersion,
        cliVersion: lifecycle.cliVersion,
        installed: managedInstalled,
        running: true
      };
    }
    if (!managedInstalled) {
      return {
        ...baseEvidence(checkedAt, 'missing'),
        appServerVersion: lifecycle.appServerVersion,
        cliVersion: lifecycle.cliVersion,
        running: true
      };
    }
    const socketPath = safeSocketPath(lifecycle.socketPath, this.environment);
    if (!socketPath) {
      return {
        ...baseEvidence(checkedAt, 'uncertain'),
        appServerVersion: lifecycle.appServerVersion,
        cliVersion: lifecycle.cliVersion,
        compatible,
        installed: managedInstalled,
        running: true
      };
    }
    let transport: CodexWebSocketTransport | undefined;
    let remoteStatus: ReturnType<typeof readRemoteControl> | undefined;
    try {
      transport = await CodexWebSocketTransport.connect({
        connectTimeoutMs: this.options.connectTimeoutMs,
        onMessage: (message) => {
          if (message.method !== 'remoteControl/status/changed') return;
          remoteStatus = readRemoteControl(message.params);
        },
        rpcTimeoutMs: this.options.rpcTimeoutMs,
        socketPath
      });
      await transport.initialize();
      const account = await transport.call<unknown>(
        'account/read',
        { refreshToken: false }
      );
      const authenticated = readAuthenticated(account);
      const remote = remoteStatus ?? { state: 'unknown' as const };
      const enabled = lifecycle.remoteControlEnabled === true ||
        ['connecting', 'connected', 'errored'].includes(remote.state);
      const paired = remote.state === 'connected' && Boolean(remote.environmentId);
      const state = !compatible
        ? 'incompatible'
        : !authenticated
          ? 'authorization-required'
          : 'ready';
      return {
        appServerVersion: lifecycle.appServerVersion,
        authenticated,
        checkedAt,
        cliVersion: lifecycle.cliVersion,
        compatible,
        ...(remote.environmentId ? { environmentId: remote.environmentId } : {}),
        installed: managedInstalled,
        paired,
        reachable: true,
        remoteControlEnabled: enabled,
        remoteControlState: remote.state,
        running: true,
        state
      };
    } catch {
      return {
        ...baseEvidence(checkedAt, compatible ? 'uncertain' : 'incompatible'),
        appServerVersion: lifecycle.appServerVersion,
        cliVersion: lifecycle.cliVersion,
        compatible,
        installed: managedInstalled,
        remoteControlEnabled: lifecycle.remoteControlEnabled === true,
        running: true
      };
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  private async ensure() {
    this.requireSupported();
    const binaryPath = this.requireBinary();
    return this.repair(binaryPath, 'start');
  }

  private async restart() {
    this.requireSupported();
    const binaryPath = this.requireBinary();
    return this.repair(binaryPath, 'restart');
  }

  private async repair(binaryPath: string, command: 'restart' | 'start') {
    const transaction = await this.reconcileManagedBinary(binaryPath);
    try {
      await this.requireLifecycle(binaryPath, command);
      await this.requireLifecycle(binaryPath, 'enable-remote-control');
      const evidence = await this.verifyRepair();
      await transaction?.commit();
      return evidence;
    } catch (error) {
      if (transaction) {
        await this.lifecycle(binaryPath, 'stop');
        await transaction.rollback();
        await this.lifecycle(binaryPath, 'start');
      }
      throw error;
    }
  }

  private async reconcileManagedBinary(binaryPath: string) {
    if (this.environment.PROJECT_SPACE_INSTALL_SOURCE !== 'managed') {
      throw new Error(
        'Doctor will not create a managed Codex installation from an unpinned runtime.'
      );
    }
    const expectedVersion = await this.binaryVersion(binaryPath);
    if (!expectedVersion) {
      throw new Error('The signed managed Codex runtime version could not be verified.');
    }
    const lifecycle = await this.lifecycle(binaryPath, 'version');
    await this.stopManagedUpdater();
    if (await this.managedBinaryMatches(binaryPath) &&
        lifecycle?.managedCodexVersion === expectedVersion) return;
    const stopped = await this.lifecycle(binaryPath, 'stop');
    if (!stopped) await this.stopOrphanedAppServer();
    try {
      return await this.installManagedRelease(binaryPath, expectedVersion);
    } catch (error) {
      await this.lifecycle(binaryPath, 'start');
      throw error;
    }
  }

  private async installManagedRelease(
    binaryPath: string,
    version: string
  ): Promise<ManagedReleaseTransaction> {
    const codexHome = resolveCodexHome(this.environment);
    const standaloneRoot = join(codexHome, 'packages', 'standalone');
    const releasesRoot = join(standaloneRoot, 'releases');
    const digest = await hashFile(binaryPath);
    const releaseDirectory = join(
      releasesRoot,
      `${version}-project-space-${digest.slice(0, 16)}`
    );
    const stagedDirectory = join(
      standaloneRoot,
      `.project-space-release-${randomBytes(12).toString('hex')}.tmp`
    );
    await mkdir(join(stagedDirectory, 'bin'), { recursive: true, mode: 0o700 });
    try {
      const stagedBinary = join(stagedDirectory, 'bin', 'codex');
      await copyFile(binaryPath, stagedBinary, constants.COPYFILE_EXCL);
      await chmod(stagedBinary, 0o755);
      await symlink('bin/codex', join(stagedDirectory, 'codex'));
      await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
      await rename(stagedDirectory, releaseDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      });
      await validateManagedRelease(releasesRoot, releaseDirectory, digest);
      const transaction = await this.switchManagedPointer(standaloneRoot, releaseDirectory);
      try {
        await access(join(standaloneRoot, 'current', 'codex'), constants.X_OK);
        return transaction;
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } finally {
      await rm(stagedDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  private async switchManagedPointer(
    standaloneRoot: string,
    releaseDirectory: string
  ): Promise<ManagedReleaseTransaction> {
    const current = join(standaloneRoot, 'current');
    const next = join(
      standaloneRoot,
      `.project-space-current-${randomBytes(12).toString('hex')}.tmp`
    );
    await symlink(releaseDirectory, next);
    try {
      const currentStatus = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!currentStatus) {
        await rename(next, current);
        return {
          commit: async () => undefined,
          rollback: async () => {
            await rm(current, { force: true });
          }
        };
      }
      if (currentStatus.isSymbolicLink()) {
        const previousTarget = await readlink(current);
        await rename(next, current);
        return {
          commit: async () => undefined,
          rollback: async () => {
            const rollback = `${next}-rollback`;
            await symlink(previousTarget, rollback);
            try {
              await rename(rollback, current);
            } finally {
              await rm(rollback, { force: true }).catch(() => undefined);
            }
          }
        };
      }
      if (!currentStatus.isDirectory()) {
        throw new Error('The managed Codex current pointer has an unsafe type.');
      }
      const backup = join(
        standaloneRoot,
        `.project-space-current-backup-${randomBytes(12).toString('hex')}`
      );
      await rename(current, backup);
      try {
        await rename(next, current);
      } catch (error) {
        await rename(backup, current);
        throw error;
      }
      return {
        commit: async () => {
          await rm(backup, { force: true, recursive: true });
        },
        rollback: async () => {
          await rm(current, { force: true });
          await rename(backup, current);
        }
      };
    } finally {
      await rm(next, { force: true }).catch(() => undefined);
    }
  }

  private async stopManagedUpdater() {
    await this.stopRecordedProcess(
      'app-server-updater.pid',
      (args) => args.length === 4 && args[1] === 'app-server' &&
        args[2] === 'daemon' && args[3] === 'pid-update-loop'
    );
  }

  private async stopOrphanedAppServer() {
    const stopped = await this.stopRecordedProcess(
      'app-server.pid',
      (args) => args.length === 5 && args[1] === 'app-server' &&
        args[2] === '--remote-control' && args[3] === '--listen' &&
        args[4] === 'unix://'
    );
    if (!stopped) {
      throw new CodexOperationUncertainError(
        'The incompatible managed Codex app-server could not be stopped safely.'
      );
    }
  }

  private async stopRecordedProcess(
    fileName: string,
    matchesArguments: (args: string[]) => boolean
  ) {
    if (this.platform !== 'linux') return false;
    const codexHome = resolveCodexHome(this.environment);
    const pidPath = join(codexHome, 'app-server-daemon', fileName);
    const record = await readPidRecord(pidPath);
    if (!record) return false;
    const managedProcess = await this.readManagedProcess(record.pid);
    if (!managedProcess) return false;
    if (managedProcess.processStartTime !== record.processStartTime) {
      throw new Error('Doctor refused to stop a managed Codex process with a reused PID.');
    }
    const standaloneRoot = join(codexHome, 'packages', 'standalone');
    if (!pathWithin(
      standaloneRoot,
      managedProcess.executable.replace(/ \(deleted\)$/, '')
    )) {
      throw new Error('Doctor refused to stop a process outside the managed Codex package tree.');
    }
    if (!matchesArguments(managedProcess.arguments)) {
      throw new Error('Doctor refused to stop a managed Codex process with unexpected arguments.');
    }
    try {
      this.terminateProcess(record.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return true;
    }
    const deadline = Date.now() + processStopTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.processExists(record.pid)) return true;
      await this.sleep(processStopPollMs);
    }
    throw new CodexOperationUncertainError(
      `The verified managed Codex process ${record.pid} did not stop.`
    );
  }

  private async verifyRepair() {
    let evidence = await this.inspect();
    for (let attempt = 0; attempt < 9; attempt++) {
      if (evidence.state === 'ready' && evidence.remoteControlEnabled &&
          evidence.remoteControlState === 'connected' && evidence.paired) return evidence;
      if (evidence.state === 'authorization-required') return evidence;
      await this.sleep(250);
      evidence = await this.inspect();
    }
    throw new CodexOperationUncertainError(
      `Managed Codex readiness was not established before the repair timeout (${evidence.state}).`
    );
  }

  private async managedBinaryInstalled() {
    const codexHome = resolveCodexHome(this.environment);
    const standaloneRoot = join(codexHome, 'packages', 'standalone');
    const path = join(standaloneRoot, 'current', 'codex');
    try {
      const [resolvedRoot, resolvedPath] = await Promise.all([
        realpath(standaloneRoot),
        realpath(path)
      ]);
      const relativePath = relative(resolvedRoot, resolvedPath);
      if (isAbsolute(relativePath) || relativePath === '..' ||
          relativePath.startsWith(`..${sep}`)) return false;
      const status = await lstat(resolvedPath);
      return status.isFile() && !status.isSymbolicLink() &&
        (status.mode & 0o111) !== 0 && (status.mode & 0o022) === 0;
    } catch {
      return false;
    }
  }

  private async managedBinaryMatches(binaryPath: string) {
    if (!await this.managedBinaryInstalled()) return false;
    const managedPath = join(
      resolveCodexHome(this.environment), 'packages', 'standalone', 'current', 'codex'
    );
    try {
      const [managedDigest, signedDigest] = await Promise.all([
        hashFile(managedPath),
        hashFile(binaryPath)
      ]);
      return managedDigest === signedDigest;
    } catch {
      return false;
    }
  }

  private async binaryVersion(binaryPath: string) {
    const result = await this.run(binaryPath, ['--version'], this.environment);
    const match = result.exitCode === 0
      ? /^codex-cli\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\s*$/.exec(
          result.stdout
        )
      : undefined;
    return match?.[1];
  }

  private lifecycle(binaryPath: string, command: string) {
    return this.run(
      binaryPath,
      ['app-server', 'daemon', command],
      this.environment
    ).then((result) => {
      if (result.exitCode !== 0) return undefined;
      return parseLifecycle(result.stdout);
    });
  }

  private async requireLifecycle(binaryPath: string, command: string) {
    const result = await this.lifecycle(binaryPath, command);
    if (!result) {
      throw new CodexOperationUncertainError(
        `The managed Codex daemon ${command} operation could not be confirmed.`
      );
    }
    return result;
  }

  private requireBinary() {
    const binaryPath = this.resolveBinary();
    if (!binaryPath) throw new Error('A compatible signed Codex runtime is not installed.');
    return binaryPath;
  }

  private requireSupported() {
    if (this.platform === 'win32') {
      throw new Error('Managed Codex daemon lifecycle is not supported on Windows.');
    }
  }

  private serializeMutation<Result>(action: () => Promise<Result>) {
    const pending = this.mutationTail.then(action);
    this.mutationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private result(
    operation: CodexDaemonOperation,
    operationId: string,
    evidence: CodexDaemonEvidence
  ): CodexDaemonConnectorResult {
    return {
      evidence,
      operation,
      operationId,
      state: codexDaemonResultStateForEvidence(evidence)
    };
  }
}

function baseEvidence(
  checkedAt: string,
  state: CodexDaemonEvidence['state']
): CodexDaemonEvidence {
  return {
    authenticated: false,
    checkedAt,
    compatible: false,
    installed: false,
    paired: false,
    reachable: false,
    remoteControlEnabled: false,
    remoteControlState: 'unknown',
    running: false,
    state
  };
}

function parseLifecycle(stdout: string): LifecycleStatus | undefined {
  if (Buffer.byteLength(stdout) > 32_768) return undefined;
  try {
    const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return {
      appServerVersion: boundedString(value.appServerVersion),
      backend: boundedString(value.backend),
      cliVersion: boundedString(value.cliVersion),
      managedCodexVersion: boundedString(value.managedCodexVersion),
      remoteControlEnabled: typeof value.remoteControlEnabled === 'boolean'
        ? value.remoteControlEnabled
        : undefined,
      socketPath: boundedString(value.socketPath, 4_096),
      status: boundedString(value.status)
    };
  } catch {
    return undefined;
  }
}

function safeSocketPath(value: string | undefined, environment: NodeJS.ProcessEnv) {
  const expected = codexAppServerSocketPath(environment);
  if (!value) return undefined;
  try {
    const actualCanonical = join(realpathSync(dirname(value)), basename(value));
    const expectedCanonical = join(realpathSync(dirname(expected)), basename(expected));
    return actualCanonical === expectedCanonical ? value : undefined;
  } catch {
    return value === expected ? value : undefined;
  }
}

function readAuthenticated(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.requiresOpenaiAuth === false || (
    record.requiresOpenaiAuth === true && record.account !== null && record.account !== undefined
  );
}

function readRemoteControl(value: unknown): {
  environmentId?: string;
  state: CodexDaemonEvidence['remoteControlState'];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown' };
  const source = 'status' in value && typeof (value as Record<string, unknown>).status === 'object'
    ? (value as Record<string, unknown>).status
    : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { state: 'unknown' };
  const record = source as Record<string, unknown>;
  const rawState = typeof record.status === 'string'
    ? record.status
    : typeof record.state === 'string'
      ? record.state
      : 'unknown';
  const state = ['disabled', 'connecting', 'connected', 'errored'].includes(rawState)
    ? rawState as CodexDaemonEvidence['remoteControlState']
    : 'unknown';
  return {
    ...(boundedString(record.environmentId) ? {
      environmentId: boundedString(record.environmentId)
    } : {}),
    state
  };
}

function boundedString(value: unknown, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function boundedTimeout(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) >= 10 && Number(value) <= 10_000
    ? Number(value)
    : fallback;
}

async function hashFile(path: string) {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (value) => hash.update(value));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function validateManagedRelease(
  releasesRoot: string,
  releaseDirectory: string,
  expectedDigest: string
) {
  const [releaseStatus, resolvedRoot, resolvedRelease] = await Promise.all([
    lstat(releaseDirectory),
    realpath(releasesRoot),
    realpath(releaseDirectory)
  ]);
  if (!releaseStatus.isDirectory() || releaseStatus.isSymbolicLink() ||
      !pathWithin(resolvedRoot, resolvedRelease)) {
    throw new Error('The existing managed Codex release path is unsafe.');
  }
  const binary = join(releaseDirectory, 'bin', 'codex');
  const binaryStatus = await lstat(binary);
  if (!binaryStatus.isFile() || binaryStatus.isSymbolicLink() ||
      (binaryStatus.mode & 0o111) === 0 || (binaryStatus.mode & 0o022) !== 0 ||
      await hashFile(binary) !== expectedDigest) {
    throw new Error('The existing managed Codex release does not match the signed runtime.');
  }
}

async function readPidRecord(path: string) {
  const body = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!body) return undefined;
  if (body.byteLength > 4_096) throw new Error('The managed Codex PID record is too large.');
  try {
    const value = JSON.parse(body.toString()) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 1) {
      throw new Error('The managed Codex PID record is invalid.');
    }
    const processStartTime = boundedString(value.processStartTime);
    if (!processStartTime) throw new Error('The managed Codex PID record is invalid.');
    return { pid: Number(value.pid), processStartTime };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('The managed Codex PID record is invalid.');
    }
    throw error;
  }
}

function pathWithin(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path !== '' && !isAbsolute(path) && path !== '..' &&
    !path.startsWith(`..${sep}`);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function readLinuxManagedProcess(pid: number): Promise<ManagedProcess | undefined> {
  const processRoot = join('/proc', String(pid));
  const [executable, argumentsBody, processStartTime] = await Promise.all([
    readlink(join(processRoot, 'exe')).catch(() => undefined),
    readFile(join(processRoot, 'cmdline')).catch(() => undefined),
    readProcessStartTime(pid)
  ]);
  if (!executable || !argumentsBody || !processStartTime) return undefined;
  if (argumentsBody.byteLength > processArgumentLimit) {
    throw new Error('The managed Codex process command line is too large.');
  }
  return {
    arguments: argumentsBody.toString().replace(/\0$/, '').split('\0'),
    executable,
    processStartTime
  };
}

function readProcessStartTime(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-p', String(pid), '-o', 'lstart='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    let stdout = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1_000);
    child.stdout.on('data', (value) => {
      stdout += String(value);
      if (Buffer.byteLength(stdout) > 256) child.kill('SIGKILL');
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      const value = exitCode === 0 ? boundedString(stdout.trim()) : undefined;
      resolve(value);
    });
  });
}

function runCodexCommand(
  binaryPath: string,
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    let stdout = '';
    let exceeded = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (value) => {
      stdout += String(value);
      if (Buffer.byteLength(stdout) > 32_768) {
        exceeded = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout: '' });
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode: exceeded ? null : exitCode, stdout: exceeded ? '' : stdout });
    });
  });
}
