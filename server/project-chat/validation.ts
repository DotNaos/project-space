import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  PROJECT_CHAT_MAX_BODY_LENGTH,
  PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH,
  ProjectChatError,
  type ProjectChatAcknowledgeInput,
  type ProjectChatActor,
  type ProjectChatContext,
  type ProjectChatJoinInput,
  type ProjectChatMentionStateInput,
  type ProjectChatPresenceInput,
  type ProjectChatProfileUpdateInput,
  type ProjectChatReadInput,
  type ProjectChatSendInput
} from './contracts';
import {
  normalizeProjectChatProviderAvatarUrl,
  parseProjectChatAvatarDataUrl
} from './avatar';

const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_METADATA_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_HANDLE = /^[a-z0-9][a-z0-9_-]*$/;

function invalid(message: string): never {
  throw new ProjectChatError('invalid_request', message);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    invalid('The request contains unsupported fields.');
  }
}

function boundedString(
  value: unknown,
  name: string,
  options: { max: number; min?: number; trim?: boolean } = { max: 128 }
) {
  if (typeof value !== 'string') {
    invalid(`${name} must be text.`);
  }
  const result = options.trim === false ? value : value.trim();
  if (result.length < (options.min ?? 1) || result.length > options.max) {
    invalid(`${name} must be between ${options.min ?? 1} and ${options.max} characters.`);
  }
  if (CONTROL_CHARACTER.test(result)) {
    invalid(`${name} contains unsupported control characters.`);
  }
  return result;
}

function boundedMetadataString(value: unknown, name: string, max: number) {
  const input = boundedString(value, name, { max });
  if (UNSAFE_METADATA_TEXT.test(input)) {
    invalid(`${name} contains unsupported characters.`);
  }
  const result = input.normalize('NFKC').replace(/\s+/gu, ' ');
  if (UNSAFE_METADATA_TEXT.test(result) || result.length > max) {
    invalid(`${name} contains unsupported characters.`);
  }
  return result;
}

function optionalBoundedMetadataString(value: unknown, name: string, max: number) {
  return value === undefined ? undefined : boundedMetadataString(value, name, max);
}

function identifier(value: unknown, name: string, max = 128) {
  const result = boundedString(value, name, { max });
  if (!SAFE_IDENTIFIER.test(result)) {
    invalid(`${name} has an invalid format.`);
  }
  return result;
}

function channelId(value: unknown) {
  return value === undefined
    ? PROJECT_CHAT_GENERAL_CHANNEL_ID
    : identifier(value, 'channelId', 128);
}

function codexThreadId(value: unknown) {
  const result = identifier(value, 'threadId');
  if (!SAFE_CODEX_THREAD_ID.test(result)) {
    invalid('threadId is not a valid Codex thread identifier.');
  }
  return result;
}

function nonNegativeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${name} must be a non-negative integer.`);
  }
  return value as number;
}

function positiveLimit(value: unknown, fallback: number, max: number) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    invalid(`limit must be between 1 and ${max}.`);
  }
  return value as number;
}

export function normalizeProjectChatHandle(displayName: string) {
  const handle = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!SAFE_HANDLE.test(handle)) {
    invalid('displayName must produce a valid mention handle.');
  }
  return handle;
}

export function projectChatActorKey(actor: ProjectChatActor) {
  switch (actor.kind) {
    case 'human':
      return JSON.stringify(['human', actor.accountId]);
    case 'agent':
      return JSON.stringify(['agent', actor.accountId, actor.machineId, actor.threadId]);
    case 'system':
      return JSON.stringify(['system', actor.serviceId]);
  }
}

export function validateProjectChatContext(context: ProjectChatContext) {
  identifier(context.spaceId, 'spaceId');
  const actor = context.actor;
  switch (actor.kind) {
    case 'human':
      identifier(actor.accountId, 'accountId');
      boundedMetadataString(actor.displayName, 'displayName', PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH);
      if (!SAFE_HANDLE.test(actor.handle) || actor.handle.length > 32) {
        invalid('The authenticated human handle is invalid.');
      }
      if (
        actor.avatarUrl !== undefined &&
        normalizeProjectChatProviderAvatarUrl(actor.avatarUrl) !== actor.avatarUrl
      ) {
        invalid('The authenticated human avatar is invalid.');
      }
      break;
    case 'agent':
      identifier(actor.accountId, 'accountId');
      identifier(actor.machineId, 'machineId');
      identifier(actor.hostId, 'hostId');
      codexThreadId(actor.threadId);
      break;
    case 'system':
      identifier(actor.serviceId, 'serviceId');
      boundedMetadataString(actor.displayName, 'displayName', PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH);
      if (!SAFE_HANDLE.test(actor.handle) || actor.handle.length > 32) {
        invalid('The authenticated system handle is invalid.');
      }
      break;
    default:
      invalid('The authenticated actor is invalid.');
  }
}

export function parseProjectChatJoinInput(actor: ProjectChatActor, input: unknown) {
  const value = objectInput(input ?? {});
  exactKeys(value, ['displayName', 'projectId', 'taskTitle']);
  const projectId = value.projectId === undefined
    ? undefined
    : identifier(value.projectId, 'projectId', 256);
  if (actor.kind !== 'agent') {
    if (value.displayName !== undefined || value.taskTitle !== undefined) {
      invalid('Authenticated human and system identities cannot be overridden.');
    }
    return { projectId };
  }
  return {
    displayName: boundedMetadataString(
      value.displayName,
      'displayName',
      PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH
    ),
    projectId,
    taskTitle: optionalBoundedMetadataString(value.taskTitle, 'taskTitle', 160)
  } satisfies Required<Pick<ProjectChatJoinInput, 'displayName'>> &
    Pick<ProjectChatJoinInput, 'projectId' | 'taskTitle'>;
}

export function parseProjectChatPresenceInput(actor: ProjectChatActor, input: unknown) {
  const value = objectInput(input);
  exactKeys(value, ['state', 'taskTitle']);
  if (value.state !== 'working' && value.state !== 'idle') {
    invalid('state must be working or idle.');
  }
  if (actor.kind !== 'agent' && value.taskTitle !== undefined) {
    invalid('Only an authenticated agent can update task metadata.');
  }
  const taskTitle = value.taskTitle === null || value.taskTitle === ''
    ? null
    : optionalBoundedMetadataString(value.taskTitle, 'taskTitle', 160);
  return {
    state: value.state,
    taskTitle
  } satisfies ProjectChatPresenceInput;
}

export function parseProjectChatProfileUpdateInput(input: unknown) {
  const value = objectInput(input);
  exactKeys(value, ['displayName', 'avatarDataUrl']);
  if (value.displayName === undefined && value.avatarDataUrl === undefined) {
    invalid('At least one profile field must be updated.');
  }

  const displayName = value.displayName === null
    ? null
    : optionalBoundedMetadataString(
        value.displayName,
        'displayName',
        PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH
      );
  const avatarDataUrl = value.avatarDataUrl === null
    ? null
    : value.avatarDataUrl === undefined
      ? undefined
      : parseProjectChatAvatarDataUrl(value.avatarDataUrl);

  return { avatarDataUrl, displayName } satisfies ProjectChatProfileUpdateInput;
}

export function parseProjectChatSendInput(input: unknown) {
  const value = objectInput(input);
  exactKeys(value, ['channelId', 'body', 'idempotencyKey']);
  const body = boundedString(value.body, 'body', {
    max: PROJECT_CHAT_MAX_BODY_LENGTH,
    trim: false
  }).replace(/\r\n?/g, '\n');
  if (body.trim().length === 0) {
    invalid('body cannot be empty.');
  }
  const idempotencyKey = identifier(value.idempotencyKey, 'idempotencyKey');
  return { body, channelId: channelId(value.channelId), idempotencyKey } satisfies ProjectChatSendInput;
}

export function parseProjectChatReadInput(input: unknown) {
  const value = objectInput(input ?? {});
  exactKeys(value, ['channelId', 'afterSequence', 'limit']);
  return {
    channelId: channelId(value.channelId),
    afterSequence: value.afterSequence === undefined
      ? undefined
      : nonNegativeInteger(value.afterSequence, 'afterSequence'),
    limit: positiveLimit(value.limit, 100, 200)
  } satisfies ProjectChatReadInput;
}

export function parseProjectChatAcknowledgeInput(input: unknown) {
  const value = objectInput(input);
  exactKeys(value, ['channelId', 'throughSequence']);
  return {
    channelId: channelId(value.channelId),
    throughSequence: nonNegativeInteger(value.throughSequence, 'throughSequence')
  } satisfies ProjectChatAcknowledgeInput;
}

export function parseProjectChatMentionStateInput(input: unknown) {
  const value = objectInput(input ?? {});
  exactKeys(value, ['channelId', 'limit']);
  return {
    channelId: channelId(value.channelId),
    limit: positiveLimit(value.limit, 50, 100)
  } satisfies ProjectChatMentionStateInput;
}
