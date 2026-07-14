import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';
import { connectorRuntimeRecord } from './connector-build-info';

export const connectorRuntimeReadyFileEnvironment = 'PROJECT_CONNECTOR_READY_FILE';
export const connectorRuntimeReadyAttemptNonceEnvironment =
  'PROJECT_CONNECTOR_READY_ATTEMPT_NONCE';
export const connectorRuntimeReadinessSchema =
  'project-space.connector-runtime-ready/v2' as const;

interface ConnectorRuntimeReadinessDocument {
  schema: typeof connectorRuntimeReadinessSchema;
  machineId: string;
  buildId: string;
  releaseId: string;
  attemptNonce: string;
}

function readinessConfiguration(environment: NodeJS.ProcessEnv) {
  const value = environment[connectorRuntimeReadyFileEnvironment]?.trim();
  const attemptNonce =
    environment[connectorRuntimeReadyAttemptNonceEnvironment]?.trim();
  if (!value && !attemptNonce) return undefined;
  if (
    !value ||
    !attemptNonce ||
    value !== environment[connectorRuntimeReadyFileEnvironment] ||
    attemptNonce !== environment[connectorRuntimeReadyAttemptNonceEnvironment] ||
    !isAbsolute(value) ||
    basename(value) !== 'connector-ready.json' ||
    /[\r\n\0]/.test(value) ||
    !/^[a-f0-9]{64}$/.test(attemptNonce)
  ) {
    throw new Error('Connector readiness configuration is invalid.');
  }
  return { attemptNonce, path: value };
}

async function inspectSafeDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Connector readiness directory is unsafe.');
  }
  await chmod(path, 0o700);
}

async function rejectUnsafeDestination(path: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Connector readiness proof path is unsafe.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function publishPrivateAtomic(path: string, document: ConnectorRuntimeReadinessDocument) {
  const directory = dirname(path);
  await inspectSafeDirectory(directory);
  await rejectUnsafeDestination(path);
  const temporary = join(
    directory,
    `.connector-ready-${randomBytes(12).toString('hex')}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function publishConnectorRuntimeReadiness(
  registry: ConnectorProjectRegistryResult,
  authenticatedMachineId: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  const configuration = readinessConfiguration(environment);
  if (!configuration) return false;
  const runtime = registry.connector.runtime;
  const compiled = connectorRuntimeRecord(environment);
  if (
    registry.connector.machineId !== authenticatedMachineId ||
    !runtime ||
    runtime.buildId !== compiled.buildId ||
    runtime.releaseId !== compiled.releaseId
  ) {
    throw new Error('Connector readiness identity does not match the authenticated build.');
  }
  await publishPrivateAtomic(configuration.path, {
    schema: connectorRuntimeReadinessSchema,
    machineId: authenticatedMachineId,
    buildId: compiled.buildId,
    releaseId: compiled.releaseId,
    attemptNonce: configuration.attemptNonce
  });
  return true;
}
