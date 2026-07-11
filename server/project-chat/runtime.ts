import type { IncomingMessage, ServerResponse } from 'node:http';

import { authenticateConnectorMachineToken } from '../connector-registration-auth';
import {
  authenticateConnectorCredential,
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
import { createProjectChatHttpApi, ProjectChatAccessError } from './http-api';
import { InMemoryProjectChatRepository } from './memory-store';
import type { ProjectChatRepository } from './repository';
import { ProjectChatRetentionWorker } from './retention-worker';
import { ProjectChatService } from './service';

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
  const service = new ProjectChatService({ repository });
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
        authenticateMachine: options.authenticateMachine ?? defaultMachineAuthenticator(
          persistentDatabaseConfigured
        ),
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

function defaultMachineAuthenticator(databaseConfigured: boolean) {
  return async function authenticateMachine(input: {
    machineId: string;
    token: string;
  }): Promise<ProjectChatAuthenticatedMachine | null> {
    if (databaseConfigured) {
      const credential = await authenticateConnectorCredential(input).catch(() => null);
      return credential
        ? { machineId: credential.machineId, userId: credential.userId }
        : null;
    }

    const authenticated = await authenticateConnectorMachineToken(
      input.token,
      input.machineId
    );
    return authenticated
      ? { machineId: input.machineId, userId: 'local-development-user' }
      : null;
  };
}

async function defaultHumanSessionReader(request: IncomingMessage) {
  const session = await readAuthSessionFromRequest(request);
  return session ? projectChatHumanSession(session) : null;
}

function projectChatHumanSession(
  session: ProjectSpaceAuthSession
): ProjectChatHumanSession {
  return {
    displayName: displayNameFromLogin(session.login),
    login: session.login,
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
