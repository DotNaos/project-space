import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { previewTestsForExactBuild } from './preview';
import type { ReleaseEntry } from './types';

export function previewTestsForCurrentBuild(
  entry: ReleaseEntry,
  environment: NodeJS.ProcessEnv = process.env,
  buildVersion = projectSpacePackageVersion(),
) {
  return previewTestsForExactBuild(
    entry,
    {
      PROJECT_SPACE_BUILD_COMMIT:
        environment.PROJECT_SPACE_BUILD_COMMIT,
      PROJECT_SPACE_PREVIEW_HEAD_SHA:
        environment.PROJECT_SPACE_PREVIEW_HEAD_SHA,
      PROJECT_SPACE_PREVIEW_MODE:
        environment.PROJECT_SPACE_PREVIEW_MODE,
      PROJECT_SPACE_PREVIEW_PR_NUMBER:
        environment.PROJECT_SPACE_PREVIEW_PR_NUMBER,
      PROJECT_SPACE_PREVIEW_REPOSITORY:
        environment.PROJECT_SPACE_PREVIEW_REPOSITORY,
    },
    buildVersion,
  );
}

type ReadTextFile = (path: string) => string;

export function projectSpacePackageVersion(
  startDirectory = process.cwd(),
  readTextFile: ReadTextFile = (path) =>
    readFileSync(path, 'utf8'),
) {
  let directory = startDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const value: unknown = JSON.parse(
        readTextFile(join(directory, 'package.json')),
      );
      if (
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        value.name === 'project-space' &&
        'version' in value &&
        typeof value.version === 'string'
      ) {
        return value.version;
      }
    } catch {
      // Continue toward the repository root.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}
