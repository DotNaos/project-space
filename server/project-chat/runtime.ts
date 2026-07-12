import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';

import {
  getProjectChatRepository,
  isDatabaseConfigured
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  type ProjectSpaceAuthSession
} from '../local-auth-store';
import {
  createProjectChatAuthContextResolver,
  type ProjectChatAuthenticatedMachine,
  type ProjectChatHumanSession
} from './auth-context';
import { readProjectChatAccountProfile } from './account-profile';
import { createProjectChatHttpApi, ProjectChatAccessError } from './http-api';
import { InMemoryProjectChatRepository } from './memory-store';
import type { ProjectChatRepository } from './repository';
import { ProjectChatRetentionWorker } from './retention-worker';
import { ProjectChatService } from './service';
import { createProjectChatProjectProvider } from './project-catalog';
import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';

type MaybePromise<Value> = Value | Promise<Value>;

export interface ProjectChatRuntime {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<boolean>;
  start(): void;
  stop(): void;
}

export interface ProjectChatRuntimeOptions {
  authenticateMachine?(input: {
    machineId: string;
    token: string;
  }): MaybePromise<ProjectChatAuthenticatedMachine | null>;
  backend?: Pick<ProjectSpaceBackend, 'getConnectorOverview' | 'getGitHubCatalog' | 'loadProjectDiscovery'>;
  authRequired?: () => boolean;
  databaseConfigured?: () => boolean;
  getPersistentRepository?: () => Promise<ProjectChatRepository>;
  localDevelopmentHuman?: ProjectChatHumanSession;
  onRetentionError?: () => void;
  readHumanSession?(
    request: IncomingMessage
  ): MaybePromise<ProjectChatHumanSession | null>;
  repository?: ProjectChatRepository;
  spaceId?: string;
}

export async function createProjectChatRuntime(
  options: ProjectChatRuntimeOptions = {}
): Promise<ProjectChatRuntime> {
  const authRequired = options.authRequired ?? isProjectSpaceAuthRequired;
  const persistentDatabaseConfigured =
    options.repository !== undefined ||
    (options.databaseConfigured ?? isDatabaseConfigured)();
  const unavailable = authRequired() && !persistentDatabaseConfigured;
  const repository = options.repository ?? (
    persistentDatabaseConfigured
      ? await (options.getPersistentRepository ?? getProjectChatRepository)()
      : new InMemoryProjectChatRepository()
  );
  const service = new ProjectChatService({
    repository,
    ...(options.backend
      ? { listProjects: createProjectChatProjectProvider({ backend: options.backend, authRequired }) }
      : {})
  });
  const retention = new ProjectChatRetentionWorker(service, {
    onError: options.onRetentionError ?? (() => {
      console.warn('Project Chat retention cleanup failed.');
    })
  });
  const resolveContext = unavailable
    ? async () => {
        throw new ProjectChatAccessError(503);
      }
    : createProjectChatAuthContextResolver({
        authenticateMachine: options.authenticateMachine ?? (async () => null),
        authRequired,
        localDevelopmentHuman: options.localDevelopmentHuman ?? {
          displayName: 'Olli',
          login: 'olli',
          userId: 'local-development-user'
        },
        readHumanSession: options.readHumanSession ?? defaultHumanSessionReader,
        spaceId: options.spaceId ?? process.env.PROJECT_SPACE_INSTALLATION_ID ?? 'project-space'
      });
  const handleRequest = createProjectChatHttpApi(service, resolveContext);

  return {
    handleRequest,
    start() {
      if (!unavailable) {
        retention.start();
      }
    },
    stop() {
      retention.stop();
    }
  };
}

export function projectChatMachineAuthenticator(
  runtime: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'> | undefined
) {
  return async function authenticateMachine(input: {
    machineId: string;
    token: string;
  }): Promise<ProjectChatAuthenticatedMachine | null> {
    const identity = await runtime
      ?.resolveMachineCredentialIdentity(input.token, input.machineId);
    return identity
      ? {
          hostId: identity.hostId,
          machineId: identity.machineId,
          userId: identity.userId
        }
      : null;
  };
}

async function defaultHumanSessionReader(request: IncomingMessage) {
  const session = await readAuthSessionFromRequest(request);
  if (!session) {
    return null;
  }
  const accountProfile = await readProjectChatAccountProfile(session.userId);
  return projectChatHumanSession(session, accountProfile);
}

function projectChatHumanSession(
  session: ProjectSpaceAuthSession,
  accountProfile: {
    avatarUrl?: string;
    defaultsResolved?: boolean;
    displayName?: string;
  } = {}
): ProjectChatHumanSession {
  return {
    avatarUrl: accountProfile.avatarUrl,
    displayName: accountProfile.displayName ?? displayNameFromLogin(session.login),
    login: session.login,
    profileDefaultsResolved: accountProfile.defaultsResolved !== false,
    userId: session.userId
  };
}

function displayNameFromLogin(login: string) {
  const localPart = login.split('@', 1)[0]?.trim() ?? '';
  const words = localPart
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`);
  return words.join(' ') || login;
}
