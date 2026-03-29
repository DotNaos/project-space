import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CreateGithubIdeaFromDraftRequest,
  GithubIdeaMutationResult,
  GithubIdeaRecord,
  ListGithubIdeasRequest,
  UpdateGithubIdeaRequest
} from '../../../../src/shared/electron-api';
import { loadProjectIssueSourceConfig } from './project-issue-source-config';

const execFileAsync = promisify(execFile);
const metadataMarker = '<!-- project-space-idea-meta';
const iterationLabelPrefix = 'iteration:';

interface GithubIssueJson {
  body: string;
  createdAt: string;
  labels: Array<{ name?: string }>;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'open' | 'closed';
  title: string;
  updatedAt: string;
  url: string;
}

interface IdeaMetadata {
  evolvesIdeaId?: string;
  id: string;
}

function getCommandErrorMessage(error: unknown, fallback: string) {
  if (typeof error === 'object' && error && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim();

    if (stderr) {
      return stderr;
    }
  }

  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
    const message = error.message.trim();

    if (message) {
      return message;
    }
  }

  return fallback;
}

function buildIterationLabel(iteration: string) {
  const normalizedIteration = iteration.trim();

  return normalizedIteration ? `${iterationLabelPrefix}${normalizedIteration}` : '';
}

function buildIssueBody({
  body,
  evolvesIdeaId,
  id
}: {
  body: string;
  evolvesIdeaId?: string;
  id: string;
}) {
  const metadata = JSON.stringify({
    evolvesIdeaId: evolvesIdeaId ?? null,
    id
  });
  const visibleBody = body.trim();
  const metadataBlock = `${metadataMarker}\n${metadata}\n-->`;

  return visibleBody ? `${visibleBody}\n\n${metadataBlock}` : metadataBlock;
}

function extractIdeaMetadata(body: string): {
  metadata: IdeaMetadata;
  visibleBody: string;
} {
  const match = body.match(/(?:\n{0,2})<!-- project-space-idea-meta\n([\s\S]*?)\n-->\s*$/);

  if (!match) {
    return {
      metadata: {
        id: ''
      },
      visibleBody: body.trim()
    };
  }

  const [, metadataJson] = match;
  let parsedMetadata: Partial<IdeaMetadata> = {};

  try {
    parsedMetadata = JSON.parse(metadataJson) as Partial<IdeaMetadata>;
  } catch {
    parsedMetadata = {};
  }

  return {
    metadata: {
      evolvesIdeaId:
        typeof parsedMetadata.evolvesIdeaId === 'string' && parsedMetadata.evolvesIdeaId.trim()
          ? parsedMetadata.evolvesIdeaId
          : undefined,
      id: typeof parsedMetadata.id === 'string' ? parsedMetadata.id : ''
    },
    visibleBody: body.slice(0, match.index).trim()
  };
}

function mapGithubIssue(issue: GithubIssueJson): GithubIdeaRecord {
  const labelNames = issue.labels
    .map((label) => label.name?.trim() || '')
    .filter(Boolean);
  const iterationLabel = labelNames.find((label) => label.startsWith(iterationLabelPrefix)) ?? '';
  const { metadata, visibleBody } = extractIdeaMetadata(issue.body);

  return {
    body: visibleBody,
    createdAt: issue.createdAt,
    evolvesIdeaId: metadata.evolvesIdeaId,
    githubIssueNumber: issue.number,
    githubIssueUrl: issue.url,
    githubLabels: labelNames,
    githubState: issue.state.toLowerCase() === 'closed' ? 'closed' : 'open',
    id: metadata.id || `github:${issue.number}`,
    iteration: iterationLabel.slice(iterationLabelPrefix.length),
    source: 'github',
    title: issue.title,
    updatedAt: issue.updatedAt
  };
}

function getGithubRepoRef(url: string) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);

  return match?.[1] ?? '';
}

async function runGhCommand(args: string[], repoRef: string) {
  const { stdout } = await execFileAsync('gh', args, {
    windowsHide: true
  });

  return stdout.trim();
}

async function resolveGithubRepoRef(projectPath: string) {
  const config = await loadProjectIssueSourceConfig(projectPath);

  if (config.kind !== 'github' || !config.url) {
    return '';
  }

  const repoRef = getGithubRepoRef(config.url);

  if (!repoRef) {
    throw new Error('The configured GitHub repository URL is invalid.');
  }

  return repoRef;
}

async function ensureIterationLabel(repoRef: string, iteration: string) {
  const labelName = buildIterationLabel(iteration);

  if (!labelName) {
    return '';
  }

  await runGhCommand([
    'label',
    'create',
    labelName,
    '--color',
    '4F46E5',
    '--description',
    'Iteration planning label managed by Project Space',
    '-R',
    repoRef,
    '--force'
  ], repoRef);

  return labelName;
}

async function fetchGithubIdea(repoRef: string, issueReference: string) {
  const output = await runGhCommand([
    'issue',
    'view',
    issueReference,
    '--json',
    'number,title,body,url,state,labels,createdAt,updatedAt',
    '-R',
    repoRef
  ], repoRef);

  return mapGithubIssue(JSON.parse(output) as GithubIssueJson);
}

export async function listGithubIdeas({
  includeClosed,
  projectPath
}: ListGithubIdeasRequest): Promise<GithubIdeaRecord[]> {
  const repoRef = await resolveGithubRepoRef(projectPath);

  if (!repoRef) {
    return [];
  }

  const output = await runGhCommand([
    'issue',
    'list',
    '--state',
    includeClosed ? 'all' : 'open',
    '--limit',
    '200',
    '--json',
    'number,title,body,url,state,labels,createdAt,updatedAt',
    '-R',
    repoRef
  ], repoRef);
  const issues = JSON.parse(output) as GithubIssueJson[];

  return issues.map(mapGithubIssue).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createGithubIdeaFromDraft({
  draft,
  projectPath
}: CreateGithubIdeaFromDraftRequest): Promise<GithubIdeaMutationResult> {
  if (!draft.title.trim()) {
    return {
      message: 'Add a title before publishing an idea to GitHub.',
      status: 'error'
    };
  }

  try {
    const repoRef = await resolveGithubRepoRef(projectPath);

    if (!repoRef) {
      throw new Error('This project is not configured to use GitHub issues.');
    }

    const iterationLabel = await ensureIterationLabel(repoRef, draft.iteration);
    const args = [
      'issue',
      'create',
      '--title',
      draft.title.trim(),
      '--body',
      buildIssueBody(draft),
      '-R',
      repoRef
    ];

    if (iterationLabel) {
      args.push('--label', iterationLabel);
    }

    const createdUrl = await runGhCommand(args, repoRef);
    const idea = await fetchGithubIdea(repoRef, createdUrl);

    return {
      idea,
      status: 'success'
    };
  } catch (error) {
    return {
      message: getCommandErrorMessage(error, 'Could not create the GitHub issue.'),
      status: 'error'
    };
  }
}

export async function updateGithubIdea({
  idea,
  projectPath
}: UpdateGithubIdeaRequest): Promise<GithubIdeaMutationResult> {
  if (!idea.title.trim()) {
    return {
      message: 'GitHub issues need a title.',
      status: 'error'
    };
  }

  try {
    const repoRef = await resolveGithubRepoRef(projectPath);

    if (!repoRef) {
      throw new Error('This project is not configured to use GitHub issues.');
    }

    const currentIdea = await fetchGithubIdea(repoRef, String(idea.githubIssueNumber));
    const iterationLabel = await ensureIterationLabel(repoRef, idea.iteration);
    const currentIterationLabels = idea.githubLabels.filter((label) =>
      label.startsWith(iterationLabelPrefix)
    );
    const args = [
      'issue',
      'edit',
      String(idea.githubIssueNumber),
      '--title',
      idea.title.trim(),
      '--body',
      buildIssueBody(idea),
      '-R',
      repoRef
    ];

    for (const label of currentIterationLabels) {
      if (label !== iterationLabel) {
        args.push('--remove-label', label);
      }
    }

    if (iterationLabel && !currentIterationLabels.includes(iterationLabel)) {
      args.push('--add-label', iterationLabel);
    }

    await runGhCommand(args, repoRef);

    if (currentIdea.githubState !== idea.githubState) {
      await runGhCommand(
        [
          'issue',
          idea.githubState === 'closed' ? 'close' : 'reopen',
          String(idea.githubIssueNumber),
          '-R',
          repoRef
        ],
        repoRef
      );
    }

    const nextIdea = await fetchGithubIdea(repoRef, String(idea.githubIssueNumber));

    return {
      idea: nextIdea,
      status: 'success'
    };
  } catch (error) {
    return {
      message: getCommandErrorMessage(error, 'Could not update the GitHub issue.'),
      status: 'error'
    };
  }
}
