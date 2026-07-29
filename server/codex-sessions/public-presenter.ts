import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type {
  CodexConversationItemKind,
  CodexConversationItemRecord,
  CodexConversationTurnRecord,
  CodexSessionRecord,
  CodexSessionStreamEvent,
  CodexSessionUserInputQuestion
} from '../../src/shared/codex-sessions-api';
import { scanProjectChatText } from '../project-chat/secret-scan';
import type {
  CodexRpcId,
  CodexSessionEvent,
  CodexThreadSummary
} from './contracts';

const redactedText = '[Sensitive content redacted]';

export function publicCodexRequestId(id: CodexRpcId) {
  return `${typeof id === 'number' ? 'n' : 's'}:${id}`;
}

export function presentCodexSession(
  thread: CodexThreadSummary,
  input: {
    archived: boolean;
    loadedThreadIds: ReadonlySet<string>;
    machineId: string;
    machineName: string;
  }
): CodexSessionRecord {
  const timestamp = numericTimestamp(thread.updatedAt) ?? numericTimestamp(thread.createdAt) ?? 0;
  const cwd = safeText(thread.cwd);
  return {
    archived: input.archived,
    ...(cwd ? { cwd } : {}),
    id: thread.id,
    lastActivityAt: new Date(timestamp).toISOString(),
    loadedByProjectSpace: input.loadedThreadIds.has(thread.id),
    machineId: input.machineId,
    machineName: safeText(input.machineName) ?? 'Connected machine',
    ...(safeText(thread.model) ? { model: safeText(thread.model) } : {}),
    ...(safeText(thread.modelProvider) ? { modelProvider: safeText(thread.modelProvider) } : {}),
    ...(cwd ? { project: basename(cwd) } : {}),
    ...(typeof thread.source === 'string' && safeText(thread.source)
      ? { source: safeText(thread.source) }
      : {}),
    status: input.archived ? 'archived' : publicStatus(thread),
    title: safeText(thread.name) ?? safeText(thread.preview) ?? 'Untitled Codex thread'
  };
}

export function presentCodexTurns(thread: CodexThreadSummary): CodexConversationTurnRecord[] {
  if (!Array.isArray(thread.turns)) return [];
  return thread.turns.flatMap((value) => {
    const turn = record(value);
    if (!turn || typeof turn.id !== 'string') return [];
    const status = turnStatus(turn.status);
    return [{
      ...(isoTimestamp(turn.completedAt) ? { completedAt: isoTimestamp(turn.completedAt) } : {}),
      id: turn.id,
      items: Array.isArray(turn.items) ? turn.items.flatMap(presentItem) : [],
      ...(isoTimestamp(turn.startedAt) ? { startedAt: isoTimestamp(turn.startedAt) } : {}),
      status
    }];
  });
}

export class CodexPublicEventPresenter {
  private readonly deltaText = new Map<string, string>();
  private readonly redactedDeltaItems = new Set<string>();

  present(event: CodexSessionEvent): CodexSessionStreamEvent | undefined {
    const params = record(event.params);
    if (!params) return undefined;
    const threadId = stringValue(params.threadId) ?? '';
    const turn = record(params.turn);
    const turnId = stringValue(params.turnId) ?? stringValue(turn?.id) ?? '';

    if (event.kind === 'request') {
      const requestId = publicCodexRequestId(event.requestId!);
      if (event.method === 'item/tool/requestUserInput' || event.method === 'tool/requestUserInput') {
        const questions = presentQuestions(params.questions);
        if (questions.length === 0 || !turnId) return undefined;
        return {
          eventId: eventId(event.method, threadId, turnId, requestId, questions),
          questions,
          requestId,
          turnId,
          type: 'user-input-requested'
        };
      }
      if (!turnId) return undefined;
      const itemId = stringValue(params.itemId);
      const permissionRequest = event.method === 'item/permissions/requestApproval';
      const permission = permissionRequest
        ? presentCodexPermissionSummary(params.permissions ?? params.requestedPermissions)
        : undefined;
      return {
        ...(permissionRequest ? { approvalId: 'permissions' } : {}),
        ...(permissionRequest ? { canAllow: permission?.complete === true } : {}),
        ...(safeText(params.command) ? { command: safeText(params.command) } : {}),
        eventId: eventId(event.method, threadId, turnId, requestId, itemId),
        ...(itemId ? { itemId } : {}),
        kind: permissionRequest
          ? 'permissions'
          : event.method === 'item/fileChange/requestApproval'
            ? 'file-change'
            : 'command',
        ...(permissionRequest && permission?.summary.length
          ? { permissionSummary: permission.summary }
          : {}),
        requestId,
        turnId,
        type: 'approval-requested'
      };
    }

    if (event.method === 'item/agentMessage/delta') {
      const itemId = stringValue(params.itemId) ?? 'agent-message';
      const rawDelta = stringValue(params.delta);
      if (!rawDelta) return undefined;
      const itemKey = `${threadId}\u0000${turnId}\u0000${itemId}`;
      if (this.redactedDeltaItems.has(itemKey)) return undefined;
      const previous = this.deltaText.get(itemKey) ?? '';
      const combined = `${previous}${rawDelta}`;
      const visibleCombined = safeText(combined);
      if (visibleCombined === redactedText) {
        this.deltaText.delete(itemKey);
        this.redactedDeltaItems.add(itemKey);
        return {
          eventId: eventId(event.method, threadId, turnId, itemId, 'redacted'),
          item: {
            id: itemId,
            kind: 'agent-message',
            status: 'in-progress',
            text: redactedText
          },
          type: 'item'
        };
      }
      const visiblePrevious = safeText(previous) ?? '';
      const delta = visibleCombined?.slice(visiblePrevious.length);
      this.deltaText.set(itemKey, combined);
      if (!delta) return undefined;
      return {
        delta,
        eventId: eventId(event.method, threadId, turnId, itemId, visiblePrevious.length, delta),
        itemId,
        type: 'agent-message-delta'
      };
    }

    if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = presentItem(params.item)[0];
      if (!item) return undefined;
      if (event.method === 'item/completed') {
        const itemKey = `${threadId}\u0000${turnId}\u0000${item.id}`;
        this.deltaText.delete(itemKey);
        this.redactedDeltaItems.delete(itemKey);
      }
      return {
        eventId: eventId(event.method, threadId, turnId, item.id, item.status),
        item,
        type: 'item'
      };
    }

    if (event.method === 'thread/status/changed') {
      const status = record(params.status);
      return {
        eventId: eventId(event.method, threadId, status?.type),
        status: status?.type === 'active'
          ? 'active'
          : status?.type === 'systemError'
            ? 'unavailable'
            : 'idle',
        type: 'session-status'
      };
    }

    if (event.method === 'thread/settings/updated') {
      const settings = record(params.threadSettings);
      const activeProfile = record(settings?.activePermissionProfile);
      const permissionProfileId = stringValue(activeProfile?.id);
      return {
        eventId: eventId(event.method, threadId, permissionProfileId),
        ...(permissionProfileId ? { permissionProfileId } : {}),
        type: 'session-settings'
      };
    }

    if (event.method === 'thread/tokenUsage/updated' && turnId) {
      const tokenUsage = presentTokenUsage(params.tokenUsage);
      if (!tokenUsage) return undefined;
      return {
        eventId: eventId(event.method, threadId, turnId, tokenUsage),
        tokenUsage,
        turnId,
        type: 'token-usage'
      };
    }

    if (event.method === 'turn/completed' && turnId) {
      return {
        eventId: eventId(event.method, threadId, turnId, turn?.status),
        ...(turn?.status === 'failed' ? { reason: 'Codex turn failed.' } : {}),
        turnId,
        type: 'turn-completed'
      };
    }
    return undefined;
  }
}

export function eventThreadId(event: CodexSessionEvent) {
  const params = record(event.params);
  return stringValue(params?.threadId);
}

function presentItem(value: unknown): CodexConversationItemRecord[] {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return [];
  const kind = itemKind(item.type);
  if (!kind) return [];
  const status = itemStatus(item.status);
  const text = visibleItemText(kind, item);
  return [{
    ...(itemDetail(kind, item) ? { detail: itemDetail(kind, item) } : {}),
    id: item.id,
    kind,
    ...(status ? { status } : {}),
    ...(text ? { text } : {})
  }];
}

function visibleItemText(kind: CodexConversationItemKind, item: Record<string, unknown>) {
  if (kind === 'reasoning' || kind === 'command' || kind === 'file-change') return undefined;
  if (kind === 'agent-message') return safeText(item.text);
  if (kind === 'plan') return safeText(item.text ?? item.plan);
  if (kind === 'user-message') {
    const content = Array.isArray(item.content) ? item.content : [];
    return safeText(content.map((part) => stringValue(record(part)?.text)).filter(Boolean).join('\n'));
  }
  return safeText(item.tool ?? item.serverName);
}

function itemDetail(kind: CodexConversationItemKind, item: Record<string, unknown>) {
  if (kind === 'reasoning') return 'Reasoning update';
  if (kind === 'command') return 'Command execution';
  if (kind === 'file-change') return 'File change';
  if (kind === 'mcp-tool') return safeText(item.tool ?? item.serverName) ?? 'Tool call';
  return undefined;
}

function itemKind(value: string): CodexConversationItemKind | undefined {
  return ({
    agentMessage: 'agent-message',
    commandExecution: 'command',
    fileChange: 'file-change',
    mcpToolCall: 'mcp-tool',
    plan: 'plan',
    reasoning: 'reasoning',
    userMessage: 'user-message'
  } as Record<string, CodexConversationItemKind>)[value];
}

function itemStatus(value: unknown): CodexConversationItemRecord['status'] | undefined {
  if (value === 'inProgress') return 'in-progress';
  if (value === 'completed' || value === 'failed' || value === 'pending') return value;
  if (value === 'declined') return 'failed';
  return undefined;
}

function turnStatus(value: unknown): CodexConversationTurnRecord['status'] {
  if (value === 'inProgress') return 'in-progress';
  if (value === 'failed' || value === 'interrupted') return value;
  return 'completed';
}

function publicStatus(thread: CodexThreadSummary): CodexSessionRecord['status'] {
  if (thread.status?.type === 'active') return 'active';
  if (thread.status?.type === 'systemError') return 'unavailable';
  return 'idle';
}

function presentQuestions(value: unknown): CodexSessionUserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry) => {
    const question = record(entry);
    const id = stringValue(question?.id);
    const prompt = safeText(question?.question ?? question?.prompt);
    if (!id || !prompt) return [];
    const options = Array.isArray(question?.options) ? question.options : [];
    const choices = options.flatMap((option) => {
      const recordOption = record(option);
      const label = safeText(recordOption?.label);
      const value = safeText(recordOption?.value ?? recordOption?.label);
      return label && value ? [{ label, value }] : [];
    });
    return [{ ...(choices.length > 0 ? { choices } : {}), id, prompt }];
  });
}

export function presentCodexPermissionSummary(value: unknown) {
  const summary: string[] = [];
  let complete = true;
  const visit = (entry: unknown, path: string[], depth: number) => {
    if (summary.length >= 32 || depth > 4) {
      complete = false;
      return;
    }
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      const label = safeText(path.join('.'));
      const content = safeText(String(entry));
      if (!label || !content || label === redactedText || content === redactedText) {
        complete = false;
        return;
      }
      summary.push(`${label}: ${content}`.slice(0, 240));
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length === 0) summary.push(`${path.join('.')}: none`);
      entry.forEach((item) => visit(item, path, depth + 1));
      return;
    }
    const object = record(entry);
    if (!object) {
      complete = false;
      return;
    }
    const entries = Object.entries(object);
    if (entries.length === 0) summary.push(`${path.join('.') || 'permissions'}: none`);
    entries.forEach(([key, item]) => visit(item, [...path, key], depth + 1));
  };
  visit(value, [], 0);
  return { complete: complete && summary.length > 0, summary };
}

function safeText(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined;
  return scanProjectChatText(value).safe ? value.slice(0, 32_000) : redactedText;
}

function presentTokenUsage(value: unknown) {
  const usage = record(value);
  const last = presentTokenBreakdown(usage?.last);
  const total = presentTokenBreakdown(usage?.total);
  if (!last || !total) return undefined;
  const contextWindow = safeInteger(usage?.modelContextWindow);
  return {
    last,
    ...(contextWindow && contextWindow > 0 ? { modelContextWindow: contextWindow } : {}),
    total
  };
}

function presentTokenBreakdown(value: unknown) {
  const usage = record(value);
  if (!usage) return undefined;
  const cachedInputTokens = safeInteger(usage.cachedInputTokens);
  const inputTokens = safeInteger(usage.inputTokens);
  const outputTokens = safeInteger(usage.outputTokens);
  const reasoningOutputTokens = safeInteger(usage.reasoningOutputTokens);
  const totalTokens = safeInteger(usage.totalTokens);
  if (
    cachedInputTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    totalTokens === undefined
  ) return undefined;
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function safeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function numericTimestamp(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function isoTimestamp(value: unknown) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  const numeric = numericTimestamp(value);
  return numeric === undefined ? undefined : new Date(numeric).toISOString();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function eventId(...parts: unknown[]) {
  return `codex:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
}
