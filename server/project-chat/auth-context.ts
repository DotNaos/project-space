import type { IncomingMessage } from 'node:http';

import type {
  ProjectChatContext,
  ProjectChatHumanActor
} from './contracts';
import { normalizeProjectChatProviderAvatarUrl } from './avatar';
import { ProjectChatAccessError } from './http-api';

const MACHINE_ID_HEADER = 'x-project-machine-id';
const THREAD_ID_HEADER = 'x-codex-thread-id';
const AUTHORIZATION_HEADER = 'authorization';
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_LOGIN_LENGTH = 160;
const MAX_DISPLAY_NAME_LENGTH = 48;
const MAX_BEARER_TOKEN_LENGTH = 4_096;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const SAFE_HANDLE = /^[a-z0-9][a-z0-9_-]*$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

const DEFAULT_LOCAL_HUMAN: ProjectChatHumanSession = {
  displayName: 'Local developer',
  login: 'local-developer',
  userId: 'local-development-user'
};

type MaybePromise<T> = T | Promise<T>;

export interface ProjectChatHumanSession {
  userId: string;
  login: string;
  avatarUrl?: string;
  displayName?: string;
  profileDefaultsResolved?: boolean;
}

export interface ProjectChatAuthenticatedMachine {
  userId: string;
  hostId?: string;
  machineId: string;
}

export interface ProjectChatAuthContextDependencies {
  spaceId: string;
  authRequired(): boolean;
  readHumanSession(
    request: IncomingMessage
  ): MaybePromise<ProjectChatHumanSession | null>;
  authenticateMachine(input: {
    machineId: string;
    token: string;
  }): MaybePromise<ProjectChatAuthenticatedMachine | null>;
  hostIdForMachine?(machineId: string): MaybePromise<string>;
  localDevelopmentHuman?: ProjectChatHumanSession;
}

interface RequestHeaderState {
  ambiguous: boolean;
  present: boolean;
  value?: string;
}

export function createProjectChatAuthContextResolver(
  dependencies: ProjectChatAuthContextDependencies
) {
  const spaceId = configuredIdentifier(dependencies.spaceId, 'spaceId');
  const localHuman = humanActor(
    dependencies.localDevelopmentHuman ?? DEFAULT_LOCAL_HUMAN
  );

  return async function resolveProjectChatAuthContext(
    request: IncomingMessage
  ): Promise<ProjectChatContext> {
    const machineHeader = requestHeader(request, MACHINE_ID_HEADER);
    const threadHeader = requestHeader(request, THREAD_ID_HEADER);

    if (machineHeader.present || threadHeader.present) {
      return resolveAgentContext(
        request,
        machineHeader,
        threadHeader,
        spaceId,
        dependencies
      );
    }

    if (!dependencies.authRequired()) {
      return { actor: localHuman, spaceId };
    }

    let session: ProjectChatHumanSession | null;
    try {
      session = await dependencies.readHumanSession(request);
    } catch {
      throw new ProjectChatAccessError(401);
    }
    if (!session) {
      throw new ProjectChatAccessError(401);
    }

    return { actor: humanActor(session), spaceId };
  };
}

async function resolveAgentContext(
  request: IncomingMessage,
  machineHeader: RequestHeaderState,
  threadHeader: RequestHeaderState,
  spaceId: string,
  dependencies: ProjectChatAuthContextDependencies
): Promise<ProjectChatContext> {
  const machineId = requestIdentifier(machineHeader);
  const threadId = requestThreadIdentifier(threadHeader);
  const token = bearerToken(requestHeader(request, AUTHORIZATION_HEADER));

  let authenticated: ProjectChatAuthenticatedMachine | null;
  try {
    authenticated = await dependencies.authenticateMachine({ machineId, token });
  } catch {
    throw new ProjectChatAccessError(401);
  }
  if (!authenticated) {
    throw new ProjectChatAccessError(401);
  }

  const authenticatedMachineId = trustedIdentifier(authenticated.machineId);
  const accountId = trustedIdentifier(authenticated.userId);
  if (authenticatedMachineId !== machineId) {
    throw new ProjectChatAccessError(403);
  }

  let rawHostId: string;
  try {
    rawHostId = authenticated.hostId ?? (
      dependencies.hostIdForMachine
        ? await dependencies.hostIdForMachine(authenticatedMachineId)
        : authenticatedMachineId
    );
  } catch {
    throw new ProjectChatAccessError(403);
  }

  return {
    actor: {
      accountId,
      hostId: trustedIdentifier(rawHostId),
      kind: 'agent',
      machineId: authenticatedMachineId,
      threadId
    },
    spaceId
  };
}

function requestHeader(request: IncomingMessage, name: string): RequestHeaderState {
  const matchingEntries = Object.entries(request.headers).filter(
    ([key, value]) => key.toLowerCase() === name && value !== undefined
  );
  const rawOccurrences = rawHeaderOccurrences(request.rawHeaders, name);
  if (matchingEntries.length === 0) {
    return {
      ambiguous: rawOccurrences > 0,
      present: rawOccurrences > 0
    };
  }

  const value = matchingEntries[0]?.[1];
  return {
    ambiguous:
      matchingEntries.length !== 1 ||
      Array.isArray(value) ||
      rawOccurrences > 1,
    present: true,
    value: typeof value === 'string' ? value : undefined
  };
}

function rawHeaderOccurrences(rawHeaders: readonly string[], name: string) {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
}

function requestIdentifier(header: RequestHeaderState) {
  if (header.ambiguous || !header.present || header.value === undefined) {
    throw new ProjectChatAccessError(403);
  }
  const value = header.value;
  if (
    value !== value.trim() ||
    value.length < 1 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    UNSAFE_TEXT.test(value) ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    throw new ProjectChatAccessError(403);
  }
  return value;
}

function requestThreadIdentifier(header: RequestHeaderState) {
  const value = requestIdentifier(header);
  if (!SAFE_CODEX_THREAD_ID.test(value)) {
    throw new ProjectChatAccessError(403);
  }
  return value;
}

function bearerToken(header: RequestHeaderState) {
  if (header.ambiguous || !header.present || header.value === undefined) {
    throw new ProjectChatAccessError(401);
  }
  const value = header.value;
  if (
    value.length > MAX_BEARER_TOKEN_LENGTH + 'Bearer '.length ||
    UNSAFE_TEXT.test(value)
  ) {
    throw new ProjectChatAccessError(401);
  }
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  const token = match?.[1];
  if (
    !token ||
    token.length > MAX_BEARER_TOKEN_LENGTH ||
    !SAFE_BEARER_TOKEN.test(token)
  ) {
    throw new ProjectChatAccessError(401);
  }
  return token;
}

function humanActor(session: ProjectChatHumanSession): ProjectChatHumanActor {
  const accountId = trustedIdentifier(session.userId);
  const login = trustedText(session.login, MAX_LOGIN_LENGTH);
  const displaySource = session.displayName?.trim() ? session.displayName : login;
  const displayName = trustedDisplayName(displaySource);
  const handle = humanHandle(login, accountId);
  const avatarUrl = normalizeProjectChatProviderAvatarUrl(session.avatarUrl);
  return {
    accountId,
    ...(avatarUrl ? { avatarUrl } : {}),
    displayName,
    handle,
    kind: 'human',
    ...(session.profileDefaultsResolved === false
      ? { profileDefaultsResolved: false }
      : {})
  };
}

function trustedDisplayName(value: string) {
  if (UNSAFE_TEXT.test(value)) {
    throw new ProjectChatAccessError(403);
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ProjectChatAccessError(403);
  }
  return normalized;
}

function humanHandle(login: string, accountId: string) {
  for (const source of [login, accountId]) {
    const handle = source
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    if (SAFE_HANDLE.test(handle)) {
      return handle;
    }
  }
  throw new ProjectChatAccessError(403);
}

function trustedText(value: string, max: number) {
  if (typeof value !== 'string' || UNSAFE_TEXT.test(value)) {
    throw new ProjectChatAccessError(403);
  }
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > max) {
    throw new ProjectChatAccessError(403);
  }
  return normalized;
}

function trustedIdentifier(value: string) {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    UNSAFE_TEXT.test(value) ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    throw new ProjectChatAccessError(403);
  }
  return value;
}

function configuredIdentifier(value: string, name: string) {
  try {
    return trustedIdentifier(value);
  } catch {
    throw new TypeError(`${name} must be a safe Project Chat identifier.`);
  }
}
