const operationIdSource =
  '([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const markerSource = `<!-- project-space-issue-create:${operationIdSource} -->`;
const markerPattern = new RegExp(markerSource, 'g');
const firstMarkerPattern = new RegExp(markerSource);
const leadingMarkerPattern = new RegExp(`^[\\t \\r\\n]*${markerSource}`);

export function gitHubIssueCreationMarker(operationId: string) {
  return `<!-- project-space-issue-create:${operationId} -->`;
}

export function stripGitHubIssueCreationMarker(body: string) {
  const startsWithMarker = leadingMarkerPattern.test(body);
  const visibleBody = body.replace(markerPattern, '');

  return (startsWithMarker ? visibleBody.replace(/^[\t \r\n]+/, '') : visibleBody)
    .trimEnd();
}

export function bodyWithGitHubIssueCreationMarker(
  body: string,
  operationId: string
) {
  const visibleBody = stripGitHubIssueCreationMarker(body);
  const marker = gitHubIssueCreationMarker(operationId);
  return visibleBody ? `${visibleBody}\n\n${marker}` : marker;
}

export function preserveGitHubIssueCreationMarker(
  nextBody: string,
  currentBody: string
) {
  const operationId = firstMarkerPattern.exec(currentBody)?.[1];
  const visibleBody = stripGitHubIssueCreationMarker(nextBody);

  return operationId
    ? bodyWithGitHubIssueCreationMarker(visibleBody, operationId)
    : visibleBody;
}
