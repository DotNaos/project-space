import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AppMeta } from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);

interface PackageJson {
  name?: string;
  version?: string;
}

export async function readAppMeta(): Promise<AppMeta> {
  const [packageJson, gitCommit, gitBranch] = await Promise.all([
    readPackageJson(),
    envOrGit('PROJECT_SPACE_BUILD_COMMIT', ['rev-parse', 'HEAD']),
    envOrGit('PROJECT_SPACE_BUILD_REF', ['branch', '--show-current'])
  ]);
  const commit = gitCommit || undefined;

  return {
    buildTime: process.env.PROJECT_SPACE_BUILD_TIME || undefined,
    commit,
    commitShort: commit?.slice(0, 8),
    environment: process.env.PROJECT_ENV || process.env.NODE_ENV || undefined,
    name: process.env.PROJECT_SPACE_BUILD_NAME || packageJson.name || 'project-space',
    nodeVersion: process.version,
    platform: process.platform,
    ref: gitBranch || undefined,
    version:
      process.env.PROJECT_SPACE_BUILD_VERSION ||
      packageJson.version ||
      'unknown'
  };
}

async function readPackageJson(): Promise<PackageJson> {
  try {
    return JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

async function envOrGit(envName: string, gitArgs: string[]) {
  const envValue = process.env[envName]?.trim();
  if (envValue) {
    return envValue;
  }

  try {
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd: process.env.PROJECT_SPACE_BACKEND_REPO_PATH || process.cwd(),
      timeout: 1_000
    });
    return stdout.trim();
  } catch {
    return '';
  }
}
