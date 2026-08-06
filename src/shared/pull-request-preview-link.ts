const trustedPreviewHubOrigin = 'https://pr.projects.os-home.net';

export function pullRequestPreviewAppHref(
  pullRequestNumber: number,
  returnPath: string
) {
  if (
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !returnPath.startsWith('/') ||
    returnPath.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(returnPath)
  ) {
    return undefined;
  }
  const target = new URL(trustedPreviewHubOrigin);
  target.searchParams.set('pr', String(pullRequestNumber));
  target.searchParams.set('return', returnPath);
  return target.toString();
}
