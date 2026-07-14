import type {
  TopologyBrowserTool,
  TopologyInventoryResult,
  TopologyMachine,
  TopologyTask,
  TopologyTaskActivity,
  TopologyTaskDelivery,
  TopologyTranscriptItem,
  TopologyTruthState
} from './project-topology-types';

export interface TopologyStatusView {
  detail?: string;
  label: string;
  lastSafeAt?: string;
  tone: 'danger' | 'neutral' | 'success' | 'warning';
}

export function topologyTruthStatus(truth: TopologyTruthState): TopologyStatusView {
  switch (truth.state) {
    case 'checking':
      return { label: 'Checking', tone: 'neutral' };
    case 'ready':
      return { label: 'Ready', tone: 'success' };
    case 'limited':
      return { detail: truth.reason, label: 'Limited', tone: 'warning' };
    case 'blocked':
      return { detail: truth.reason, label: 'Blocked', tone: 'danger' };
    case 'stale':
      return {
        detail: truth.reason,
        label: 'Stale snapshot',
        lastSafeAt: truth.lastSafeAt,
        tone: 'warning'
      };
  }
}

const activityStatus: Record<TopologyTaskActivity, TopologyStatusView> = {
  active: { label: 'Active', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
  'awaiting-decision': { label: 'Awaiting decision', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
  'idle-unverified': { label: 'Idle, not complete', tone: 'neutral' },
  offline: { label: 'Offline', tone: 'warning' },
  stale: { label: 'Stale snapshot', tone: 'warning' },
  unknown: { label: 'Unknown', tone: 'neutral' }
};

const deliveryStatus: Record<Exclude<TopologyTaskDelivery, 'unknown'>, TopologyStatusView> = {
  deployed: { label: 'Deployed', tone: 'success' },
  merged: { label: 'Merged', tone: 'success' },
  'verified-complete': { label: 'Verified complete', tone: 'success' }
};

export function topologyTaskStatuses(task: TopologyTask) {
  const activity: TopologyStatusView = { ...activityStatus[task.activity] };
  if (task.activity === 'blocked' || task.activity === 'offline' || task.activity === 'stale') {
    activity.detail = task.interaction.reason;
  }
  if (task.activity === 'stale') activity.lastSafeAt = task.lastSafeAt;
  return {
    activity,
    delivery: task.delivery === 'unknown' ? undefined : deliveryStatus[task.delivery]
  };
}

export type TopologyMachineTaskArea =
  | { kind: 'tasks' }
  | { kind: 'proven-empty'; message: 'No active tasks' }
  | { detail?: string; kind: 'unavailable'; label: string };

export function topologyMachineTaskArea(machine: TopologyMachine): TopologyMachineTaskArea {
  if (machine.tasks.length > 0) return { kind: 'tasks' };
  if (machine.taskInventory.state === 'ready') {
    return { kind: 'proven-empty', message: 'No active tasks' };
  }
  const status = topologyTruthStatus(machine.taskInventory);
  return { detail: status.detail, kind: 'unavailable', label: status.label };
}

export interface TopologyTaskPreviewView {
  browserFrameUrl?: string;
  browserReadOnly: true;
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>;
}

export function topologyTaskPreview(task: TopologyTask): TopologyTaskPreviewView {
  return {
    browserFrameUrl: task.browser.state === 'ready' ? task.browser.frameUrl : undefined,
    browserReadOnly: true,
    transcript: task.transcript
  };
}

export interface TopologyWorkspaceToolView {
  checkedAt: string;
  kind: TopologyBrowserTool;
  streamUrl: string;
}

export interface TopologyTaskWorkspaceView {
  browser?: {
    frameUrl: string;
    interaction: 'read-only';
    sessionId: string;
  };
  composer: {
    action?: 'send' | 'stop';
    context: { label: 'Current task'; state: 'locked' };
    inputEnabled: boolean;
    microphone: { reason: string; state: 'unavailable' };
    model: { label: string; state: 'read-only' };
    reason?: string;
    security: { label: 'Project Space policy'; state: 'managed' };
    visible: boolean;
  };
  mode: 'split' | 'tabs' | 'transcript-only';
  tools: TopologyWorkspaceToolView[];
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>;
}

export function topologyTaskWorkspace(
  task: TopologyTask,
  options: { actionsAvailable: boolean; viewportWidth: number }
): TopologyTaskWorkspaceView {
  const browser = task.browser.state === 'ready'
    ? {
        frameUrl: task.browser.frameUrl,
        interaction: task.browser.interaction,
        sessionId: task.browser.sessionId
      }
    : undefined;
  const tools = task.browser.state === 'ready'
    ? (Object.entries(task.browser.tools) as Array<[
        TopologyBrowserTool,
        { checkedAt: string; streamUrl: string }
      ]>).map(([kind, value]) => ({ ...value, kind }))
    : [];
  const composerVisible = options.actionsAvailable && task.interaction.composerVisible;
  return {
    browser,
    composer: {
      action: composerVisible
        ? task.interaction.canInterrupt ? 'stop' : 'send'
        : undefined,
      context: { label: 'Current task', state: 'locked' },
      inputEnabled: composerVisible && task.interaction.canContinue,
      microphone: {
        reason: 'Voice input is not available for existing remote Codex tasks.',
        state: 'unavailable'
      },
      model: { label: task.model ?? 'Current model', state: 'read-only' },
      reason: composerVisible
        ? undefined
        : !options.actionsAvailable
          ? 'The existing-task messaging action is unavailable.'
          : task.interaction.reason,
      security: { label: 'Project Space policy', state: 'managed' },
      visible: composerVisible
    },
    mode: browser
      ? options.viewportWidth >= 1120
        ? 'split'
        : 'tabs'
      : 'transcript-only',
    tools,
    transcript: task.transcript
  };
}
