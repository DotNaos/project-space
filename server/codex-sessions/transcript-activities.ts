import type { CodexConversationItemRecord } from '../../src/shared/codex-sessions-api';

export function safeTranscriptActivity(
  type: string,
  payload: Record<string, unknown>
): {
  detail: string;
  kind: Exclude<
    CodexConversationItemRecord['kind'],
    'agent-message' | 'user-message'
  >;
} {
  if (type === 'tool_search_call') {
    return { detail: 'Checked available tools', kind: 'mcp-tool' };
  }
  const name = typeof payload.name === 'string' ? payload.name : '';
  const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
  if (type === 'custom_tool_call' && name === 'exec') {
    return { detail: 'Ran a command', kind: 'command' };
  }
  if (type === 'custom_tool_call' && name === 'apply_patch') {
    return { detail: 'Updated files', kind: 'file-change' };
  }
  if (namespace === 'web') {
    return { detail: 'Searched the web', kind: 'mcp-tool' };
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
  return { detail: 'Used a connected tool', kind: 'mcp-tool' };
}
