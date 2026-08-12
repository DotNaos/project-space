import type { ConnectorCompatibilitySurface } from './contracts';

export type ConnectorCompatibilityCommandKind =
  | 'chat'
  | 'dev-server-inspect'
  | 'dev-server-list'
  | 'dev-server-start'
  | 'dev-server-stop'
  | 'worktree-action'
  | 'filesystem-directory'
  | 'filesystem-file'
  | 'filesystem-root'
  | 'folder-create'
  | 'folder-delete'
  | 'folder-rename'
  | 'models'
  | 'terminal'
  | 'worktrees';

export function successfulCompatibilityResult(
  kind: ConnectorCompatibilityCommandKind,
  value: unknown
) {
  if (kind === 'chat') return value === undefined;
  if (kind === 'worktrees') return Array.isArray(value);
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (kind === 'terminal') return result.exitCode === 0;
  if (kind.startsWith('filesystem-') || kind.startsWith('folder-')) {
    return result.status === 'success';
  }
  if (kind.startsWith('dev-server-')) {
    return result.capability === 'configured' && result.state !== 'error';
  }
  if (kind === 'worktree-action') {
    if (result.state === 'error' || result.capability === 'unavailable') return false;
    return !Array.isArray(result.steps) || result.steps.every((step) =>
      typeof step === 'object' && step !== null &&
      !['error', 'failed', 'unavailable'].includes(
        String((step as Record<string, unknown>).state)
      )
    );
  }
  if (kind === 'models') return result.status !== 'error';
  return false;
}

export function successfulWorkspaceCompatibilityResult(input: {
  operation: 'cancel' | 'start' | 'status';
  state: string;
}) {
  if (input.operation === 'cancel') return input.state === 'cancelled';
  if (input.operation === 'start') {
    return input.state === 'queued' || input.state === 'running' ||
      input.state === 'completed';
  }
  return input.state === 'queued' || input.state === 'running' ||
    input.state === 'completed' || input.state === 'cancelled';
}

export function compatibilitySurfaceForPendingKind(
  kind: ConnectorCompatibilityCommandKind
): ConnectorCompatibilitySurface | undefined {
  if (kind.startsWith('dev-server-')) return 'connector.dev-server.command.v1';
  if (kind === 'worktrees' || kind === 'worktree-action') {
    return 'connector.project-registry.websocket.v2';
  }
  if (kind === 'models') return 'connector.codex-models.websocket.v1';
  if (kind === 'chat') return 'connector.codex-chat.websocket.v1';
  if (kind === 'terminal' || kind.startsWith('filesystem-') || kind.startsWith('folder-')) {
    return 'connector.command.remote.v2';
  }
  return undefined;
}
