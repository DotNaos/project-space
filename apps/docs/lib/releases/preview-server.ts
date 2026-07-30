import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { previewTestsForExactBuild } from './preview';
import type { ReleaseEntry } from './types';

export function previewTestsForCurrentBuild(
  entry: ReleaseEntry,
  environment: NodeJS.ProcessEnv = process.env,
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
    rootPackageVersion(),
  );
}

function rootPackageVersion() {
  try {
    const source = readFileSync(
      resolve(process.cwd(), '../../package.json'),
      'utf8',
    );
    const value: unknown = JSON.parse(source);
    if (
      typeof value === 'object' &&
      value !== null &&
      'version' in value &&
      typeof value.version === 'string'
    ) {
      return value.version;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
