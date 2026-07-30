import type {
  ReleaseChangeCategory,
  ReleaseEntry,
} from './types';

export const generatedReleaseChangelogSchema =
  'project-space.changelog/v1' as const;

export function generatedReleaseChangelogSource(
  entries: ReleaseEntry[],
) {
  return {
    schema: generatedReleaseChangelogSchema,
    entries: entries.flatMap((entry) =>
      entry.changes.flatMap((change) =>
        change.items.map((item, index) => ({
          id: [
            'release',
            entry.version.replaceAll('.', '-'),
            change.category.toLowerCase(),
            String(index + 1),
          ].join('-'),
          category: change.category.toLowerCase() as
            Lowercase<ReleaseChangeCategory>,
          summary: item,
          body: entry.summary,
          ...(entry.issues[0]
            ? { issueNumber: entry.issues[0] }
            : {}),
          pullRequestNumber: entry.pullRequest,
          testing: entry.previewTests,
        })),
      ),
    ),
  };
}
