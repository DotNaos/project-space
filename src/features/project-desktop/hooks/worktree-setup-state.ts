export function setupOperationKey(worktreeId: string, setupStepId: string) {
  return `${worktreeId}\u0000${setupStepId}`;
}

export function addSetupOperation(current: Set<string>, operationKey: string) {
  return new Set(current).add(operationKey);
}

export function removeSetupOperation(current: Set<string>, operationKey: string) {
  const next = new Set(current);
  next.delete(operationKey);
  return next;
}

export function hasPendingWorktreeSetup(current: Set<string>, worktreeId: string) {
  const prefix = `${worktreeId}\u0000`;
  return Array.from(current).some((key) => key.startsWith(prefix));
}
