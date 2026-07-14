import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import type {
  ConnectorHubMessage,
  ConnectorMachineMessage
} from './connector-command-protocol';

type WorktreeListMessage = Extract<ConnectorMachineMessage, { type: 'worktrees.list' }>;
type CancellableWorktreeLoader = (
  projectPath: string,
  machineId?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
) => ReturnType<ProjectSpaceBackend['loadProjectWorktrees']>;

export function createProjectConnectorWorktreeLoads(
  backend: ProjectSpaceBackend,
  send: (message: ConnectorHubMessage) => void
) {
  const running = new Map<string, AbortController>();
  const load: CancellableWorktreeLoader = typeof backend.loadProjectWorktrees === 'function'
    ? backend.loadProjectWorktrees.bind(backend) as CancellableWorktreeLoader
    : async () => {
        throw new Error('This connector does not provide worktree inventory.');
      };

  return {
    cancel(id: string) {
      const controller = running.get(id);
      if (!controller) return false;
      running.delete(id);
      controller.abort(new Error('The hub cancelled this worktree inventory request.'));
      return true;
    },
    cancelAll() {
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
    start(message: WorktreeListMessage) {
      const controller = new AbortController();
      running.set(message.id, controller);
      void load(message.payload.projectPath, undefined, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) {
            send({ id: message.id, payload: result, type: 'worktrees.result' });
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            send({
              id: message.id,
              payload: {
                message: error instanceof Error ? error.message : 'Git worktree discovery failed.'
              },
              type: 'worktrees.error'
            });
          }
        })
        .finally(() => {
          if (running.get(message.id) === controller) running.delete(message.id);
        });
    }
  };
}
