import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getCodexStatus, openCodexTarget } from './local-codex-client';
import { runTerminalCommand } from './local-command-runner';
import { loadConnectorProjectDiscovery } from './connector-discovery';
import {
  getRegisteredConnectorDiscovery,
  getRegisteredConnectorMachines
} from './connector-hub';
import {
  commitGitChanges,
  getGitDiff,
  getGitStatus,
  stageGitPaths,
  unstageGitPaths
} from './local-git-client';
import {
  getGitHubCatalog,
  pollGitHubOAuthDeviceFlow,
  startGitHubOAuthDeviceFlow
} from './local-github-catalog';
import {
  loadInstalledLauncherApps,
  loadLauncherAppIcon,
  openCodexSkills,
  openPathInApp
} from './local-launcher-apps';
import { getConnectorOverview } from './local-machine-registry';
import { runProjectCliCommand } from './local-project-cli-client';
import {
  getProjectctlOverview,
  getProjectctlPreview
} from './local-projectctl-client';
import {
  backupProject,
  deployProject,
  getPlatformOverview
} from './local-platform-operations';
import {
  getScopeDevboxOverview,
  startScopeDevboxJob
} from './local-scope-devbox-jobs';
import type {
  AppMeta,
  FileSystemEntry,
  ProjectDirectorySelection,
  ProjectDiscoveryResult,
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceBackend,
  ProjectSpaceRecord,
  ProjectWorktreeRecord,
  ProjectsState,
  ToolLaunchRequest,
  ToolLaunchResult
} from '../src/shared/project-space-api';

interface LocalProjectSpaceBackendOptions {
  getAppMeta?: () => AppMeta | Promise<AppMeta>;
  selectProjectDirectory?: () => Promise<ProjectDirectorySelection>;
}

const projectSpaceDirectory = `${homedir()}/.project-space`;
const projectsStateFile = `${projectSpaceDirectory}/projects.json`;
const discoveryRoot = join(homedir(), 'projects');
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

function makeNodeId(rootPath: string, path: string) {
  const relativePath = relative(rootPath, path).replace(/^\.\/?/, '');

  return relativePath.length > 0 ? relativePath.replace(/[\\/]+/g, '__') : basename(path);
}

function createProjectRecord(
  rootPath: string,
  path: string,
  kind: ProjectSpaceRecord['kind'],
  groupId?: string
): ProjectSpaceRecord {
  const resolvedPath = resolve(path);
  const hasProject = existsSync(join(resolvedPath, 'project.yaml'));
  const hasLock = existsSync(join(resolvedPath, 'template.lock.yaml'));
  const hasGoals = existsSync(join(resolvedPath, 'GOALS.md'));
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
  const groupId = makeNodeId(discoveryRoot, groupPath);
  const projects: ProjectSpaceRecord[] = [];

  for (const childDirectory of childEntries.filter((entry) => entry.isDirectory())) {
    const childPath = resolve(groupPath, childDirectory.name);
    const kind = await classifyProjectDirectory(childPath);

    if (kind) {
      projects.push(createProjectRecord(discoveryRoot, childPath, kind, groupId));
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

async function shouldTreatAsWorktreeProject(
  childProjects: ProjectSpaceRecord[]
) {
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

function readProjectsState(): ProjectsState {
  try {
    if (!existsSync(projectsStateFile)) {
      return {
        activeGroupId: '',
        selectedExplorerTarget: { kind: 'workspace' },
        selectedLauncherAppId: '',
        selectedProjectId: ''
      };
    }

    const parsed = JSON.parse(readFileSync(projectsStateFile, 'utf-8')) as Partial<ProjectsState> & {
      selectedWorktreeId?: string;
    };

    return {
      activeGroupId: parsed.activeGroupId ?? '',
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
    return {
      activeGroupId: '',
      selectedExplorerTarget: { kind: 'workspace' },
      selectedLauncherAppId: '',
      selectedProjectId: ''
    };
  }
}

function writeProjectsState(state: ProjectsState) {
  mkdirSync(projectSpaceDirectory, { recursive: true });
  writeFileSync(projectsStateFile, JSON.stringify(state, null, 2));
}

function mergeDiscoveries(
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
    rootPath: [localDiscovery.rootPath, remoteDiscovery.rootPath].filter(Boolean).join(', ')
  };
}

async function discoverProjects(): Promise<ProjectDiscoveryResult> {
  if (!existsSync(discoveryRoot)) {
    return {
      groups: [],
      projects: [],
      rootItems: [],
      rootPath: discoveryRoot
    };
  }

  const rootEntries = await listDirectoryEntries(discoveryRoot);
  const groups: ProjectGroupRecord[] = [];
  const projects: ProjectSpaceRecord[] = [];
  const rootItems: ProjectNavigationItem[] = [];

  for (const rootDirectory of rootEntries.filter((entry) => entry.isDirectory())) {
    const rootChildPath = resolve(discoveryRoot, rootDirectory.name);
    const projectKind = await classifyProjectDirectory(rootChildPath);
    const childProjects =
      projectKind === 'workspace' || !projectKind
        ? await discoverProjectChildren(rootChildPath)
        : [];

    if (childProjects.length > 0 && (await shouldTreatAsWorktreeProject(childProjects))) {
      const project = createProjectRecord(discoveryRoot, rootChildPath, 'workspace');
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
        discoveryRoot,
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
      const project = createProjectRecord(discoveryRoot, rootChildPath, projectKind);
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
    rootPath: discoveryRoot
  };
}

function createBaseWorktree(projectPath: string): ProjectWorktreeRecord {
  const resolvedPath = resolve(projectPath);

  return {
    id: resolvedPath,
    name: basename(resolvedPath),
    path: resolvedPath,
    isBase: true,
    status: 'ready'
  };
}

function parseWorktreeList(output: string, basePath: string): ProjectWorktreeRecord[] {
  const normalizedBasePath = resolve(basePath);

  return output
    .trim()
    .split('\n\n')
    .reduce<ProjectWorktreeRecord[]>((entries, block) => {
      const lines = block.split('\n').filter(Boolean);
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));

      if (!worktreeLine) {
        return entries;
      }

      const worktreePath = resolve(worktreeLine.slice('worktree '.length));
      const branchLine = lines.find((line) => line.startsWith('branch '));
      const branchRef = branchLine?.slice('branch '.length).trim();

      entries.push({
        branchName: branchRef?.replace('refs/heads/', ''),
        id: worktreePath,
        isBase: worktreePath === normalizedBasePath,
        name: basename(worktreePath),
        path: worktreePath,
        status: 'ready'
      });

      return entries;
    }, [])
    .sort((left, right) => {
      if (left.isBase !== right.isBase) {
        return left.isBase ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

async function scanProjectContainerWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]> {
  const entries = await listDirectoryEntries(projectPath);

  return entries
    .filter((entry) => entry.isDirectory())
    .reduce<ProjectWorktreeRecord[]>((worktrees, entry) => {
      const worktreePath = resolve(projectPath, entry.name);
      const gitPath = join(worktreePath, '.git');

      if (!existsSync(gitPath)) {
        return worktrees;
      }

      let status: ProjectWorktreeRecord['status'] = 'ready';

      try {
        const gitPointer = readFileSync(gitPath, 'utf-8').trim();

        if (gitPointer.startsWith('gitdir:')) {
          const gitDirPath = gitPointer.slice('gitdir:'.length).trim();
          const resolvedGitDir = gitDirPath.startsWith('/')
            ? gitDirPath
            : resolve(worktreePath, gitDirPath);

          if (!existsSync(resolvedGitDir)) {
            status = 'broken';
          }
        }
      } catch {
        status = 'ready';
      }

      worktrees.push({
        id: worktreePath,
        isBase: entry.name === 'base',
        name: entry.name,
        path: worktreePath,
        status
      });

      return worktrees;
    }, [])
    .sort((left, right) => {
      if (left.isBase !== right.isBase) {
        return left.isBase ? -1 : 1;
      }

      if (left.status !== right.status) {
        return left.status === 'ready' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

async function loadProjectWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]> {
  const resolvedProjectPath = resolve(projectPath);

  try {
    const gitCommonDir = (
      await runCommand('git', [
        '-C',
        resolvedProjectPath,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir'
      ])
    ).trim();
    const basePath = dirname(gitCommonDir);
    const worktreeList = await runCommand('git', [
      '-C',
      resolvedProjectPath,
      'worktree',
      'list',
      '--porcelain'
    ]);
    const parsedWorktrees = parseWorktreeList(worktreeList, basePath);

    return parsedWorktrees.length > 0 ? parsedWorktrees : [createBaseWorktree(basePath)];
  } catch {
    const scannedWorktrees = await scanProjectContainerWorktrees(resolvedProjectPath);

    return scannedWorktrees.length > 0 ? scannedWorktrees : [];
  }
}

async function readDirectoryEntries(path: string): Promise<FileSystemEntry[]> {
  const entries = await listDirectoryEntries(path);

  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
      name: entry.name,
      path: resolve(path, entry.name)
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

export function createLocalProjectSpaceBackend(
  options: LocalProjectSpaceBackendOptions = {}
): ProjectSpaceBackend {
  return {
    async getAppMeta() {
      return options.getAppMeta?.() ?? {
        name: 'project-space',
        platform: process.platform,
        version: '0.1.0'
      };
    },
    async getCodexStatus() {
      return getCodexStatus();
    },
    async getConnectorOverview() {
      const connector = await getConnectorOverview();
      const registeredMachines = getRegisteredConnectorMachines();
      const knownMachineIds = new Set(connector.machines.map((machine) => machine.id));

      return {
        ...connector,
        machines: [
          ...connector.machines,
          ...registeredMachines.filter((machine) => !knownMachineIds.has(machine.id))
        ]
      };
    },
    async getConnectorProjectRegistry() {
      const [connector, discovery] = await Promise.all([
        getConnectorOverview(),
        discoverProjects()
      ]);
      const localMachine =
        connector.machines.find((machine) => machine.connector.status === 'local') ??
        connector.machines[0];
      const machineName = localMachine?.name ?? hostname().split('.')[0];

      return {
        checkedAt: new Date().toISOString(),
        connector: {
          machineId: localMachine?.id ?? machineName,
          machineName,
          origin: connector.connectorOrigin,
          serviceName: process.env.PROJECT_CONNECTOR_SERVICE_NAME ?? 'project-space-connector'
        },
        discovery
      };
    },
    async runProjectCliCommand(request) {
      return runProjectCliCommand(request);
    },
    async getGitHubCatalog() {
      return getGitHubCatalog();
    },
    async getGitDiff(request) {
      return getGitDiff(request);
    },
    async getGitStatus(cwd: string) {
      return getGitStatus(cwd);
    },
    async getPlatformOverview() {
      return getPlatformOverview();
    },
    async loadLauncherApps() {
      return loadInstalledLauncherApps();
    },
    async loadLauncherAppIcon(appId: string) {
      return loadLauncherAppIcon(appId);
    },
    async loadProjectDiscovery() {
      if (process.env.PROJECT_SPACE_DISCOVERY_SOURCE === 'connector') {
        return (await loadConnectorProjectDiscovery()) ?? {
          groups: [],
          projects: [],
          rootItems: [],
          rootPath: 'connector'
        };
      }

      return mergeDiscoveries(await discoverProjects(), getRegisteredConnectorDiscovery());
    },
    async loadProjectctlOverview(projectPath: string) {
      return getProjectctlOverview(projectPath);
    },
    async loadProjectctlPreview(projectPath: string) {
      return getProjectctlPreview(projectPath);
    },
    async loadProjectsState() {
      return readProjectsState();
    },
    async loadProjectWorktrees(projectPath: string) {
      return loadProjectWorktrees(projectPath);
    },
    async openCodexSkills() {
      return openCodexSkills();
    },
    async openCodexTarget(request) {
      return openCodexTarget(request);
    },
    async openPathInApp(request) {
      return openPathInApp(request);
    },
    async readDirectory(path: string) {
      return readDirectoryEntries(path);
    },
    async runTerminalCommand(request) {
      return runTerminalCommand(request);
    },
    async saveProjectsState(state: ProjectsState) {
      writeProjectsState(state);
    },
    async selectProjectDirectory() {
      return options.selectProjectDirectory?.() ?? { canceled: true };
    },
    async startGitHubOAuthDeviceFlow() {
      return startGitHubOAuthDeviceFlow();
    },
    async pollGitHubOAuthDeviceFlow(request) {
      return pollGitHubOAuthDeviceFlow(request);
    },
    async getScopeDevboxOverview() {
      return getScopeDevboxOverview();
    },
    async startScopeDevboxJob(request) {
      return startScopeDevboxJob(request);
    },
    async stageGitPaths(request) {
      return stageGitPaths(request);
    },
    async deployProject(request) {
      return deployProject(request);
    },
    async backupProject(request) {
      return backupProject(request);
    },
    async unstageGitPaths(request) {
      return unstageGitPaths(request);
    },
    async commitGitChanges(request) {
      return commitGitChanges(request);
    },
    async openWorkspaceTool(request: ToolLaunchRequest): Promise<ToolLaunchResult> {
      return {
        message: `Launcher placeholder: ${request.tool} will attach to worktree ${request.worktreeId ?? 'unselected'} later.`,
        status: 'placeholder'
      };
    }
  };
}
