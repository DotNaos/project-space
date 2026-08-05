export interface CodexTaskStartAttempt {
  connectorId: string;
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
  'connectorId' | 'issue' | 'physicalMachineId' | 'repositoryId'
>) {
  return `${storagePrefix}${encodeURIComponent(input.repositoryId)}:${input.issue}:` +
    `${encodeURIComponent(input.physicalMachineId ?? input.connectorId)}`;
}

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
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
  createOperationId: () => string = () => `task:${globalThis.crypto.randomUUID()}`
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
  target?.setItem(key, JSON.stringify(attempt));
  return attempt;
}

export function clearCodexTaskStartAttempt(
  input: Pick<CodexTaskStartAttempt, 'connectorId' | 'issue' | 'physicalMachineId' | 'repositoryId'>
) {
  storage()?.removeItem(storageKey(input));
}
