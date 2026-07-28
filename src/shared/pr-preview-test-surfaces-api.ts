export const pullRequestTestSurfaceKinds = [
  'full-preview',
  'mobile-prototype',
  'desktop-prototype',
  'dev-server'
] as const;

export type PullRequestTestSurfaceKind = (typeof pullRequestTestSurfaceKinds)[number];

export const pullRequestPrototypeSurfaceKinds = [
  'mobile-prototype',
  'desktop-prototype'
] as const;

export type PullRequestPrototypeSurfaceKind =
  (typeof pullRequestPrototypeSurfaceKinds)[number];

export type PullRequestTestSurfaceState =
  | 'available'
  | 'pending'
  | 'stale'
  | 'unavailable';

export type PullRequestTestSurfaceReasonCode =
  | 'deployment-head-mismatch'
  | 'deployment-not-published'
  | 'deployment-pending'
  | 'deployment-unavailable'
  | 'deployment-verification-missing'
  | 'live-heartbeat-expired'
  | 'live-machine-offline'
  | 'live-registration-mismatch'
  | 'live-registration-missing'
  | 'live-server-stopped'
  | 'pull-request-closed'
  | 'repository-unauthorized';

export type PullRequestFeedbackReasonCode =
  | 'feedback-not-live'
  | 'feedback-task-mismatch'
  | 'feedback-task-missing'
  | 'feedback-task-unavailable'
  | 'feedback-write-capability-expired';

interface PullRequestTestSurfaceBase {
  kind: PullRequestTestSurfaceKind;
}

export interface AvailablePullRequestTestSurface extends PullRequestTestSurfaceBase {
  commitSha: string;
  source: 'deployed' | 'live';
  state: 'available';
  url: string;
  verifiedAt: string;
}

export interface AvailablePullRequestDevServerSurface
  extends AvailablePullRequestTestSurface {
  connectorId: string;
  kind: 'dev-server';
  leaseExpiresAt: string;
  machineId: string;
  servedSurface: PullRequestPrototypeSurfaceKind;
  source: 'live';
}

export interface UnavailablePullRequestTestSurface extends PullRequestTestSurfaceBase {
  reasonCode: PullRequestTestSurfaceReasonCode;
  state: Exclude<PullRequestTestSurfaceState, 'available'>;
  url?: never;
}

export type PullRequestTestSurface =
  | AvailablePullRequestDevServerSurface
  | (AvailablePullRequestTestSurface & {
      kind: Exclude<PullRequestTestSurfaceKind, 'dev-server'>;
      source: 'deployed';
    })
  | UnavailablePullRequestTestSurface;

export type PullRequestFeedbackEligibility =
  | {
      state: 'available';
      threadId: string;
      verifiedAt: string;
    }
  | {
      reasonCode: PullRequestFeedbackReasonCode;
      state: 'stale' | 'unavailable';
      threadId?: never;
    };

export type PullRequestLiveDevelopmentContext =
  | {
      connectorId: string;
      heartbeatAt: string;
      leaseExpiresAt: string;
      machineId: string;
      servedSurface: PullRequestPrototypeSurfaceKind;
      state: 'available';
      verifiedAt: string;
    }
  | {
      reasonCode: PullRequestTestSurfaceReasonCode;
      state: 'stale' | 'unavailable';
    };

export interface PullRequestTestSurfacesResult {
  checkedAt: string;
  feedback: PullRequestFeedbackEligibility;
  headSha: string;
  liveContext: PullRequestLiveDevelopmentContext;
  pullRequestNumber: number;
  repositoryFullName: string;
  surfaces: PullRequestTestSurface[];
}

export interface PullRequestDevServerRegistrationRequest {
  branchName: string;
  codexThreadId?: string;
  commitSha: string;
  connectorId: string;
  machineId: string;
  projectId: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  runtime: {
    checkedAt: string;
    state: 'running' | 'stopped';
    tailscaleIpv4?: string;
    tailscalePort?: number;
  };
  servedSurface: PullRequestPrototypeSurfaceKind;
  serverId: string;
  worktreeId: string;
}

export interface PullRequestDevServerHeartbeatRequest {
  connectorId: string;
  generation: number;
  leaseId: string;
  machineId: string;
  runtime: PullRequestDevServerRegistrationRequest['runtime'];
  servedSurface: PullRequestPrototypeSurfaceKind;
}

export interface PullRequestDevServerReleaseRequest {
  connectorId: string;
  generation: number;
  leaseId: string;
  machineId: string;
}

export interface PullRequestDevServerLeaseResponse {
  heartbeatIntervalSeconds: number;
  lease: {
    expiresAt: string;
    generation: number;
    id: string;
  };
  leaseDurationSeconds: number;
}

export interface PullRequestPrototypeFeedbackRequest {
  comment: string;
  pullRequestNumber: number;
  repositoryFullName: string;
  scenario: string;
  screenshotContext?: string;
  selectedElement?: string;
  surface: PullRequestPrototypeSurfaceKind;
  viewport: 'phone' | 'tablet' | 'desktop';
}

export interface PullRequestPrototypeFeedbackResult {
  state: 'sent';
  threadId: string;
}
