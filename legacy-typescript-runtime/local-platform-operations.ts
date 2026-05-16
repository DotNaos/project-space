import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  BackupRecordSummary,
  DeploymentRecordSummary,
  GitActionResult,
  PlatformOverviewResult,
  ProjectBackupRequest,
  ProjectDeployRequest
} from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);
const platformRepoPath = join(homedir(), 'projects', 'private-vps-platform');

function getApiBaseUrl() {
  return (
    process.env.PROJECT_SPACE_PRIVATE_VPS_BASE_URL ??
    process.env.PRIVATE_VPS_PLATFORM_API_BASE_URL ??
    ''
  ).replace(/\/+$/, '');
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getApiBaseUrl();

  if (!baseUrl) {
    throw new Error('No private VPS platform API URL configured.');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(
      payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : `Private VPS platform request failed with ${response.status}.`
    );
  }

  return payload as T;
}

function summarizeDeployment(entry: Record<string, unknown>): DeploymentRecordSummary {
  return {
    appSlug: String(entry.AppSlug ?? entry.app_slug ?? ''),
    createdAt: String(entry.CreatedAt ?? entry.created_at ?? ''),
    environment: String(entry.EnvName ?? entry.environment ?? ''),
    id: String(entry.ID ?? entry.id ?? ''),
    routeHost: String(entry.RouteHost ?? entry.route_host ?? ''),
    routeKind: entry.RouteKind === 'public' ? 'public' : 'private',
    runtimeDir: String(entry.RuntimeDir ?? entry.runtime_dir ?? ''),
    sourceRef: String(entry.SourceRef ?? entry.source_ref ?? ''),
    status: String(entry.Status ?? entry.status ?? 'unknown'),
    updatedAt: String(entry.UpdatedAt ?? entry.updated_at ?? '')
  };
}

function summarizeBackup(entry: Record<string, unknown>): BackupRecordSummary {
  return {
    appSlug: String(entry.AppSlug ?? entry.app_slug ?? ''),
    artifactPath: String(entry.ArtifactPath ?? entry.artifact_path ?? ''),
    createdAt: String(entry.CreatedAt ?? entry.created_at ?? ''),
    environment: String(entry.EnvName ?? entry.environment ?? ''),
    id: String(entry.ID ?? entry.id ?? ''),
    status: String(entry.Status ?? entry.status ?? 'unknown'),
    target: String(entry.Target ?? entry.target ?? '')
  };
}

async function getGitRemoteUrl(cwd: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 5_000,
      windowsHide: true
    });

    return stdout.trim();
  } catch {
    return '';
  }
}

async function getGitBranch(cwd: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current'], {
      timeout: 5_000,
      windowsHide: true
    });

    return stdout.trim();
  } catch {
    return '';
  }
}

export async function getPlatformOverview(): Promise<PlatformOverviewResult> {
  const apiBaseUrl = getApiBaseUrl();
  const overview: PlatformOverviewResult = {
    apiBaseUrl: apiBaseUrl || undefined,
    apiReachable: false,
    backups: [],
    deployments: [],
    platformRepo: {
      exists: existsSync(platformRepoPath),
      path: platformRepoPath
    }
  };

  if (!apiBaseUrl) {
    return {
      ...overview,
      error: 'No private VPS platform API URL configured.'
    };
  }

  try {
    const [health, deployments, backups] = await Promise.all([
      readJson<{ status?: string }>('/api/v1/health'),
      readJson<Record<string, unknown>[]>('/api/v1/deployments'),
      readJson<Record<string, unknown>[]>('/api/v1/backups')
    ]);

    return {
      ...overview,
      apiReachable: true,
      backups: backups.map(summarizeBackup),
      deployments: deployments.map(summarizeDeployment),
      healthStatus: health.status ?? 'ok'
    };
  } catch (error) {
    return {
      ...overview,
      error: error instanceof Error ? error.message : 'Could not reach private VPS platform API.'
    };
  }
}

export async function deployProject(request: ProjectDeployRequest): Promise<GitActionResult> {
  try {
    const repoUrl = request.repoUrl || (await getGitRemoteUrl(request.cwd));
    const gitRef = request.gitRef || (await getGitBranch(request.cwd)) || 'main';
    const projectSlug = request.projectSlug || basename(request.cwd).toLowerCase();

    if (!repoUrl) {
      return {
        message: 'No git remote URL found for this project.',
        status: 'error'
      };
    }

    const deployment = await readJson<Record<string, unknown>>('/api/v1/projects/deploy', {
      body: JSON.stringify({
        display_name: request.displayName || projectSlug,
        environment: request.environment,
        env_file_path: request.envFilePath,
        git_ref: gitRef,
        plan_only: request.planOnly,
        repo_url: repoUrl,
        slug: projectSlug,
        visibility: request.visibility
      }),
      method: 'POST'
    });
    const summary = summarizeDeployment(deployment);

    return {
      message: `${summary.status} deployment for ${summary.appSlug}/${summary.environment}.`,
      status: 'success',
      stdout: summary.routeHost || summary.runtimeDir
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Deployment failed.',
      status: 'error'
    };
  }
}

export async function backupProject(request: ProjectBackupRequest): Promise<GitActionResult> {
  try {
    const backup = await readJson<Record<string, unknown>>('/api/v1/backups', {
      body: JSON.stringify({
        app_slug: request.projectSlug,
        environment: request.environment,
        target: request.target
      }),
      method: 'POST'
    });
    const summary = summarizeBackup(backup);

    return {
      message: `${summary.status} backup for ${summary.appSlug}/${summary.environment}.`,
      status: 'success',
      stdout: summary.artifactPath
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Backup failed.',
      status: 'error'
    };
  }
}
