import type { IncomingMessage, ServerResponse } from 'node:http';

import { ProjectHostdError } from './contracts';
import { ProjectHostdService, projectHostdStaleAfterSeconds } from './service';
import { parseCredentialRequest } from './validation';
import { writeJson } from '../project-space-http-response';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';

const credentialRoute = '/api/compute/hostd/credentials';
const telemetryRoute = '/api/compute/hostd/telemetry';
const maximumBodyBytes = 128 * 1024;

export interface ProjectHostdActor {
  userId: string;
}

export function createProjectHostdHttpApi(
  service: ProjectHostdService,
  resolveActor: (request: IncomingMessage) => Promise<ProjectHostdActor>
) {
  return async function handleProjectHostdRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== credentialRoute && url.pathname !== telemetryRoute) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method !== 'POST' || url.search || [...url.searchParams.keys()].length > 0) {
        failure(response, 400, 'invalid_request', 'project-hostd requests require POST without query parameters.');
        return true;
      }
      if (!isJson(request.headers['content-type'])) {
        failure(response, 415, 'invalid_content_type', 'project-hostd requests require JSON.');
        return true;
      }
      if (url.pathname === credentialRoute) {
        const actor = await resolveActor(request);
        const input = parseCredentialRequest(await readBoundedJson(request));
        writeJson(response, 201, await service.issue({ ...input, ownerUserId: actor.userId }));
        return true;
      }
      const token = bearerToken(request.headers.authorization);
      const scope = token ? await service.authenticate(token) : null;
      if (!scope) {
        failure(response, 401, 'authentication_failed', 'project-hostd authentication failed.');
        return true;
      }
      const result = await service.append(scope, await readBoundedJson(request));
      writeJson(response, 200, {
        acceptedSequence: result.snapshot.sequence,
        replayed: result.replayed,
        schemaVersion: 1,
        staleAfterSeconds: projectHostdStaleAfterSeconds,
        type: 'hostd.accepted'
      });
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        failure(response, error.statusCode, 'authentication_failed',
          'Project Space machine authentication failed.');
      } else if (error instanceof ProjectHostdError) {
        const status = error.code === 'authentication_failed' || error.code === 'credential_expired'
          ? 401
          : error.code === 'operation_in_progress' || error.code === 'replay_conflict' ||
              error.code === 'sequence_conflict' || error.code === 'target_conflict'
            ? 409
            : 400;
        failure(response, status, error.code, error.message, error.expectedNextSequence);
      } else {
        failure(response, 503, 'hostd_unavailable', 'project-hostd telemetry is temporarily unavailable.');
      }
    }
    return true;
  };
}

async function readBoundedJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximumBodyBytes) {
      throw new ProjectHostdError('invalid_message', 'project-hostd message is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ProjectHostdError('invalid_message', 'project-hostd message is invalid JSON.');
  }
}

function bearerToken(value: string | undefined) {
  if (!value) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1];
}

function isJson(value: string | undefined) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function failure(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  expectedNextSequence?: number
) {
  writeJson(response, status, {
    error: {
      code,
      ...(expectedNextSequence === undefined ? {} : { expectedNextSequence }),
      message
    }
  });
}
