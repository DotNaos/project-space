import type {
  CodexConversationItemRecord,
  CodexConversationTurnRecord,
  CodexSessionRecord,
  CodexSessionStreamEvent,
  CodexTaskActivitySnapshot,
  CodexTaskIdentitySnapshot,
  CodexTaskTurnState
} from './codex-sessions-api';

interface ActivityInput {
  attention?: CodexSessionRecord['attention'];
  archived: boolean;
  lastActivityAt: string;
  observedAt?: string;
  status: CodexSessionRecord['status'];
  turns?: readonly CodexConversationTurnRecord[];
}

export function createCodexTaskActivity(input: ActivityInput): CodexTaskActivitySnapshot {
  const observedAt = validTimestamp(input.observedAt) ?? validTimestamp(input.lastActivityAt) ?? new Date(0).toISOString();
  const latestTurn = input.turns?.at(-1);
  const activeTurn = [...(input.turns ?? [])].reverse().find((turn) => turn.status === 'in-progress');
  const latestItem = [...(latestTurn?.items ?? [])].reverse().find((item) => item.kind !== 'user-message');
  const latestCompletedItem = [...(input.turns ?? [])]
    .reverse()
    .flatMap((turn) => [...turn.items].reverse())
    .find((item) => item.status === 'completed' && item.kind !== 'reasoning' && item.kind !== 'user-message');
  const terminalState = latestTurn ? terminalTurnState(latestTurn.status) : undefined;
  const currentTurnState: CodexTaskTurnState = input.attention === 'approval'
    ? 'waiting-for-approval'
    : input.attention === 'input'
      ? 'waiting-for-user'
      : activeTurn
        ? 'running'
        : terminalState ?? 'none';
  const conversationState = input.archived
    ? 'stopped' as const
    : input.status === 'unavailable' || latestTurn?.status === 'failed'
      ? 'failed' as const
      : currentTurnState === 'waiting-for-approval'
        ? 'waiting-for-approval' as const
        : currentTurnState === 'waiting-for-user'
          ? 'waiting-for-user' as const
          : input.status === 'active' || currentTurnState === 'running'
            ? 'running' as const
            : currentTurnState === 'completed' || currentTurnState === 'cancelled'
              ? 'completed' as const
              : 'idle' as const;
  return {
    conversationState,
    currentPhase: phaseForItem(latestItem, currentTurnState),
    ...(activeTurn?.id || latestTurn?.id ? { currentTurnId: activeTurn?.id ?? latestTurn?.id } : {}),
    ...(activeTurn?.startedAt || latestTurn?.startedAt
      ? { currentTurnStartedAt: activeTurn?.startedAt ?? latestTurn?.startedAt }
      : {}),
    currentTurnState,
    evidenceRevision: `inventory:${observedAt}:${input.status}:${activeTurn?.id ?? latestTurn?.id ?? 'none'}`,
    freshness: input.status === 'offline' ? 'stale' : 'live',
    lastEventAt: validTimestamp(input.lastActivityAt) ?? observedAt,
    lastSuccessfulRefreshAt: observedAt,
    latestActivity: activityForItem(latestItem, currentTurnState),
    ...(latestCompletedItem ? { latestMilestone: milestoneForItem(latestCompletedItem) } : {}),
    machineState: input.status === 'offline' ? 'offline' : 'online',
    processState: input.status === 'unavailable' || input.status === 'missing' ? 'unavailable' : 'ready'
  };
}

export function inferCodexTaskIdentity(
  cwd: string | undefined,
  title: string,
  machineName?: string
): CodexTaskIdentitySnapshot | undefined {
  const normalized = cwd?.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  const match = normalized?.match(/^(.*?\/\.worktrees\/([^/]+)\/([^/]+))(?:\/.*)?$/);
  const branch = match?.[3];
  const issueUrlMatch = title.match(
    /https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:\b|\/)/i
  );
  const branchIssueMatch = branch?.match(/^issue-(\d+)(?:-|$)/i);
  const conflictingIssueUrl = Boolean(
    branchIssueMatch && issueUrlMatch && branchIssueMatch[1] !== issueUrlMatch[2]
  );
  const issueMatch = branchIssueMatch
    ?? (issueUrlMatch ? [issueUrlMatch[0], issueUrlMatch[2]] : undefined)
    ?? title.match(/(?:^|\s|·)#?(\d+)(?:\s|·|$)/);
  const issueNumber = issueMatch ? Number(issueMatch[1]) : undefined;
  const isCodespace = machineName?.toLocaleLowerCase().includes('codespace')
    || machineName?.startsWith('project-space--');
  const result: CodexTaskIdentitySnapshot = {
    ...(branch ? { branch } : {}),
    ...(isCodespace && machineName ? { codespaceName: machineName } : {}),
    ...(issueNumber && Number.isSafeInteger(issueNumber) ? { issueNumber } : {}),
    ...(issueUrlMatch?.[1] && !conflictingIssueUrl
      ? { repository: issueUrlMatch[1] }
      : match?.[2]
        ? { repository: match[2] }
        : {}),
    ...(match?.[1] ? { worktree: match[1] } : {})
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export function applyCodexActivityEvent(
  current: CodexTaskActivitySnapshot,
  event: CodexSessionStreamEvent,
  sequence?: number
): CodexTaskActivitySnapshot {
  const observedAt = validTimestamp(event.observedAt) ?? current.lastEventAt;
  const turnId = 'turnId' in event ? event.turnId : undefined;
  const next: CodexTaskActivitySnapshot = {
    ...current,
    evidenceRevision: `event:${sequence ?? current.eventSequence ?? 0}:${event.eventId}`,
    ...(sequence !== undefined ? { eventSequence: sequence } : {}),
    freshness: 'live',
    lastEventAt: observedAt,
    latestActivity: eventActivity(event),
    machineState: 'online',
    processState: 'ready',
    ...(turnId ? { currentTurnId: turnId } : {})
  };
  if (event.type === 'approval-requested') {
    return { ...next, conversationState: 'waiting-for-approval', currentPhase: 'Waiting for approval', currentTurnState: 'waiting-for-approval' };
  }
  if (event.type === 'user-input-requested') {
    return { ...next, conversationState: 'waiting-for-user', currentPhase: 'Waiting for your answer', currentTurnState: 'waiting-for-user' };
  }
  if (event.type === 'turn-completed') {
    const failed = event.reason?.toLocaleLowerCase().includes('fail');
    const cancelled = event.reason?.toLocaleLowerCase().includes('cancel') || event.reason?.toLocaleLowerCase().includes('interrupt');
    return {
      ...next,
      conversationState: failed ? 'failed' : 'completed',
      currentPhase: failed ? 'Turn failed' : cancelled ? 'Turn stopped' : 'Turn completed',
      currentTurnState: failed ? 'failed' : cancelled ? 'cancelled' : 'completed',
      latestMilestone: failed ? current.latestMilestone : 'Finished the latest turn'
    };
  }
  if (event.type === 'session-status') {
    if (event.status === 'active') {
      return { ...next, conversationState: 'running', currentPhase: 'Codex is working', currentTurnState: 'running' };
    }
    if (event.status === 'unavailable' || event.status === 'missing') {
      return { ...next, conversationState: 'failed', currentPhase: 'Codex is unavailable', processState: 'failed' };
    }
    if (event.status === 'offline') {
      return { ...next, freshness: 'stale', machineState: 'offline' };
    }
    return current.currentTurnState === 'running' || current.currentTurnState.startsWith('waiting-')
      ? next
      : { ...next, conversationState: 'idle', currentPhase: 'Ready for a follow-up', currentTurnState: 'none' };
  }
  if (event.type === 'item') {
    const running = event.item.status === 'in-progress' || event.item.status === 'pending';
    return {
      ...next,
      ...(running ? { conversationState: 'running' as const, currentTurnState: 'running' as const } : {}),
      currentPhase: phaseForItem(event.item, running ? 'running' : current.currentTurnState),
      ...(event.item.status === 'completed' && event.item.kind !== 'reasoning'
        ? { latestMilestone: milestoneForItem(event.item) }
        : {})
    };
  }
  if (event.type === 'agent-message-delta') {
    return { ...next, conversationState: 'running', currentPhase: 'Writing a response', currentTurnState: 'running' };
  }
  return next;
}

export function mergeCodexSessionEvidence(
  current: CodexSessionRecord | undefined,
  incoming: CodexSessionRecord
): CodexSessionRecord {
  if (!current) return incoming;
  const currentActivity = current.activity;
  const incomingActivity = incoming.activity;
  if (!currentActivity || !incomingActivity) return { ...current, ...incoming };
  const activity = preferCodexTaskActivity(currentActivity, incomingActivity);
  return {
    ...current,
    ...incoming,
    activity,
    attention: activity.currentTurnState === 'waiting-for-approval'
      ? 'approval'
      : activity.currentTurnState === 'waiting-for-user'
        ? 'input'
        : incoming.attention,
    status: legacyStatus(activity, incoming.status)
  };
}

export function preferCodexTaskActivity(
  currentActivity: CodexTaskActivitySnapshot,
  incomingActivity: CodexTaskActivitySnapshot
) {
  const currentTurnIsAuthoritative = currentActivity.eventSequence !== undefined
    && ['running', 'waiting-for-approval', 'waiting-for-user'].includes(currentActivity.currentTurnState)
    && !(incomingActivity.currentTurnId === currentActivity.currentTurnId
      && ['completed', 'failed', 'cancelled'].includes(incomingActivity.currentTurnState));
  const incomingIsNewer = evidenceTime(incomingActivity) >= evidenceTime(currentActivity);
  return currentTurnIsAuthoritative || !incomingIsNewer ? currentActivity : incomingActivity;
}

export function withCodexInventoryFreshness(
  session: CodexSessionRecord,
  input: { checkedAt: string; inventoryState?: 'live' | 'stale'; online: boolean }
): CodexSessionRecord {
  if (!session.activity) return session;
  const live = input.online && input.inventoryState !== 'stale';
  return {
    ...session,
    activity: {
      ...session.activity,
      freshness: live ? 'live' : 'stale',
      lastSuccessfulRefreshAt: live ? input.checkedAt : session.activity.lastSuccessfulRefreshAt,
      machineState: live ? 'online' : 'offline'
    }
  };
}

function legacyStatus(activity: CodexTaskActivitySnapshot, fallback: CodexSessionRecord['status']) {
  if (activity.machineState === 'offline') return 'offline' as const;
  if (activity.conversationState === 'running' || activity.conversationState.startsWith('waiting-')) return 'active' as const;
  if (activity.processState === 'failed') return 'unavailable' as const;
  return fallback === 'active' ? 'idle' as const : fallback;
}

function terminalTurnState(status: CodexConversationTurnRecord['status']): CodexTaskTurnState | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'cancelled';
  return status === 'in-progress' ? 'running' : undefined;
}

function phaseForItem(item: CodexConversationItemRecord | undefined, turnState: CodexTaskTurnState) {
  if (turnState === 'waiting-for-approval') return 'Waiting for approval';
  if (turnState === 'waiting-for-user') return 'Waiting for your answer';
  if (!item) return turnState === 'running' ? 'Codex is working' : 'Ready for a follow-up';
  const labels: Record<CodexConversationItemRecord['kind'], string> = {
    'agent-message': 'Writing a response',
    command: 'Running a command',
    'file-change': 'Editing files',
    'mcp-tool': item.detail ? `Using ${item.detail}` : 'Using a tool',
    plan: 'Updating the plan',
    reasoning: 'Thinking through the next step',
    status: item.text ?? item.detail ?? 'Updating task status',
    'user-message': 'Reading your message'
  };
  return labels[item.kind];
}

function activityForItem(item: CodexConversationItemRecord | undefined, turnState: CodexTaskTurnState) {
  return item ? phaseForItem(item, turnState) : turnState === 'running' ? 'Codex is producing activity' : 'No active turn';
}

function milestoneForItem(item: CodexConversationItemRecord) {
  const labels: Record<CodexConversationItemRecord['kind'], string> = {
    'agent-message': 'Produced a response',
    command: 'Completed a command',
    'file-change': 'Applied file changes',
    'mcp-tool': item.detail ? `Completed ${item.detail}` : 'Completed a tool call',
    plan: 'Updated the plan',
    reasoning: 'Completed a reasoning step',
    status: item.text ?? item.detail ?? 'Updated task status',
    'user-message': 'Received your message'
  };
  return labels[item.kind];
}

function eventActivity(event: CodexSessionStreamEvent) {
  if (event.type === 'item') return activityForItem(event.item, event.item.status === 'in-progress' ? 'running' : 'completed');
  if (event.type === 'agent-message-delta') return 'Codex is writing a response';
  if (event.type === 'approval-requested') return 'Approval is required to continue';
  if (event.type === 'user-input-requested') return 'Your answer is required to continue';
  if (event.type === 'turn-completed') return event.reason ?? 'The turn completed';
  if (event.type === 'session-status') return `Conversation is ${event.status}`;
  if (event.type === 'session-settings') return 'Task settings changed';
  return 'Token usage updated';
}

function evidenceTime(activity: CodexTaskActivitySnapshot) {
  return Date.parse(activity.lastEventAt) || Date.parse(activity.lastSuccessfulRefreshAt ?? '') || 0;
}

function validTimestamp(value: string | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
