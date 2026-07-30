import type { ReleaseEntry } from './types';
import {
  compareStableSemver,
  releaseAnchor,
  releaseMajor,
  releaseMinor,
} from './semver';
import type * as PageTree from 'fumadocs-core/page-tree';

export interface ReleaseNavigationOptions {
  previewPullRequest?: number;
}

export function withReleaseNavigation(
  tree: PageTree.Root,
  entries: ReleaseEntry[],
  options: ReleaseNavigationOptions = {},
): PageTree.Root {
  const releaseFolder = buildReleaseFolder(entries, options);
  const children: PageTree.Node[] = [];
  let replaced = false;

  for (const child of tree.children) {
    if (
      child.type === 'page' &&
      child.url === '/docs/changelog'
    ) {
      children.push(releaseFolder);
      replaced = true;
    } else {
      children.push(child);
    }
  }
  if (!replaced) children.push(releaseFolder);

  return { ...tree, children };
}

export function buildReleaseFolder(
  entries: ReleaseEntry[],
  options: ReleaseNavigationOptions = {},
): PageTree.Folder {
  const sorted = [...entries].sort((left, right) =>
    compareStableSemver(right.version, left.version),
  );
  const latest = sorted[0];
  const children: PageTree.Node[] = [];

  if (latest) {
    children.push({
      $id: 'release-latest',
      name: `${options.previewPullRequest ? 'Preview' : 'Latest'} · v${latest.version}`,
      type: 'page',
      url: releaseEntryUrl(latest),
    });
    children.push({
      $id: 'release-history-separator',
      name: 'History',
      type: 'separator',
    });
  }

  const byMajor = groupBy(sorted, (entry) =>
    releaseMajor(entry.version),
  );
  for (const [major, majorEntries] of byMajor) {
    const byMinor = groupBy(majorEntries, (entry) =>
      releaseMinor(entry.version),
    );
    children.push({
      $id: `release-${major}`,
      children: [...byMinor].map(
        ([minor, minorEntries], minorIndex) => ({
          $id: `release-${minor}`,
          children: minorEntries.map((entry, patchIndex) => ({
            $id: `release-${entry.version}`,
            name: patchLabel(
              entry,
              patchIndex === 0 && minorIndex === 0,
              options,
            ),
            type: 'page' as const,
            url: releaseEntryUrl(entry),
          })),
          collapsible: true,
          defaultOpen: major === releaseMajor(latest.version) &&
            minor === releaseMinor(latest.version),
          index: {
            $id: `release-${minor}-index`,
            name: minor,
            type: 'page' as const,
            url: `/docs/releases/${minor}`,
          },
          name: minor,
          type: 'folder' as const,
        }),
      ),
      collapsible: true,
      defaultOpen: major === releaseMajor(latest.version),
      name: major,
      type: 'folder',
    });
  }

  children.push({
    $id: 'release-authoring-separator',
    name: 'Contribute',
    type: 'separator',
  });
  children.push({
    $id: 'release-authoring',
    name: 'Release authoring',
    type: 'page',
    url: '/docs/releases/authoring',
  });

  return {
    $id: 'releases',
    children,
    collapsible: true,
    defaultOpen: true,
    name: 'Releases',
    type: 'folder',
  };
}

function patchLabel(
  entry: ReleaseEntry,
  newest: boolean,
  options: ReleaseNavigationOptions,
) {
  if (!newest) return `v${entry.version}`;
  return `v${entry.version} · ${options.previewPullRequest ? 'Preview' : 'Latest'}`;
}

function releaseEntryUrl(entry: ReleaseEntry) {
  return `/docs/releases/${releaseMinor(entry.version)}#${releaseAnchor(entry.version)}`;
}

function groupBy(
  entries: ReleaseEntry[],
  keyFor: (entry: ReleaseEntry) => string,
) {
  const groups = new Map<string, ReleaseEntry[]>();
  for (const entry of entries) {
    const key = keyFor(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}
