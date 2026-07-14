import type { GitHubIssueRecord } from '../src/shared/project-space-api';
import type { GitHubIssueCreationRemote } from './github-issue-creation-service';
import { stripGitHubIssueCreationMarker } from '../src/shared/github-issue-creation-marker';
import { GitHubRequestError, requestGitHub } from './local-github-catalog';

export interface LocalGitHubApiIssue {
  body?: string | null;
  html_url: string;
  labels?: Array<{ name?: string }>;
  number: number;
  pull_request?: unknown;
  state: 'open' | 'closed';
  title: string;
  updated_at?: string | null;
  user?: { login?: string } | null;
}

type GitHubRequest = typeof requestGitHub;

interface LocalGitHubIssueSearchResult {
  items?: LocalGitHubApiIssue[];
}

function repoApiPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

export function mapLocalGitHubIssue(issue: LocalGitHubApiIssue): GitHubIssueRecord {
  const body = stripGitHubIssueCreationMarker(issue.body ?? '');
  return {
    author: issue.user?.login,
    body: body || undefined,
    labels: issue.labels
      ?.map((label) => label.name)
      .filter((name): name is string => Boolean(name)) ?? [],
    number: issue.number,
    state: issue.state,
    title: issue.title,
    updatedAt: issue.updated_at ?? undefined,
    url: issue.html_url
  };
}

export function createLocalGitHubIssueCreationRemote(
  token: string,
  request: GitHubRequest = requestGitHub
): GitHubIssueCreationRemote {
  return {
    async create(input) {
      const issue = await request<LocalGitHubApiIssue>(
        `/repos/${repoApiPath(input.fullName)}/issues`,
        token,
        {
          body: JSON.stringify({
            body: input.body || undefined,
            labels: input.labels,
            title: input.title
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST'
        }
      );
      return mapLocalGitHubIssue(issue);
    },

    async findByMarker(repositoryFullName, marker) {
      const matches = new Map<number, GitHubIssueRecord>();
      let scannedEveryIssue = false;

      const addMatches = (issues: readonly LocalGitHubApiIssue[]) => {
        for (const issue of issues) {
          if (!issue.pull_request && issue.body?.includes(marker)) {
            matches.set(issue.number, mapLocalGitHubIssue(issue));
          }
        }
      };

      for (let page = 1; page <= 5; page += 1) {
        const issues = await request<LocalGitHubApiIssue[]>(
          `/repos/${repoApiPath(repositoryFullName)}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
          token
        );
        addMatches(issues);
        if (matches.size > 1) return Array.from(matches.values());
        if (issues.length < 100) {
          scannedEveryIssue = true;
          break;
        }
      }

      if (!scannedEveryIssue) {
        const search = new URLSearchParams({
          per_page: '100',
          q: `repo:${repositoryFullName} is:issue in:body "${marker}"`
        });
        const result = await request<LocalGitHubIssueSearchResult>(
          `/search/issues?${search.toString()}`,
          token
        );
        addMatches(result.items ?? []);
      }

      return Array.from(matches.values());
    },

    isRetrySafeError(error) {
      return error instanceof GitHubRequestError
        && [400, 401, 403, 404, 410, 422].includes(error.statusCode);
    }
  };
}
