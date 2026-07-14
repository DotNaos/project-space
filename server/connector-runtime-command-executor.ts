import { createHash, randomBytes, type KeyLike } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rm,
  unlink
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { canonicalJson } from './codex-sessions/canonical-json';
import {
  ConnectorRuntimeCommandReplayProtection,
  isConnectorRuntimeCommandWireRequest,
  verifyConnectorRuntimeCommandWireRequest,
  type ConnectorRuntimeCommandOperation,
  type ConnectorRuntimeCommandWireRequest
} from './connector-runtime-command-contract';
import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';

export const connectorRuntimeSupervisorControlSchema =
  'project-space.connector-runtime-supervisor-control/v1' as const;

export type ConnectorRuntimeCommandStage =
  | 'accepted'
  | 'staging'
  | 'validating'
  | 'verifying';

export interface ConnectorRuntimeCommandStageEvent {
  operation: ConnectorRuntimeCommandOperation;
  operationId: string;
  stage: ConnectorRuntimeCommandStage;
}

export interface ConnectorRuntimeCommandAcceptedResult {
  operation: ConnectorRuntimeCommandOperation;
  operationId: string;
  status: 'accepted';
}

export interface ConnectorRuntimeSupervisorStagedArtifact {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export type ConnectorRuntimeSupervisorControlRequest =
  | {
      command: ConnectorRuntimeCommandWireRequest;
      schema: typeof connectorRuntimeSupervisorControlSchema;
    }
  | {
      artifact: ConnectorRuntimeSupervisorStagedArtifact;
      command: ConnectorRuntimeCommandWireRequest;
      schema: typeof connectorRuntimeSupervisorControlSchema;
    };

export type ConnectorRuntimeCommandExecutorErrorCode =
  | 'control-conflict'
  | 'download-failed'
  | 'integrity-failed'
  | 'invalid-configuration';

export class ConnectorRuntimeCommandExecutorError extends Error {
  constructor(readonly code: ConnectorRuntimeCommandExecutorErrorCode) {
    super('The connector runtime command could not be accepted.');
    this.name = 'ConnectorRuntimeCommandExecutorError';
  }
}

type FetchArtifact = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorRuntimeCommandExecutorOptions {
  commandVerificationKey: KeyLike;
  controlFilePath: string;
  emitStage?(event: ConnectorRuntimeCommandStageEvent): void;
  expectedGeneration: number | (() => number);
  expectedMachineId: string;
  expectedTarget: ConnectorRuntimeReleaseTarget;
  fetchArtifact?: FetchArtifact;
  now?(): number;
  releaseVerificationKey?: Buffer | KeyLike | string;
  replayProtection?: ConnectorRuntimeCommandReplayProtection;
  shutdown(result: ConnectorRuntimeCommandAcceptedResult): Promise<void> | void;
  stagingDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isStagedArtifact(value: unknown): value is ConnectorRuntimeSupervisorStagedArtifact {
  return isRecord(value) && hasExactKeys(value, ['path', 'sha256', 'sizeBytes']) &&
    typeof value.path === 'string' && isAbsolute(value.path) &&
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0;
}

export function isConnectorRuntimeSupervisorControlRequest(
  value: unknown
): value is ConnectorRuntimeSupervisorControlRequest {
  if (!isRecord(value) || value.schema !== connectorRuntimeSupervisorControlSchema ||
      !isConnectorRuntimeCommandWireRequest(value.command)) return false;
  return value.command.plan.operation === 'restart'
    ? hasExactKeys(value, ['command', 'schema'])
    : hasExactKeys(value, ['artifact', 'command', 'schema']) && isStagedArtifact(value.artifact);
}

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new ConnectorRuntimeCommandExecutorError('invalid-configuration');
  }
  await chmod(path, 0o700);
}

function operationKey(operationId: string) {
  return createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 24);
}

async function publishExclusive(path: string, body: string) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (isRecord(error) && error.code === 'EEXIST') {
      throw new ConnectorRuntimeCommandExecutorError('control-conflict');
    }
    throw error;
  }
}

async function downloadArtifact(input: {
  artifact: NonNullable<ReturnType<typeof verifiedArtifact>>;
  fetchArtifact: FetchArtifact;
  operationId: string;
  stagingDirectory: string;
}) {
  const { artifact } = input;
  const key = operationKey(input.operationId);
  const partialPath = join(input.stagingDirectory, `.runtime-${key}.partial`);
  const finalPath = join(input.stagingDirectory, `runtime-${key}-${artifact.assetName}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await rm(partialPath, { force: true });
    const response = await input.fetchArtifact(artifact.downloadUrl, {
      credentials: 'omit',
      method: 'GET',
      redirect: 'follow'
    });
    if (!response.ok || !response.body) {
      throw new ConnectorRuntimeCommandExecutorError('download-failed');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) !== artifact.sizeBytes)) {
      throw new ConnectorRuntimeCommandExecutorError('integrity-failed');
    }

    handle = await open(partialPath, 'wx', 0o600);
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > artifact.sizeBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ConnectorRuntimeCommandExecutorError('integrity-failed');
      }
      hash.update(value);
      await handle.write(value);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (received !== artifact.sizeBytes || hash.digest('hex') !== artifact.sha256) {
      throw new ConnectorRuntimeCommandExecutorError('integrity-failed');
    }
    await link(partialPath, finalPath);
    await unlink(partialPath);
    return {
      path: finalPath,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes
    } satisfies ConnectorRuntimeSupervisorStagedArtifact;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (error instanceof ConnectorRuntimeCommandExecutorError) throw error;
    throw new ConnectorRuntimeCommandExecutorError('download-failed');
  }
}

function verifiedArtifact(
  value: ReturnType<typeof verifyConnectorRuntimeCommandWireRequest>
) {
  return value.artifact;
}

export class ConnectorRuntimeCommandExecutor {
  private readonly fetchArtifact: FetchArtifact;
  private readonly replay: ConnectorRuntimeCommandReplayProtection;

  constructor(private readonly options: ConnectorRuntimeCommandExecutorOptions) {
    if (!isAbsolute(options.controlFilePath) || !isAbsolute(options.stagingDirectory) ||
        !options.expectedMachineId.trim() || !Number.isSafeInteger(this.generation()) ||
        this.generation() <= 0) {
      throw new ConnectorRuntimeCommandExecutorError('invalid-configuration');
    }
    this.fetchArtifact = options.fetchArtifact ?? ((url, init) => fetch(url, init));
    this.replay = options.replayProtection ?? new ConnectorRuntimeCommandReplayProtection();
  }

  async execute(value: unknown): Promise<ConnectorRuntimeCommandAcceptedResult> {
    const verified = verifyConnectorRuntimeCommandWireRequest(
      value,
      this.options.commandVerificationKey,
      {
        expectedGeneration: this.generation(),
        expectedMachineId: this.options.expectedMachineId,
        expectedTarget: this.options.expectedTarget,
        now: this.options.now?.(),
        releaseVerificationKey: this.options.releaseVerificationKey,
        replayProtection: this.replay
      }
    );
    const command = value as ConnectorRuntimeCommandWireRequest;
    this.emit(verified.plan, 'validating');
    await ensurePrivateDirectory(dirname(this.options.controlFilePath));
    await ensurePrivateDirectory(this.options.stagingDirectory);

    let staged: ConnectorRuntimeSupervisorStagedArtifact | undefined;
    let controlPublished = false;
    try {
      if (verified.plan.operation === 'update') {
        if (!verified.artifact) {
          throw new ConnectorRuntimeCommandExecutorError('integrity-failed');
        }
        this.emit(verified.plan, 'staging');
        staged = await downloadArtifact({
          artifact: verified.artifact,
          fetchArtifact: this.fetchArtifact,
          operationId: verified.plan.operationId,
          stagingDirectory: this.options.stagingDirectory
        });
        this.emit(verified.plan, 'verifying');
      }
      const control: ConnectorRuntimeSupervisorControlRequest = staged
        ? { artifact: staged, command, schema: connectorRuntimeSupervisorControlSchema }
        : { command, schema: connectorRuntimeSupervisorControlSchema };
      if (!isConnectorRuntimeSupervisorControlRequest(control)) {
        throw new ConnectorRuntimeCommandExecutorError('invalid-configuration');
      }
      await publishExclusive(
        this.options.controlFilePath,
        `${canonicalJson(control)}\n`
      );
      controlPublished = true;
      const accepted = {
        operation: verified.plan.operation,
        operationId: verified.plan.operationId,
        status: 'accepted'
      } as const;
      this.emit(verified.plan, 'accepted');
      await this.options.shutdown(accepted);
      return accepted;
    } catch (error) {
      if (staged && !controlPublished) await rm(staged.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emit(
    plan: { operation: ConnectorRuntimeCommandOperation; operationId: string },
    stage: ConnectorRuntimeCommandStage
  ) {
    try {
      this.options.emitStage?.({ operation: plan.operation, operationId: plan.operationId, stage });
    } catch {
      // Progress reporting cannot invalidate an already-authorized maintenance command.
    }
  }

  private generation() {
    return typeof this.options.expectedGeneration === 'function'
      ? this.options.expectedGeneration()
      : this.options.expectedGeneration;
  }
}
