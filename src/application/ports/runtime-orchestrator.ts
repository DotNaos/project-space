import type { RuntimeSession } from '@/domain';

export interface RuntimeOrchestrator {
  listSessions(worktreeId: string): Promise<RuntimeSession[]>;
}
