import type {
  GitHubIssueMutationResult,
  GitHubIssueRecord
} from '@/shared/project-space-api';
import type { IssueColumnId } from './issue-board-model';

export type IssueBoardMoveResult =
  | { issue?: GitHubIssueRecord; state: 'ready' }
  | { message: string; state: 'blocked' };

interface MoveIssueToColumnOptions {
  columnId: IssueColumnId;
  isCurrentRepository(): boolean;
  issue?: GitHubIssueRecord;
  repositoryFullName?: string;
  updateIssue(request: {
    fullName: string;
    number: number;
    state: 'closed' | 'open';
  }): Promise<GitHubIssueMutationResult>;
}

export async function moveIssueToColumn({
  columnId,
  isCurrentRepository,
  issue,
  repositoryFullName,
  updateIssue
}: MoveIssueToColumnOptions): Promise<IssueBoardMoveResult> {
  if (!issue) return { message: 'This issue is no longer available.', state: 'blocked' };

  const nextState = columnId === 'closed'
    ? (issue.state === 'closed' ? undefined : 'closed')
    : (issue.state === 'closed' ? 'open' : undefined);
  if (!nextState) return { state: 'ready' };
  if (!repositoryFullName) {
    return { message: 'Connect the repository before changing issue state.', state: 'blocked' };
  }

  try {
    const result = await updateIssue({
      fullName: repositoryFullName,
      number: issue.number,
      state: nextState
    });
    if (!isCurrentRepository()) {
      return { message: 'The repository changed before GitHub confirmed the move.', state: 'blocked' };
    }
    if (result.status !== 'connected' || !result.issue) {
      return {
        message: result.message ?? 'GitHub did not confirm the issue state change.',
        state: 'blocked'
      };
    }
    return { issue: result.issue, state: 'ready' };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Could not change the GitHub issue state.',
      state: 'blocked'
    };
  }
}
