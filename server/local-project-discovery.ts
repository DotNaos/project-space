import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  GitHubCatalogRepository,
  ProjectDiscoveryResult,
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectsState
} from '../src/shared/project-space-api';
import { getGitStatus } from './local-git-client';
import { collectProjectStructureViolations } from './project-structure-violations';

const projectSpaceDirectory = `${homedir()}/.project-space`;
const projectsStateFile = `${projectSpaceDirectory}/projects.json`;
export const localProjectsDiscoveryRoot = join(homedir(), 'projects');
const execFileAsync = promisify(execFile);
const standaloneProjectMarkers = new Set([
  '.git',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod'
]);

async function runCommand(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true
  });

  return stdout;
}

async function listDirectoryEntries(path: string) {
  try {
    return await readdir(path, {
      withFileTypes: true
    });
  } catch {
    return [];
  }
}

function repositoryIdFromFullName(fullName: string) {
  let hash = 0;

  for (const character of fullName) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function parseGitHubRemote(remoteUrl: string): GitHubCatalogRepository | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const match = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+)$/i);

  if (!match?.groups) {
    return undefined;
  }

  const owner = match.groups.owner;
  const name = match.groups.repo;
  const fullName = `${owner}/${name}`;

  return {
    defaultBranch: undefined,
    fullName,
    id: repositoryIdFromFullName(fullName),
    isPrivate: false,
    name,
    owner,
    projectConfig: {
      projectYaml: false,
      status: 'unknown',
      templateLock: false
    },
    url: `https://github.com/${fullName}`
  };
}

async function loadGitHubRemote(path: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'remote', 'get-url', 'origin'], {
      timeout: 2_000,
      windowsHide: true
    });

    return parseGitHubRemote(stdout);
  } catch {
    return undefined;
  }
}

function makeNodeId(rootPath: string, path: string) {
  const relativePath = relative(rootPath, path).replace(/^\.\/?/, '');

  return relativePath.length > 0 ? relativePath.replace(/[\\/]+/g, '__') : basename(path);
}

async function createProjectRecord(
  rootPath: string,
  path: string,
  kind: ProjectSpaceRecord['kind'],
  groupId?: string
): Promise<ProjectSpaceRecord> {
  const resolvedPath = resolve(path);
  const hasProject = existsSync(join(resolvedPath, 'project.yaml'));
  const hasLock = existsSync(join(resolvedPath, 'template.lock.yaml'));
  const hasGoals = existsSync(join(resolvedPath, 'GOALS.md'));
  const gitStatus = await getGitStatus(resolvedPath);
  const github = gitStatus.isRepository ? await loadGitHubRemote(resolvedPath) : undefined;
  const unstaged =
    gitStatus.summary.untracked +
    gitStatus.entries.filter(
      (entry) => entry.displayStatus !== '??' && Boolean(entry.worktreeStatus.trim())
    ).length;
  const status =
    hasProject && hasLock
      ? 'managed'
      : hasProject || hasLock || hasGoals
        ? 'partial'
        : 'unmanaged';

  return {
    id: makeNodeId(rootPath, resolvedPath),
    kind,
    groupId,
    name: basename(resolvedPath),
    rootPath: resolvedPath,
    gitStatus: gitStatus.isRepository
      ? {
          branchName: gitStatus.branchName,
          changed: gitStatus.summary.changed,
          hasUnstagedChanges: unstaged > 0,
          staged: gitStatus.summary.staged,
          unstaged,
          untracked: gitStatus.summary.untracked
        }
      : undefined,
    github,
    projectctl: {
      hasGoals,
      hasLock,
      hasProject,
      status
    }
  };
}

function createGroupRecord(
  rootPath: string,
  path: string,
  childProjectIds: string[]
): ProjectGroupRecord {
  const resolvedPath = resolve(path);

  return {
    childProjectIds,
    id: makeNodeId(rootPath, resolvedPath),
    name: basename(resolvedPath),
    rootPath: resolvedPath
  };
}

function hasWorkspaceFileMarker(path: string, entryNames: Set<string>) {
  return Array.from(entryNames).some((entryName) => {
    return entryName.endsWith('.code-workspace') && existsSync(join(path, entryName));
  });
}

function hasStrongWorkspaceMarker(path: string, entryNames: Set<string>) {
  return entryNames.has('base') || basename(path).endsWith('.worktrees');
}

async function classifyProjectDirectory(path: string): Promise<ProjectSpaceRecord['kind'] | null> {
  const entries = await listDirectoryEntries(path);
  const entryNames = new Set(entries.map((entry) => entry.name));

  if (hasStrongWorkspaceMarker(path, entryNames) || hasWorkspaceFileMarker(path, entryNames)) {
    return 'workspace';
  }

  if (Array.from(entryNames).some((entryName) => standaloneProjectMarkers.has(entryName))) {
    return 'standalone';
  }

  return null;
}

async function shouldPreferGroupOverWorkspace(path: string) {
  const entries = await listDirectoryEntries(path);
  const entryNames = new Set(entries.map((entry) => entry.name));

  return !hasStrongWorkspaceMarker(path, entryNames) && hasWorkspaceFileMarker(path, entryNames);
}

async function discoverProjectChildren(groupPath: string): Promise<ProjectSpaceRecord[]> {
  const childEntries = await listDirectoryEntries(groupPath);
  const groupId = makeNodeId(localProjectsDiscoveryRoot, groupPath);
  const projects: ProjectSpaceRecord[] = [];

  for (const childDirectory of childEntries.filter((entry) => entry.isDirectory())) {
    const childPath = resolve(groupPath, childDirectory.name);
    const kind = await classifyProjectDirectory(childPath);

    if (kind) {
      projects.push(
        await createProjectRecord(localProjectsDiscoveryRoot, childPath, kind, groupId)
      );
    }
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadGitCommonDir(path: string) {
  try {
    return (
      await runCommand('git', [
        '-C',
        path,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir'
      ])
    ).trim();
  } catch {
    return '';
  }
}

async function shouldTreatAsWorktreeProject(childProjects: ProjectSpaceRecord[]) {
  if (childProjects.length < 2) {
    return false;
  }

  const commonDirs = new Set<string>();

  for (const childProject of childProjects) {
    const gitCommonDir = await loadGitCommonDir(childProject.rootPath);

    if (!gitCommonDir) {
      return false;
    }

    commonDirs.add(gitCommonDir);

    if (commonDirs.size > 1) {
      return false;
    }
  }

  return true;
}

function normalizeProjectIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.filter((projectId): projectId is string => typeof projectId === 'string'))
  );
}

function normalizePinnedProjectIds(value: unknown) {
  return normalizeProjectIds(value);
}

export function readProjectsState(): ProjectsState {
  const emptyState: ProjectsState = {
    activeGroupId: '',
    pinnedProjectIds: [],
    recentProjectIds: [],
    selectedExplorerTarget: { kind: 'workspace' },
    selectedLauncherAppId: '',
    selectedProjectId: ''
  };

  try {
    if (!existsSync(projectsStateFile)) {
      return emptyState;
    }

    const parsed = JSON.parse(readFileSync(projectsStateFile, 'utf-8')) as Partial<ProjectsState> & {
      selectedWorktreeId?: string;
    };

    return {
      activeGroupId: parsed.activeGroupId ?? '',
      pinnedProjectIds: normalizePinnedProjectIds(parsed.pinnedProjectIds),
      recentProjectIds: normalizeProjectIds(parsed.recentProjectIds),
      selectedExplorerTarget:
        parsed.selectedExplorerTarget?.kind === 'worktree' &&
        typeof parsed.selectedExplorerTarget.worktreeId === 'string'
          ? {
              kind: 'worktree',
              worktreeId: parsed.selectedExplorerTarget.worktreeId
            }
          : parsed.selectedWorktreeId
            ? {
                kind: 'worktree',
                worktreeId: parsed.selectedWorktreeId
              }
            : { kind: 'workspace' },
      selectedLauncherAppId: parsed.selectedLauncherAppId ?? '',
      selectedProjectId: parsed.selectedProjectId ?? ''
    };
  } catch {
    return emptyState;
  }
}

export function writeProjectsState(state: ProjectsState) {
  mkdirSync(projectSpaceDirectory, { recursive: true });
  writeFileSync(
    projectsStateFile,
    JSON.stringify(
      {
        ...state,
        pinnedProjectIds: normalizePinnedProjectIds(state.pinnedProjectIds),
        recentProjectIds: normalizeProjectIds(state.recentProjectIds).slice(0, 8)
      },
      null,
      2
    )
  );
}

export function mergeProjectDiscoveries(
  localDiscovery: ProjectDiscoveryResult,
  remoteDiscovery: ProjectDiscoveryResult
): ProjectDiscoveryResult {
  return {
    groups: [...localDiscovery.groups, ...remoteDiscovery.groups],
    projects: [...localDiscovery.projects, ...remoteDiscovery.projects].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    rootItems: [...localDiscovery.rootItems, ...remoteDiscovery.rootItems].sort((left, right) =>
      left.label.localeCompare(right.label)
    ),
    rootPath: [localDiscovery.rootPath, remoteDiscovery.rootPath].filter(Boolean).join(', '),
    structureViolations: [
      ...(localDiscovery.structureViolations ?? []),
      ...(remoteDiscovery.structureViolations ?? [])
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  };
}

export async function discoverLocalProjects(): Promise<ProjectDiscoveryResult> {
  if (!existsSync(localProjectsDiscoveryRoot)) {
    return {
      groups: [],
      projects: [],
      rootItems: [],
      rootPath: localProjectsDiscoveryRoot,
      structureViolations: []
    };
  }

  const rootEntries = await listDirectoryEntries(localProjectsDiscoveryRoot);
  const groups: ProjectGroupRecord[] = [];
  const projects: ProjectSpaceRecord[] = [];
  const rootItems: ProjectNavigationItem[] = [];
  const structureViolations = await collectProjectStructureViolations(localProjectsDiscoveryRoot);

  for (const rootDirectory of rootEntries.filter((entry) => entry.isDirectory())) {
    const rootChildPath = resolve(localProjectsDiscoveryRoot, rootDirectory.name);
    const projectKind = await classifyProjectDirectory(rootChildPath);
    const childProjects =
      projectKind === 'workspace' || !projectKind
        ? await discoverProjectChildren(rootChildPath)
        : [];

    if (childProjects.length > 0 && (await shouldTreatAsWorktreeProject(childProjects))) {
      const project = await createProjectRecord(
        localProjectsDiscoveryRoot,
        rootChildPath,
        'workspace'
      );
      projects.push(project);
      rootItems.push({
        id: project.id,
        kind: 'project',
        label: project.name,
        projectId: project.id
      });
      continue;
    }

    if (
      childProjects.length > 0 &&
      (!projectKind ||
        (projectKind === 'workspace' && (await shouldPreferGroupOverWorkspace(rootChildPath))))
    ) {
      projects.push(...childProjects);

      const group = createGroupRecord(
        localProjectsDiscoveryRoot,
        rootChildPath,
        childProjects.map((project) => project.id)
      );

      groups.push(group);
      rootItems.push({
        groupId: group.id,
        id: group.id,
        kind: 'group',
        label: group.name
      });
      continue;
    }

    if (projectKind) {
      const project = await createProjectRecord(
        localProjectsDiscoveryRoot,
        rootChildPath,
        projectKind
      );
      projects.push(project);
      rootItems.push({
        id: project.id,
        kind: 'project',
        label: project.name,
        projectId: project.id
      });
    }
  }

  return {
    groups: groups.sort((left, right) => left.name.localeCompare(right.name)),
    projects: projects.sort((left, right) => left.name.localeCompare(right.name)),
    rootItems: rootItems.sort((left, right) => left.label.localeCompare(right.label)),
    rootPath: localProjectsDiscoveryRoot,
    structureViolations
  };
}
