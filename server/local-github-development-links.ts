import type {
  GitHubBranchRecord,
  GitHubPullRequestRecord
} from '../src/shared/project-space-api';
import { requestGitHubGraphQL } from './github-graphql-client';

interface GitHubGraphQLPageInfo {
  endCursor?: string | null;
  hasNextPage?: boolean;
}

interface GitHubGraphQLPullRequest {
  headRefName?: string | null;
  headRefOid?: string | null;
  headRef?: {
    id?: string | null;
  } | null;
  headRepository?: {
    nameWithOwner?: string | null;
  } | null;
  isCrossRepository?: boolean | null;
  mergeCommit?: {
    oid?: string | null;
  } | null;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
  updatedAt?: string | null;
  url: string;
}

interface GitHubGraphQLPullRequestConnection {
  nodes?: Array<GitHubGraphQLPullRequest | null>;
  pageInfo?: GitHubGraphQLPageInfo | null;
}

interface GitHubGraphQLIssue {
  closedByPullRequestsReferences?: GitHubGraphQLPullRequestConnection | null;
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
}

interface GitHubGraphQLDevelopmentLinks {
  repository?: {
    issues?: {
      nodes?: Array<GitHubGraphQLIssue | null>;
    } | null;
  } | null;
}

interface GitHubGraphQLIssuePullRequests {
  repository?: {
    issue?: {
      closedByPullRequestsReferences?: GitHubGraphQLPullRequestConnection | null;
    } | null;
  } | null;
}

interface LinkedPullRequest {
  issueNumbers: Set<number>;
  pullRequest: GitHubGraphQLPullRequest;
}

const pullRequestFragment = `
  fragment DevelopmentPullRequestFields on PullRequest {
    number
    title
    url
    state
    headRefName
    headRefOid
    headRef {
      id
    }
    headRepository {
      nameWithOwner
    }
    isCrossRepository
    mergeCommit {
      oid
    }
    updatedAt
  }
`;

function addLinkedIssue(
  linkedIssueNumbersByBranch: Map<string, Set<number>>,
  branchName: string,
  issueNumber: number
) {
  const current = linkedIssueNumbersByBranch.get(branchName) ?? new Set<number>();

  current.add(issueNumber);
  linkedIssueNumbersByBranch.set(branchName, current);
}

function addPullRequestLink(
  linkedPullRequests: Map<number, LinkedPullRequest>,
  pullRequest: GitHubGraphQLPullRequest,
  issueNumber: number
) {
  const current = linkedPullRequests.get(pullRequest.number) ?? {
    issueNumbers: new Set<number>(),
    pullRequest
  };

  current.issueNumbers.add(issueNumber);
  linkedPullRequests.set(pullRequest.number, current);
}

function requireNextCursor(
  pageInfo: GitHubGraphQLPageInfo | null | undefined,
  issueNumber: number
) {
  if (!pageInfo?.hasNextPage) {
    return null;
  }

  if (!pageInfo.endCursor) {
    throw new Error(
      `GitHub pull request pagination for issue #${issueNumber} did not include a cursor.`
    );
  }

  return pageInfo.endCursor;
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
              closedByPullRequestsReferences(first: 100) {
                nodes {
                  ...DevelopmentPullRequestFields
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      }
      ${pullRequestFragment}
    `,
    { name, owner }
  );
  const linkedIssueNumbersByBranch = new Map<string, Set<number>>();
  const linkedBranchShaByName = new Map<string, string | undefined>();
  const linkedPullRequests = new Map<number, LinkedPullRequest>();

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

    const initialConnection = issue.closedByPullRequestsReferences;

    for (const pullRequest of initialConnection?.nodes ?? []) {
      if (pullRequest) {
        addPullRequestLink(linkedPullRequests, pullRequest, issue.number);
      }
    }

    let cursor = requireNextCursor(initialConnection?.pageInfo, issue.number);

    while (cursor) {
      const page = await request<GitHubGraphQLIssuePullRequests>(
        token,
        `
          query IssuePullRequestLinks(
            $owner: String!
            $name: String!
            $issueNumber: Int!
            $cursor: String
          ) {
            repository(owner: $owner, name: $name) {
              issue(number: $issueNumber) {
                closedByPullRequestsReferences(first: 100, after: $cursor) {
                  nodes {
                    ...DevelopmentPullRequestFields
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
          ${pullRequestFragment}
        `,
        { cursor, issueNumber: issue.number, name, owner }
      );
      const connection =
        page.repository?.issue?.closedByPullRequestsReferences;

      if (!connection) {
        throw new Error(
          `GitHub pull request pagination for issue #${issue.number} did not return a page.`
        );
      }

      for (const pullRequest of connection.nodes ?? []) {
        if (pullRequest) {
          addPullRequestLink(linkedPullRequests, pullRequest, issue.number);
        }
      }

      cursor = requireNextCursor(connection.pageInfo, issue.number);
    }
  }

  const pullRequests = Array.from(linkedPullRequests.values())
    .map(({ issueNumbers, pullRequest }) => ({
      headBranch: pullRequest.headRefName ?? undefined,
      headRefPresent: Boolean(pullRequest.headRef),
      headRepositoryFullName: pullRequest.headRepository?.nameWithOwner ?? undefined,
      headSha: pullRequest.headRefOid ?? undefined,
      isCrossRepository: pullRequest.isCrossRepository ?? undefined,
      linkedIssueNumbers: Array.from(issueNumbers).sort((left, right) => left - right),
      mergeCommitHash: pullRequest.mergeCommit?.oid ?? undefined,
      number: pullRequest.number,
      state: pullRequest.state.toLowerCase() as GitHubPullRequestRecord['state'],
      title: pullRequest.title,
      updatedAt: pullRequest.updatedAt ?? undefined,
      url: pullRequest.url
    }))
    .sort(
      (left, right) =>
        (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') ||
        right.number - left.number
    );

  return {
    linkedBranches: Array.from(linkedIssueNumbersByBranch, ([name, issueNumbers]) => ({
      commitSha: linkedBranchShaByName.get(name),
      isDefault: false,
      linkedIssueNumbers: Array.from(issueNumbers).sort((left, right) => left - right),
      name
    })),
    linkedIssueNumbersByBranch,
    pullRequests
  };
}
