import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  CodexThreadCatalogResult,
  MachineDirectoryResult,
  MachineSshConnectionResult
} from '../../src/shared/machine-directory-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';
import {
  MachineDirectoryServiceError,
  type MachineDirectoryActor,
  type MachineDirectoryThreadFilter
} from './service';

const machineCatalogRoute = '/api/machines/catalog';
const codexCatalogRoute = '/api/codex/catalog';
const sshRoutePattern =
  /^\/api\/machines\/catalog\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/ssh$/i;
const safeStatePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const allowedThreadQuery = new Set([
  'includeArchived',
  'machineId',
  'machineName',
  'search',
  'state'
]);

export interface MachineDirectoryHttpService {
  listMachines(actor: MachineDirectoryActor): Promise<MachineDirectoryResult>;
  listCodexThreads(
    actor: MachineDirectoryActor,
    filter: MachineDirectoryThreadFilter
  ): Promise<CodexThreadCatalogResult>;
  resolveSsh(
    actor: MachineDirectoryActor,
    machineId: string
  ): Promise<MachineSshConnectionResult>;
}

class MachineDirectoryHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'MachineDirectoryHttpError';
  }
}

export function createMachineDirectoryHttpApi(
  service: MachineDirectoryHttpService,
  resolveActor: (request: IncomingMessage) => Promise<MachineDirectoryActor>
) {
  return async function handleMachineDirectoryHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    const sshMatch = sshRoutePattern.exec(url.pathname);
    const isSshCandidate =
      url.pathname.startsWith(`${machineCatalogRoute}/`) &&
      url.pathname.endsWith('/ssh');
    if (
      url.pathname !== machineCatalogRoute &&
      url.pathname !== codexCatalogRoute &&
      !isSshCandidate
    ) {
      return false;
    }

    response.setHeader('Cache-Control', 'private, no-store');
    try {
      requireGet(request);
      if (url.pathname === machineCatalogRoute) {
        requireNoQuery(url);
        const actor = await resolveActor(request);
        writeJson(response, 200, await service.listMachines(actor));
      } else if (url.pathname === codexCatalogRoute) {
        const filter = parseThreadFilter(url);
        const actor = await resolveActor(request);
        writeJson(
          response,
          200,
          await service.listCodexThreads(actor, filter)
        );
      } else {
        if (!sshMatch) {
          throw invalidRequest('The SSH machine identifier must be a UUID.');
        }
        requireNoQuery(url);
        const actor = await resolveActor(request);
        writeJson(response, 200, await service.resolveSsh(actor, sshMatch[1]));
      }
    } catch (error) {
      writeMachineDirectoryError(response, error);
    }
    return true;
  };
}

function requireGet(request: IncomingMessage) {
  if (request.method !== 'GET') {
    throw invalidRequest('Machine discovery only supports GET requests.');
  }
}

function requireNoQuery(url: URL) {
  if ([...url.searchParams.keys()].length > 0) {
    throw invalidRequest('This machine discovery request does not accept query parameters.');
  }
}

function parseThreadFilter(url: URL): MachineDirectoryThreadFilter {
  for (const key of url.searchParams.keys()) {
    if (!allowedThreadQuery.has(key)) {
      throw invalidRequest(`Unsupported Codex catalog query field: ${key}.`);
    }
  }

  const machineId = optionalQueryValue(url, 'machineId', 128);
  const machineName = optionalQueryValue(url, 'machineName', 128);
  const search = optionalQueryValue(url, 'search', 256);
  if (machineId && machineName) {
    throw invalidRequest('Choose either machineId or machineName, not both.');
  }

  const archivedValue = url.searchParams.get('includeArchived');
  if (archivedValue !== null && archivedValue !== 'true' && archivedValue !== 'false') {
    throw invalidRequest('includeArchived must be true or false.');
  }

  const states = [...new Set(url.searchParams.getAll('state').map((state) => {
    if (!safeStatePattern.test(state)) {
      throw invalidRequest('Each Codex state must be a short lowercase identifier.');
    }
    return state;
  }))].sort();

  return {
    includeArchived: archivedValue === 'true',
    ...(machineId ? { machineId } : {}),
    ...(machineName ? { machineName } : {}),
    ...(search ? { search } : {}),
    ...(states.length > 0 ? { states } : {})
  };
}

function optionalQueryValue(url: URL, key: string, maximumLength: number) {
  const values = url.searchParams.getAll(key);
  if (values.length > 1 || (values[0]?.length ?? 0) > maximumLength) {
    throw invalidRequest(`${key} must be provided once and within ${maximumLength} characters.`);
  }
  return values[0]?.trim() || undefined;
}

function invalidRequest(message: string) {
  return new MachineDirectoryHttpError(400, 'invalid_request', message);
}

function writeMachineDirectoryError(response: ServerResponse, error: unknown) {
  if (error instanceof CodexMachineTasksAuthError) {
    writeJson(response, error.statusCode, {
      error: {
        code: 'authentication_failed',
        message: 'Project Space machine authentication failed.'
      }
    });
    return;
  }
  if (error instanceof MachineDirectoryServiceError) {
    const statusCode =
      error.code === 'machine_unavailable' ? 404 :
      error.code === 'ssh_unavailable' || error.code === 'machine_ambiguous' ? 409 :
      503;
    writeJson(response, statusCode, {
      error: { code: error.code, message: error.message }
    });
    return;
  }
  const mapped = error instanceof MachineDirectoryHttpError
    ? error
    : new MachineDirectoryHttpError(
        503,
        'directory_unavailable',
        'The Project Space machine directory is temporarily unavailable.'
      );
  writeJson(response, mapped.statusCode, {
    error: { code: mapped.code, message: mapped.message }
  });
}
