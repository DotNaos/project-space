export interface GitHubReauthorizationAction {
  label: 'Continue GitHub login' | 'Reconnect GitHub';
  variant: 'ghost' | 'primary';
}

export function getGitHubReauthorizationAction({
  embedded,
  flowPending
}: {
  embedded: boolean;
  flowPending: boolean;
}): GitHubReauthorizationAction | undefined {
  if (embedded && flowPending) return undefined;
  return flowPending
    ? { label: 'Continue GitHub login', variant: 'ghost' }
    : { label: 'Reconnect GitHub', variant: 'primary' };
}
