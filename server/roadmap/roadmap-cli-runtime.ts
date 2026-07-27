import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { createRoadmapCliHttpApi } from './roadmap-cli-http';

export interface ConfiguredRoadmapCliOptions {
  backend: Pick<
    ProjectSpaceBackend,
    | 'addRoadmapDependency'
    | 'getRoadmap'
    | 'removeRoadmapDependency'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

export function createConfiguredRoadmapCliHandler(options: ConfiguredRoadmapCliOptions) {
  const resolveActor = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });
  const handler = createRoadmapCliHttpApi({
    add: (actor, request) => runWithAuthSession(
      machineSession(actor.userId),
      () => options.backend.addRoadmapDependency(request)
    ),
    get: (actor, fullName) => runWithAuthSession(
      machineSession(actor.userId),
      () => options.backend.getRoadmap(fullName)
    ),
    remove: (actor, request) => runWithAuthSession(
      machineSession(actor.userId),
      () => options.backend.removeRoadmapDependency(request)
    )
  }, resolveActor);
  return (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) => handler(request, response, url);
}

function machineSession(userId: string) {
  return { login: 'project-cli', role: 'user' as const, userId };
}
