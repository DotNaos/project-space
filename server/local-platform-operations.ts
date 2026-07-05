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
const backendRepoPath = process.env.PROJECT_SPACE_BACKEND_REPO_PATH || '/workspace/backend-repo';

interface PlatformAppRecordSummary {
  repoUrl: string;
}

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
    revision: String(entry.Revision ?? entry.revision ?? ''),
    routeHost: String(entry.RouteHost ?? entry.route_host ?? ''),
    routeKind: entry.RouteKind === 'public' ? 'public' : 'private',
    runtimeDir: String(entry.RuntimeDir ?? entry.runtime_dir ?? ''),
    sourceRef: String(entry.SourceRef ?? entry.source_ref ?? ''),
    status: String(entry.Status ?? entry.status ?? 'unknown'),
    updatedAt: String(entry.UpdatedAt ?? entry.updated_at ?? '')
  };
}

function summarizeAppRecord(entry: Record<string, unknown>): [string, PlatformAppRecordSummary] | undefined {
  const app = entry.App && typeof entry.App === 'object' ? entry.App as Record<string, unknown> : entry;
  const slug = String(app.Slug ?? app.slug ?? '');

  if (!slug) {
    return undefined;
  }

  return [
    slug,
    {
      repoUrl: String(app.RepoURL ?? app.repo_url ?? '')
    }
  ];
}

function githubRepoPath(repoUrl: string) {
  const trimmed = repoUrl.trim().replace(/\.git$/, '');
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(trimmed);

  if (sshMatch) {
    return sshMatch[1];
  }

  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(trimmed);

  if (httpsMatch) {
    return httpsMatch[1];
  }

  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : undefined;
}

function packageVersionFromJson(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };

    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function readGitHubPackageVersion(repoUrl: string, revision: string) {
  const repoPath = githubRepoPath(repoUrl);

  if (!repoPath || !revision) {
    return undefined;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repoPath}/contents/package.json?ref=${encodeURIComponent(revision)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        'User-Agent': 'project-space',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );

  if (!response.ok) {
    return undefined;
  }

  const payload = await response.json().catch(() => undefined) as
    | { content?: unknown; encoding?: unknown }
    | undefined;

  if (typeof payload?.content !== 'string') {
    return undefined;
  }

  const content = payload.content.replace(/\s/g, '');
  const raw =
    payload.encoding === 'base64'
      ? Buffer.from(content, 'base64').toString('utf-8')
      : payload.content;

  return packageVersionFromJson(raw);
}

async function readLocalPackageVersionAtRevision(revision: string) {
  if (!revision) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', backendRepoPath, 'show', `${revision}:package.json`], {
      timeout: 5_000,
      windowsHide: true
    });

    return packageVersionFromJson(stdout);
  } catch {
    return undefined;
  }
}

async function readCurrentLocalPackageVersion() {
  try {
    const { stdout } = await execFileAsync('git', ['-C', backendRepoPath, 'show', 'HEAD:package.json'], {
      timeout: 5_000,
      windowsHide: true
    });

    return packageVersionFromJson(stdout);
  } catch {
    return undefined;
  }
}

async function addDeploymentVersion(
  deployment: DeploymentRecordSummary,
  appsBySlug: Map<string, PlatformAppRecordSummary>,
  versionCache: Map<string, Promise<string | undefined>>
) {
  const app = appsBySlug.get(deployment.appSlug);

  if (!app?.repoUrl || !deployment.revision) {
    return deployment;
  }

  const cacheKey = `${app.repoUrl}#${deployment.revision}`;
  let versionPromise = versionCache.get(cacheKey);

  if (!versionPromise) {
    versionPromise = readGitHubPackageVersion(app.repoUrl, deployment.revision)
      .then((version) => version ?? readLocalPackageVersionAtRevision(deployment.revision ?? ''))
      .then((version) => version ?? readCurrentLocalPackageVersion());
    versionCache.set(cacheKey, versionPromise);
  }

  const version = await versionPromise;

  return version ? { ...deployment, version } : deployment;
}

function deploymentPublicUrl(deployment: DeploymentRecordSummary) {
  if (deployment.routeKind !== 'public' || !deployment.routeHost) {
    return undefined;
  }

  if (/^https?:\/\//i.test(deployment.routeHost)) {
    return deployment.routeHost;
  }

  return `https://${deployment.routeHost}`;
}

async function checkDeploymentLiveStatus(deployment: DeploymentRecordSummary) {
  const url = deploymentPublicUrl(deployment);
  const checkedAt = new Date().toISOString();

  if (!url) {
    return {
      ...deployment,
      live: {
        checkedAt,
        status: 'unknown' as const
      }
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);

  try {
    let response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal
    });

    if (response.status === 405) {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal
      });
    }

    return {
      ...deployment,
      live: {
        checkedAt,
        latencyMs: Date.now() - startedAt,
        status: response.status < 500 ? 'online' as const : 'offline' as const,
        statusCode: response.status,
        url
      }
    };
  } catch (error) {
    return {
      ...deployment,
      live: {
        checkedAt,
        error: error instanceof Error ? error.message : 'Live check failed.',
        latencyMs: Date.now() - startedAt,
        status: 'offline' as const,
        url
      }
    };
  } finally {
    clearTimeout(timeout);
  }
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

function entriesOrEmpty(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
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
    const [health, apps, deployments, backups] = await Promise.all([
      readJson<{ status?: string }>('/api/v1/health'),
      readJson<unknown>('/api/v1/apps'),
      readJson<unknown>('/api/v1/deployments'),
      readJson<unknown>('/api/v1/backups')
    ]);
    const appEntries = entriesOrEmpty(apps)
      .map(summarizeAppRecord)
      .filter((entry): entry is [string, PlatformAppRecordSummary] => Boolean(entry));
    const appsBySlug = new Map(appEntries);
    const versionCache = new Map<string, Promise<string | undefined>>();
    const deploymentSummaries = entriesOrEmpty(deployments).map(summarizeDeployment);
    const versionedDeployments = await Promise.all(
      deploymentSummaries.map((deployment) =>
        addDeploymentVersion(deployment, appsBySlug, versionCache)
      )
    );

    return {
      ...overview,
      apiReachable: true,
      backups: entriesOrEmpty(backups).map(summarizeBackup),
      deployments: await Promise.all(versionedDeployments.map(checkDeploymentLiveStatus)),
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
