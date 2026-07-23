import type { GitHubPullRequestRecord } from '../src/shared/project-space-api';
import { requestGitHubGraphQL } from './github-graphql-client';

interface GitHubGraphQLDevelopmentLinks {
  repository?: {
    issues?: {
      nodes?: Array<{
        linkedBranches?: {
          nodes?: Array<{
            ref?: {
              name?: string;
            } | null;
          } | null>;
        } | null;
        number: number;
      } | null>;
    } | null;
    pullRequests?: {
      nodes?: Array<{
        closingIssuesReferences?: {
          nodes?: Array<{
            number: number;
          } | null>;
        } | null;
        headRefName?: string | null;
        headRefOid?: string | null;
        mergeCommit?: {
          oid?: string | null;
        } | null;
        number: number;
        state: 'OPEN' | 'CLOSED' | 'MERGED';
        title: string;
        updatedAt?: string | null;
        url: string;
      } | null>;
    } | null;
  } | null;
}

function addLinkedIssue(
  linkedIssueNumbersByBranch: Map<string, Set<number>>,
  branchName: string,
  issueNumber: number
) {
  const current = linkedIssueNumbersByBranch.get(branchName) ?? new Set<number>();

  current.add(issueNumber);
  linkedIssueNumbersByBranch.set(branchName, current);
}

export async function loadRepositoryDevelopmentLinks(
  fullName: string,
  token: string,
  request: typeof requestGitHubGraphQL = requestGitHubGraphQL
): Promise<{
  linkedIssueNumbersByBranch: Map<string, Set<number>>;
  pullRequests: GitHubPullRequestRecord[];
}> {
  const [owner, name] = fullName.split('/');

  if (!owner || !name) {
    return {
      linkedIssueNumbersByBranch: new Map(),
      pullRequests: []
    };
  }

  const data = await request<GitHubGraphQLDevelopmentLinks>(
    token,
    `
      query RepositoryDevelopmentLinks($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          issues(first: 100, states: [OPEN, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number
              linkedBranches(first: 20) {
                nodes {
                  ref {
                    name
                  }
                }
              }
            }
          }
          pullRequests(first: 100, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number
              title
              url
              state
              headRefName
              headRefOid
              mergeCommit {
                oid
              }
              updatedAt
              closingIssuesReferences(first: 20) {
                nodes {
                  number
                }
              }
            }
          }
        }
      }
    `,
    { name, owner }
  );
  const linkedIssueNumbersByBranch = new Map<string, Set<number>>();

  for (const issue of data.repository?.issues?.nodes ?? []) {
    if (!issue) {
      continue;
    }

    for (const linkedBranch of issue.linkedBranches?.nodes ?? []) {
      const branchName = linkedBranch?.ref?.name;

      if (branchName) {
        addLinkedIssue(linkedIssueNumbersByBranch, branchName, issue.number);
      }
    }
  }

  return {
    linkedIssueNumbersByBranch,
    pullRequests: (data.repository?.pullRequests?.nodes ?? [])
      .filter((pullRequest): pullRequest is NonNullable<typeof pullRequest> => Boolean(pullRequest))
      .map((pullRequest) => ({
        headBranch: pullRequest.headRefName ?? undefined,
        headSha: pullRequest.headRefOid ?? undefined,
        linkedIssueNumbers:
          pullRequest.closingIssuesReferences?.nodes
            ?.map((issue) => issue?.number)
            .filter((number): number is number => typeof number === 'number') ?? [],
        mergeCommitHash: pullRequest.mergeCommit?.oid ?? undefined,
        number: pullRequest.number,
        state: pullRequest.state.toLowerCase() as GitHubPullRequestRecord['state'],
        title: pullRequest.title,
        updatedAt: pullRequest.updatedAt ?? undefined,
        url: pullRequest.url
      }))
  };
}
