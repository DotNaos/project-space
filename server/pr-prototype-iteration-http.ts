import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  PullRequestPrototypeIterationRequest,
  PullRequestPrototypeIterationResult
} from '../src/shared/pr-prototype-iteration-api';
import type {
  AvailablePullRequestDevServerSurface,
  PullRequestPrototypeSurfaceKind
} from '../src/shared/pr-preview-test-surfaces-api';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import { readJson, writeJson } from './project-space-http-response';
import { createConfiguredPullRequestPrototypeIterationService } from './pr-prototype-iteration-configured';
import { readConfiguredPullRequestTestSurfaces } from './pr-test-surfaces/configured-runtime';

const iterationPath = '/api/pull-request-previews/prototype-iteration';
const requestKeys = new Set([
  'headSha',
  'pullRequestNumber',
  'repositoryFullName',
  'surface'
]);

function isSurface(value: unknown): value is PullRequestPrototypeSurfaceKind {
  return value === 'desktop-prototype' || value === 'mobile-prototype';
}

function parseRecord(value: unknown): PullRequestPrototypeIterationRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !requestKeys.has(key))) return undefined;
  const pullRequestNumber = Number(record.pullRequestNumber);
  const repositoryFullName = typeof record.repositoryFullName === 'string'
    ? record.repositoryFullName
    : '';
  const headSha = typeof record.headSha === 'string' ? record.headSha : '';
  if (
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName) ||
    !/^[0-9a-f]{40}$/i.test(headSha) ||
    !isSurface(record.surface)
  ) {
    return undefined;
  }
  return {
    headSha: headSha.toLowerCase(),
    pullRequestNumber,
    repositoryFullName,
    surface: record.surface
  };
}

function parseQuery(url: URL) {
  if (
    [...url.searchParams.keys()].some((key) => !requestKeys.has(key)) ||
    [...requestKeys].some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    return undefined;
  }
  return parseRecord(Object.fromEntries(url.searchParams));
}

function liveSurface(
  result: Awaited<ReturnType<typeof readConfiguredPullRequestTestSurfaces>>,
  request: PullRequestPrototypeIterationRequest
) {
  return result.surfaces.find((candidate): candidate is AvailablePullRequestDevServerSurface =>
    candidate.kind === 'dev-server' &&
    candidate.state === 'available' &&
    candidate.commitSha === request.headSha &&
    candidate.servedSurface === request.surface
  );
}

export function createPullRequestPrototypeIterationRoute(backend: ProjectSpaceBackend) {
  return async function handlePullRequestPrototypeIteration(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    userId: string
  ) {
    if (url.pathname !== iterationPath) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    let payload: PullRequestPrototypeIterationRequest | undefined;
    if (request.method === 'GET') payload = parseQuery(url);
    else if (request.method === 'POST') payload = parseRecord(await readJson<unknown>(request));
    else {
      response.setHeader('Allow', 'GET, POST');
      writeJson(response, 405, { error: 'Method not allowed.' });
      return true;
    }
    if (!payload) {
      writeJson(response, 400, { error: 'Invalid prototype iteration request.' });
      return true;
    }
    const service = createConfiguredPullRequestPrototypeIterationService(backend, userId);
    let result: PullRequestPrototypeIterationResult;
    if (request.method === 'POST') {
      writeJson(response, 409, {
        code: 'canonical_runtime_required',
        error: 'Prototype development servers must be started through the canonical Workspace Runtime.'
      });
      return true;
    } else {
      const surfaces = await readConfiguredPullRequestTestSurfaces({
        backend,
        pullRequestNumber: payload.pullRequestNumber,
        repositoryFullName: payload.repositoryFullName,
        userId
      });
      result = await service.read(payload, liveSurface(surfaces, payload));
    }
    writeJson(response, 200, result);
    return true;
  };
}
