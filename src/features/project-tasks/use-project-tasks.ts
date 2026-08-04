import { useCallback, useEffect, useMemo, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  GitHubCatalogRepository,
  GitHubIssueCommentRecord,
  GitHubRepositoryDetailsResult,
  GitHubWorkflowRunSummary
} from '@/shared/project-space-api';
import { createProjectTaskViewModels } from './task-view-model';

export function useProjectTasks(repository?: GitHubCatalogRepository) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [runs, setRuns] = useState<GitHubWorkflowRunSummary[]>([]);
  const [commentsByIssue, setCommentsByIssue] = useState(
    () => new Map<number, GitHubIssueCommentRecord[]>()
  );
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const repositoryFullName = repository?.fullName;

  useEffect(() => {
    if (!repositoryFullName) {
      setDetails(undefined);
      setRuns([]);
      setCommentsByIssue(new Map());
      setError('No GitHub repository is linked to this project.');
      return;
    }

    let canceled = false;
    setIsLoading(true);
    setError('');
    Promise.allSettled([
      projectSpaceClient.getGitHubRepositoryDetails(repositoryFullName),
      projectSpaceClient.getGitHubPipelineStatus(repositoryFullName, { perPage: 100 })
    ])
      .then(([detailsResult, pipelineResult]) => {
        if (canceled) return;
        if (detailsResult.status === 'rejected') {
          throw detailsResult.reason;
        }
        const nextDetails = detailsResult.value;
        setDetails(nextDetails);
        setRuns(pipelineResult.status === 'fulfilled' ? pipelineResult.value.runs : []);
        setCommentsByIssue(new Map());
        if (nextDetails.status !== 'connected') {
          setError(nextDetails.message ?? 'GitHub repository details are unavailable.');
        } else if (pipelineResult.status === 'rejected') {
          setError('Tasks loaded, but pipeline status is temporarily unavailable.');
        }
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load tasks.');
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [generation, repositoryFullName]);

  const tasks = useMemo(() => createProjectTaskViewModels({
    branches: details?.branches ?? [],
    commentsByIssue,
    issues: details?.issues ?? [],
    pullRequests: details?.pullRequests ?? [],
    runs
  }), [commentsByIssue, details, runs]);

  const loadComments = useCallback(async (issueNumber: number) => {
    if (!repositoryFullName) return [];
    const cached = commentsByIssue.get(issueNumber);
    if (cached) return cached;
    const result = await projectSpaceClient.getGitHubIssueComments(repositoryFullName, issueNumber);
    const comments = result.comments ?? [];
    setCommentsByIssue((current) => new Map(current).set(issueNumber, comments));
    return comments;
  }, [commentsByIssue, repositoryFullName]);

  const addComment = useCallback(async (issueNumber: number, body: string) => {
    if (!repositoryFullName || !body.trim()) return;
    const result = await projectSpaceClient.createGitHubIssueComment({
      body: body.trim(),
      fullName: repositoryFullName,
      number: issueNumber
    });
    if (result.status !== 'connected' || !result.comment) {
      throw new Error(result.message ?? 'Could not add comment.');
    }
    setCommentsByIssue((current) => {
      const next = new Map(current);
      next.set(issueNumber, [...(next.get(issueNumber) ?? []), result.comment!]);
      return next;
    });
  }, [repositoryFullName]);

  const refresh = useCallback(() => setGeneration((current) => current + 1), []);

  const upsertIssue = useCallback((issue: NonNullable<GitHubRepositoryDetailsResult['issues']>[number]) => {
    setDetails((current) => current ? {
      ...current,
      issues: current.issues.some((entry) => entry.number === issue.number)
        ? current.issues.map((entry) => entry.number === issue.number ? issue : entry)
        : [issue, ...current.issues]
    } : current);
  }, []);

  const upsertBranch = useCallback((branch: NonNullable<GitHubRepositoryDetailsResult['branches']>[number]) => {
    setDetails((current) => current ? {
      ...current,
      branches: current.branches.some((entry) => entry.name === branch.name)
        ? current.branches.map((entry) => entry.name === branch.name ? branch : entry)
        : [branch, ...current.branches]
    } : current);
  }, []);

  const upsertPullRequest = useCallback((pullRequest: NonNullable<GitHubRepositoryDetailsResult['pullRequests']>[number]) => {
    setDetails((current) => current ? {
      ...current,
      pullRequests: current.pullRequests.some((entry) => entry.number === pullRequest.number)
        ? current.pullRequests.map((entry) => entry.number === pullRequest.number ? pullRequest : entry)
        : [pullRequest, ...current.pullRequests]
    } : current);
  }, []);

  return {
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
  };
}
