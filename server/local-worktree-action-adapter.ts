import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { runProjectBinary } from './local-project-cli-client';
import { resolveLocalProjectPath } from './local-project-identity';
import { resolveLocalProjectWorktree } from './local-project-worktrees';
import type {
  ConnectorWorktreeActionAdapter,
  ConnectorWorktreeActionResult,
  ConnectorWorktreeSetupConnectorResult,
  ConnectorWorktreeSetupStepResult
} from './connector-worktree-action-contract';

const secret =
  /(?:bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;
function safeError(value: unknown, fallback: string) {
  const raw = typeof value === 'string' ? value : fallback;
  return (
    raw
      .replace(secret, '[redacted]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 500) || fallback
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
}

function setupResult(
  raw: unknown,
  request: Parameters<ConnectorWorktreeActionAdapter['runWorktreeAction']>[0]
): ConnectorWorktreeSetupConnectorResult {
  const fallback: ConnectorWorktreeSetupConnectorResult = {
    capability: 'unavailable',
    checkedAt: new Date().toISOString(),
    generation: request.actor.generation,
    lastError: 'Trusted setup status is unavailable.',
    machineId: request.machineId,
    operation: request.operation as 'setup.inspect' | 'setup.run',
    projectId: request.projectId,
    steps: [],
    worktreeId: 'worktreeId' in request ? request.worktreeId : ''
  };
  if (
    !record(raw) ||
    !Array.isArray(raw.steps) ||
    (raw.capability !== 'configured' && raw.capability !== 'unavailable') ||
    (raw.operation !== 'status' && raw.operation !== 'prepare') ||
    typeof raw.checkedAt !== 'string'
  )
    return fallback;
  const steps: ConnectorWorktreeSetupStepResult[] = [];
  for (const value of raw.steps) {
    if (
      !record(value) ||
      typeof value.stepId !== 'string' ||
      typeof value.commit !== 'string' ||
      typeof value.declarationDigest !== 'string' ||
      typeof value.checkedAt !== 'string' ||
      !['required', 'running', 'ready', 'failed', 'interrupted', 'stale'].includes(
        String(value.state)
      )
    )
      return fallback;
    steps.push({
      checkedAt: value.checkedAt,
      commitSha: value.commit,
      declarationDigest: value.declarationDigest,
      ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
      ...(typeof value.lastError === 'string'
        ? { lastError: safeError(value.lastError, 'Setup step failed.') }
        : {}),
      setupStepId: value.stepId,
      ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
      state: value.state as ConnectorWorktreeSetupStepResult['state']
    });
  }
  return {
    capability: raw.capability,
    checkedAt: raw.checkedAt,
    generation: request.actor.generation,
    ...(typeof raw.lastError === 'string'
      ? { lastError: safeError(raw.lastError, 'Trusted setup failed.') }
      : {}),
    machineId: request.machineId,
    operation: request.operation as 'setup.inspect' | 'setup.run',
    projectId: request.projectId,
    steps,
    worktreeId: 'worktreeId' in request ? request.worktreeId : ''
  };
}

export function createLocalWorktreeActionAdapter(
  runBinary: typeof runProjectBinary = runProjectBinary,
  resolution: {
    resolveProjectPath?: typeof resolveLocalProjectPath;
    resolveWorktree?: typeof resolveLocalProjectWorktree;
  } = {}
): ConnectorWorktreeActionAdapter {
  const projectPathResolver = resolution.resolveProjectPath ?? resolveLocalProjectPath;
  const worktreeResolver = resolution.resolveWorktree ?? resolveLocalProjectWorktree;
  return {
    async runWorktreeAction(request): Promise<ConnectorWorktreeActionResult> {
      if (request.operation === 'materialize') {
        const result = await runBinary(
          [
            'worktree',
            'materialize',
            '--repository',
            request.repositoryFullName,
            '--branch',
            request.branchName,
            '--commit',
            request.commitSha,
            '--format',
            'json'
          ],
          homedir(),
          { timeoutMs: 180_000 }
        );
        const raw = parseJson(result.stdout);
        if (
          !record(raw) ||
          (raw.status !== 'created' && raw.status !== 'ready') ||
          raw.repository !== request.repositoryFullName ||
          raw.branch !== request.branchName ||
          raw.commit !== request.commitSha ||
          typeof raw.path !== 'string'
        ) {
          return {
            branchName: request.branchName,
            checkedAt: new Date().toISOString(),
            commitSha: request.commitSha,
            generation: request.actor.generation,
            lastError: safeError(result.stderr, 'Worktree materialization failed.'),
            machineId: request.machineId,
            operation: 'materialize',
            projectId: request.projectId,
            state: 'error'
          };
        }
        const projectName = request.repositoryFullName.split('/')[1]!;
        return {
          branchName: request.branchName,
          checkedAt: new Date().toISOString(),
          commitSha: request.commitSha,
          generation: request.actor.generation,
          machineId: request.machineId,
          operation: 'materialize',
          projectId: request.projectId,
          projectPath: resolve(homedir(), 'projects', projectName),
          state: raw.status,
          worktreePath: resolve(raw.path)
        };
      }
      const projectPath = await projectPathResolver(request.machineId, request.projectId);
      const worktree = await worktreeResolver(projectPath, request.worktreeId, {
        expectedHeadSha: request.expectedHeadSha
      });
      const worktreePath = worktree.path;
      if (request.operation === 'setup.run') {
        const args = [
          'prepare',
          worktreePath,
          '--step',
          request.setupStepId!,
          '--expect-commit',
          request.expectedHeadSha,
          '--expect-declaration-digest',
          request.declarationDigest!,
          '--format',
          'json'
        ];
        const result = await runBinary(args, worktreePath, {
          timeoutMs: 15 * 60_000
        });
        const mapped = setupResult(parseJson(result.stdout), request);
        const selected = mapped.steps.find(
          (candidate) => candidate.setupStepId === request.setupStepId
        );
        if (
          !selected ||
          selected.commitSha !== request.expectedHeadSha ||
          selected.declarationDigest !== request.declarationDigest
        ) {
          return {
            ...mapped,
            capability: 'unavailable',
            lastError: 'Trusted setup identity changed before execution.',
            steps: []
          };
        }
        return mapped;
      }
      const args = ['prepare', 'status', worktreePath, '--format', 'json'];
      const result = await runBinary(args, worktreePath, {
        timeoutMs: 30_000
      });
      const mapped = setupResult(parseJson(result.stdout), request);
      return mapped;
    }
  };
}
