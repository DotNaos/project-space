import type { RuntimeOrchestrator } from '@/application/ports/runtime-orchestrator';

export const placeholderRuntimeOrchestrator: RuntimeOrchestrator = {
  async listSessions() {
    return [];
  }
};
