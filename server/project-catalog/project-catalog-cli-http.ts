import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectCliCatalogResult } from '../../src/shared/project-catalog-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';

const catalogRoute = '/api/projects/catalog';

export interface ProjectCatalogCliActor {
  callerMachineId?: string;
  userId: string;
}

export interface ProjectCatalogCliHttpService {
  list(actor: ProjectCatalogCliActor): Promise<ProjectCliCatalogResult>;
}

class ProjectCatalogCliHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectCatalogCliHttpError';
  }
}

export function createProjectCatalogCliHttpApi(
  service: ProjectCatalogCliHttpService,
  resolveActor: (request: IncomingMessage) => Promise<ProjectCatalogCliActor>
) {
  return async function handleProjectCatalogCliHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== catalogRoute) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method !== 'GET' || [...url.searchParams.keys()].length > 0) {
        throw new ProjectCatalogCliHttpError(
          400,
          'invalid_request',
          'Project catalog requests do not accept query parameters.'
        );
      }
      writeJson(response, 200, await service.list(await resolveActor(request)));
    } catch (error) {
      writeProjectCatalogError(response, error);
    }
    return true;
  };
}

function writeProjectCatalogError(response: ServerResponse, error: unknown) {
  if (error instanceof CodexMachineTasksAuthError) {
    writeJson(response, error.statusCode, {
      error: {
        code: 'authentication_failed',
        message: 'Project Space machine authentication failed.'
      }
    });
    return;
  }
  const mapped = error instanceof ProjectCatalogCliHttpError
    ? error
    : new ProjectCatalogCliHttpError(
        503,
        'catalog_unavailable',
        'The Project Space project catalog is temporarily unavailable.'
      );
  writeJson(response, mapped.statusCode, {
    error: { code: mapped.code, message: mapped.message }
  });
}
