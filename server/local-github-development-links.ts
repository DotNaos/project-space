import type {
  GitHubBranchRecord,
  GitHubPullRequestRecord
} from '../src/shared/project-space-api';
import { requestGitHubGraphQL } from './github-graphql-client';

interface GitHubGraphQLDevelopmentLinks {
  repository?: {
    issues?: {
      nodes?: Array<{
        linkedBranches?: {
          nodes?: Array<{
            ref?: {
              name?: string;
              target?: {
                oid?: string | null;
              } | null;
            } | null;
          } | null>;
        } | null;
        number: number;
      } | null>;
    } | null;
    pullRequests?: {
      nodes?: Array<{
        baseRefName?: string | null;
        closingIssuesReferences?: {
          nodes?: Array<{
            number: number;
          } | null>;
        } | null;
        headRefName?: string | null;
        headRefOid?: string | null;
        headRef?: {
          id?: string | null;
        } | null;
        headRepository?: {
          nameWithOwner?: string | null;
        } | null;
        isCrossRepository?: boolean | null;
        isDraft?: boolean | null;
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
  linkedBranches: GitHubBranchRecord[];
  linkedIssueNumbersByBranch: Map<string, Set<number>>;
  pullRequests: GitHubPullRequestRecord[];
}> {
  const [owner, name] = fullName.split('/');

  if (!owner || !name) {
    return {
      linkedBranches: [],
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
                    target {
                      oid
                    }
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
              baseRefName
              headRefName
              headRefOid
              headRef {
                id
              }
              headRepository {
                nameWithOwner
              }
              isCrossRepository
              isDraft
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
  const linkedBranchShaByName = new Map<string, string | undefined>();

  for (const issue of data.repository?.issues?.nodes ?? []) {
    if (!issue) {
      continue;
    }

    for (const linkedBranch of issue.linkedBranches?.nodes ?? []) {
      const branchName = linkedBranch?.ref?.name;

      if (branchName) {
        addLinkedIssue(linkedIssueNumbersByBranch, branchName, issue.number);
        linkedBranchShaByName.set(
          branchName,
          linkedBranch?.ref?.target?.oid ?? linkedBranchShaByName.get(branchName)
        );
      }
    }
  }

  return {
    linkedBranches: Array.from(linkedIssueNumbersByBranch, ([name, issueNumbers]) => ({
      commitSha: linkedBranchShaByName.get(name),
      isDefault: false,
      linkedIssueNumbers: Array.from(issueNumbers).sort((left, right) => left - right),
      name
    })),
    linkedIssueNumbersByBranch,
    pullRequests: (data.repository?.pullRequests?.nodes ?? [])
      .filter((pullRequest): pullRequest is NonNullable<typeof pullRequest> => Boolean(pullRequest))
      .map((pullRequest) => ({
        baseBranch: pullRequest.baseRefName ?? undefined,
        headBranch: pullRequest.headRefName ?? undefined,
        headRefPresent: Boolean(pullRequest.headRef),
        headRepositoryFullName: pullRequest.headRepository?.nameWithOwner ?? undefined,
        headSha: pullRequest.headRefOid ?? undefined,
        isCrossRepository: pullRequest.isCrossRepository ?? undefined,
        isDraft: pullRequest.isDraft ?? undefined,
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
