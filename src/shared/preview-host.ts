const PREVIEW_HOST_PATTERNS = [
  /^pr-([1-9][0-9]{0,8})\.projects\.os-home\.net$/,
  /^pr-([1-9][0-9]{0,8})\.localhost$/
] as const;

export function previewPullRequestNumberFromHostname(hostname: string): number | undefined {
  const normalized = hostname.toLowerCase();
  const match = PREVIEW_HOST_PATTERNS
    .map((pattern) => pattern.exec(normalized))
    .find(Boolean);
  if (!match) return undefined;
  const pullRequestNumber = Number(match[1]);
  return Number.isSafeInteger(pullRequestNumber) && pullRequestNumber > 0 ? pullRequestNumber : undefined;
}

export function isPreviewHubHostname(hostname: string): boolean {
  return hostname.toLowerCase() === 'pr.projects.os-home.net' || previewPullRequestNumberFromHostname(hostname) !== undefined;
}

export function isCentralPreviewHubHostname(hostname: string): boolean {
  return hostname.toLowerCase() === 'pr.projects.os-home.net';
}
