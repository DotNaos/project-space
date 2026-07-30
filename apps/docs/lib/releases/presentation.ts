import type { DocsDeploymentIdentity } from '../deployment-identity';
import type { ReleaseEntry } from './types';

export function canShowPreviewOnly(
  entry: ReleaseEntry,
  identity: DocsDeploymentIdentity | undefined,
) {
  return (
    identity?.state === 'preview' &&
    identity.pullRequestNumber === entry.pullRequest &&
    identity.version === entry.version
  );
}

export function activeAnchorAtReadingLine(
  sections: Array<{ id: string; top: number }>,
  readingLine: number,
) {
  if (sections.length === 0) return undefined;
  let active = sections[0].id;
  for (const section of sections) {
    if (section.top <= readingLine) {
      active = section.id;
    } else {
      break;
    }
  }
  return active;
}
