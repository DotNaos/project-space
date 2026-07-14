export type GitHubRepositorySummaryResult =
  | {
      branchCount: number;
      checkedAt: string;
      fullName: string;
      openIssueCount: number;
      status: 'connected';
    }
  | {
      checkedAt: string;
      fullName: string;
      message: string;
      status: 'auth-required' | 'error' | 'not-configured';
    };

export function isValidGitHubRepositoryFullName(fullName: string) {
  if (fullName.length > 140) return false;

  const [owner, repository, extra] = fullName.split('/');
  if (!owner || !repository || extra) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return false;
  if (repository === '.' || repository === '..' || repository.length > 100) return false;

  return /^[A-Za-z0-9._-]+$/.test(repository);
}
