import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, join } from 'node:path';

import type {
  DeleteLocalIdeaDraftRequest,
  ExportIdeasToWorktreeRequest,
  GithubIdeaRecord,
  IdeaRecord,
  LocalIdeaDraftRecord,
  MoveIdeaToWorktreeRequest,
  SaveLocalIdeaDraftRequest
} from '../../../../src/shared/electron-api';

const frontmatterFence = '---';
const ideaDivider = '\n\n<!-- project-space-idea-divider -->\n\n';
const projectInboxFileName = 'IDEAS.md';
const worktreeExportFileName = 'WORKTREE-IDEAS.md';

const seedIdeaTemplates = [
  {
    body:
      'Capture rough ideas locally first, then publish them to GitHub as soon as they have a working title.',
    iteration: 'Iteration 1',
    title: 'Ideas inbox with early GitHub capture'
  },
  {
    body:
      'Let a worktree start from a small bundle of ready ideas so the execution branch carries a focused slice of planned work.',
    iteration: 'Iteration 1',
    title: 'Worktree planning from selected ideas'
  },
  {
    body:
      'Keep a visible chain from an original feature idea to the follow-up ideas that refine or extend it later.',
    iteration: 'Iteration 1',
    title: 'Feature lineage as living documentation'
  }
] as const;

interface ParsedFrontmatter {
  [key: string]: unknown;
}

function getProjectDevDirectory(projectPath: string) {
  return join(projectPath, '.dev');
}

function getProjectInboxPath(projectPath: string) {
  return join(getProjectDevDirectory(projectPath), projectInboxFileName);
}

function getWorktreeExportPath(worktreePath: string) {
  return join(worktreePath, '.dev', worktreeExportFileName);
}

function ensureDevDirectory(projectPath: string) {
  mkdirSync(getProjectDevDirectory(projectPath), { recursive: true });
}

function ensureWorktreeDevDirectory(worktreePath: string) {
  mkdirSync(join(worktreePath, '.dev'), { recursive: true });
}

function parseFrontmatter(frontmatter: string): ParsedFrontmatter {
  return frontmatter.split('\n').reduce<ParsedFrontmatter>((parsed, line) => {
    const separatorIndex = line.indexOf(':');

    if (separatorIndex <= 0) {
      return parsed;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (!key || !rawValue) {
      return parsed;
    }

    try {
      parsed[key] = JSON.parse(rawValue);
    } catch {
      parsed[key] = rawValue;
    }

    return parsed;
  }, {});
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizeDateString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function parseLocalDraftBlock(block: string): LocalIdeaDraftRecord | null {
  const match = block.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return null;
  }

  const [, frontmatterContent, bodyContent] = match;
  const frontmatter = parseFrontmatter(frontmatterContent);
  const now = new Date().toISOString();

  return {
    body: bodyContent.trim(),
    createdAt: normalizeDateString(frontmatter.createdAt, now),
    evolvesIdeaId: normalizeOptionalString(frontmatter.evolvesIdeaId),
    id: normalizeString(frontmatter.id) || randomUUID(),
    iteration: normalizeString(frontmatter.iteration),
    source: 'local',
    title: normalizeString(frontmatter.title),
    updatedAt: normalizeDateString(frontmatter.updatedAt, now)
  };
}

function serializeFrontmatter(record: Record<string, unknown>) {
  const lines = Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);

  return `${frontmatterFence}\n${lines.join('\n')}\n${frontmatterFence}`;
}

function serializeLocalDraft(record: LocalIdeaDraftRecord) {
  const frontmatter = serializeFrontmatter({
    createdAt: record.createdAt,
    evolvesIdeaId: record.evolvesIdeaId,
    id: record.id,
    iteration: record.iteration,
    title: record.title,
    updatedAt: record.updatedAt
  });

  return `${frontmatter}\n${record.body.trim()}`;
}

function serializeWorktreeIdea(record: IdeaRecord, exportedAt: string) {
  const frontmatter = serializeFrontmatter(
    record.source === 'github'
      ? {
          evolvesIdeaId: record.evolvesIdeaId,
          exportedAt,
          githubIssueNumber: record.githubIssueNumber,
          githubIssueUrl: record.githubIssueUrl,
          id: record.id,
          iteration: record.iteration,
          source: record.source,
          title: record.title
        }
      : {
          evolvesIdeaId: record.evolvesIdeaId,
          exportedAt,
          id: record.id,
          iteration: record.iteration,
          source: record.source,
          title: record.title
        }
  );

  return `${frontmatter}\n${record.body.trim()}`;
}

type StoredWorktreeIdea =
  | (LocalIdeaDraftRecord & {
      exportedAt?: string;
    })
  | (GithubIdeaRecord & {
      exportedAt?: string;
    });

function parseWorktreeIdeaIds(content: string) {
  if (!content.trim()) {
    return [];
  }

  const ideaIds = content
    .split(ideaDivider)
    .map((block) => {
      const match = block.trim().match(/^---\n([\s\S]*?)\n---/);

      if (!match) {
        return '';
      }

      const frontmatter = parseFrontmatter(match[1]);
      return normalizeString(frontmatter.id);
    })
    .filter(Boolean);

  return [...new Set(ideaIds)];
}

function parseWorktreeIdeaBlock(block: string): StoredWorktreeIdea | null {
  const match = block.trim().match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return null;
  }

  const [, frontmatterContent, bodyContent] = match;
  const frontmatter = parseFrontmatter(frontmatterContent);
  const githubIssueNumber = Number(frontmatter.githubIssueNumber);
  const githubIssueUrl = normalizeString(frontmatter.githubIssueUrl);
  const id = normalizeString(frontmatter.id);
  const source = normalizeString(frontmatter.source) === 'local' ? 'local' : 'github';

  if (!id) {
    return null;
  }

  if (source === 'local' || (!Number.isFinite(githubIssueNumber) && !githubIssueUrl)) {
    return {
      body: bodyContent.trim(),
      createdAt: normalizeOptionalString(frontmatter.exportedAt) ?? new Date().toISOString(),
      evolvesIdeaId: normalizeOptionalString(frontmatter.evolvesIdeaId),
      exportedAt: normalizeOptionalString(frontmatter.exportedAt),
      id,
      iteration: normalizeString(frontmatter.iteration),
      source: 'local',
      title: normalizeString(frontmatter.title),
      updatedAt: normalizeOptionalString(frontmatter.exportedAt) ?? new Date().toISOString()
    };
  }

  if (!Number.isFinite(githubIssueNumber) || !githubIssueUrl) {
    return null;
  }

  return {
    body: bodyContent.trim(),
    createdAt: normalizeOptionalString(frontmatter.exportedAt) ?? new Date().toISOString(),
    evolvesIdeaId: normalizeOptionalString(frontmatter.evolvesIdeaId),
    exportedAt: normalizeOptionalString(frontmatter.exportedAt),
    githubIssueNumber,
    githubIssueUrl,
    githubLabels: [],
    githubState: 'open',
    id,
    iteration: normalizeString(frontmatter.iteration),
    source: 'github',
    title: normalizeString(frontmatter.title),
    updatedAt: normalizeOptionalString(frontmatter.exportedAt) ?? new Date().toISOString()
  };
}

function readWorktreeIdeas(worktreePath: string): StoredWorktreeIdea[] {
  const exportPath = getWorktreeExportPath(worktreePath);

  if (!existsSync(exportPath)) {
    return [];
  }

  const content = readFileSync(exportPath, 'utf-8').trim();

  if (!content) {
    return [];
  }

  return content
    .split(ideaDivider)
    .map((block) => parseWorktreeIdeaBlock(block))
    .filter((idea): idea is StoredWorktreeIdea => Boolean(idea));
}

function writeWorktreeIdeas(worktreePath: string, ideas: StoredWorktreeIdea[]) {
  const exportPath = getWorktreeExportPath(worktreePath);

  if (ideas.length === 0) {
    if (existsSync(exportPath)) {
      rmSync(exportPath);
    }

    return;
  }

  ensureWorktreeDevDirectory(worktreePath);

  const serialized = ideas
    .map((idea) =>
      serializeWorktreeIdea(
        idea.source === 'github'
          ? {
              body: idea.body,
              createdAt: idea.createdAt,
              evolvesIdeaId: idea.evolvesIdeaId,
              githubIssueNumber: idea.githubIssueNumber,
              githubIssueUrl: idea.githubIssueUrl,
              githubLabels: idea.githubLabels ?? [],
              githubState: idea.githubState ?? 'open',
              id: idea.id,
              iteration: idea.iteration,
              source: 'github',
              title: idea.title,
              updatedAt: idea.updatedAt
            }
          : {
              body: idea.body,
              createdAt: idea.createdAt,
              evolvesIdeaId: idea.evolvesIdeaId,
              id: idea.id,
              iteration: idea.iteration,
              source: 'local',
              title: idea.title,
              updatedAt: idea.updatedAt
            },
        idea.exportedAt ?? new Date().toISOString()
      )
    )
    .join(ideaDivider);

  writeFileSync(exportPath, `${serialized}\n`, 'utf-8');
}

function writeLocalDrafts(projectPath: string, drafts: LocalIdeaDraftRecord[]) {
  const inboxPath = getProjectInboxPath(projectPath);

  if (drafts.length === 0) {
    if (existsSync(inboxPath)) {
      rmSync(inboxPath);
    }

    return;
  }

  ensureDevDirectory(projectPath);

  const serialized = drafts
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(serializeLocalDraft)
    .join(ideaDivider);

  writeFileSync(inboxPath, `${serialized}\n`, 'utf-8');
}

function createSeedDrafts(projectPath: string): LocalIdeaDraftRecord[] {
  const now = new Date().toISOString();
  const projectName = basename(projectPath);

  return seedIdeaTemplates.map((template, index) => ({
    body: `${template.body}\n\nSeeded for ${projectName} so the backlog is immediately usable.`,
    createdAt: now,
    id: randomUUID(),
    iteration: template.iteration,
    source: 'local',
    title: template.title,
    updatedAt: now
  }));
}

function shouldSeedProjectInbox(projectPath: string) {
  return basename(projectPath) === 'project-space';
}

export function loadLocalIdeaDrafts(projectPath: string): LocalIdeaDraftRecord[] {
  return readLocalIdeaDrafts(projectPath, {
    seedWhenMissing: shouldSeedProjectInbox(projectPath)
  });
}

function readLocalIdeaDrafts(
  projectPath: string,
  options: {
    seedWhenMissing: boolean;
  }
): LocalIdeaDraftRecord[] {
  const inboxPath = getProjectInboxPath(projectPath);

  if (!existsSync(inboxPath)) {
    if (!options.seedWhenMissing) {
      return [];
    }

    const seededDrafts = createSeedDrafts(projectPath);
    writeLocalDrafts(projectPath, seededDrafts);

    return seededDrafts;
  }

  const content = readFileSync(inboxPath, 'utf-8').trim();

  if (!content) {
    return [];
  }

  return content
    .split(ideaDivider)
    .map((block) => parseLocalDraftBlock(block.trim()))
    .filter((draft): draft is LocalIdeaDraftRecord => Boolean(draft))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function saveLocalIdeaDraft({
  draft,
  projectPath
}: SaveLocalIdeaDraftRequest): LocalIdeaDraftRecord {
  const currentDrafts = readLocalIdeaDrafts(projectPath, {
    seedWhenMissing: shouldSeedProjectInbox(projectPath)
  }).filter((entry) => entry.id !== draft.id);
  const now = new Date().toISOString();
  const nextDraft: LocalIdeaDraftRecord = {
    ...draft,
    body: draft.body.trim(),
    createdAt: draft.createdAt || now,
    iteration: draft.iteration.trim(),
    source: 'local',
    title: draft.title.trim(),
    updatedAt: now
  };

  writeLocalDrafts(projectPath, [nextDraft, ...currentDrafts]);

  return nextDraft;
}

export function deleteLocalIdeaDraft({
  ideaId,
  projectPath
}: DeleteLocalIdeaDraftRequest): void {
  const nextDrafts = readLocalIdeaDrafts(projectPath, {
    seedWhenMissing: false
  }).filter((entry) => entry.id !== ideaId);

  writeLocalDrafts(projectPath, nextDrafts);
}

export function exportIdeasToWorktree({
  ideas,
  worktreePath
}: ExportIdeasToWorktreeRequest): void {
  ensureWorktreeDevDirectory(worktreePath);

  const exportedAt = new Date().toISOString();
  const content = ideas.map((idea) => serializeWorktreeIdea(idea, exportedAt)).join(ideaDivider);

  writeFileSync(getWorktreeExportPath(worktreePath), `${content}\n`, 'utf-8');
}

export function loadWorktreeIdeaIds(worktreePath: string): string[] {
  const exportPath = getWorktreeExportPath(worktreePath);

  if (!existsSync(exportPath)) {
    return [];
  }

  return parseWorktreeIdeaIds(readFileSync(exportPath, 'utf-8'));
}

export function moveIdeaToWorktree({
  idea,
  targetWorktreePath,
  worktreePaths
}: MoveIdeaToWorktreeRequest): void {
  const exportedAt = new Date().toISOString();
  const uniqueWorktreePaths = [...new Set(worktreePaths.map((path) => path.trim()).filter(Boolean))];

  for (const worktreePath of uniqueWorktreePaths) {
    const remainingIdeas = readWorktreeIdeas(worktreePath).filter((entry) => entry.id !== idea.id);
    const shouldReceiveIdea = targetWorktreePath === worktreePath;

    if (shouldReceiveIdea) {
      remainingIdeas.push(
        idea.source === 'github'
          ? {
              body: idea.body.trim(),
              createdAt: idea.createdAt,
              evolvesIdeaId: idea.evolvesIdeaId,
              exportedAt,
              githubIssueNumber: idea.githubIssueNumber,
              githubIssueUrl: idea.githubIssueUrl,
              githubLabels: idea.githubLabels ?? [],
              githubState: idea.githubState ?? 'open',
              id: idea.id,
              iteration: idea.iteration.trim(),
              source: 'github',
              title: idea.title.trim(),
              updatedAt: idea.updatedAt
            }
          : {
              body: idea.body.trim(),
              createdAt: idea.createdAt,
              evolvesIdeaId: idea.evolvesIdeaId,
              exportedAt,
              id: idea.id,
              iteration: idea.iteration.trim(),
              source: 'local',
              title: idea.title.trim(),
              updatedAt: idea.updatedAt
            }
      );
    }

    writeWorktreeIdeas(worktreePath, remainingIdeas);
  }
}
