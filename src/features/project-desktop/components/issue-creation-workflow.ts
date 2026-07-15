import type {
  GitHubIssueCreateRequest,
  GitHubIssueCreationResult,
  GitHubIssueMutationResult,
  GitHubIssueRecord,
  GitHubIssueUpdateRequest
} from '@/shared/project-space-api';
import { bodyWithGitHubIssueCreationMarker } from '../../../shared/github-issue-creation-marker';

export type IssueCreationRecoveryStage =
  | 'attachments'
  | 'finalization'
  | 'labels';

export type IssueCreationWriteCapability = 'denied' | 'unverified';

export interface RepositoryIssueCapabilities {
  attachmentWrite: IssueCreationWriteCapability;
  labelWrite: IssueCreationWriteCapability;
  repositoryKey: string;
}

export interface ScopedCreatedIssue {
  issue: GitHubIssueRecord;
  recoveryBody: string;
  repositoryKey: string;
}

export type IssueCreationWorkflowOutcome =
  | {
      creationState: 'retryable' | 'uncertain';
      error: string;
      status: 'creation-failed';
    }
  | {
      error: string;
      issue: GitHubIssueRecord;
      recoveryBody: string;
      stage: IssueCreationRecoveryStage;
      status: 'created-incomplete';
    }
  | {
      issue: GitHubIssueRecord;
      status: 'complete';
    };

interface IssueAttachmentUploadResult {
  completed: boolean;
  markdown: string;
  persistableMarkdown: string;
}

interface RunIssueCreationWorkflowOptions {
  createIssue(request: GitHubIssueCreateRequest): Promise<GitHubIssueCreationResult>;
  existingIssue?: GitHubIssueRecord | null;
  initialBody: string;
  onRemoteIssue(issue: GitHubIssueRecord): void;
  request: GitHubIssueCreateRequest;
  updateIssue(request: GitHubIssueUpdateRequest): Promise<GitHubIssueMutationResult>;
  uploadAttachments(issueNumber: number): Promise<IssueAttachmentUploadResult>;
}

interface FinishIssueCreationOptions {
  body: string;
  fullName: string;
  issue: GitHubIssueRecord;
  onRemoteIssue(issue: GitHubIssueRecord): void;
  operationId: string;
  updateIssue(request: GitHubIssueUpdateRequest): Promise<GitHubIssueMutationResult>;
}

function resultIssue(result: GitHubIssueMutationResult) {
  return result.status === 'connected' && result.issue ? result.issue : null;
}

function resultError(result: GitHubIssueMutationResult, fallback: string) {
  return result.message?.trim() || fallback;
}

function normalizedLabels(labels: readonly string[] = []) {
  return Array.from(
    new Set(labels.map((label) => label.trim()).filter(Boolean).map((label) => label.toLowerCase()))
  ).sort();
}

export function issueLabelsMatch(
  actual: readonly string[],
  expected: readonly string[] = []
) {
  const normalizedActual = normalizedLabels(actual);
  const normalizedExpected = normalizedLabels(expected);

  return normalizedActual.length === normalizedExpected.length
    && normalizedActual.every((label, index) => label === normalizedExpected[index]);
}

async function attemptMutation(
  mutation: () => Promise<GitHubIssueMutationResult>,
  fallback: string
) {
  try {
    return await mutation();
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : fallback,
      status: 'error' as const
    };
  }
}

async function attemptCreation(
  mutation: () => Promise<GitHubIssueCreationResult>,
  fallback: string
): Promise<GitHubIssueCreationResult> {
  try {
    return await mutation();
  } catch (error) {
    return {
      creationState: 'uncertain',
      message: error instanceof Error ? error.message : fallback,
      status: 'error'
    };
  }
}

export async function runIssueCreationWorkflow({
  createIssue,
  existingIssue,
  initialBody,
  onRemoteIssue,
  request,
  updateIssue,
  uploadAttachments
}: RunIssueCreationWorkflowOptions): Promise<IssueCreationWorkflowOutcome> {
  let issue = existingIssue ?? null;

  if (!issue) {
    const createResult = await attemptCreation(
      () => createIssue({
        body: initialBody,
        fullName: request.fullName,
        operationId: request.operationId,
        title: request.title
      }),
      'Could not create issue.'
    );
    issue = resultIssue(createResult);

    if (!issue) {
      return {
        creationState: createResult.creationState === 'retryable'
          ? 'retryable'
          : 'uncertain',
        error: resultError(createResult, 'Could not create issue.'),
        status: 'creation-failed'
      };
    }
    onRemoteIssue(issue);
  }

  let labelError: string | null = null;
  if (!issueLabelsMatch(issue.labels, request.labels)) {
    const labelResult = await attemptMutation(
      () => updateIssue({
        fullName: request.fullName,
        labels: request.labels ?? [],
        number: issue!.number
      }),
      'Could not apply labels.'
    );
    const labeledIssue = resultIssue(labelResult);

    if (!labeledIssue) {
      labelError = resultError(labelResult, 'Could not apply labels.');
    } else {
      issue = labeledIssue;
      onRemoteIssue(issue);
      if (!issueLabelsMatch(issue.labels, request.labels)) {
        labelError = 'GitHub created the issue but did not apply every selected label.';
      }
    }
  }

  let uploadResult: IssueAttachmentUploadResult;
  try {
    uploadResult = await uploadAttachments(issue.number);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Could not store pasted images.',
      issue,
      recoveryBody: issue.body ?? initialBody,
      stage: 'attachments',
      status: 'created-incomplete'
    };
  }

  if (!uploadResult.completed) {
    return {
      error: 'The issue was created, but one or more pasted images could not be stored.',
      issue,
      recoveryBody: uploadResult.persistableMarkdown,
      stage: 'attachments',
      status: 'created-incomplete'
    };
  }

  if ((issue.body ?? '') !== uploadResult.markdown) {
    const body = bodyWithGitHubIssueCreationMarker(
      uploadResult.markdown,
      request.operationId
    );
    const bodyResult = await attemptMutation(
      () => updateIssue({
        body,
        fullName: request.fullName,
        number: issue!.number
      }),
      'Could not add the stored images to the issue description.'
    );
    const updatedIssue = resultIssue(bodyResult);

    if (!updatedIssue) {
      return {
        error: resultError(
          bodyResult,
          'Could not add the stored images to the issue description.'
        ),
        issue,
        recoveryBody: uploadResult.markdown,
        stage: 'finalization',
        status: 'created-incomplete'
      };
    }
    issue = updatedIssue;
    onRemoteIssue(issue);
  }

  if (labelError) {
    return {
      error: labelError,
      issue,
      recoveryBody: issue.body ?? uploadResult.markdown,
      stage: 'labels',
      status: 'created-incomplete'
    };
  }

  return { issue, status: 'complete' };
}

export async function finishIssueCreationWithAvailableImages({
  body,
  fullName,
  issue,
  onRemoteIssue,
  operationId,
  updateIssue
}: FinishIssueCreationOptions): Promise<IssueCreationWorkflowOutcome> {
  if ((issue.body ?? '') === body) {
    return { issue, status: 'complete' };
  }

  const result = await attemptMutation(
    () => updateIssue({
      body: bodyWithGitHubIssueCreationMarker(body, operationId),
      fullName,
      number: issue.number
    }),
    'Could not finish the issue description.'
  );
  const updatedIssue = resultIssue(result);

  if (!updatedIssue) {
    return {
      error: resultError(result, 'Could not finish the issue description.'),
      issue,
      recoveryBody: body,
      stage: 'finalization',
      status: 'created-incomplete'
    };
  }

  onRemoteIssue(updatedIssue);
  return { issue: updatedIssue, status: 'complete' };
}
