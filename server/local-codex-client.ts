import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCommand } from './local-command-runner';
import {
  loadCodexAppServerModels,
  runCodexAppServerChat,
  type CodexChatRuntime,
  type CodexChatStreamEmitter
} from './local-codex-app-server-client';
import { resolveCodexBinary } from './codex-sessions/binary-resolver';
import type {
  CodexChatRequest,
  CodexChatResult,
  CodexOpenRequest,
  CodexModelCatalogueRequest,
  CodexModelCatalogueResult,
  CodexStatusResult,
  OpenPathInAppResult
} from '../src/shared/project-space-api';

function resolveCodexHome() {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export async function resolveCodexCliPath(
  options: Parameters<typeof resolveCodexBinary>[0] = {}
) {
  const environment = options.environment ?? process.env;
  const legacyOverride = environment.PROJECT_SPACE_CODEX_CLI?.trim();
  return resolveCodexBinary({
    ...options,
    environment: legacyOverride && !environment.PROJECT_CODEX_CLI_PATH
      ? { ...environment, PROJECT_CODEX_CLI_PATH: legacyOverride }
      : environment
  }).path;
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

async function copyPromptToClipboard(prompt?: string) {
  if (!prompt?.trim()) {
    return false;
  }

  return new Promise<boolean>((resolveCopy) => {
    const child = spawn('pbcopy', [], {
      env: process.env,
      windowsHide: true
    });

    child.on('error', () => resolveCopy(false));
    child.on('close', (exitCode) => resolveCopy(exitCode === 0));
    child.stdin.end(prompt);
  });
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

export async function runCodexChat(
  request: CodexChatRequest,
  runtime?: CodexChatRuntime
): Promise<CodexChatResult> {
  const cwd = resolve(request.cwd);
  const codexCliPath = runtime ? undefined : await resolveCodexCliPath();

  if (!runtime && !codexCliPath) {
    return {
      message: 'Codex CLI is not available on this machine.',
      status: 'error'
    };
  }

  return runCodexAppServerChat({
    codexCliPath,
    codexHome: resolveCodexHome(),
    request: { ...request, cwd },
    runtime
  });
}

export async function getCodexModels(
  request: CodexModelCatalogueRequest,
  runtime?: CodexChatRuntime
): Promise<CodexModelCatalogueResult> {
  const cwd = resolve(request.cwd);
  const codexCliPath = runtime ? undefined : await resolveCodexCliPath();

  if (!runtime && !codexCliPath) {
    return {
      message: 'Codex CLI is not available on this machine.',
      models: [],
      status: 'error'
    };
  }

  return loadCodexAppServerModels({
    codexCliPath,
    codexHome: resolveCodexHome(),
    cwd,
    runtime
  });
}

export async function streamCodexChat(
  request: CodexChatRequest,
  emit: CodexChatStreamEmitter,
  runtime?: CodexChatRuntime,
  signal?: AbortSignal
) {
  const cwd = resolve(request.cwd);
  const codexCliPath = runtime ? undefined : await resolveCodexCliPath();

  if (!runtime && !codexCliPath) {
    emit({ message: 'Codex CLI is not available on this machine.', type: 'error' });
    return;
  }

  const result = await runCodexAppServerChat({
    codexCliPath,
    codexHome: resolveCodexHome(),
    emit,
    request: { ...request, cwd },
    runtime,
    signal
  });

  if (result.status === 'success' && result.response) {
    emit({ response: result.response, type: 'done' });
    return;
  }

  emit({ message: result.message ?? 'Codex chat failed.', type: 'error' });
}

export async function openCodexTarget(
  request: CodexOpenRequest
): Promise<OpenPathInAppResult> {
  const status = await getCodexStatus();
  const cwd = resolve(request.cwd);
  const promptCopied = await copyPromptToClipboard(request.prompt);

  if (status.appInstalled) {
    try {
      await runCommand('open', ['-a', 'Codex', cwd]);

      return {
        message: promptCopied
          ? 'Codex opened. The repair prompt was copied to the clipboard.'
          : undefined,
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
      message: promptCopied
        ? `Codex CLI is available at ${status.cliPath}. Open a terminal in ${cwd}, run codex, and paste the copied repair prompt.`
        : `Codex CLI is available at ${status.cliPath}. Open a terminal in ${cwd} and run codex.`,
      status: 'success'
    };
  }

  return {
    message: 'Codex is not installed or not visible on PATH.',
    status: 'error'
  };
}
