import { lstat, open, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

export const connectorRuntimeSupervisorOutcomeSchema =
  'project-space.connector-runtime-supervisor-outcome/v1' as const;

export interface ConnectorRuntimeSupervisorCommitOutcome {
  action: 'commit';
  operationId: string;
  schema: typeof connectorRuntimeSupervisorOutcomeSchema;
}

const maximumOutcomeBytes = 64 * 1024;
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCommitOutcome(value: unknown): value is ConnectorRuntimeSupervisorCommitOutcome {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 && keys[0] === 'action' && keys[1] === 'operationId' &&
    keys[2] === 'schema' && value.action === 'commit' &&
    typeof value.operationId === 'string' && operationIdPattern.test(value.operationId) &&
    value.schema === connectorRuntimeSupervisorOutcomeSchema;
}

function outcomeBody(outcome: ConnectorRuntimeSupervisorCommitOutcome) {
  return `${JSON.stringify(outcome)}\n`;
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ConnectorRuntimeSupervisorOutcomeReader {
  constructor(private readonly path: string) {
    if (!isAbsolute(path) || basename(path) !== 'outcome.json') {
      throw new Error('The connector runtime supervisor outcome path is invalid.');
    }
  }

  async read(): Promise<ConnectorRuntimeSupervisorCommitOutcome | undefined> {
    const before = await lstat(this.path).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (!before) return undefined;
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 ||
        before.size > maximumOutcomeBytes || (before.mode & 0o077) !== 0) {
      throw new Error('The connector runtime supervisor outcome file is unsafe.');
    }
    const handle = await open(this.path, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
          opened.size !== before.size) {
        throw new Error('The connector runtime supervisor outcome changed while opening.');
      }
      const body = await handle.readFile('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error('The connector runtime supervisor outcome is invalid.');
      }
      if (!isCommitOutcome(parsed) || body !== outcomeBody(parsed)) {
        throw new Error('The connector runtime supervisor outcome is invalid.');
      }
      return parsed;
    } finally {
      await handle.close();
    }
  }

  async waitForCommit(
    operationId: string,
    options: { pollIntervalMs?: number; timeoutMs?: number } = {}
  ) {
    if (!operationIdPattern.test(operationId)) {
      throw new Error('The connector runtime maintenance operation is invalid.');
    }
    const timeoutMs = options.timeoutMs ?? 2 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000 ||
        !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
      throw new Error('The connector runtime supervisor outcome wait is invalid.');
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const outcome = await this.read();
      if (outcome) {
        if (outcome.operationId !== operationId) {
          throw new Error('The connector runtime supervisor outcome is for another operation.');
        }
        return outcome;
      }
      if (Date.now() >= deadline) {
        throw new Error('The connector runtime supervisor did not durably accept the commit.');
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  async acknowledgeCommit(operationId: string) {
    const outcome = await this.read();
    if (!outcome) return false;
    if (outcome.operationId !== operationId) {
      throw new Error('The connector runtime supervisor outcome is for another operation.');
    }
    await rm(this.path);
    await syncDirectory(dirname(this.path));
    return true;
  }
}

export async function recoverConnectorRuntimeSupervisorOutcome(input: {
  commit(operationId: string): Promise<unknown>;
  environment: NodeJS.ProcessEnv;
}) {
  if (input.environment.PROJECT_SPACE_INSTALL_SOURCE !== 'managed') return false;
  const path = input.environment.PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE?.trim();
  if (!path) return false;
  const reader = new ConnectorRuntimeSupervisorOutcomeReader(path);
  const outcome = await reader.read();
  if (!outcome) return false;
  await input.commit(outcome.operationId);
  await reader.acknowledgeCommit(outcome.operationId);
  if (input.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID?.trim() ===
      outcome.operationId &&
      input.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE ===
        'pending-health-check') {
    delete input.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID;
    delete input.environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE;
  }
  return true;
}
