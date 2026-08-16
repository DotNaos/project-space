import type { CodexSession } from '../codex-sessions/codex-sessions-types';
import { projectCodexTasks } from '../codex-sessions/project-codex-task-model';
import type {
  GitHubPullRequestRecord,
  GitHubWorkflowRunSummary,
  ProjectSpaceRecord
} from '../../shared/project-space-api';
import type { ProjectTaskHealth } from './task-view-model';

export function codexTasksForIssue({
  issueNumber,
  project,
  sessions
}: {
  issueNumber: number;
  project: ProjectSpaceRecord;
  sessions: readonly CodexSession[];
}) {
  return projectCodexTasks(sessions, [project]).filter((task) => task.issueNumber === issueNumber);
}

export function projectTaskPipelinePresentation({
  health,
  pipeline,
  pullRequest
}: {
  health: ProjectTaskHealth;
  pipeline?: GitHubWorkflowRunSummary;
  pullRequest?: GitHubPullRequestRecord;
}) {
  if (health === 'attention') return { color: 'danger' as const, label: 'Checks failed' };
  if (health === 'healthy') return { color: 'success' as const, label: 'Checks passed' };
  if (pipeline?.status === 'in_progress') return { color: 'warning' as const, label: 'Checks running' };
  if (pipeline?.status === 'queued' || pipeline?.status === 'waiting' || pipeline?.status === 'pending') {
    return { color: 'warning' as const, label: 'Checks queued' };
  }
  return { color: 'default' as const, label: pullRequest ? 'Waiting for checks' : 'Not started' };
}
