import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

export interface CodexBinaryResolution {
  attempted: string[];
  path?: string;
}

export function resolveCodexBinary(options: {
  environment?: NodeJS.ProcessEnv;
  executable?(path: string): boolean;
  platform?: NodeJS.Platform;
  runtimeExecutable?: string;
  validate?(path: string): boolean;
} = {}): CodexBinaryResolution {
  const environment = options.environment ?? process.env;
  const executable = options.executable ?? isExecutable;
  const validate = options.validate ?? isWorkingCodex;
  const configured = environment.PROJECT_CODEX_CLI_PATH?.trim();
  const attempted: string[] = [];
  const candidates: string[] = [];
  const platform = options.platform ?? process.platform;
  const managedLinux = platform === 'linux' &&
    environment.PROJECT_SPACE_INSTALL_SOURCE === 'managed';
  if (managedLinux) {
    let runtimeExecutable: string;
    try {
      runtimeExecutable = options.runtimeExecutable ?? realpathSync(process.execPath);
    } catch {
      return { attempted: ['managed connector executable (unresolved)'] };
    }
    candidates.push(resolve(dirname(runtimeExecutable), 'codex'));
  } else if (configured) {
    if (!isAbsolute(configured)) return { attempted: ['PROJECT_CODEX_CLI_PATH (not absolute)'] };
    candidates.push(configured);
  } else {
    for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
      candidates.push(resolve(directory, platform === 'win32' ? 'codex.exe' : 'codex'));
    }
    if (platform === 'darwin') {
      candidates.push(
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        '/Applications/Codex.app/Contents/Resources/codex'
      );
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    attempted.push(candidate);
    const safe = options.executable
      ? executable(candidate)
      : managedLinux
        ? isSecureManagedExecutable(candidate)
        : executable(candidate);
    if (!safe) continue;
    const valid = options.validate
      ? validate(candidate)
      : managedLinux
        ? isPinnedManagedCodex(candidate)
        : validate(candidate);
    if (valid) return { attempted, path: candidate };
  }
  return { attempted };
}

function isSecureManagedExecutable(path: string) {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() &&
      (info.mode & 0o111) !== 0 && (info.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function isPinnedManagedCodex(path: string) {
  let version: string;
  try {
    version = readFileSync(resolve(dirname(path), 'CODEX-VERSION'), 'utf8').trim();
  } catch {
    return false;
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
    windowsHide: true
  });
  return result.status === 0 && result.stdout?.trim() === `codex-cli ${version}`;
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
