import { describe, expect, test } from 'bun:test';
import type { CodexSessionsClient } from '../../src/shared/codex-sessions-api';
import {
  createProjectTopologyProductionRouteRuntime
} from '../../src/features/project-topology/project-topology-production-route-runtime';
import { ProjectTopologyController } from '../../src/features/project-topology/project-topology-controller';
import { ProjectTopologyTranscriptRegistry } from '../../src/features/project-topology/project-topology-live-transcript';
import { TopologyExistingTaskActions } from '../../src/features/project-topology/project-topology-actions';

function unusedCodexClient(): CodexSessionsClient {
  const unused = async () => {
    throw new Error('The disposed route must not call its client.');
  };
  return {
    approve: unused,
    continue: unused,
    interrupt: unused,
    list: unused,
    read: unused,
    respondToUserInput: unused,
    subscribe: () => () => undefined
  };
}

function unusedProjectSpaceClient() {
  const unused = async () => {
    throw new Error('The disposed route must not call its project client.');
  };
  return {
    discoverProjectWorktrees: unused,
    getConnectorOverview: unused,
    getDeployedEnvironmentStatus: unused,
    getGitHubRepositoryDetails: unused,
    loadProjectDiscovery: unused
  };
}

describe('project topology production route runtime', () => {
  test('composes and safely disposes the controller, live registry, and action boundary', async () => {
    const runtime = createProjectTopologyProductionRouteRuntime({
      codex: unusedCodexClient(),
      projectSpace: unusedProjectSpaceClient()
    });

    expect(runtime.controller).toBeInstanceOf(ProjectTopologyController);
    expect(runtime.transcriptRegistry).toBeInstanceOf(ProjectTopologyTranscriptRegistry);
    expect(runtime.taskActions).toBeInstanceOf(TopologyExistingTaskActions);
    expect(runtime.controller.getState()).toEqual({ state: 'checking' });

    runtime.dispose();
    runtime.dispose();

    expect(await runtime.controller.refresh()).toEqual({ state: 'checking' });
    expect(runtime.controller.subscribe(() => undefined)).toBeFunction();
  });
});
