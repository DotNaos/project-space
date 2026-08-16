import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GitHubCodespaceRunnerRequest } from '../../src/shared/github-codespace-runner-api';
import { writeJson } from '../project-space-http-response';
import {
  GitHubCodespaceRunnerAuthenticationError,
  type GitHubCodespaceInventoryRuntime,
  type GitHubCodespaceRunnerRuntime
} from './configured-runtime';

const runnerRoute = '/api/github/codespace-runner';
const inventoryRoute = '/api/compute/github/codespaces';
const maximumBodyBytes = 16 * 1024;
const operationPattern = /^codespace:[0-9a-f-]{36}$/i;
const branchPattern = /^[^\s~^:?*\\[\]]{1,255}$/;
const codespaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function createGitHubCodespaceRunnerHttpHandler(options: {
  runtime: GitHubCodespaceRunnerRuntime & GitHubCodespaceInventoryRuntime;
}) {
  return async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname !== runnerRoute && url.pathname !== inventoryRoute) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (url.pathname === inventoryRoute) {
      return handleInventoryRequest(request, response, url, options.runtime);
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Method not allowed.' });
      return true;
    }

    try {
      const parsed = parseRequest(await readBody(request));
      if (request.headers['idempotency-key'] !== parsed.operationId) {
        throw new Error('Idempotency-Key must match operationId.');
      }
      writeJson(response, 200, await options.runtime.run(parsed));
    } catch (error) {
      writeJson(response, error instanceof GitHubCodespaceRunnerAuthenticationError ? 401 : 400, {
        error: error instanceof Error ? error.message : 'The GitHub Codespaces request is invalid.'
      });
    }
    return true;
  };
}

async function handleInventoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: GitHubCodespaceInventoryRuntime
) {
  if (request.method !== 'GET') {
    writeJson(response, 405, {
      error: { code: 'method_not_allowed', message: 'Method not allowed.' }
    });
    return true;
  }
  if ([...url.searchParams.keys()].length > 0) {
    writeJson(response, 400, {
      error: { code: 'invalid_request', message: 'GitHub Codespaces inventory requests do not accept query parameters.' }
    });
    return true;
  }
  try {
    writeJson(response, 200, await runtime.listInventory());
  } catch (error) {
    if (error instanceof GitHubCodespaceRunnerAuthenticationError) {
      writeJson(response, 401, {
        error: { code: 'authentication_failed', message: 'Authentication failed.' }
      });
    } else {
      writeJson(response, 503, {
        error: {
          code: 'github_codespace_inventory_unavailable',
          message: 'GitHub Codespaces inventory is temporarily unavailable.'
        }
      });
    }
  }
  return true;
}

function parseRequest(value: Record<string, unknown>): GitHubCodespaceRunnerRequest {
  const allowed = new Set([
    'action',
    'branch',
    'codespaceName',
    'issue',
    'listOnly',
    'operationId',
    'repositoryFullName'
  ]);
  const actions = ['delete', 'provision', 'start', 'status', 'stop'];
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.action !== 'string' || !actions.includes(value.action) ||
    typeof value.branch !== 'string' || !branchPattern.test(value.branch) ||
    (value.codespaceName !== undefined && (
      typeof value.codespaceName !== 'string' || !codespaceNamePattern.test(value.codespaceName)
    )) ||
    !Number.isSafeInteger(value.issue) || Number(value.issue) < 1 ||
    (value.listOnly !== undefined && typeof value.listOnly !== 'boolean') ||
    (value.listOnly === true && (value.action !== 'status' || value.codespaceName !== undefined)) ||
    typeof value.operationId !== 'string' || !operationPattern.test(value.operationId) ||
    typeof value.repositoryFullName !== 'string' || !repositoryPattern.test(value.repositoryFullName)
  ) {
    throw new Error('The GitHub Codespaces request is invalid.');
  }
  return value as unknown as GitHubCodespaceRunnerRequest;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
