import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GitHubCodespaceRunnerRequest } from '../../src/shared/github-codespace-runner-api';
import { writeJson } from '../project-space-http-response';
import {
  GitHubCodespaceRunnerAuthenticationError,
  type GitHubCodespaceRunnerRuntime
} from './configured-runtime';

const route = '/api/github/codespace-runner';
const maximumBodyBytes = 16 * 1024;
const operationPattern = /^codespace:[0-9a-f-]{36}$/i;
const branchPattern = /^[^\s~^:?*\\[\]]{1,255}$/;
const codespaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function createGitHubCodespaceRunnerHttpHandler(options: {
  runtime: GitHubCodespaceRunnerRuntime;
}) {
  return async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
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
