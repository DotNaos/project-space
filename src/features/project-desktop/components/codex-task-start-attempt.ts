export interface CodexTaskStartAttempt {
  connectorId: string;
  environmentId?: string;
  expectedBranch: string;
  expectedCommit: string;
  issue: number;
  operationId: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
  repositoryId: string;
}

const storagePrefix = 'project-space:codex-task-start:v1:';

function storageKey(input: Pick<
  CodexTaskStartAttempt,
  'connectorId' | 'environmentId' | 'issue' | 'physicalMachineId' | 'repositoryId'
>) {
  return `${storagePrefix}${encodeURIComponent(input.repositoryId)}:${input.issue}:` +
    `${encodeURIComponent(input.environmentId ?? input.physicalMachineId ?? input.connectorId)}`;
}

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function createCodexTaskStartOperationId(
  randomUUID: (() => string) | null = globalThis.crypto?.randomUUID?.bind(globalThis.crypto) ?? null
) {
  const suffix = randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `task:${suffix}`;
}

function isAttempt(value: unknown): value is CodexTaskStartAttempt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CodexTaskStartAttempt>;
  return (
    typeof candidate.connectorId === 'string' && candidate.connectorId.length > 0 &&
    typeof candidate.expectedBranch === 'string' && candidate.expectedBranch.length > 0 &&
    /^[a-f0-9]{40}$/i.test(candidate.expectedCommit ?? '') &&
    Number.isSafeInteger(candidate.issue) && Number(candidate.issue) > 0 &&
    typeof candidate.operationId === 'string' && candidate.operationId.startsWith('task:') &&
    typeof candidate.repositoryId === 'string' && candidate.repositoryId.length > 0
  );
}

export function readOrCreateCodexTaskStartAttempt(
  input: Omit<CodexTaskStartAttempt, 'operationId'>,
  createOperationId: () => string = createCodexTaskStartOperationId
) {
  const key = storageKey(input);
  const target = storage();
  if (target) {
    try {
      const restored = JSON.parse(target.getItem(key) ?? 'null') as unknown;
      if (isAttempt(restored)) return restored;
    } catch {
      target.removeItem(key);
    }
  }
  const attempt = { ...input, operationId: createOperationId() };
  try {
    target?.setItem(key, JSON.stringify(attempt));
  } catch {
    // The start can still be safely dispatched when browser storage is unavailable.
  }
  return attempt;
}

export function clearCodexTaskStartAttempt(
  input: Pick<CodexTaskStartAttempt, 'connectorId' | 'environmentId' | 'issue' | 'physicalMachineId' | 'repositoryId'>
) {
  try {
    storage()?.removeItem(storageKey(input));
  } catch {
    // Storage cleanup is best effort and must not break a confirmed start.
  }
}
