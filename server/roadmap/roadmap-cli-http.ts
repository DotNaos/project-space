import type { IncomingMessage, ServerResponse } from 'node:http';

import { isValidGitHubRepositoryFullName } from '../../src/shared/github-repository-summary';
import type {
  RoadmapDependencyMutationRequest,
  RoadmapResult
} from '../../src/shared/roadmap-api';
import { buildRoadmapGraph } from '../../src/shared/roadmap-graph';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { GitHubRequestError } from '../local-github-catalog';
import { readJson, writeJson } from '../project-space-http-response';

const graphRoute = '/api/roadmap';
const dependenciesRoute = '/api/roadmap/dependencies';

interface RoadmapCliActor {
  userId: string;
}

export interface RoadmapCliHttpService {
  add(
    actor: RoadmapCliActor,
    request: RoadmapDependencyMutationRequest
  ): Promise<RoadmapResult>;
  get(actor: RoadmapCliActor, fullName: string): Promise<RoadmapResult>;
  remove(
    actor: RoadmapCliActor,
    request: RoadmapDependencyMutationRequest
  ): Promise<RoadmapResult>;
}

class RoadmapCliHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 409 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RoadmapCliHttpError';
  }
}

export function createRoadmapCliHttpApi(
  service: RoadmapCliHttpService,
  resolveActor: (request: IncomingMessage) => Promise<RoadmapCliActor>
) {
  return async function handleRoadmapCliHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== graphRoute && url.pathname !== dependenciesRoute) {
      return false;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const actor = await resolveActor(request);
      if (request.method === 'GET' && url.pathname === graphRoute) {
        writeJson(response, 200, graphForResult(await service.get(
          actor,
          repositoryFromUrl(url)
        )));
        return true;
      }
      if (
        url.pathname === dependenciesRoute
        && (request.method === 'POST' || request.method === 'DELETE')
      ) {
        const mutation = await dependencyMutation(request);
        const result = request.method === 'POST'
          ? await service.add(actor, mutation)
          : await service.remove(actor, mutation);
        writeJson(response, 200, graphForResult(result));
        return true;
      }
      throw new RoadmapCliHttpError(400, 'invalid_request', 'Unsupported roadmap request.');
    } catch (error) {
      writeRoadmapError(response, error);
      return true;
    }
  };
}

function graphForResult(result: RoadmapResult) {
  if (result.conflict) {
    throw new RoadmapCliHttpError(
      409,
      result.conflict === 'dependencies' ? 'revision_conflict' : 'plan_conflict',
      result.message ?? 'The roadmap changed before the update was saved.'
    );
  }
  if (result.status !== 'connected') {
    throw new RoadmapCliHttpError(
      result.status === 'unauthorized' || result.status === 'auth-required' ? 401 : 503,
      result.status === 'unauthorized' || result.status === 'auth-required'
        ? 'github_auth_required'
        : 'roadmap_unavailable',
      result.message ?? 'The roadmap is unavailable.'
    );
  }
  return buildRoadmapGraph(result);
}

function repositoryFromUrl(url: URL) {
  const allowed = new Set(['fullName']);
  if (
    [...url.searchParams.keys()].some((key) => !allowed.has(key))
    || url.searchParams.getAll('fullName').length !== 1
  ) {
    throw new RoadmapCliHttpError(
      400,
      'invalid_repository',
      'Provide one exact repository as owner/name.'
    );
  }
  return repositoryName(url.searchParams.get('fullName'));
}

async function dependencyMutation(
  request: IncomingMessage
): Promise<RoadmapDependencyMutationRequest> {
  let body: Record<string, unknown>;
  try {
    const parsed = await readJson<unknown>(request);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new RoadmapCliHttpError(
      400,
      'invalid_request',
      'The roadmap dependency request must be a JSON object.'
    );
  }
  const allowed = new Set([
    'blockedIssueNumber',
    'blocker',
    'expectedGraphRevision',
    'fullName'
  ]);
  const blocker = body.blocker;
  if (
    Object.keys(body).some((key) => !allowed.has(key))
    || !blocker
    || typeof blocker !== 'object'
    || Array.isArray(blocker)
  ) {
    throw invalidDependency();
  }
  const blockerRecord = blocker as Record<string, unknown>;
  if (
    Object.keys(blockerRecord).some((key) => !new Set(['fullName', 'issueNumber']).has(key))
    || !positiveInteger(body.blockedIssueNumber)
    || !positiveInteger(blockerRecord.issueNumber)
    || typeof body.expectedGraphRevision !== 'string'
    || !/^[a-f0-9]{8,64}$/.test(body.expectedGraphRevision)
  ) {
    throw invalidDependency();
  }
  return {
    blockedIssueNumber: body.blockedIssueNumber as number,
    blocker: {
      fullName: repositoryName(blockerRecord.fullName),
      issueNumber: blockerRecord.issueNumber as number
    },
    expectedGraphRevision: body.expectedGraphRevision,
    fullName: repositoryName(body.fullName)
  };
}

function repositoryName(value: unknown) {
  if (typeof value !== 'string' || !isValidGitHubRepositoryFullName(value)) {
    throw new RoadmapCliHttpError(
      400,
      'invalid_repository',
      'Repository names must use the exact owner/name form.'
    );
  }
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function invalidDependency() {
  return new RoadmapCliHttpError(
    400,
    'invalid_dependency',
    'Provide positive issue numbers, exact repositories, and the current graph revision.'
  );
}

function writeRoadmapError(response: ServerResponse, error: unknown) {
  if (error instanceof CodexMachineTasksAuthError) {
    writeJson(response, error.statusCode, {
      error: {
        code: 'authentication_failed',
        message: 'Project Space machine authentication failed.'
      }
    });
    return;
  }
  const mapped = error instanceof RoadmapCliHttpError ? error : mapRoadmapError(error);
  writeJson(response, mapped.statusCode, {
    error: { code: mapped.code, message: mapped.message }
  });
}

function mapRoadmapError(error: unknown) {
  if (error instanceof GitHubRequestError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new RoadmapCliHttpError(
        403,
        'github_permission_denied',
        'GitHub denied access to this roadmap or issue.'
      );
    }
    if (error.statusCode === 404 || error.statusCode === 410) {
      return new RoadmapCliHttpError(
        400,
        'invalid_issue',
        'A referenced GitHub issue does not exist or is not accessible.'
      );
    }
    return new RoadmapCliHttpError(
      503,
      'github_unavailable',
      'GitHub could not load or update the roadmap.'
    );
  }
  const message = error instanceof Error ? error.message : '';
  if (message === 'GITHUB_AUTH_REQUIRED') {
    return new RoadmapCliHttpError(
      401,
      'github_auth_required',
      'Connect GitHub in Project Space before editing the roadmap.'
    );
  }
  if (message.includes('permission to edit')) {
    return new RoadmapCliHttpError(403, 'permission_denied', message);
  }
  if (message.includes('Refresh GitHub dependencies')) {
    return new RoadmapCliHttpError(409, 'stale_dependencies', message);
  }
  if (message.includes('create a cycle') || message.includes('contains a cycle')) {
    return new RoadmapCliHttpError(409, 'dependency_cycle', message);
  }
  if (message.includes('manual plan order')) {
    return new RoadmapCliHttpError(409, 'plan_order_conflict', message);
  }
  if (
    message.includes('repository')
    || message.includes('issue')
    || message.includes('prerequisite')
  ) {
    return new RoadmapCliHttpError(400, 'invalid_request', message);
  }
  return new RoadmapCliHttpError(
    503,
    'roadmap_unavailable',
    'The roadmap service is temporarily unavailable.'
  );
}
