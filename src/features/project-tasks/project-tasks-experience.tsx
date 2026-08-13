import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { IssueCreationOverlay } from '@/features/project-desktop/components/issue-creation-overlay';
import {
  browserIssueCreationHistory,
  IssueCreationHistoryController
} from '@/features/project-desktop/components/issue-creation-history';
import { isIssueCreationPath } from '@/features/project-desktop/components/issue-creation-route';
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
  repositories,
  repository,
  selectedIssueNumber,
  targetPath
}: {
  connectorOverview: ConnectorOverviewResult;
  onOpenHistory(input: { defaultBranch: string; headBranch: string }): void;
  onOpenTask(issueNumber: number, projectIdOverride?: string): void;
  onShowTasks(): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repositories: GitHubCatalogRepository[];
  repository?: GitHubCatalogRepository;
  selectedIssueNumber?: number;
  targetPath: string;
}) {
  const [creationOpen, setCreationOpen] = useState(() =>
    typeof window !== 'undefined' && isIssueCreationPath(window.location.pathname, project.id)
  );
  const [creationCloseRequest, setCreationCloseRequest] = useState(0);
  const [commentsLoadingFor, setCommentsLoadingFor] = useState<number>();
  const creationHistoryRef = useRef<IssueCreationHistoryController | null>(null);
  const pendingCreatedIssueRef = useRef<{
    issueNumber: number;
    projectId?: string;
  } | null>(null);
  const onOpenTaskRef = useRef(onOpenTask);
  onOpenTaskRef.current = onOpenTask;
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
    const controller = new IssueCreationHistoryController(
      project.id,
      browserIssueCreationHistory(),
      {
        onCloseRequest: () => setCreationCloseRequest((request) => request + 1),
        onClosed: () => {
          setCreationOpen(false);
          const pendingIssue = pendingCreatedIssueRef.current;
          pendingCreatedIssueRef.current = null;
          if (pendingIssue) {
            onOpenTaskRef.current(pendingIssue.issueNumber, pendingIssue.projectId);
          }
        },
        onOpen: () => setCreationOpen(true)
      }
    );
    creationHistoryRef.current = controller;
    setCreationOpen(controller.isOpen());

    const handlePopState = () => controller.handlePopState();
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (creationHistoryRef.current === controller) creationHistoryRef.current = null;
    };
  }, [project.id]);

  const openCreation = useCallback(() => {
    if (!repository) return;
    creationHistoryRef.current?.openFromControl();
  }, [repository]);

  const closeCreation = useCallback(() => {
    creationHistoryRef.current?.finishClose();
  }, []);

  useEffect(() => {
    if (!selectedIssueNumber || selectedTask?.comments.length) return;
    setCommentsLoadingFor(selectedIssueNumber);
    void loadComments(selectedIssueNumber).finally(() => {
      setCommentsLoadingFor((current) => current === selectedIssueNumber ? undefined : current);
    });
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
          onNewTask={openCreation}
          onOpenTask={onOpenTask}
          onRetry={refresh}
          projectName={project.name}
          tasks={tasks}
        />
      )}
      <IssueCreationOverlay
        closeRequest={creationCloseRequest}
        onClose={closeCreation}
        onIssueCreated={(issue, repositoryKey) => {
          const isCurrentRepository = repositoryKey === repository?.fullName;
          if (isCurrentRepository) upsertIssue(issue);
          const targetProject = isCurrentRepository
            ? project
            : projects.find((candidate) =>
                candidate.kind === 'github'
                && candidate.github?.fullName.toLowerCase() === repositoryKey.toLowerCase()
              ) ?? projects.find((candidate) =>
                candidate.github?.fullName.toLowerCase() === repositoryKey.toLowerCase()
              );
          if (creationHistoryRef.current?.isOpen() && targetProject) {
            pendingCreatedIssueRef.current = {
              issueNumber: issue.number,
              projectId: targetProject.id
            };
          } else if (targetProject) {
            onOpenTask(issue.number, targetProject.id);
          }
        }}
        open={creationOpen}
        repositories={repositories}
        repository={repository}
      />
    </div>
  );
}
