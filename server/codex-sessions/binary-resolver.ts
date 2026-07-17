import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

export interface CodexBinaryResolution {
  attempted: string[];
  path?: string;
}

export function resolveCodexBinary(options: {
  environment?: NodeJS.ProcessEnv;
  executable?(path: string): boolean;
  platform?: NodeJS.Platform;
  validate?(path: string): boolean;
} = {}): CodexBinaryResolution {
  const environment = options.environment ?? process.env;
  const executable = options.executable ?? isExecutable;
  const validate = options.validate ?? isWorkingCodex;
  const configured = environment.PROJECT_CODEX_CLI_PATH?.trim();
  const attempted: string[] = [];
  const candidates: string[] = [];
  if (configured) {
    if (!isAbsolute(configured)) return { attempted: ['PROJECT_CODEX_CLI_PATH (not absolute)'] };
    candidates.push(configured);
  } else {
    for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
      candidates.push(resolve(directory, (options.platform ?? process.platform) === 'win32' ? 'codex.exe' : 'codex'));
    }
    if ((options.platform ?? process.platform) === 'darwin') {
      candidates.push(
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        '/Applications/Codex.app/Contents/Resources/codex'
      );
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    attempted.push(candidate);
    if (executable(candidate) && validate(candidate)) return { attempted, path: candidate };
  }
  return { attempted };
}

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWorkingCodex(path: string) {
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    windowsHide: true
  });
  return result.status === 0 && /^codex-cli\s+\S+/m.test(result.stdout ?? '');
}
