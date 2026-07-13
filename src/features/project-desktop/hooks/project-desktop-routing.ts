import { parseProjectChatRoute } from '../../project-chat/project-chat-route';
import { codexSessionRoute, parseCodexSessionRoute } from '../../codex-sessions/codex-session-route';
import {
  normalizeRouteKey,
  parseWorkflowRunRoute,
  routeProjectIdMatchesRepository,
  workflowRunRouteSuffix
} from './project-route-model';
import type {
  GitHubCatalogRepository,
  ProjectDiscoveryResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';

export type ProjectMainView =
  'root' | 'chat' | 'codex' | 'machines' | 'machine' | 'projects' | 'project' | 'settings';

export const projectDetailTabs = [
  'overview',
  'issues',
  'machines',
  'workspaces',
  'chat',
  'history',
  'template',
  'deployments',
  'codex'
] as const;
export type ProjectDetailTab = (typeof projectDetailTabs)[number];

export const machineDetailTabs = ['overview', 'projects', 'explorer', 'terminal'] as const;
export type MachineDetailTab = (typeof machineDetailTabs)[number];

function parseProjectDetailTab(segment: string | undefined): ProjectDetailTab {
  return projectDetailTabs.includes(segment as ProjectDetailTab)
    ? (segment as ProjectDetailTab)
    : 'overview';
}

function parseMachineDetailTab(segment: string | undefined): MachineDetailTab {
  return machineDetailTabs.includes(segment as MachineDetailTab)
    ? (segment as MachineDetailTab)
    : 'overview';
}

function normalizePath(path: string) {
  return path.replace(/\/+$/, '');
}

const templatePlaceholderPattern = /\{\{.*?\}\}/;
const chatPath = '/chat';
const projectsPath = '/projects';
const machinesPath = '/machines';
export const connectorOverviewRefreshIntervalMs = 60_000;
export const githubCatalogTimeoutMs = 12_000;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function sanitizeProjectName(project: ProjectSpaceRecord): string {
  const name = project.name?.trim();

  if (name && !templatePlaceholderPattern.test(name)) {
    return name;
  }

  return basename(project.rootPath) || 'Untitled project';
}

export function sanitizeDiscovery(discovery: ProjectDiscoveryResult): ProjectDiscoveryResult {
  return {
    ...discovery,
    projects: discovery.projects.map((project) => ({
      ...project,
      name: sanitizeProjectName(project)
    })),
    structureViolations: discovery.structureViolations ?? []
  };
}

function machinePath(machineId: string) {
  return `${machinesPath}/${encodeURIComponent(machineId)}`;
}

function projectPath(projectId: string) {
  return `${projectsPath}/${encodeURIComponent(projectId)}`;
}

const settingsPath = '/settings';

export function routeForView(view: ProjectMainView, projectId = '', tab = '', detail = '') {
  if (view === 'codex') {
    return codexSessionRoute();
  }

  if (view === 'chat') {
    return chatPath;
  }

  if (view === 'machines') {
    return machinesPath;
  }

  if (view === 'machine' && projectId) {
    const base = machinePath(projectId);

    return tab && tab !== 'overview' ? `${base}/${tab}` : base;
  }

  if (view === 'projects') {
    return projectsPath;
  }

  if (view === 'project' && projectId) {
    const base = projectPath(projectId);

    if (tab === 'issues' && detail) {
      return `${base}/issues/${encodeURIComponent(detail)}`;
    }

    if (tab === 'deployments') {
      return `${base}/${workflowRunRouteSuffix(detail)}`;
    }

    if (!tab || tab === 'overview') {
      return base;
    }

    return `${base}/${tab}`;
  }

  if (view === 'settings') {
    return settingsPath;
  }

  return '/';
}

export interface ParsedProjectRoute {
  codexMachineId?: string;
  codexThreadId?: string;
  issueNumber?: number;
  machineId?: string;
  machineTab?: MachineDetailTab;
  projectId?: string;
  projectTab?: ProjectDetailTab;
  workflowRunId?: number;
  view: ProjectMainView;
}

export function parseProjectRoute(pathname: string): ParsedProjectRoute {
  const codexRoute = parseCodexSessionRoute(pathname);
  if (codexRoute.matches) {
    return {
      codexMachineId: codexRoute.machineId,
      codexThreadId: codexRoute.threadId,
      view: 'codex'
    };
  }

  if (parseProjectChatRoute(pathname).matches) {
    return { view: 'chat' };
  }

  if (pathname === settingsPath || pathname === `${settingsPath}/`) {
    return { view: 'settings' };
  }

  if (pathname === machinesPath) {
    return { view: 'machines' };
  }

  if (pathname.startsWith(`${machinesPath}/`)) {
    const rest = pathname.slice(machinesPath.length + 1);
    const [rawMachineId, rawTab] = rest.split('/');
    const machineId = decodeURIComponent(rawMachineId ?? '');

    return machineId
      ? {
          machineId,
          machineTab: parseMachineDetailTab(rawTab),
          view: 'machine'
        }
      : { view: 'machines' };
  }

  if (pathname === projectsPath || pathname === `${projectsPath}/`) {
    return { view: 'projects' };
  }

  if (pathname.startsWith(`${projectsPath}/`)) {
    const rest = pathname.slice(projectsPath.length + 1);
    const [rawProjectId, rawTab, rawDetail, rawRunId] = rest.split('/');
    const projectId = decodeURIComponent(rawProjectId ?? '');
    const issueNumber = rawTab === 'issues' && rawDetail ? Number(rawDetail) : undefined;
    const workflowRunId = parseWorkflowRunRoute(rawTab, rawDetail, rawRunId);

    return projectId
      ? {
          issueNumber: Number.isFinite(issueNumber) ? issueNumber : undefined,
          projectId,
          projectTab: parseProjectDetailTab(rawTab),
          workflowRunId,
          view: 'project'
        }
      : { view: 'projects' };
  }

  return { view: 'root' };
}

export function initialProjectMainView(pathname: string): ProjectMainView {
  const view = parseProjectRoute(pathname).view;
  return view === 'chat' || view === 'codex' ? view : 'root';
}

export function resolveRouteProject(
  projects: ProjectSpaceRecord[],
  projectId: string
): ProjectSpaceRecord | undefined {
  return (
    projects.find((entry) => entry.id === projectId) ??
    projects.find((entry) => basename(entry.rootPath) === projectId) ??
    projects.find((entry) => entry.name === projectId) ??
    projects.find((entry) =>
      entry.github ? routeProjectIdMatchesRepository(projectId, entry.github) : false
    )
  );
}

export function shouldPreserveProjectRoute(
  projectId: string | undefined,
  routeProject: ProjectSpaceRecord | undefined
) {
  return Boolean(projectId && !routeProject);
}

export function projectMatchesGitHubRepository(
  project: ProjectSpaceRecord,
  repo: GitHubCatalogRepository
) {
  const projectName = normalizeRouteKey(project.name);
  const projectFolder = normalizeRouteKey(basename(project.rootPath));
  const repoFullName = normalizeRouteKey(repo.fullName);
  const repoName = normalizeRouteKey(repo.name);

  return (
    projectName === repoFullName ||
    projectName === repoName ||
    projectFolder === repoName ||
    projectFolder === repoFullName
  );
}

export function createGitHubProjectRecord(repo: GitHubCatalogRepository): ProjectSpaceRecord {
  return {
    github: repo,
    id: `github:${repo.fullName}`,
    kind: 'github',
    name: repo.fullName,
    rootPath: ''
  };
}

export function writeRoute(
  view: ProjectMainView,
  projectId = '',
  replace = false,
  tab = '',
  detail = ''
) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = routeForView(view, projectId, tab, detail);
  const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;

  if (window.location.pathname === nextPath) {
    return;
  }

  if (replace) {
    window.history.replaceState(null, '', nextUrl);
    return;
  }

  window.history.pushState(null, '', nextUrl);
}

export function findMatchingProject(projects: ProjectSpaceRecord[], path: string) {
  const normalizedPath = normalizePath(path);

  return [...projects]
    .sort((left, right) => right.rootPath.length - left.rootPath.length)
    .find((project) => {
      const projectPath = normalizePath(project.rootPath);

      return normalizedPath === projectPath || normalizedPath.startsWith(`${projectPath}/`);
    });
}
