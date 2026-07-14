import type {
  DeployedEnvironmentStatusResult,
  GitHubRepositoryDetailsResult,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type {
  CodexConversationItemRecord,
  CodexSessionListResult,
  CodexSessionReadResult,
  CodexSessionRecord
} from '@/shared/codex-sessions-api';

export type TopologyInventoryResult<T> =
  | { state: 'checking' }
  | { checkedAt?: string; reason: string; state: 'blocked' }
  | { checkedAt: string; data: T; state: 'ready' }
  | { data: T; lastSafeAt: string; reason: string; state: 'stale' };

export type TopologyTruthState =
  | { state: 'checking' }
  | { checkedAt: string; state: 'ready' }
  | { checkedAt?: string; reason: string; state: 'limited' }
  | { checkedAt?: string; reason: string; state: 'blocked' }
  | { lastSafeAt: string; reason: string; state: 'stale' };

export type TopologyBrowserCapability =
  | {
      checkedAt: string;
      frameUrl: string;
      interaction: 'read-only';
      machineId: string;
      sessionId: string;
      state: 'ready';
      threadId: string;
      tools: Partial<Record<TopologyBrowserTool, {
        checkedAt: string;
        streamUrl: string;
      }>>;
    }
  | {
      checkedAt?: string;
      reason: string;
      state: 'blocked' | 'unavailable';
    };

export interface TopologyTaskLocationEvidence {
  canonicalCwd: string;
  checkedAt: string;
  machineId: string;
  sessionRevision: string;
  source: 'connector-realpath';
  threadId: string;
  worktreeRoot: string;
}

export type TopologyTaskWriteCapability =
  | {
      canContinue: boolean;
      checkedAt: string;
      expiresAt: string;
      interruptTurnId?: string;
      machineId: string;
      sessionRevision: string;
      sessionLastActivityAt: string;
      state: 'ready';
      threadId: string;
    }
  | {
      checkedAt?: string;
      reason: string;
      state: 'blocked' | 'unavailable';
    };

export interface TopologyTaskEvidence {
  awaitingDecision?: {
    expiresAt: string;
    observedAt: string;
    sessionLastActivityAt: string;
  };
  delivery?: {
    branchName: string;
    headSha: string;
    mergeCommitHash: string;
    observedAt: string;
    pullRequestNumber: number;
    sessionLastActivityAt: string;
    source: 'github-pull-request';
  };
  machineId: string;
  threadId: string;
  verification?: {
    headSha?: string;
    sessionLastActivityAt: string;
    verifiedAt: string;
  };
}

export type TopologyBrowserTool = 'console' | 'network' | 'logs';

export interface TopologyPrimaryMachineEvidence {
  machineId: string;
  source: 'project-configuration';
}

export type TopologyWorktreeInventory =
  | ProjectWorktreeDiscoveryState
  | {
      data: Extract<ProjectWorktreeDiscoveryState, { state: 'ready' | 'proven-empty' }>;
      lastSafeAt: string;
      reason: string;
      state: 'stale';
    };

export interface ProjectTopologyInventory {
  browsersByTaskId?: Record<string, TopologyBrowserCapability>;
  checkedAt: string;
  codexByMachineId: Record<string, TopologyInventoryResult<CodexSessionListResult>>;
  conversationsByTaskId?: Record<string, TopologyInventoryResult<CodexSessionReadResult>>;
  deploymentsByRepository: Record<
    string,
    TopologyInventoryResult<DeployedEnvironmentStatusResult>
  >;
  intentionalMultiMachineProjects?: string[];
  machines: TopologyInventoryResult<MachineRecord[]>;
  primaryMachineByProject?: Record<string, TopologyPrimaryMachineEvidence>;
  projects: TopologyInventoryResult<ProjectSpaceRecord[]>;
  repositoriesByFullName: Record<
    string,
    TopologyInventoryResult<GitHubRepositoryDetailsResult>
  >;
  taskLocationFailuresByTaskId?: Record<string, { checkedAt: string; reason: string }>;
  taskLocationsByTaskId?: Record<string, TopologyTaskLocationEvidence>;
  taskEvidenceByTaskId?: Record<string, TopologyTaskEvidence>;
  writeCapabilitiesByTaskId?: Record<string, TopologyTaskWriteCapability>;
  worktreesByProjectScope: Record<string, TopologyWorktreeInventory>;
}

export type TopologyTaskActivity =
  | 'active'
  | 'archived'
  | 'awaiting-decision'
  | 'blocked'
  | 'idle-unverified'
  | 'offline'
  | 'stale'
  | 'unknown';

export type TopologyTaskDelivery =
  | 'deployed'
  | 'merged'
  | 'unknown'
  | 'verified-complete';

export interface TopologyTranscriptItem extends CodexConversationItemRecord {
  order: number;
  turnId?: string;
  turnStatus?: CodexSessionReadResult['turns'][number]['status'];
}

export interface TopologyTaskIssue {
  number: number;
  state: 'open' | 'closed';
  title: string;
  url: string;
}

export interface TopologyTaskInteraction {
  authority?: Extract<TopologyTaskWriteCapability, { state: 'ready' }>;
  canContinue: boolean;
  canInterrupt: boolean;
  composerVisible: boolean;
  reason?: string;
}

export interface TopologyTask {
  activity: TopologyTaskActivity;
  agentLabel: string;
  branchName?: string;
  browser: TopologyBrowserCapability;
  cwd: string;
  delivery: TopologyTaskDelivery;
  evidence: {
    current: boolean;
    lastSafeAt?: string;
    match: 'project-root' | 'worktree';
    matchedPath: string;
    sessionRevision: string;
    source: 'connector-canonical-cwd';
  };
  id: string;
  interaction: TopologyTaskInteraction;
  issue?: TopologyTaskIssue;
  lastSafeAt?: string;
  machineId: string;
  model?: string;
  session: CodexSessionRecord;
  threadId: string;
  title: string;
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>;
  worktree?: ProjectWorktreeRecord;
}

export type TopologyMachineOccupancy =
  | 'primary'
  | 'secondary'
  | 'single'
  | 'unknown';

export interface TopologyMachine {
  id: string;
  inventory: TopologyTruthState;
  machine?: MachineRecord;
  name: string;
  occupancy: TopologyMachineOccupancy;
  projectRecords: ProjectSpaceRecord[];
  tasks: TopologyTask[];
  taskInventory: TopologyTruthState;
  worktreeInventory: TopologyWorktreeInventory;
  worktrees: ProjectWorktreeRecord[];
}

export type TopologyMultiMachineState =
  | 'ambiguous'
  | 'intentional-difference'
  | 'single'
  | 'stale'
  | 'synchronized';

export interface TopologyProject {
  branches: TopologyInventoryResult<GitHubRepositoryDetailsResult['branches']>;
  chatProjectId: string;
  id: string;
  inventory: TopologyTruthState;
  issues: TopologyInventoryResult<GitHubRepositoryDetailsResult['issues']>;
  machines: TopologyMachine[];
  multiMachineState: TopologyMultiMachineState;
  name: string;
  projectRecords: ProjectSpaceRecord[];
  pullRequests: TopologyInventoryResult<GitHubRepositoryDetailsResult['pullRequests']>;
  repositoryFullName?: string;
  repositoryUrl?: string;
}

export interface ProjectTopologySnapshot {
  checkedAt: string;
  inventory: {
    machines: TopologyTruthState;
    projects: TopologyTruthState;
  };
  lead: {
    conversationTarget: 'portfolio';
    id: 'lead';
    label: 'Lead';
  };
  projects: TopologyProject[];
  summary: {
    machineCount: number;
    projectCount: number;
    tasks: {
      completeness: 'complete' | 'partial' | 'unknown';
      observedCount: number;
    };
  };
  warnings: Array<{
    id: string;
    message: string;
    projectId?: string;
  }>;
}

export type ProjectTopologyBuildResult =
  | { state: 'checking' }
  | { checkedAt?: string; reason: string; state: 'blocked' }
  | { snapshot: ProjectTopologySnapshot; state: 'ready' };

export type ProjectTopologyReadState =
  | { previous?: ProjectTopologySnapshot; state: 'checking' }
  | { checkedAt?: string; reason: string; state: 'blocked' }
  | { snapshot: ProjectTopologySnapshot; state: 'ready' }
  | {
      failedAt: string;
      reason: string;
      snapshot: ProjectTopologySnapshot;
      state: 'stale';
    };

export function topologyTaskId(machineId: string, threadId: string) {
  return `task:${encodeURIComponent(machineId)}:${encodeURIComponent(threadId)}`;
}
