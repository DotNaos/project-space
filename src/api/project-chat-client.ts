import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  type ProjectChatAcknowledgeRequest,
  type ProjectChatAcknowledgeResult,
  type ProjectChatApiErrorPayload,
  type ProjectChatClient,
  type ProjectChatJoinRequest,
  type ProjectChatJoinResult,
  type ProjectChatMemberListResult,
  type ProjectChatMemberRecord,
  type ProjectChatMentionListRequest,
  type ProjectChatMentionListResult,
  type ProjectChatPresenceRequest,
  type ProjectChatReadRequest,
  type ProjectChatReadResult,
  type ProjectChatSendRequest,
  type ProjectChatSendResult
} from '../shared/project-chat-api';

export class ProjectChatRequestError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;
  readonly status: number;

  constructor({ code, message, retryAfterMs, status }: {
    code: string;
    message: string;
    retryAfterMs?: number;
    status: number;
  }) {
    super(message);
    this.name = 'ProjectChatRequestError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export interface ProjectChatClientOptions {
  authToken?: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  getAuthToken?: () => Promise<string | null> | string | null;
}

function isIpv4Loopback(host: string) {
  const octets = host.split('.');
  return octets.length === 4 && octets.every((octet, index) => {
    if (!/^\d{1,3}$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255 && (index !== 0 || value === 127);
  });
}

function safeProjectChatBaseUrl(value = '') {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//')) {
      throw new Error('Project Chat base URL must not be protocol-relative.');
    }

    return trimmed.replace(/\/+$/, '');
  }

  const url = new URL(trimmed);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Project Chat base URL must be an HTTP(S) URL without credentials.');
  }

  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isIpv4Loopback(host) ||
    host === '[::1]' ||
    host === '::1';
  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error('Project Chat requires HTTPS for non-local servers.');
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function safeAuthToken(value: string | null | undefined) {
  const token = value?.trim() ?? '';
  if (/[\r\n]/.test(token)) {
    throw new Error('Project Chat auth token contains invalid characters.');
  }

  return token;
}

async function readProjectChatResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => undefined)) as
    | ProjectChatApiErrorPayload
    | T
    | undefined;

  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? payload.error
      : undefined;
    throw new ProjectChatRequestError({
      code: error?.code ?? 'request_failed',
      message: error?.message ?? `Project Chat request failed with ${response.status}.`,
      retryAfterMs: error?.retryAfterMs,
      status: response.status
    });
  }

  if (payload === undefined) {
    throw new ProjectChatRequestError({
      code: 'invalid_response',
      message: 'Project Chat returned an invalid response.',
      status: response.status
    });
  }

  return payload as T;
}

export function createProjectChatClient(options: ProjectChatClientOptions): ProjectChatClient {
  const baseUrl = safeProjectChatBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

  async function request<T>(path: string, init?: RequestInit) {
    const token = safeAuthToken(
      options.getAuthToken ? await options.getAuthToken() : options.authToken
    );
    const response = await fetchImplementation(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      }
    });

    return readProjectChatResponse<T>(response);
  }

  return {
    acknowledge(value: ProjectChatAcknowledgeRequest) {
      return request<ProjectChatAcknowledgeResult>('/api/project-chat/ack', {
        body: JSON.stringify(value),
        method: 'POST'
      });
    },
    join(value: ProjectChatJoinRequest = {}) {
      return request<ProjectChatJoinResult>('/api/project-chat/join', {
        body: JSON.stringify(value),
        method: 'POST'
      });
    },
    listMembers() {
      return request<ProjectChatMemberListResult>('/api/project-chat/members');
    },
    listMentions(value: ProjectChatMentionListRequest = {}) {
      const query = new URLSearchParams({
        channelId: value.channelId ?? PROJECT_CHAT_GENERAL_CHANNEL_ID,
        limit: String(value.limit ?? 50)
      });
      return request<ProjectChatMentionListResult>(`/api/project-chat/mentions?${query}`);
    },
    read(value: ProjectChatReadRequest = {}) {
      const query = new URLSearchParams({
        channelId: value.channelId ?? PROJECT_CHAT_GENERAL_CHANNEL_ID,
        limit: String(value.limit ?? 100)
      });
      if (value.afterSequence !== undefined) {
        query.set('afterSequence', String(value.afterSequence));
      }
      return request<ProjectChatReadResult>(`/api/project-chat/messages?${query}`);
    },
    send(value: ProjectChatSendRequest) {
      return request<ProjectChatSendResult>('/api/project-chat/messages', {
        body: JSON.stringify(value),
        method: 'POST'
      });
    },
    updatePresence(value: ProjectChatPresenceRequest) {
      return request<ProjectChatMemberRecord>('/api/project-chat/presence', {
        body: JSON.stringify(value),
        method: 'POST'
      });
    }
  };
}
