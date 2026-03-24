import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  ProjectIssueSourceConfig,
  SaveProjectIssueSourceConfigRequest
} from '../../../../src/shared/electron-api';

const execFileAsync = promisify(execFile);
const configFileName = 'project-space.json';

interface StoredProjectConfig {
  issueSource?: {
    kind?: string;
    url?: string;
  };
}

function getProjectConfigPath(projectPath: string) {
  return join(projectPath, '.dev', configFileName);
}

function normalizeGithubRepoUrl(remoteUrl: string) {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);

  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}`;
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);

  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return '';
}

async function tryReadGitRemote(path: string) {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: path,
      windowsHide: true
    });

    return normalizeGithubRepoUrl(stdout);
  } catch {
    return '';
  }
}

async function inferGithubRepoUrl(projectPath: string): Promise<string> {
  const directRemote = await tryReadGitRemote(projectPath);

  if (directRemote) {
    return directRemote;
  }

  const entries = await readdir(projectPath, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    const candidateRemote = await tryReadGitRemote(join(projectPath, entry.name));

    if (candidateRemote) {
      return candidateRemote;
    }
  }

  return '';
}

export async function loadProjectIssueSourceConfig(
  projectPath: string
): Promise<ProjectIssueSourceConfig> {
  const configPath = getProjectConfigPath(projectPath);

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as StoredProjectConfig;
      const kind = parsed.issueSource?.kind;
      const url = parsed.issueSource?.url?.trim() ?? '';

      if ((kind === 'github' || kind === 'azure-devops') && url) {
        return {
          kind,
          source: 'saved',
          url
        };
      }
    } catch {
      return {
        kind: 'unconfigured',
        source: 'unconfigured',
        url: ''
      };
    }
  }

  const githubUrl = await inferGithubRepoUrl(projectPath);

  if (githubUrl) {
    return {
      kind: 'github',
      source: 'inferred',
      url: githubUrl
    };
  }

  return {
    kind: 'unconfigured',
    source: 'unconfigured',
    url: ''
  };
}

export async function saveProjectIssueSourceConfig({
  config,
  projectPath
}: SaveProjectIssueSourceConfigRequest): Promise<ProjectIssueSourceConfig> {
  mkdirSync(join(projectPath, '.dev'), { recursive: true });

  writeFileSync(
    getProjectConfigPath(projectPath),
    JSON.stringify(
      {
        issueSource: {
          kind: config.kind,
          url: config.url.trim()
        }
      },
      null,
      2
    ),
    'utf-8'
  );

  return {
    kind: config.kind,
    source: 'saved',
    url: config.url.trim()
  };
}
