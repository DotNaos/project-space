const PREVIEW_HOST_PATTERN = /^pr-([1-9][0-9]{0,8})\.projects\.os-home\.net$/;

export function previewPullRequestNumberFromHostname(hostname: string): number | undefined {
  const match = PREVIEW_HOST_PATTERN.exec(hostname.toLowerCase());
  if (!match) return undefined;
  const pullRequestNumber = Number(match[1]);
  return Number.isSafeInteger(pullRequestNumber) && pullRequestNumber > 0 ? pullRequestNumber : undefined;
}

export function isPreviewHubHostname(hostname: string): boolean {
  return hostname.toLowerCase() === 'pr.projects.os-home.net' || previewPullRequestNumberFromHostname(hostname) !== undefined;
}
