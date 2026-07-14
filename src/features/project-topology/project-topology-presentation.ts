import type {
  TopologyBrowserCapability,
  TopologyInventoryResult,
  TopologyTask,
  TopologyTranscriptItem
} from './project-topology-types';

export interface TopologyTaskHeaderView {
  agentLabel: string;
  branchName?: string;
  issueLabel?: string;
  title: string;
}

export interface TopologyTranscriptPresentation {
  detail?: string;
  items: TopologyTranscriptItem[];
  label: string;
  lastSafeAt?: string;
  state: 'blocked' | 'checking' | 'ready' | 'stale';
}

export interface TopologyBrowserPresentation {
  label: string;
  reason?: string;
  state: TopologyBrowserCapability['state'];
}

const transcriptItemLabels: Record<TopologyTranscriptItem['kind'], string> = {
  'agent-message': 'Agent message',
  command: 'Command',
  'file-change': 'File change',
  'mcp-tool': 'Tool call',
  plan: 'Plan update',
  reasoning: 'Reasoning',
  status: 'Status update',
  'user-message': 'User message'
};

export function topologyTaskHeader(task: TopologyTask): TopologyTaskHeaderView {
  return {
    agentLabel: task.agentLabel,
    ...(task.branchName ? { branchName: task.branchName } : {}),
    ...(task.issue ? { issueLabel: `#${task.issue.number}` } : {}),
    title: task.title
  };
}

export function orderedTopologyTranscriptItems(items: readonly TopologyTranscriptItem[]) {
  return items
    .map((item, index) => ({ index, item }))
    .sort((left, right) => left.item.order - right.item.order || left.index - right.index)
    .map(({ item }) => item);
}

export function topologyTranscriptPresentation(
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>
): TopologyTranscriptPresentation {
  if (transcript.state === 'checking') {
    return { items: [], label: 'Checking transcript', state: 'checking' };
  }
  if (transcript.state === 'blocked') {
    return {
      detail: transcript.reason,
      items: [],
      label: 'Transcript unavailable',
      state: 'blocked'
    };
  }
  const items = orderedTopologyTranscriptItems(transcript.data);
  if (transcript.state === 'stale') {
    return {
      detail: transcript.reason,
      items,
      label: 'Stale transcript',
      lastSafeAt: transcript.lastSafeAt,
      state: 'stale'
    };
  }
  return {
    items,
    label: items.length > 0 ? 'Current task transcript' : 'No stored transcript items',
    state: 'ready'
  };
}

export function topologyTranscriptPreviewItems(
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>,
  maximum = 3
) {
  const count = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 3;
  return topologyTranscriptPresentation(transcript).items.slice(-count);
}

export function topologyTranscriptItemLabel(item: TopologyTranscriptItem) {
  return transcriptItemLabels[item.kind];
}

export function topologyTranscriptItemText(item: TopologyTranscriptItem) {
  return item.text?.trim() || item.detail?.trim() || topologyTranscriptItemLabel(item);
}

export function topologyBrowserPresentation(
  browser: TopologyBrowserCapability
): TopologyBrowserPresentation {
  if (browser.state === 'ready') {
    return { label: 'Live browser · read-only', state: 'ready' };
  }
  return {
    label: browser.state === 'blocked' ? 'Browser blocked' : 'Browser unavailable',
    reason: browser.reason,
    state: browser.state
  };
}

export function topologyBoundBrowserCapability(
  task: Pick<TopologyTask, 'browser' | 'machineId' | 'threadId'>
): TopologyBrowserCapability {
  if (
    task.browser.state !== 'ready'
    || (
      task.browser.machineId === task.machineId
      && task.browser.threadId === task.threadId
    )
  ) return task.browser;
  return {
    checkedAt: task.browser.checkedAt,
    reason: 'The browser capability does not match this exact task.',
    state: 'blocked'
  };
}
