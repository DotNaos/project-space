import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCommand } from './local-command-runner';
import type {
  CodexOpenRequest,
  CodexStatusResult,
  OpenPathInAppResult
} from '../src/shared/project-space-api';

function resolveCodexHome() {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

async function resolveCodexCliPath() {
  try {
    const output = await runCommand('zsh', ['-lc', 'command -v codex']);

    return output.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function isAppServerReachable(origin?: string) {
  if (!origin) {
    return false;
  }

  try {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(800)
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function getCodexStatus(): Promise<CodexStatusResult> {
  const codexHome = resolveCodexHome();
  const appPaths = ['/Applications/Codex.app', join(homedir(), 'Applications', 'Codex.app')];
  const appPath = appPaths.find((path) => existsSync(path));
  const cliPath = await resolveCodexCliPath();
  const appServerOrigin =
    process.env.PROJECT_SPACE_CODEX_APP_SERVER_URL ?? process.env.CODEX_APP_SERVER_URL;

  return {
    appInstalled: Boolean(appPath),
    appPath,
    appServerOrigin,
    appServerReachable: await isAppServerReachable(appServerOrigin),
    cliAvailable: Boolean(cliPath),
    cliPath,
    codexHome,
    configPath: join(codexHome, 'config.toml'),
    currentThreadId: process.env.CODEX_THREAD_ID,
    skillsPath: join(codexHome, 'skills')
  };
}

export async function openCodexTarget(
  request: CodexOpenRequest
): Promise<OpenPathInAppResult> {
  const status = await getCodexStatus();
  const cwd = resolve(request.cwd);

  if (status.appInstalled) {
    try {
      await runCommand('open', ['-a', 'Codex', cwd]);

      return {
        status: 'success'
      };
    } catch {
      return {
        message: 'Could not open the selected target in Codex.',
        status: 'error'
      };
    }
  }

  if (status.cliAvailable) {
    return {
      message: `Codex CLI is available at ${status.cliPath}. Open a terminal in ${cwd} and run codex.`,
      status: 'success'
    };
  }

  return {
    message: 'Codex is not installed or not visible on PATH.',
    status: 'error'
  };
}
