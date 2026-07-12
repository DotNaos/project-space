import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { runProjectBinary, type ProjectBinaryRunResult } from './local-project-cli-client';
import type {
  DeployedEnvironmentStatus,
  DeployedEnvironmentStatusResult
} from '../src/shared/project-space-api';

const fullSha = /^[0-9a-f]{40}$/i;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const execFileAsync = promisify(execFile);

interface RawEnvironment {
  branch?: unknown;
  buildCommit?: unknown;
  environment?: unknown;
  evidence?: {
    composeHealthy?: unknown;
    httpHealthy?: unknown;
    liveOriginHealthy?: unknown;
    remoteCheckoutCommit?: unknown;
    runningBuildCommit?: unknown;
  };
  status?: unknown;
  webUrl?: unknown;
}

function publicHttpsUrl(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      /^10\.|^127\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function displayName(id: string) {
  return id === 'prod' ? 'Production' : id === 'dev' ? 'Development' :
    id.charAt(0).toUpperCase() + id.slice(1);
}

export function sanitizeDeployedEnvironment(raw: RawEnvironment): DeployedEnvironmentStatus {
  const id = typeof raw.environment === 'string' && raw.environment.trim()
    ? raw.environment.trim().slice(0, 64)
    : 'unknown';
  const running = typeof raw.evidence?.runningBuildCommit === 'string'
    ? raw.evidence.runningBuildCommit.toLowerCase() : '';
  const checkout = typeof raw.evidence?.remoteCheckoutCommit === 'string'
    ? raw.evidence.remoteCheckoutCommit.toLowerCase() : '';
  const build = typeof raw.buildCommit === 'string' ? raw.buildCommit.toLowerCase() : '';
  const evidencePresent = Boolean(running || checkout || build);
  const evidenceAgrees = fullSha.test(running) && running === checkout && running === build;
  const healthAgrees = raw.evidence?.composeHealthy === true &&
    raw.evidence?.httpHealthy === true && raw.evidence?.liveOriginHealthy === true;
  let verification: DeployedEnvironmentStatus['verification'] = 'unavailable';
  if (raw.status === 'healthy' && evidenceAgrees && healthAgrees) verification = 'healthy';
  else if (raw.status === 'healthy' || (evidencePresent && !evidenceAgrees)) verification = 'inconsistent';
  else if (raw.status === 'unhealthy') verification = 'unhealthy';

  return {
    id,
    displayName: displayName(id),
    deployedSha: fullSha.test(running) ? running : undefined,
    liveUrl: publicHttpsUrl(raw.webUrl),
    sourceRef: typeof raw.branch === 'string' ? raw.branch.slice(0, 256) : undefined,
    verification
  };
}

async function reconcileCurrentEnvironment(
  environment: DeployedEnvironmentStatus,
  checkedAt: string,
  repositoryFullName: string
) {
  const currentId = process.env.PROJECT_DEPLOY_ENVIRONMENT?.trim();
  const buildCommit = process.env.PROJECT_SPACE_BUILD_COMMIT?.trim().toLowerCase();
  const stateRoot = process.env.PROJECT_DEPLOY_STATE_ROOT?.trim();
  if (!currentId || environment.id !== currentId || !stateRoot || !buildCommit || !fullSha.test(buildCommit)) {
    return environment;
  }
  try {
    const projectName = process.env.PROJECT_SPACE_BUILD_NAME?.trim() || 'project-space';
    const verified = (await readFile(`${stateRoot}/${projectName}-${currentId}/verified.sha`, 'utf8')).trim().toLowerCase();
    if (verified !== buildCommit) return { ...environment, verification: 'inconsistent' as const };
    return {
      ...environment,
      deployedSha: buildCommit,
      githubUrl: `https://github.com/${repositoryFullName}/commit/${buildCommit}`,
      verifiedAt: checkedAt
    };
  } catch {
    return environment;
  }
}

export async function getDeployedEnvironmentStatus(
  repositoryFullName: string,
  options: { cwd?: string; run?: (args: string[], cwd: string) => Promise<ProjectBinaryRunResult> } = {}
): Promise<DeployedEnvironmentStatusResult> {
  const checkedAt = new Date().toISOString();
  const run = options.run ?? runProjectBinary;
  const cwd = resolve(options.cwd ?? process.env.PROJECT_SPACE_BACKEND_REPO_PATH ?? process.cwd());
  const normalizedRepository = repositoryFullName.trim().toLowerCase();
  const safeGitEnvironment = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: cwd
  };
  if (!repositoryName.test(repositoryFullName)) {
    return { checkedAt, environments: [], repositoryFullName, status: 'unauthorized' };
  }
  if (!options.run) {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
        cwd,
        env: { ...process.env, ...safeGitEnvironment }
      });
      const match = stdout.trim().match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
      if (match?.[1]?.toLowerCase() !== normalizedRepository) {
        return { checkedAt, environments: [], repositoryFullName, status: 'unauthorized' };
      }
    } catch {
      return { checkedAt, environments: [], repositoryFullName, status: 'unavailable' };
    }
  }
  const result = options.run
    ? await run(['deploy', 'status', '--all-envs', '--format', 'json'], cwd)
    : await runProjectBinary(['deploy', 'status', '--all-envs', '--format', 'json'], cwd, {
        environment: safeGitEnvironment,
        timeoutMs: 120_000
      });
  if (result.exitCode !== 0) {
    return { checkedAt, environments: [], repositoryFullName, status: 'unavailable' };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { environments?: Array<RawEnvironment & { remoteRef?: unknown }>; projectName?: unknown };
    const matchingEnvironments = parsed.environments?.filter(
      (environment) => typeof environment.remoteRef === 'string' &&
        environment.remoteRef.toLowerCase() === normalizedRepository
    ) ?? [];
    if (matchingEnvironments.length === 0) {
      return { checkedAt, environments: [], repositoryFullName, status: 'unauthorized' };
    }
    return {
      checkedAt,
      environments: await Promise.all(matchingEnvironments.map(async (environment) => {
        const sanitized = sanitizeDeployedEnvironment(environment);
        return reconcileCurrentEnvironment({
          ...sanitized,
          githubUrl: sanitized.deployedSha
            ? `https://github.com/${repositoryFullName}/commit/${sanitized.deployedSha}`
            : undefined,
          verifiedAt: checkedAt
        }, checkedAt, repositoryFullName);
      })),
      repositoryFullName,
      status: 'available'
    };
  } catch {
    return { checkedAt, environments: [], repositoryFullName, status: 'unavailable' };
  }
}
