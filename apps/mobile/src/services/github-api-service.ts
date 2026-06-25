import type { GitHubRepository, GitHubViewer } from '../domain/models';

interface UserResponse {
  login: string;
  name: string | null;
  avatar_url: string;
}

interface RepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  updated_at: string;
  default_branch: string;
  private: boolean;
  owner: {
    login: string;
  };
}

export async function fetchViewer(accessToken: string): Promise<GitHubViewer> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('GitHub account lookup failed.');
  }

  const payload = (await response.json()) as UserResponse;

  return {
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatar_url,
  };
}

export async function fetchRepositories(
  accessToken: string
): Promise<GitHubRepository[]> {
  const response = await fetch(
    'https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error('GitHub repositories could not be loaded.');
  }

  const payload = (await response.json()) as RepositoryResponse[];

  return payload.map((repository) => ({
    id: repository.id,
    name: repository.name,
    fullName: repository.full_name,
    ownerLogin: repository.owner.login,
    description: repository.description,
    htmlUrl: repository.html_url,
    homepageUrl: repository.homepage,
    updatedAt: repository.updated_at,
    defaultBranch: repository.default_branch,
    isPrivate: repository.private,
  }));
}
