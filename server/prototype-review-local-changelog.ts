import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';
import type { ReleaseEntry } from '../apps/docs/lib/releases/types';
import {
  prototypeReviewChecklist,
  prototypeReviewLocalChangelogSchema,
  type PrototypeReviewChecklistItem,
  type PrototypeReviewLocalChangelogSnapshot,
  type PrototypeReviewReleaseEntryState,
  type SavePrototypeReviewChecklistRequest
} from '../src/shared/prototype-review-local-changelog-api';
import { readJson, writeJson } from './project-space-http-response';

const routePath = '/api/prototype-review/local-changelog';
const checklistSchema = 'project-space.prototype-preview-review/v1';
const execFileAsync = promisify(execFile);

interface WorkspaceIdentity {
  branchName: string;
  headSha: string;
  issueNumber?: number;
  repositoryFullName: string;
}

interface StoredChecklist {
  items: PrototypeReviewChecklistItem[];
  savedAt: string;
  schema: typeof checklistSchema;
}

export function createPrototypeReviewLocalChangelogHandler(repositoryRoot: string) {
  return async function handlePrototypeReviewLocalChangelog(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== routePath) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (url.search) {
      writeJson(response, 400, { error: 'Query parameters are not supported.' });
      return true;
    }
    try {
      if (request.method === 'GET') {
        writeJson(response, 200, await readSnapshot(repositoryRoot));
        return true;
      }
      if (request.method === 'PUT') {
        const items = parseChecklistRequest(await readJson<unknown>(request));
        const snapshot = await readSnapshot(repositoryRoot);
        validatePreviewItems(items);
        await saveChecklist(repositoryRoot, snapshot.branchName, items);
        writeJson(response, 200, await readSnapshot(repositoryRoot));
        return true;
      }
      response.setHeader('Allow', 'GET, PUT');
      writeJson(response, 405, { error: 'Method not allowed.' });
      return true;
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : 'The Preview review could not be saved.'
      });
      return true;
    }
  };
}

async function readSnapshot(
  repositoryRoot: string
): Promise<PrototypeReviewLocalChangelogSnapshot> {
  const workspace = await readWorkspaceIdentity(repositoryRoot);
  if (!workspace) {
    throw new Error('The current repository checkout could not be identified.');
  }
  const pullRequest = await discoverPullRequest(workspace);
  const entry = pullRequest.state === 'unavailable'
    ? pullRequest
    : await readReleaseEntry(repositoryRoot, pullRequest.pullRequestNumber);
  const storagePath = checklistPath(repositoryRoot, workspace.branchName);
  const stored = await readChecklist(storagePath);
  const items = prototypeReviewChecklist(stored?.items);

  return {
    ...workspace,
    checkedAt: new Date().toISOString(),
    entry,
    ...(pullRequest.state === 'available'
      ? { pullRequestNumber: pullRequest.pullRequestNumber }
      : {}),
    review: {
      items,
      ...(stored?.savedAt ? { savedAt: stored.savedAt } : {}),
      storagePath: relative(repositoryRoot, storagePath),
      writable: true
    },
    schema: prototypeReviewLocalChangelogSchema
  };
}

async function readWorkspaceIdentity(
  repositoryRoot: string
): Promise<WorkspaceIdentity | undefined> {
  try {
    const options = {
      cwd: repositoryRoot,
      encoding: 'utf8' as const,
      maxBuffer: 64 * 1024,
      timeout: 5_000
    };
    const [{ stdout: head }, { stdout: branch }, { stdout: remote }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], options),
      execFileAsync('git', ['branch', '--show-current'], options),
      execFileAsync('git', ['remote', 'get-url', 'origin'], options)
    ]);
    const headSha = String(head).trim().toLowerCase();
    const branchName = String(branch).trim();
    const repositoryFullName = githubRepositoryFullName(String(remote).trim());
    if (!/^[0-9a-f]{40}$/.test(headSha) || !branchName || !repositoryFullName) {
      return undefined;
    }
    const issue = /(?:^|\/)issue-(\d+)(?:-|$)/.exec(branchName)?.[1];
    return {
      branchName,
      headSha,
      ...(issue ? { issueNumber: Number(issue) } : {}),
      repositoryFullName
    };
  } catch {
    return undefined;
  }
}

async function discoverPullRequest(workspace: WorkspaceIdentity): Promise<
  | { pullRequestNumber?: undefined; state: 'missing' }
  | { pullRequestNumber: number; state: 'available' }
  | Extract<PrototypeReviewReleaseEntryState, { state: 'unavailable' }>
> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr',
      'list',
      '--repo',
      workspace.repositoryFullName,
      '--head',
      workspace.branchName,
      '--state',
      'open',
      '--limit',
      '2',
      '--json',
      'number'
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 8_000
    });
    const parsed: unknown = JSON.parse(String(stdout));
    if (!Array.isArray(parsed) || parsed.length === 0) return { state: 'missing' };
    const number = (parsed[0] as { number?: unknown }).number;
    return Number.isSafeInteger(number) && Number(number) > 0
      ? { pullRequestNumber: Number(number), state: 'available' }
      : { reason: 'pr-discovery-unavailable', state: 'unavailable' };
  } catch {
    return { reason: 'pr-discovery-unavailable', state: 'unavailable' };
  }
}

async function readReleaseEntry(
  repositoryRoot: string,
  pullRequestNumber: number | undefined
): Promise<PrototypeReviewReleaseEntryState> {
  if (!pullRequestNumber) {
    return { reason: 'no-pull-request', state: 'missing' };
  }
  const relativePath = `apps/docs/content/docs/releases/entries/${pullRequestNumber}.mdx`;
  let source: string;
  try {
    source = await readFile(join(repositoryRoot, relativePath), 'utf8');
  } catch {
    return { path: relativePath, reason: 'no-entry', state: 'missing' };
  }
  const parsed = parseReleaseEntryMdx(source, `${pullRequestNumber}.mdx`);
  if (!parsed.ok) {
    return { errors: parsed.errors, path: relativePath, state: 'invalid' };
  }
  return { entry: releaseEntryDto(parsed.entry, relativePath), state: 'available' };
}

function releaseEntryDto(entry: ReleaseEntry, path: string) {
  return {
    areas: entry.areas,
    breakingChanges: entry.breakingChanges,
    changes: entry.changes,
    issues: entry.issues,
    path,
    previewTests: entry.previewTests,
    pullRequest: entry.pullRequest,
    summary: entry.summary,
    title: entry.title,
    upgrade: entry.upgrade,
    upgradeNotes: entry.upgradeNotes,
    version: entry.version
  };
}

function checklistPath(repositoryRoot: string, branchName: string) {
  const safeBranch = branchName
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 96) || 'checkout';
  return join(repositoryRoot, '.project-space', 'prototype-review', `${safeBranch}.json`);
}

async function readChecklist(path: string): Promise<StoredChecklist | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Partial<StoredChecklist>;
    if (
      record.schema !== checklistSchema ||
      typeof record.savedAt !== 'string' ||
      !Array.isArray(record.items)
    ) return undefined;
    return {
      items: parseChecklistItems(record.items),
      savedAt: record.savedAt,
      schema: checklistSchema
    };
  } catch {
    return undefined;
  }
}

async function saveChecklist(
  repositoryRoot: string,
  branchName: string,
  items: readonly PrototypeReviewChecklistItem[]
) {
  const path = checklistPath(repositoryRoot, branchName);
  await mkdir(join(repositoryRoot, '.project-space', 'prototype-review'), {
    mode: 0o700,
    recursive: true
  });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const saved: StoredChecklist = {
    items: [...items],
    savedAt: new Date().toISOString(),
    schema: checklistSchema
  };
  await writeFile(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

function parseChecklistRequest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Preview review payload is invalid.');
  }
  const record = value as Partial<SavePrototypeReviewChecklistRequest>;
  if (!Array.isArray(record.items)) {
    throw new Error('The Preview review payload is invalid.');
  }
  return parseChecklistItems(record.items);
}

function parseChecklistItems(value: readonly unknown[]) {
  if (value.length !== prototypeReviewChecklist().length) {
    throw new Error('The Preview review must contain every Preview.');
  }
  const items = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('The Preview review contains an invalid item.');
    }
    const item = candidate as Partial<PrototypeReviewChecklistItem>;
    if (
      typeof item.id !== 'string' ||
      typeof item.label !== 'string' ||
      typeof item.reviewed !== 'boolean'
    ) {
      throw new Error('The Preview review contains an invalid item.');
    }
    return { id: item.id, label: item.label, reviewed: item.reviewed } as PrototypeReviewChecklistItem;
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('The Preview review contains duplicate items.');
  }
  return items;
}

function validatePreviewItems(
  items: readonly PrototypeReviewChecklistItem[]
) {
  if (JSON.stringify(items) !== JSON.stringify(prototypeReviewChecklist(items))) {
    throw new Error('The Preview review does not match the available Previews.');
  }
}

function githubRepositoryFullName(remote: string) {
  const match = remote.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}
