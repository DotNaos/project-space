export interface GitHubViewer {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface AuthSession {
  accessToken: string;
  viewer: GitHubViewer;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  ownerLogin: string;
  description: string | null;
  htmlUrl: string;
  homepageUrl: string | null;
  updatedAt: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface SelectedProject {
  repository: GitHubRepository;
  groupName: string;
}

export interface ProjectIdea {
  id: string;
  title: string;
  description: string;
  createdAt: string;
}

export interface PersistedAppState {
  authSession: AuthSession | null;
  selectedProjects: SelectedProject[];
  ideasByRepositoryId: Record<string, ProjectIdea[]>;
}
