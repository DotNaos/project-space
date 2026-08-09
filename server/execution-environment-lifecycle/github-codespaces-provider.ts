import type {
  GitHubCodespaceRunnerAction,
  GitHubCodespaceRunnerResult
} from '../../src/shared/github-codespace-runner-api';
import type { GitHubCodespaceRunnerRuntime } from '../github-codespace-runner/configured-runtime';
import type { EnvironmentProviderBinding } from './store';
import type {
  ExecutionEnvironmentLifecycleProvider,
  ExecutionEnvironmentProviderObservation,
  ExecutionEnvironmentProviderTarget
} from './provider';

export interface GitHubCodespacesLifecycleProviderOptions {
  now?: () => Date;
  sanitizeUrl?: (value: string | undefined) => string | undefined;
}

export function createGitHubCodespacesLifecycleProvider(
  runtime: GitHubCodespaceRunnerRuntime,
  options: GitHubCodespacesLifecycleProviderOptions = {}
): ExecutionEnvironmentLifecycleProvider {
  const now = options.now ?? (() => new Date());
  const sanitizeUrl = options.sanitizeUrl ?? safeHttpsUrl;
  const run = async (
    action: GitHubCodespaceRunnerAction,
    target: EnvironmentProviderBinding | ExecutionEnvironmentProviderTarget,
    operationId: string
  ) => observation(
    await runtime.run({
      action,
      branch: target.branch,
      issue: target.task,
      operationId,
      repositoryFullName: target.repositoryFullName
    }),
    action,
    now().toISOString(),
    sanitizeUrl
  );

  return {
    kind: 'github_codespaces',
    delete: (binding, operationId) => run('delete', binding, operationId),
    provision: (target, operationId) => run('provision', target, operationId),
    start: (binding, operationId) => run('start', binding, operationId),
    status: (target, correlationId) => run('status', target, correlationId),
    stop: (binding, operationId) => run('stop', binding, operationId)
  };
}

function observation(
  result: GitHubCodespaceRunnerResult,
  action: GitHubCodespaceRunnerAction,
  observedAt: string,
  sanitizeUrl: (value: string | undefined) => string | undefined
): ExecutionEnvironmentProviderObservation {
  const state = String(result.state);
  const nativeState = boundedText(result.codespace?.state, 100);
  const readiness = readinessFor(result, sanitizeUrl);
  const failedMutation = action !== 'status' && state === 'failed';
  const providerResourceUrl = sanitizeUrl(result.codespace?.url);
  const blockedReason = state === 'github-reauthorization-required'
    ? 'provider_reauthorization_required'
    : state === 'connector-approval-required'
      ? 'connector_approval_required'
      : state === 'authorization-required'
        ? 'agent_authorization_required'
        : undefined;
  return {
    ...(blockedReason ? { blockedReason } : {}),
    ...(result.environmentId ? { environmentId: result.environmentId } : {}),
    lifecycleState: failedMutation ? 'uncertain' : normalizeLifecycle(action, state, nativeState),
    message: boundedText(result.message, 500) ?? 'GitHub Codespaces returned no status message.',
    ...(nativeState ? { nativeState } : {}),
    observedAt,
    outcome: state === 'uncertain' || failedMutation ? 'uncertain' : 'confirmed',
    ...(result.codespace?.name
      ? { providerResourceName: boundedText(result.codespace.name, 128) }
      : {}),
    ...(providerResourceUrl ? { providerResourceUrl } : {}),
    ...(readiness ? { readiness } : {}),
    ...(state === 'github-reauthorization-required'
      ? { reauthorization: { provider: 'github' as const, requiredScopes: ['codespace'] as ['codespace'] } }
      : {})
  };
}

function readinessFor(
  result: GitHubCodespaceRunnerResult,
  sanitizeUrl: (value: string | undefined) => string | undefined
) {
  const common = result.connectorId ? { connectorId: result.connectorId } : {};
  switch (String(result.state)) {
    case 'ready':
      return { ...common, state: 'ready' as const };
    case 'authorization-required':
      return { ...common, pendingEvidence: ['codex_authorization'], state: 'authorization_required' as const };
    case 'connector-approval-required': {
      const approvalUrl = sanitizeUrl(result.approvalUrl);
      return {
        ...common,
        ...(approvalUrl ? { approvalUrl } : {}),
        pendingEvidence: ['connector_approval'],
        state: 'connector_approval_required' as const
      };
    }
    case 'offline':
      return { ...common, state: 'offline' as const };
    case 'provisioning':
      return { ...common, pendingEvidence: ['provider_or_connector'], state: 'checking' as const };
    default:
      return { ...common, state: 'unavailable' as const };
  }
}

function normalizeLifecycle(
  action: GitHubCodespaceRunnerAction,
  runnerState: string,
  nativeState: string | undefined
) {
  const native = nativeState?.toLowerCase();
  if (native === 'available') return 'running' as const;
  if (native === 'shutdown') return 'stopped' as const;
  if (native === 'starting') return 'starting' as const;
  if (native === 'stopping') return 'stopping' as const;
  if (native === 'deleting') return 'deleting' as const;
  if (native === 'deleted') return 'deleted' as const;
  if (['failed', 'unavailable'].includes(native ?? '')) return 'failed' as const;
  if (['queued', 'creating', 'pending', 'provisioning', 'rebuilding'].includes(native ?? '')) {
    return 'provisioning' as const;
  }
  if (runnerState === 'uncertain') return 'uncertain' as const;
  if (runnerState === 'not-created') return action === 'delete' ? 'deleted' as const : 'missing' as const;
  if (runnerState === 'offline') return 'stopped' as const;
  if (runnerState === 'failed') return 'failed' as const;
  if (['ready', 'authorization-required', 'connector-approval-required'].includes(runnerState)) {
    return 'running' as const;
  }
  if (runnerState === 'provisioning') {
    return action === 'start' ? 'starting' as const : 'provisioning' as const;
  }
  return 'uncertain' as const;
}

function boundedText(value: string | undefined, maximum: number) {
  if (!value) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum) || undefined;
}

function safeHttpsUrl(value: string | undefined) {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}
