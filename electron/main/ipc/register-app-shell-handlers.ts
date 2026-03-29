import { app, dialog, ipcMain, nativeTheme } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  type FileSystemEntry,
  type LauncherAppRecord,
  type OpenPathInAppRequest,
  type OpenPathInAppResult,
  type ProjectDiscoveryResult,
  type ProjectGroupRecord,
  type ProjectNavigationItem,
  type ProjectSpaceRecord,
  type ProjectWorktreeRecord,
  type ProjectsState,
  projectSpaceChannels,
  type ProjectDirectorySelection,
  type ToolLaunchRequest,
  type ToolLaunchResult
} from '../../../src/shared/electron-api';
import {
  loadWorktreeIdeaIds,
} from './ideas/idea-storage';
import {
  createWorktreeRecord,
  inferProjectNameFromGitData,
  parseWorktreeListOutput
} from './project-git-metadata';
import { registerIdeaHandlers } from './register-idea-handlers';

const projectSpaceDirectory = `${homedir()}/.project-space`;
const projectsStateFile = `${projectSpaceDirectory}/projects.json`;
const launcherIconCacheDirectory = `${projectSpaceDirectory}/cache/launcher-icons`;
const launcherIconHelperScriptPath = `${projectSpaceDirectory}/cache/render-app-icon.swift`;
const launcherIconSize = 64;
// TODO: make the projects root user-configurable.
const discoveryRoot = join(homedir(), 'projects');
const execFileAsync = promisify(execFile);

const launcherIconHelperScript = `
import AppKit

let path = CommandLine.arguments[1]
let out = CommandLine.arguments[2]
let appearanceArgument = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "dark"
let appearanceName: NSAppearance.Name = appearanceArgument == "light" ? .aqua : .darkAqua
let appearance = NSAppearance(named: appearanceName)!
let requestedSize = CommandLine.arguments.count > 4 ? Int(CommandLine.arguments[4]) ?? 64 : 64
let size = NSSize(width: requestedSize, height: requestedSize)
let icon = NSWorkspace.shared.icon(forFile: path)
icon.size = size
let image = NSImage(size: size)
image.lockFocus()
appearance.performAsCurrentDrawingAppearance {
  icon.draw(in: NSRect(origin: .zero, size: size))
}
image.unlockFocus()
if let tiff = image.tiffRepresentation,
   let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
  try png.write(to: URL(fileURLWithPath: out))
}
`;

const standaloneProjectMarkers = new Set([
  '.git',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod'
]);

const launcherRegistry: Array<
  LauncherAppRecord & {
    bundleName: string;
    candidatePaths?: string[];
  }
> = [
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    appName: 'Visual Studio Code - Insiders',
    bundleName: 'Visual Studio Code - Insiders.app'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    appName: 'Cursor',
    bundleName: 'Cursor.app'
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    appName: 'Antigravity',
    bundleName: 'Antigravity.app'
  },
  {
    id: 'finder',
    label: 'Finder',
    appName: 'Finder',
    bundleName: 'Finder.app',
    candidatePaths: ['/System/Library/CoreServices/Finder.app']
  },
  {
    id: 'terminal',
    label: 'Terminal',
    appName: 'Terminal',
    bundleName: 'Terminal.app',
    candidatePaths: ['/System/Applications/Utilities/Terminal.app']
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    appName: 'Ghostty',
    bundleName: 'Ghostty.app'
  },
  {
    id: 'xcode',
    label: 'Xcode',
    appName: 'Xcode',
    bundleName: 'Xcode.app'
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    appName: 'Android Studio',
    bundleName: 'Android Studio.app'
  },
  {
    id: 'rider',
    label: 'Rider',
    appName: 'Rider',
    bundleName: 'Rider.app'
  },
  {
    id: 'codex',
    label: 'Codex',
    appName: 'Codex',
    bundleName: 'Codex.app'
  }
];

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

    const content = readFileSync(projectsStateFile, 'utf-8');
    const parsed = JSON.parse(content) as Partial<ProjectsState> & {
      projects?: unknown[];
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

function ensureLauncherIconHelperScript() {
  mkdirSync(`${projectSpaceDirectory}/cache`, { recursive: true });

  if (!existsSync(launcherIconHelperScriptPath)) {
    writeFileSync(launcherIconHelperScriptPath, launcherIconHelperScript);
    return;
  }

  const currentScript = readFileSync(launcherIconHelperScriptPath, 'utf-8');

  if (currentScript !== launcherIconHelperScript) {
    writeFileSync(launcherIconHelperScriptPath, launcherIconHelperScript);
  }
}

function loadCachedLauncherIconSource(appId: string) {
  const appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const candidatePaths = [
    join(launcherIconCacheDirectory, `${appId}-${appearance}.png`),
    join(launcherIconCacheDirectory, `${appId}-bundle.png`)
  ];

  const cachedPath = candidatePaths.find((path) => existsSync(path));

  if (!cachedPath) {
    return {
      iconDataUrl: undefined,
      iconUrl: undefined
    };
  }

  try {
    const iconBuffer = readFileSync(cachedPath);

    return {
      iconDataUrl: `data:image/png;base64,${iconBuffer.toString('base64')}`,
      iconUrl: pathToFileURL(cachedPath).toString()
    };
  } catch {
    return {
      iconDataUrl: undefined,
      iconUrl: undefined
    };
  }
}

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

async function inferProjectName(path: string) {
  try {
    const remoteUrl = await runCommand('git', ['-C', path, 'remote', 'get-url', 'origin']);
    return inferProjectNameFromGitData({
      fallbackPath: path,
      remoteUrl
    });
  } catch {
    // fall through to other repo-derived names
  }

  try {
    const gitCommonDir = (
      await runCommand('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    return inferProjectNameFromGitData({
      fallbackPath: path,
      gitCommonDir
    });
  } catch {
    // fall through to other repo-derived names
  }

  try {
    const topLevelPath = (await runCommand('git', ['-C', path, 'rev-parse', '--show-toplevel'])).trim();
    return inferProjectNameFromGitData({
      fallbackPath: path,
      topLevelPath
    });
  } catch {
    // fall through to folder name
  }

  return inferProjectNameFromGitData({
    fallbackPath: path
  });
}

async function createProjectRecord(
  rootPath: string,
  path: string,
  kind: ProjectSpaceRecord['kind'],
  groupId?: string
): Promise<ProjectSpaceRecord> {
  const resolvedPath = resolve(path);

  return {
    id: makeNodeId(rootPath, resolvedPath),
    kind,
    groupId,
    name: await inferProjectName(resolvedPath),
    rootPath: resolvedPath
  };
}

function createGroupRecord(rootPath: string, path: string, childProjectIds: string[]): ProjectGroupRecord {
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
  if (entryNames.has('base')) {
    return true;
  }

  return basename(path).endsWith('.worktrees');
}

function hasStandaloneMarker(entryNames: Set<string>) {
  return Array.from(entryNames).some((entryName) => standaloneProjectMarkers.has(entryName));
}

async function classifyProjectDirectory(path: string): Promise<ProjectSpaceRecord['kind'] | null> {
  const entries = await listDirectoryEntries(path);
  const entryNames = new Set(entries.map((entry) => entry.name));

  if (hasStrongWorkspaceMarker(path, entryNames) || hasWorkspaceFileMarker(path, entryNames)) {
    return 'workspace';
  }

  if (hasStandaloneMarker(entryNames)) {
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
  const childDirectories = childEntries.filter((entry) => entry.isDirectory());
  const projects: ProjectSpaceRecord[] = [];
  const groupId = makeNodeId(discoveryRoot, groupPath);

  for (const childDirectory of childDirectories) {
    const childPath = resolve(groupPath, childDirectory.name);
    const kind = await classifyProjectDirectory(childPath);

    if (!kind) {
      continue;
    }

    projects.push(await createProjectRecord(discoveryRoot, childPath, kind, groupId));
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadGitCommonDir(path: string) {
  try {
    const output = await runCommand('git', [
      '-C',
      path,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    ]);

    return output.trim();
  } catch {
    return '';
  }
}

async function shouldTreatAsWorktreeProject(
  path: string,
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
  const rootDirectories = rootEntries.filter((entry) => entry.isDirectory());
  const groups: ProjectGroupRecord[] = [];
  const projects: ProjectSpaceRecord[] = [];
  const rootItems: ProjectNavigationItem[] = [];

  for (const rootDirectory of rootDirectories) {
    const rootChildPath = resolve(discoveryRoot, rootDirectory.name);
    const projectKind = await classifyProjectDirectory(rootChildPath);
    const childProjects =
      projectKind === 'workspace' || !projectKind
        ? await discoverProjectChildren(rootChildPath)
        : [];
    const treatAsWorktreeProject =
      childProjects.length > 0 &&
      (await shouldTreatAsWorktreeProject(rootChildPath, childProjects));

    if (treatAsWorktreeProject) {
      const project = await createProjectRecord(discoveryRoot, rootChildPath, 'workspace');

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
      const project = await createProjectRecord(discoveryRoot, rootChildPath, projectKind);

      projects.push(project);
      rootItems.push({
        id: project.id,
        kind: 'project',
        label: project.name,
        projectId: project.id
      });
      continue;
    }

    if (childProjects.length === 0) {
      continue;
    }

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
  }

  return {
    groups: groups.sort((left, right) => left.name.localeCompare(right.name)),
    projects: projects.sort((left, right) => left.name.localeCompare(right.name)),
    rootItems: rootItems.sort((left, right) => left.label.localeCompare(right.label)),
    rootPath: discoveryRoot
  };
}

async function readWorktreeBranchName(worktreePath: string): Promise<string | undefined> {
  try {
    const branchName = (
      await runCommand('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim();

    return branchName || undefined;
  } catch {
    return undefined;
  }
}

async function createBaseWorktree(projectPath: string): Promise<ProjectWorktreeRecord> {
  const resolvedPath = resolve(projectPath);
  const branchName = await readWorktreeBranchName(resolvedPath);

  const worktree = createWorktreeRecord({
    branchRef: branchName,
    isBase: true,
    path: resolvedPath,
    status: 'ready'
  });

  return {
    ...worktree,
    ideaIds: loadWorktreeIdeaIds(resolvedPath)
  };
}

async function scanProjectContainerWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]> {
  const entries = await listDirectoryEntries(projectPath);

  const worktrees: ProjectWorktreeRecord[] = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const worktreePath = resolve(projectPath, entry.name);
    const gitPath = join(worktreePath, '.git');

    if (!existsSync(gitPath)) {
      continue;
    }

    const isBase = entry.name === 'base';
    const branchName = await readWorktreeBranchName(worktreePath);
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
      ...createWorktreeRecord({
        branchRef: branchName,
        isBase,
        path: worktreePath,
        status
      }),
      ideaIds: loadWorktreeIdeaIds(worktreePath)
    });
  }

  return worktrees
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
    const gitCommonDirOutput = await runCommand('git', [
      '-C',
      resolvedProjectPath,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    ]);
    const gitCommonDir = gitCommonDirOutput.trim();
    const basePath = dirname(gitCommonDir);
    const worktreeList = await runCommand('git', [
      '-C',
      resolvedProjectPath,
      'worktree',
      'list',
      '--porcelain'
    ]);
    const parsedWorktrees = parseWorktreeListOutput(worktreeList, basePath).map((worktree) => ({
      ...worktree,
      ideaIds: loadWorktreeIdeaIds(worktree.path)
    }));

    return parsedWorktrees.length > 0 ? parsedWorktrees : [await createBaseWorktree(basePath)];
  } catch {
    try {
      const scannedWorktrees = await scanProjectContainerWorktrees(resolvedProjectPath);

      return scannedWorktrees.length > 0 ? scannedWorktrees : [];
    } catch {
      return [];
    }
  }
}

async function readDirectoryEntries(path: string): Promise<FileSystemEntry[]> {
  const entries = await listDirectoryEntries(path);

  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => {
      const kind: FileSystemEntry['kind'] = entry.isDirectory() ? 'directory' : 'file';

      return {
        kind,
        name: entry.name,
        path: resolve(path, entry.name)
      };
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

async function resolveInstalledAppPath(appEntry: (typeof launcherRegistry)[number]) {
  const candidatePaths = appEntry.candidatePaths ?? [
    join('/Applications', appEntry.bundleName),
    join(homedir(), 'Applications', appEntry.bundleName),
    join('/System/Applications', appEntry.bundleName),
    join('/System/Applications/Utilities', appEntry.bundleName)
  ];

  if (candidatePaths.some((path) => existsSync(path))) {
    return candidatePaths.find((path) => existsSync(path));
  }

  try {
    const result = await runCommand('mdfind', [
      `kMDItemFSName == "${appEntry.bundleName}"c`
    ]);

    return result
      .split('\n')
      .map((entry) => entry.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

async function resolveAppIconPath(appPath: string) {
  const infoPlistPath = join(appPath, 'Contents/Info.plist');
  const resourceDirectory = join(appPath, 'Contents/Resources');
  const candidateNames: string[] = [];

  try {
    const bundleIconFilesOutput = await runCommand('plutil', [
      '-extract',
      'CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles',
      'json',
      '-o',
      '-',
      infoPlistPath
    ]);
    const bundleIconFiles = JSON.parse(bundleIconFilesOutput) as string[];

    candidateNames.push(...bundleIconFiles.slice().reverse());
  } catch {
    // Ignore and fall back to other plist keys.
  }

  try {
    const iconName = (
      await runCommand('plutil', [
        '-extract',
        'CFBundleIconFile',
        'raw',
        '-o',
        '-',
        infoPlistPath
      ])
    ).trim();

    if (iconName.length > 0) {
      candidateNames.push(iconName);
    }
  } catch {
    // Ignore and fall back to other plist keys.
  }

  try {
    const iconName = (
      await runCommand('plutil', [
        '-extract',
        'CFBundleIconName',
        'raw',
        '-o',
        '-',
        infoPlistPath
      ])
    ).trim();

    if (iconName.length > 0) {
      candidateNames.push(iconName);
    }
  } catch {
    // Ignore and fall back to common bundle icon names.
  }

  const fallbackNames = ['AppIcon', basename(appPath, '.app')];
  candidateNames.push(...fallbackNames);

  return candidateNames
    .flatMap((entryName) => {
      const normalizedName = extname(entryName) ? entryName : `${entryName}.icns`;

      return [
        join(resourceDirectory, normalizedName),
        join(resourceDirectory, entryName)
      ];
    })
    .find((iconPath) => existsSync(iconPath));
}

async function loadAppIconSource(appId: string, appPath: string) {
  ensureLauncherIconHelperScript();
  mkdirSync(launcherIconCacheDirectory, { recursive: true });

  const appearance = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const themedOutputPath = join(launcherIconCacheDirectory, `${appId}-${appearance}.png`);

  try {
    await execFileAsync(
      'swift',
      [
        launcherIconHelperScriptPath,
        appPath,
        themedOutputPath,
        appearance,
        `${launcherIconSize}`
      ],
      {
        windowsHide: true
      }
    );

    const iconBuffer = readFileSync(themedOutputPath);

    if (iconBuffer.length > 0) {
      return {
        iconDataUrl: `data:image/png;base64,${iconBuffer.toString('base64')}`,
        iconUrl: pathToFileURL(themedOutputPath).toString()
      };
    }
  } catch {
    // Fall through to bundled icon rendering.
  }

  const iconPath = await resolveAppIconPath(appPath);
  if (iconPath) {
    const outputPath = join(launcherIconCacheDirectory, `${appId}-bundle.png`);

    try {
      await execFileAsync(
        'sips',
        ['-z', `${launcherIconSize}`, `${launcherIconSize}`, '-s', 'format', 'png', iconPath, '--out', outputPath],
        {
          windowsHide: true
        }
      );
      const iconBuffer = readFileSync(outputPath);

      return {
        iconDataUrl: `data:image/png;base64,${iconBuffer.toString('base64')}`,
        iconUrl: pathToFileURL(outputPath).toString()
      };
    } catch {
      return {
        iconDataUrl: undefined,
        iconUrl: undefined
      };
    }
  }

  return {
    iconDataUrl: undefined,
    iconUrl: undefined
  };
}

async function loadInstalledLauncherApps() {
  const installedApps: LauncherAppRecord[] = [];

  for (const appEntry of launcherRegistry) {
    const installedPath = await resolveInstalledAppPath(appEntry);

    if (installedPath) {
      const iconSource = loadCachedLauncherIconSource(appEntry.id);

      installedApps.push({
        appName: appEntry.appName,
        id: appEntry.id,
        iconDataUrl: iconSource.iconDataUrl,
        iconUrl: iconSource.iconUrl,
        label: appEntry.label
      });
    }
  }

  return installedApps;
}

async function loadLauncherAppIcon(appId: string) {
  const launcherApp = launcherRegistry.find((appEntry) => appEntry.id === appId);

  if (!launcherApp) {
    return undefined;
  }

  const installedPath = await resolveInstalledAppPath(launcherApp);
  if (!installedPath) {
    return undefined;
  }

  const iconSource = await loadAppIconSource(launcherApp.id, installedPath);

  return iconSource.iconDataUrl;
}

async function openPathInApp(request: OpenPathInAppRequest): Promise<OpenPathInAppResult> {
  const launcherApp = launcherRegistry.find((appEntry) => appEntry.id === request.appId);

  if (!launcherApp) {
    return {
      message: 'Selected app is no longer available.',
      status: 'error'
    };
  }

  try {
    await execFileAsync('open', ['-a', launcherApp.appName, request.path], {
      windowsHide: true
    });

    return {
      status: 'success'
    };
  } catch {
    return {
      message: `Could not open ${basename(request.path)} in ${launcherApp.label}.`,
      status: 'error'
    };
  }
}

async function openCodexSkills(): Promise<OpenPathInAppResult> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const skillsPath = join(codexHome, 'skills');

  try {
    await execFileAsync('open', [skillsPath], {
      windowsHide: true
    });

    return {
      status: 'success'
    };
  } catch {
    return {
      message: 'Could not open the local skills folder.',
      status: 'error'
    };
  }
}

async function openExternalUrl(url: string): Promise<OpenPathInAppResult> {
  try {
    await execFileAsync('open', [url], {
      windowsHide: true
    });

    return {
      status: 'success'
    };
  } catch {
    return {
      message: 'Could not open the external link.',
      status: 'error'
    };
  }
}

export function registerAppShellHandlers() {
  registerIdeaHandlers();

  ipcMain.handle(projectSpaceChannels.appMeta, () => {
    return {
      name: app.getName(),
      platform: process.platform,
      version: app.getVersion()
    };
  });

  ipcMain.handle(projectSpaceChannels.loadLauncherApps, async () => {
    return loadInstalledLauncherApps();
  });

  ipcMain.handle(projectSpaceChannels.openCodexSkills, async () => {
    return openCodexSkills();
  });

  ipcMain.handle(projectSpaceChannels.openExternalUrl, async (_event, url: string) => {
    return openExternalUrl(url);
  });

  ipcMain.handle(projectSpaceChannels.loadLauncherAppIcon, async (_event, appId: string) => {
    return loadLauncherAppIcon(appId);
  });

  ipcMain.handle(projectSpaceChannels.loadProjectDiscovery, async () => {
    return discoverProjects();
  });

  ipcMain.handle(projectSpaceChannels.loadProjectsState, () => {
    return readProjectsState();
  });

  ipcMain.handle(projectSpaceChannels.loadProjectWorktrees, async (_event, projectPath: string) => {
    return loadProjectWorktrees(projectPath);
  });

  ipcMain.handle(projectSpaceChannels.openPathInApp, async (_event, request: OpenPathInAppRequest) => {
    return openPathInApp(request);
  });

  ipcMain.handle(projectSpaceChannels.readDirectory, async (_event, path: string) => {
    return readDirectoryEntries(path);
  });

  ipcMain.handle(projectSpaceChannels.saveProjectsState, async (_event, state: ProjectsState) => {
    writeProjectsState(state);
  });

  ipcMain.handle(
    projectSpaceChannels.selectProjectDirectory,
    async (): Promise<ProjectDirectorySelection> => {
      const result = await dialog.showOpenDialog({
        title: 'Select project folder',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const selectedPath = result.filePaths[0];

      return {
        canceled: false,
        name: basename(selectedPath),
        path: selectedPath
      };
    }
  );

  ipcMain.handle(
    projectSpaceChannels.openWorkspaceTool,
    async (_event, request: ToolLaunchRequest): Promise<ToolLaunchResult> => {
      return {
        message: `Launcher placeholder: ${request.tool} will attach to worktree ${request.worktreeId ?? 'unselected'} later.`,
        status: 'placeholder'
      };
    }
  );
}
