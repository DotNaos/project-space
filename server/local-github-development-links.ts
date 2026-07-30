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
  closingIssuesReferences?: {
    nodes?: Array<{
      number: number;
    } | null>;
    pageInfo?: GitHubGraphQLPageInfo | null;
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
  mergeCommit?: {
    oid?: string | null;
  } | null;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
  updatedAt?: string | null;
  url: string;
}

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
      nodes?: Array<GitHubGraphQLPullRequest | null>;
      pageInfo?: GitHubGraphQLPageInfo | null;
    } | null;
  } | null;
}

interface GitHubGraphQLClosingIssues {
  repository?: {
    pullRequest?: {
      closingIssuesReferences?: {
        nodes?: Array<{
          number: number;
        } | null>;
        pageInfo?: GitHubGraphQLPageInfo | null;
      } | null;
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

  const pullRequests: GitHubGraphQLPullRequest[] = [];
  let data: GitHubGraphQLDevelopmentLinks | undefined;
  let pullRequestCursor: string | null = null;

  do {
    const page: GitHubGraphQLDevelopmentLinks =
      await request<GitHubGraphQLDevelopmentLinks>(
        token,
        `
      query RepositoryDevelopmentLinks(
        $owner: String!
        $name: String!
        $pullRequestCursor: String
      ) {
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
          pullRequests(
            first: 100
            after: $pullRequestCursor
            states: [OPEN, CLOSED, MERGED]
            orderBy: {field: UPDATED_AT, direction: DESC}
          ) {
            nodes {
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
              closingIssuesReferences(first: 100) {
                nodes {
                  number
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
        `,
        { name, owner, pullRequestCursor }
      );

    data ??= page;
    pullRequests.push(
      ...(page.repository?.pullRequests?.nodes ?? []).filter(
        (
          pullRequest: GitHubGraphQLPullRequest | null
        ): pullRequest is GitHubGraphQLPullRequest => Boolean(pullRequest)
      )
    );

    const pageInfo: GitHubGraphQLPageInfo | null | undefined =
      page.repository?.pullRequests?.pageInfo;

    if (!pageInfo?.hasNextPage) {
      pullRequestCursor = null;
      break;
    }

    if (!pageInfo.endCursor) {
      throw new Error('GitHub pull request pagination did not include a cursor.');
    }

    pullRequestCursor = pageInfo.endCursor;
  } while (pullRequestCursor);

  for (const pullRequest of pullRequests) {
    const closingIssuePageInfo = pullRequest.closingIssuesReferences?.pageInfo;

    if (closingIssuePageInfo?.hasNextPage && !closingIssuePageInfo.endCursor) {
      throw new Error(
        `GitHub closing issue pagination for pull request #${pullRequest.number} did not include a cursor.`
      );
    }

    let closingIssueCursor = closingIssuePageInfo?.hasNextPage
      ? closingIssuePageInfo.endCursor
      : null;

    while (closingIssueCursor) {
      const closingIssuesPage = await request<GitHubGraphQLClosingIssues>(
        token,
        `
          query PullRequestClosingIssues(
            $owner: String!
            $name: String!
            $number: Int!
            $closingIssueCursor: String
          ) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                closingIssuesReferences(first: 100, after: $closingIssueCursor) {
                  nodes {
                    number
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        { closingIssueCursor, name, number: pullRequest.number, owner }
      );
      const connection =
        closingIssuesPage.repository?.pullRequest?.closingIssuesReferences;

      pullRequest.closingIssuesReferences ??= { nodes: [] };
      pullRequest.closingIssuesReferences.nodes ??= [];
      pullRequest.closingIssuesReferences.nodes.push(...(connection?.nodes ?? []));

      if (!connection?.pageInfo?.hasNextPage) {
        closingIssueCursor = null;
        break;
      }

      if (!connection.pageInfo.endCursor) {
        throw new Error(
          `GitHub closing issue pagination for pull request #${pullRequest.number} did not include a cursor.`
        );
      }

      closingIssueCursor = connection.pageInfo.endCursor;
    }
  }

  const linkedIssueNumbersByBranch = new Map<string, Set<number>>();
  const linkedBranchShaByName = new Map<string, string | undefined>();

  for (const issue of data?.repository?.issues?.nodes ?? []) {
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
    pullRequests: pullRequests.map((pullRequest) => ({
      headBranch: pullRequest.headRefName ?? undefined,
      headRefPresent: Boolean(pullRequest.headRef),
      headRepositoryFullName: pullRequest.headRepository?.nameWithOwner ?? undefined,
      headSha: pullRequest.headRefOid ?? undefined,
      isCrossRepository: pullRequest.isCrossRepository ?? undefined,
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
