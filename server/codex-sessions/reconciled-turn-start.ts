import type {
  CodexStartTurnInput,
  CodexThreadResult,
  CodexTurnResult
} from './contracts';
import type { CodexSessionManager } from './manager';
import { CodexOperationUncertainError } from './operation-ledger';
import { validateIdentifier } from './validation';

type ReconciledTurnManager = Pick<
  CodexSessionManager,
  | 'operationSnapshot'
  | 'readThread'
  | 'reconcileOperationCompleted'
  | 'reconcileOperationNotApplied'
  | 'startTurn'
>;

type ReconciliationThread = CodexThreadResult | { unmaterialized: true };

export async function startTurnWithReadReconciliation(
  manager: ReconciledTurnManager,
  input: CodexStartTurnInput
): Promise<CodexTurnResult> {
  const before = await readThreadForReconciliation(manager, input.threadId);
  const persisted = manager.operationSnapshot()
    .find((operation) => operation.operationId === input.operationId);
  if (persisted?.state === 'uncertain') {
    const matchingTurnIds = turnsWithPrompt(before, input.prompt);
    if (matchingTurnIds.length === 1) {
      const result = { turn: { id: matchingTurnIds[0]! } };
      await manager.reconcileOperationCompleted(input.operationId, result);
      return result;
    }
    if (matchingTurnIds.length !== 0 || !provesNoActiveTurn(before)) {
      throw reconciliationError();
    }
    await manager.reconcileOperationNotApplied(input.operationId);
    return manager.startTurn(input);
  }

  const knownTurnIds = turnIds(before);
  try {
    return await manager.startTurn(input);
  } catch (error) {
    if (!(error instanceof CodexOperationUncertainError)) throw error;
  }

  const after = await readThreadForReconciliation(manager, input.threadId);
  const addedTurnIds = [...turnIds(after)].filter((turnId) => !knownTurnIds.has(turnId));
  const matchingAddedTurnIds = turnsWithPrompt(after, input.prompt)
    .filter((turnId) => addedTurnIds.includes(turnId));
  if (addedTurnIds.length === 1 && matchingAddedTurnIds.length === 1) {
    const result = { turn: { id: matchingAddedTurnIds[0]! } };
    await manager.reconcileOperationCompleted(input.operationId, result);
    return result;
  }
  if (addedTurnIds.length !== 0 || !provesNoActiveTurn(after)) {
    throw reconciliationError();
  }

  await manager.reconcileOperationNotApplied(input.operationId);
  return manager.startTurn(input);
}

async function readThreadForReconciliation(
  manager: Pick<CodexSessionManager, 'readThread'>,
  threadId: string
): Promise<ReconciliationThread> {
  try {
    return await manager.readThread(threadId, true);
  } catch (error) {
    if (isUnmaterializedThread(error)) return { unmaterialized: true };
    throw error;
  }
}

function isUnmaterializedThread(error: unknown) {
  return error instanceof Error && error.message.includes(
    'is not materialized yet; includeTurns is unavailable before first user message'
  );
}

function turnsWithPrompt(result: ReconciliationThread, prompt: string) {
  if ('unmaterialized' in result) return [];
  const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
  return turns.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const turn = value as Record<string, unknown>;
    const id = turn.id;
    if (typeof id !== 'string' || !turnContainsPrompt(turn, prompt)) return [];
    try {
      return [validateIdentifier(id, 'turnId')];
    } catch {
      return [];
    }
  });
}

function turnContainsPrompt(turn: Record<string, unknown>, prompt: string) {
  if (!Array.isArray(turn.items)) return false;
  return turn.items.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    if (item.type !== 'userMessage' || !Array.isArray(item.content)) return false;
    const text = item.content.flatMap((content) => (
      content && typeof content === 'object' && !Array.isArray(content) &&
      (content as Record<string, unknown>).type === 'text' &&
      typeof (content as Record<string, unknown>).text === 'string'
        ? [(content as Record<string, unknown>).text as string]
        : []
    )).join('');
    return text === prompt;
  });
}

function turnIds(result: ReconciliationThread) {
  if ('unmaterialized' in result) return new Set<string>();
  const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
  return new Set(turns.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const id = (value as Record<string, unknown>).id;
    if (typeof id !== 'string') return [];
    try {
      return [validateIdentifier(id, 'turnId')];
    } catch {
      return [];
    }
  }));
}

function provesNoActiveTurn(result: ReconciliationThread) {
  if ('unmaterialized' in result) return true;
  return result.thread.status?.type === 'idle' || result.thread.status?.type === 'notLoaded';
}

function reconciliationError() {
  return new CodexOperationUncertainError(
    'The Codex turn outcome could not be reconciled from the thread.'
  );
}
