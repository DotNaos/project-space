import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type {
  LauncherAppRecord,
  OpenPathInAppRequest,
  OpenPathInAppResult
} from '../src/shared/project-space-api';

const projectSpaceDirectory = `${homedir()}/.project-space`;
const launcherIconCacheDirectory = `${projectSpaceDirectory}/cache/launcher-icons`;
const launcherIconHelperScriptPath = `${projectSpaceDirectory}/cache/render-app-icon.swift`;
const launcherIconSize = 64;
const execFileAsync = promisify(execFile);

const launcherIconHelperScript = `
import AppKit

let path = CommandLine.arguments[1]
let out = CommandLine.arguments[2]
let requestedSize = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3]) ?? 64 : 64
let size = NSSize(width: requestedSize, height: requestedSize)
let icon = NSWorkspace.shared.icon(forFile: path)
icon.size = size
let image = NSImage(size: size)
image.lockFocus()
icon.draw(in: NSRect(origin: .zero, size: size))
image.unlockFocus()
if let tiff = image.tiffRepresentation,
   let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
  try png.write(to: URL(fileURLWithPath: out))
}
`;

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

async function runCommand(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true
  });

  return stdout;
}

async function resolveInstalledAppPath(appEntry: (typeof launcherRegistry)[number]) {
  const candidatePaths = appEntry.candidatePaths ?? [
    join('/Applications', appEntry.bundleName),
    join(homedir(), 'Applications', appEntry.bundleName),
    join('/System/Applications', appEntry.bundleName),
    join('/System/Applications/Utilities', appEntry.bundleName)
  ];
  const existingCandidate = candidatePaths.find((path) => existsSync(path));

  if (existingCandidate) {
    return existingCandidate;
  }

  try {
    const result = await runCommand('mdfind', [`kMDItemFSName == "${appEntry.bundleName}"c`]);

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

  for (const key of [
    'CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconFiles',
    'CFBundleIconFile',
    'CFBundleIconName'
  ]) {
    try {
      const output = await runCommand('plutil', ['-extract', key, 'json', '-o', '-', infoPlistPath]);
      const parsed = JSON.parse(output) as string | string[];
      candidateNames.push(...(Array.isArray(parsed) ? parsed.slice().reverse() : [parsed]));
    } catch {
      // Fall through to the next plist key.
    }
  }

  candidateNames.push('AppIcon', basename(appPath, '.app'));

  return candidateNames
    .flatMap((entryName) => {
      const normalizedName = extname(entryName) ? entryName : `${entryName}.icns`;

      return [join(resourceDirectory, normalizedName), join(resourceDirectory, entryName)];
    })
    .find((iconPath) => existsSync(iconPath));
}

function loadCachedLauncherIconSource(appId: string) {
  const cachedPath = [
    join(launcherIconCacheDirectory, `${appId}.png`),
    join(launcherIconCacheDirectory, `${appId}-bundle.png`)
  ].find((path) => existsSync(path));

  if (!cachedPath) {
    return undefined;
  }

  try {
    const iconBuffer = readFileSync(cachedPath);

    return `data:image/png;base64,${iconBuffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function ensureLauncherIconHelperScript() {
  mkdirSync(`${projectSpaceDirectory}/cache`, { recursive: true });

  if (!existsSync(launcherIconHelperScriptPath)) {
    writeFileSync(launcherIconHelperScriptPath, launcherIconHelperScript);
    return;
  }

  if (readFileSync(launcherIconHelperScriptPath, 'utf-8') !== launcherIconHelperScript) {
    writeFileSync(launcherIconHelperScriptPath, launcherIconHelperScript);
  }
}

async function loadAppIconSource(appId: string, appPath: string) {
  const cachedSource = loadCachedLauncherIconSource(appId);

  if (cachedSource) {
    return cachedSource;
  }

  mkdirSync(launcherIconCacheDirectory, { recursive: true });

  const outputPath = join(launcherIconCacheDirectory, `${appId}.png`);
  const iconPath = await resolveAppIconPath(appPath);

  if (iconPath) {
    return pathToFileURL(iconPath).toString();
  }

  try {
    ensureLauncherIconHelperScript();
    await runCommand('swift', [
      launcherIconHelperScriptPath,
      appPath,
      outputPath,
      String(launcherIconSize)
    ]);

    return loadCachedLauncherIconSource(appId);
  } catch {
    return undefined;
  }
}

export async function loadInstalledLauncherApps(): Promise<LauncherAppRecord[]> {
  const apps: LauncherAppRecord[] = [];

  for (const launcherApp of launcherRegistry) {
    const installedPath = await resolveInstalledAppPath(launcherApp);

    if (installedPath) {
      apps.push({
        appName: launcherApp.appName,
        id: launcherApp.id,
        label: launcherApp.label
      });
    }
  }

  return apps;
}

export async function loadLauncherAppIcon(appId: string) {
  const launcherApp = launcherRegistry.find((appEntry) => appEntry.id === appId);
  const installedPath = launcherApp ? await resolveInstalledAppPath(launcherApp) : undefined;

  return installedPath ? loadAppIconSource(appId, installedPath) : undefined;
}

export async function openPathInApp(
  request: OpenPathInAppRequest
): Promise<OpenPathInAppResult> {
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

export async function openCodexSkills(): Promise<OpenPathInAppResult> {
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
