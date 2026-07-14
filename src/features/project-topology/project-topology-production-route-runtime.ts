import type {
  CodexSessionOperationResult,
  CodexSessionsClient
} from '../../shared/codex-sessions-api';
import { TopologyExistingTaskActions } from './project-topology-actions';
import { createTopologyCodexTaskController } from './project-topology-codex-controller';
import { ProjectTopologyController } from './project-topology-controller';
import { ProjectTopologyTranscriptRegistry } from './project-topology-live-transcript';
import { createProjectTopologyProductionSource } from './project-topology-production-source';
import type { ProjectTopologyWorktreeSnapshot } from '../../shared/project-topology-api';

type ProjectTopologyProjectClient = Parameters<
  typeof createProjectTopologyProductionSource
>[0]['projectSpace'];

export interface ProjectTopologyProductionRouteRuntime {
  controller: ProjectTopologyController;
  dispose(): void;
  taskActions: TopologyExistingTaskActions<CodexSessionOperationResult>;
  transcriptRegistry: ProjectTopologyTranscriptRegistry;
}

export interface ProjectTopologyProductionRouteDependencies {
  codex: CodexSessionsClient;
  loadProjectWorktreeSnapshot?(
    signal?: AbortSignal
  ): Promise<ProjectTopologyWorktreeSnapshot>;
  projectSpace: ProjectTopologyProjectClient;
}

export function createProjectTopologyProductionRouteRuntime(
  dependencies: ProjectTopologyProductionRouteDependencies
): ProjectTopologyProductionRouteRuntime {
  const source = createProjectTopologyProductionSource(dependencies);
  const controller = new ProjectTopologyController(source, { includeTranscripts: false });
  const transcriptRegistry = new ProjectTopologyTranscriptRegistry(dependencies.codex);
  const taskActions = new TopologyExistingTaskActions(
    createTopologyCodexTaskController(dependencies.codex)
  );
  let disposed = false;

  return {
    controller,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      transcriptRegistry.dispose();
    },
    taskActions,
    transcriptRegistry
  };
}
