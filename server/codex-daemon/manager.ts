import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
  codexAppServerSocketPath
} from '../codex-sessions/websocket-transport';
import {
  commitManagedCodexBinarySelection,
  managedCodexBinaryInstalled,
  provisionExactManagedCodexBinary,
  restorePreviousManagedCodexBinary
} from './managed-binary';
import { recoverConnectorRuntimeSupervisorOutcome } from '../connector-runtime-supervisor-outcome';

type CommandResult = { exitCode: number | null; stdout: string };

export interface CodexDaemonManagerOptions {
  connectTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  manager: Pick<CodexSessionManager, 'executeManagedOperation'>;
  now?(): number;
  platform?: NodeJS.Platform;
  resolveBinary?(): string | undefined;
  rpcTimeoutMs?: number;
  run?(binaryPath: string, args: string[], environment: NodeJS.ProcessEnv): Promise<CommandResult>;
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
  private readonly resolveBinary: () => string | undefined;
  private readonly run: NonNullable<CodexDaemonManagerOptions['run']>;

  constructor(private readonly options: CodexDaemonManagerOptions) {
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.resolveBinary = options.resolveBinary ?? (() => resolveCodexBinary({
      environment: this.environment,
      platform: this.platform
    }).path);
    this.run = options.run ?? runCodexCommand;
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
      const managedInstalled = await managedCodexBinaryInstalled(this.environment);
      return {
        ...baseEvidence(checkedAt, managedInstalled ? 'stopped' : 'missing'),
        cliVersion: await this.binaryVersion(binaryPath),
        installed: managedInstalled
      };
    }
    const running = lifecycle.status === 'running' ||
      lifecycle.status === 'alreadyRunning' ||
      Boolean(lifecycle.appServerVersion);
    const managedInstalled = await managedCodexBinaryInstalled(this.environment);
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
        ...(lifecycle.backend ? { backend: lifecycle.backend } : {}),
        cliVersion: lifecycle.cliVersion,
        installed: managedInstalled,
        ...(lifecycle.managedCodexVersion
          ? { managedCodexVersion: lifecycle.managedCodexVersion }
          : {}),
        running: true
      };
    }
    if (!managedInstalled) {
      return {
        ...baseEvidence(checkedAt, 'missing'),
        appServerVersion: lifecycle.appServerVersion,
        ...(lifecycle.backend ? { backend: lifecycle.backend } : {}),
        cliVersion: lifecycle.cliVersion,
        ...(lifecycle.managedCodexVersion
          ? { managedCodexVersion: lifecycle.managedCodexVersion }
          : {}),
        running: true
      };
    }
    const socketPath = safeSocketPath(lifecycle.socketPath, this.environment);
    if (!socketPath) {
      return {
        ...baseEvidence(checkedAt, 'uncertain'),
        appServerVersion: lifecycle.appServerVersion,
        ...(lifecycle.backend ? { backend: lifecycle.backend } : {}),
        cliVersion: lifecycle.cliVersion,
        compatible,
        installed: managedInstalled,
        ...(lifecycle.managedCodexVersion
          ? { managedCodexVersion: lifecycle.managedCodexVersion }
          : {}),
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
        ...(lifecycle.backend ? { backend: lifecycle.backend } : {}),
        checkedAt,
        cliVersion: lifecycle.cliVersion,
        compatible,
        ...(remote.environmentId ? { environmentId: remote.environmentId } : {}),
        installed: managedInstalled,
        ...(lifecycle.managedCodexVersion
          ? { managedCodexVersion: lifecycle.managedCodexVersion }
          : {}),
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
        ...(lifecycle.backend ? { backend: lifecycle.backend } : {}),
        cliVersion: lifecycle.cliVersion,
        compatible,
        installed: managedInstalled,
        ...(lifecycle.managedCodexVersion
          ? { managedCodexVersion: lifecycle.managedCodexVersion }
          : {}),
        remoteControlEnabled: lifecycle.remoteControlEnabled === true,
        running: true
      };
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  async restoreMaintenanceSelection(operationId: string) {
    return this.serializeMutation(async () => {
      this.requireSupported();
      const binaryPath = this.requireBinary();
      const restored = await restorePreviousManagedCodexBinary({
        environment: this.environment,
        operationId
      });
      if (restored.found) {
        // A failed restart remains visible in the fresh evidence collected by
        // the reconnect path; the durable pointer restoration is the hard gate.
        await this.lifecycle(binaryPath, 'restart');
      }
      return restored;
    });
  }

  async commitMaintenanceSelection(operationId: string) {
    return this.serializeMutation(() => this.commitMaintenanceSelectionUnlocked(operationId));
  }

  async recoverMaintenanceSelectionOutcome() {
    return this.serializeMutation(() => recoverConnectorRuntimeSupervisorOutcome({
      commit: (operationId) => this.commitMaintenanceSelectionUnlocked(operationId),
      environment: this.environment
    }));
  }

  private async ensure() {
    this.requireSupported();
    const binaryPath = this.requireBinary();
    await this.provisionExactManagedBinary(binaryPath);
    await this.requireLifecycle(binaryPath, 'start');
    const evidence = await this.inspect();
    if (evidence.state !== 'incompatible') return evidence;
    await this.requireLifecycle(binaryPath, 'restart');
    return this.inspect();
  }

  private async restart() {
    this.requireSupported();
    const binaryPath = this.requireBinary();
    await this.provisionExactManagedBinary(binaryPath);
    await this.requireLifecycle(binaryPath, 'restart');
    return this.inspect();
  }

  private async binaryVersion(binaryPath: string) {
    const result = await this.run(binaryPath, ['--version'], this.environment);
    const match = result.exitCode === 0
      ? /^codex-cli\s+(\S+)\s*$/.exec(result.stdout)
      : undefined;
    return match?.[1];
  }

  private async provisionExactManagedBinary(binaryPath: string) {
    const version = await this.binaryVersion(binaryPath);
    if (!version) {
      throw new Error('The signed Codex runtime did not report an exact version.');
    }
    await provisionExactManagedCodexBinary({
      environment: this.environment,
      ...(this.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE ===
        'pending-health-check' &&
        this.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID?.trim()
        ? {
            operationId: this.environment
              .PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID.trim()
          }
        : {}),
      sourcePath: binaryPath,
      version
    });
  }

  private async commitMaintenanceSelectionUnlocked(operationId: string) {
    const committed = await commitManagedCodexBinarySelection({
      environment: this.environment,
      operationId
    });
    if (!committed.found) {
      throw new Error('The staged managed Codex selection is unavailable.');
    }
    return committed;
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
