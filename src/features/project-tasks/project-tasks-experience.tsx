import { useEffect, useMemo, useState } from 'react';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { IssueCreationOverlay } from '@/features/project-desktop/components/issue-creation-overlay';
import { ProjectTaskDetail } from './project-task-detail';
import { ProjectTasksPage } from './project-tasks-page';
import { useProjectTasks } from './use-project-tasks';

export function ProjectTasksExperience({
  connectorOverview,
  onOpenHistory,
  onOpenTask,
  onShowTasks,
  project,
  projects,
  repository,
  selectedIssueNumber,
  targetPath
}: {
  connectorOverview: ConnectorOverviewResult;
  onOpenHistory(input: { defaultBranch: string; headBranch: string }): void;
  onOpenTask(issueNumber: number): void;
  onShowTasks(): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repository?: GitHubCatalogRepository;
  selectedIssueNumber?: number;
  targetPath: string;
}) {
  const [creationOpen, setCreationOpen] = useState(false);
  const [commentsLoadingFor, setCommentsLoadingFor] = useState<number>();
  const {
    addComment,
    details,
    error,
    isLoading,
    loadComments,
    refresh,
    tasks,
    upsertBranch,
    upsertIssue,
    upsertPullRequest
  } = useProjectTasks(repository);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.issue.number === selectedIssueNumber),
    [selectedIssueNumber, tasks]
  );

  useEffect(() => {
    if (!selectedIssueNumber || selectedTask?.comments.length) return;
    let canceled = false;
    setCommentsLoadingFor(selectedIssueNumber);
    void loadComments(selectedIssueNumber).finally(() => {
      if (!canceled) setCommentsLoadingFor(undefined);
    });
    return () => { canceled = true; };
  }, [loadComments, selectedIssueNumber, selectedTask?.comments.length]);

  return (
    <div className="@container h-full min-h-0 overflow-hidden">
      {selectedTask ? (
        <ProjectTaskDetail
          addComment={(body) => addComment(selectedTask.issue.number, body)}
          branches={details?.branches ?? []}
          comments={selectedTask.comments}
          connectorOverview={connectorOverview}
          isLoadingComments={commentsLoadingFor === selectedTask.issue.number}
          onBack={onShowTasks}
          onBranchCreated={upsertBranch}
          onIssueUpdated={upsertIssue}
          onOpenHistory={onOpenHistory}
          onPullRequestCreated={upsertPullRequest}
          project={project}
          projects={projects}
          pullRequests={details?.pullRequests ?? []}
          repositoryFullName={repository?.fullName}
          repositoryUrl={repository?.url}
          targetPath={targetPath}
          task={selectedTask}
        />
      ) : (
        <ProjectTasksPage
          error={error}
          isLoading={isLoading}
          onNewTask={() => setCreationOpen(true)}
          onOpenTask={onOpenTask}
          onRetry={refresh}
          projectName={project.name}
          tasks={tasks}
        />
      )}
      <IssueCreationOverlay
        onClose={() => setCreationOpen(false)}
        onIssueCreated={(issue) => {
          upsertIssue(issue);
          setCreationOpen(false);
          onOpenTask(issue.number);
        }}
        open={creationOpen}
        repository={repository}
      />
    </div>
  );
}
