import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AppMeta } from '../src/shared/project-space-api';
import { pullRequestPreviewMetadataFromBuild } from './pr-preview-build-identity';

const execFileAsync = promisify(execFile);

interface PackageJson {
  name?: string;
  version?: string;
}

export async function readAppMeta(): Promise<AppMeta> {
  const [packageJson, gitCommit, gitBranch, gitReleaseTag] = await Promise.all([
    readPackageJson(),
    envOrGit('PROJECT_SPACE_BUILD_COMMIT', ['rev-parse', 'HEAD']),
    envOrGit('PROJECT_SPACE_BUILD_REF', ['branch', '--show-current']),
    gitValue(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'])
  ]);
  const commit = gitCommit || undefined;
  const preview = pullRequestPreviewMetadataFromBuild(
    process.env,
    commit
  );

  return {
    buildTime: process.env.PROJECT_SPACE_BUILD_TIME || undefined,
    commit,
    commitShort: commit?.slice(0, 8),
    environment: process.env.PROJECT_ENV || process.env.NODE_ENV || undefined,
    name: process.env.PROJECT_SPACE_BUILD_NAME || packageJson.name || 'project-space',
    nodeVersion: process.version,
    platform: process.platform,
    ...(preview ? { preview } : {}),
    ref: gitBranch || undefined,
    version: resolveAppVersion({
      buildVersion: process.env.PROJECT_SPACE_BUILD_VERSION,
      gitReleaseTag,
      packageVersion: packageJson.version
    })
  };
}

export function resolveAppVersion(input: {
  buildVersion?: string;
  gitReleaseTag?: string;
  packageVersion?: string;
}) {
  const buildVersion = input.buildVersion?.trim();
  if (buildVersion) return buildVersion;

  const releaseVersion = input.gitReleaseTag?.trim().match(
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
  )?.[1];
  if (releaseVersion) return releaseVersion;

  return input.packageVersion?.trim() || 'unknown';
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

  return gitValue(gitArgs);
}

async function gitValue(gitArgs: string[]) {
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
