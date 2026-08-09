import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GitHubCodespaceRunnerRequest } from '../../src/shared/github-codespace-runner-api';
import { GITHUB_CODESPACE_RUNNER_API_VERSION } from '../../src/shared/github-codespace-runner-api';
import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { getCurrentAuthSession, isProjectSpaceAuthRequired } from '../local-auth-store';
import { getMachineConnectionDatabaseClient, listComputeInventory } from '../local-database-store';
import { GitHubRequestError, requestGitHub, resolveOAuthToken } from '../local-github-catalog';
import { readMachineConnectionPublicOrigin } from '../machine-connection-environment';
import { writeJson } from '../project-space-http-response';
import {
  createGitHubCodespaceRunnerService,
  type GitHubCodespaceRecord
} from './service';

const route = '/api/github/codespace-runner';
const maximumBodyBytes = 16 * 1024;
const operationPattern = /^codespace:[0-9a-f-]{36}$/i;
const branchPattern = /^[^\s~^:?*\\[\]]{1,255}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface GitHubApiCodespace {
  created_at: string;
  display_name?: string;
  git_status?: { ref?: string };
  name: string;
  repository: { full_name: string };
  state: string;
  web_url?: string;
}

export function createGitHubCodespaceRunnerHttpHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
}) {
  return async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Method not allowed.' });
      return true;
    }

    const session = getCurrentAuthSession() ?? (!isProjectSpaceAuthRequired()
      ? { login: 'local-development', role: 'user' as const, userId: 'local-development-user' }
      : null);
    if (!session) {
      writeJson(response, 401, { error: 'Login required.' });
      return true;
    }

    let parsed: GitHubCodespaceRunnerRequest | undefined;
    try {
      parsed = parseRequest(await readBody(request));
      if (request.headers['idempotency-key'] !== parsed.operationId) {
        throw new Error('Idempotency-Key must match operationId.');
      }
      const auth = await resolveOAuthToken();
      if (!auth) {
        writeJson(response, 200, unavailable(parsed, 'github-reauthorization-required', 'Connect GitHub before creating a Codespace.'));
        return true;
      }
      if (auth.source === 'stored-oauth' && !scopeIncludes(auth.scope, 'codespace')) {
        writeJson(response, 200, unavailable(parsed, 'github-reauthorization-required', 'Reconnect GitHub once to grant Codespaces access.'));
        return true;
      }

      const service = createGitHubCodespaceRunnerService({
        create: (input) => createCodespace(auth.token, input),
        delete: async (name) => {
          await requestGitHub(`/user/codespaces/${encodeURIComponent(name)}`, auth.token, { method: 'DELETE' });
        },
        findApproval,
        async inventory() {
          return {
            compute: await listComputeInventory(session.userId),
            connectors: (await options.backend.getConnectorOverview()).machines
          };
        },
        list: () => listCodespaces(auth.token),
        start: (name) => mutateCodespace(auth.token, name, 'start'),
        stop: (name) => mutateCodespace(auth.token, name, 'stop')
      });
      writeJson(response, 200, await runSerialized(parsed, () => service.run(parsed!)));
    } catch (error) {
      const state = error instanceof GitHubRequestError && error.statusCode === 403
        ? 'github-reauthorization-required'
        : 'failed';
      const message = error instanceof GitHubRequestError && error.rateLimited
        ? 'GitHub rate limited the Codespaces request. Try again shortly.'
        : error instanceof Error ? error.message : 'The Codespaces request failed safely.';
      writeJson(response, 200, unavailable(
        parsed ?? fallbackRequest(),
        state,
        message
      ));
    }
    return true;
  };
}

async function listCodespaces(token: string) {
  const codespaces: GitHubApiCodespace[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await requestGitHub<{ codespaces: GitHubApiCodespace[] }>(
      `/user/codespaces?per_page=100&page=${page}`,
      token
    );
    codespaces.push(...payload.codespaces);
    if (payload.codespaces.length < 100) break;
  }
  return codespaces.map(mapCodespace);
}

async function runSerialized<Result>(
  request: GitHubCodespaceRunnerRequest,
  operation: () => Promise<Result>
) {
  if (request.action === 'status') return operation();
  const client = await getMachineConnectionDatabaseClient();
  const scope = `${request.repositoryFullName.toLowerCase()}:${request.issue}:${request.branch}`;
  return client.transaction(async (transaction) => {
    await transaction.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
    return operation();
  });
}

async function createCodespace(
  token: string,
  input: { branch: string; displayName: string; repositoryFullName: string }
) {
  const [owner, repository] = input.repositoryFullName.split('/');
  return mapCodespace(await requestGitHub<GitHubApiCodespace>(
    `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/codespaces`,
    token,
    {
      body: JSON.stringify({
        devcontainer_path: '.devcontainer/devcontainer.json',
        display_name: input.displayName,
        idle_timeout_minutes: 30,
        ref: input.branch,
        retention_period_minutes: 4_320
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    }
  ));
}

async function mutateCodespace(token: string, name: string, action: 'start' | 'stop') {
  return mapCodespace(await requestGitHub<GitHubApiCodespace>(
    `/user/codespaces/${encodeURIComponent(name)}/${action}`,
    token,
    { method: 'POST' }
  ));
}

function mapCodespace(value: GitHubApiCodespace): GitHubCodespaceRecord {
  return {
    createdAt: value.created_at,
    displayName: value.display_name,
    name: value.name,
    repositoryFullName: value.repository.full_name,
    state: value.state,
    url: value.web_url,
    ref: value.git_status?.ref
  };
}

async function findApproval(input: { codespaceName: string; createdAt: string }) {
  const client = await getMachineConnectionDatabaseClient();
  const found = await client.query<{ id: string }>(
    `select id
       from machine_connection_requests
      where name = $1 and hostname = $1
        and created_at >= $2::timestamptz - interval '5 minutes'
        and expires_at > now() and status in ('pending', 'approved')
      order by created_at desc
      limit 1`,
    [input.codespaceName, input.createdAt]
  );
  const id = found.rows[0]?.id;
  const origin = readMachineConnectionPublicOrigin(process.env);
  return id && origin
    ? { approvalUrl: `${origin}/connector/connect?request=${encodeURIComponent(id)}` }
    : null;
}

function scopeIncludes(scope: string | undefined, expected: string) {
  return (scope ?? '').split(/[ ,]+/).includes(expected);
}

function parseRequest(value: Record<string, unknown>): GitHubCodespaceRunnerRequest {
  const allowed = new Set(['action', 'branch', 'issue', 'operationId', 'repositoryFullName']);
  const actions = ['delete', 'provision', 'start', 'status', 'stop'];
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.action !== 'string' || !actions.includes(value.action) ||
    typeof value.branch !== 'string' || !branchPattern.test(value.branch) ||
    !Number.isSafeInteger(value.issue) || Number(value.issue) < 1 ||
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

function unavailable(
  request: GitHubCodespaceRunnerRequest,
  state: 'failed' | 'github-reauthorization-required',
  message: string
) {
  return {
    apiVersion: GITHUB_CODESPACE_RUNNER_API_VERSION,
    message,
    operationId: request.operationId,
    state
  };
}

function fallbackRequest(): GitHubCodespaceRunnerRequest {
  return {
    action: 'status',
    branch: 'unknown',
    issue: 1,
    operationId: 'codespace:00000000-0000-0000-0000-000000000000',
    repositoryFullName: 'unknown/unknown'
  };
}
