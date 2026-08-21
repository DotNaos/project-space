import type { CodexConversationItemRecord } from '../../src/shared/codex-sessions-api';
import { scanProjectChatText } from '../project-chat/secret-scan';

type ActivityDescription = {
  detail: string;
  kind: Exclude<CodexConversationItemRecord['kind'], 'agent-message' | 'user-message'>;
};

export function safeTranscriptActivity(
  type: string,
  payload: Record<string, unknown>
): ActivityDescription {
  if (type === 'tool_search_call') {
    return { detail: 'Checked available tools', kind: 'mcp-tool' };
  }
  const name = typeof payload.name === 'string' ? payload.name : '';
  const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
  if (type === 'custom_tool_call' && name === 'exec') {
    return { detail: transcriptCommandDetail(payload.input), kind: 'command' };
  }
  if (type === 'custom_tool_call' && name === 'apply_patch') {
    return { detail: transcriptPatchDetail(payload.input), kind: 'file-change' };
  }
  if (namespace === 'web') {
    return { detail: webDetail(payload.arguments), kind: 'mcp-tool' };
  }
  if (namespace === 'codex_app' && name === 'list_threads') {
    return { detail: 'Listed Codex tasks', kind: 'mcp-tool' };
  }
  if (namespace === 'mcp__node_repl' && name === 'js') {
    return { detail: 'Checked the browser', kind: 'mcp-tool' };
  }
  if (name === 'wait') {
    return { detail: 'Waited for a running task', kind: 'status' };
  }
  return {
    detail: safeDetail(humanizeToolName(name) || 'Used a connected tool'),
    kind: 'mcp-tool'
  };
}

export function appServerActivityDetail(
  kind: CodexConversationItemRecord['kind'],
  item: Record<string, unknown>
) {
  if (kind === 'reasoning') return 'Reasoning update';
  if (kind === 'command') return commandActionsDetail(item.commandActions);
  if (kind === 'file-change') return fileChangesDetail(item.changes);
  if (item.type === 'webSearch') {
    return safeDetail(typeof item.query === 'string' ? `Searched the web for ${item.query}` : 'Searched the web');
  }
  if (item.type === 'collabAgentToolCall') return collabDetail(item.tool);
  if (kind === 'mcp-tool') {
    const appContext = record(item.appContext);
    const label = text(appContext?.actionName) ?? text(item.tool) ?? text(item.serverName) ?? text(item.server);
    return safeDetail(humanizeToolName(label) || 'Tool call');
  }
  return undefined;
}

function commandActionsDetail(value: unknown) {
  if (!Array.isArray(value)) return 'Ran a command';
  const descriptions = value.flatMap((entry) => {
    const action = record(entry);
    if (!action) return [];
    if (action.type === 'read') {
      const target = text(action.name) ?? finalPathPart(text(action.path));
      return [target ? `Read ${target}` : 'Read files'];
    }
    if (action.type === 'listFiles') {
      const target = finalPathPart(text(action.path));
      return [target ? `Listed files in ${target}` : 'Listed files'];
    }
    if (action.type === 'search') {
      const query = text(action.query);
      return [query ? `Searched for ${query}` : 'Searched code'];
    }
    return [commandDetail(text(action.command))];
  });
  return summarize(descriptions, 'Ran a command');
}

function fileChangesDetail(value: unknown) {
  if (!Array.isArray(value)) return 'Updated files';
  const descriptions = value.flatMap((entry) => {
    const change = record(entry);
    const path = finalPathPart(text(change?.path));
    if (!path) return [];
    const verb = change?.kind === 'add' ? 'Added' : change?.kind === 'delete' ? 'Deleted' : 'Updated';
    return [`${verb} ${path}`];
  });
  return summarize(descriptions, 'Updated files');
}

function transcriptCommandDetail(value: unknown) {
  if (typeof value !== 'string') return 'Ran a command';
  const match = value.match(/"cmd"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (!match?.[1]) return 'Ran a command';
  try {
    return safeDetail(commandDetail(JSON.parse(match[1])));
  } catch {
    return 'Ran a command';
  }
}

function transcriptPatchDetail(value: unknown) {
  if (typeof value !== 'string') return 'Updated files';
  const files = [...value.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\\n\n]+)/g)]
    .map((match) => finalPathPart(match[1]?.replace(/\\n/g, '')))
    .filter((path): path is string => Boolean(path));
  return summarize(files.map((path) => `Updated ${path}`), 'Updated files');
}

function commandDetail(command: string | undefined) {
  if (!command) return 'Ran a command';
  const normalized = command.trim();
  if (/^(?:rg|grep)\b/.test(normalized)) return 'Searched code';
  if (/^(?:sed|head|tail|cat)\b/.test(normalized)) return 'Read files';
  if (/^git\s+status\b/.test(normalized)) return 'Checked Git status';
  if (/^git\s+(?:diff|show|log)\b/.test(normalized)) return 'Inspected Git history';
  if (/^bun\s+(?:test|run test)\b/.test(normalized)) return 'Ran tests';
  if (/^bun\s+(?:run )?(?:lint|typecheck|check)\b/.test(normalized)) return 'Checked the code';
  if (/^gh\s+issue\s+view\b/.test(normalized)) return 'Read a GitHub issue';
  return 'Ran a command';
}

function webDetail(value: unknown) {
  if (typeof value !== 'string') return 'Searched the web';
  try {
    const input = record(JSON.parse(value));
    const searches = Array.isArray(input?.search_query) ? input.search_query : [];
    const first = record(searches[0]);
    return safeDetail(text(first?.q) ? `Searched the web for ${text(first?.q)}` : 'Searched the web');
  } catch {
    return 'Searched the web';
  }
}

function collabDetail(value: unknown) {
  return ({
    closeAgent: 'Closed a delegated task',
    resumeAgent: 'Resumed a delegated task',
    sendInput: 'Sent input to a delegated task',
    spawnAgent: 'Delegated a task',
    wait: 'Waited for delegated tasks'
  } as Record<string, string>)[String(value)] ?? 'Coordinated delegated tasks';
}

function humanizeToolName(value: string | undefined) {
  if (!value) return undefined;
  const final = value.split(/[/.]/).at(-1) ?? value;
  const words = final.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : undefined;
}

function summarize(values: string[], fallback: string) {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length === 0) return fallback;
  const summary = unique.length > 2 ? `${unique.slice(0, 2).join(', ')} and ${unique.length - 2} more` : unique.join(', ');
  return safeDetail(summary);
}

function safeDetail(value: string) {
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, 240);
  return trimmed && scanProjectChatText(trimmed).safe ? trimmed : 'Used a tool';
}

function finalPathPart(value: string | undefined) {
  return value?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
