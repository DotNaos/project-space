import { basename } from 'node:path';
import {
  isReleaseIntentFileName,
  type ReleaseIntent,
} from '../apps/docs/lib/releases/release-intent';
import type { ReleaseBump } from '../apps/docs/lib/releases/types';

export interface MergedChangelogQueueItem {
  allChangelogChanges: readonly string[];
  allIntentChanges: readonly string[];
  changelogBump: ReleaseBump;
  changelogPaths: readonly string[];
  intent: ReleaseIntent;
  intentPaths: readonly string[];
}

export function validateMergedChangelogQueueItem(
  item: MergedChangelogQueueItem,
) {
  if (item.changelogPaths.length !== 1) {
    throw new Error(
      'Merged commit must add exactly one changelog/<PR>.md file.',
    );
  }
  if (item.allChangelogChanges.length !== 1) {
    throw new Error(
      'Merged commit modifies changelog history instead of adding one queue item.',
    );
  }
  if (
    item.intentPaths.length !== 1 ||
    item.allIntentChanges.length !== 1 ||
    !isReleaseIntentFileName(basename(item.intentPaths[0] ?? ''))
  ) {
    throw new Error(
      'Merged commit must add exactly one lowercase-UUID release intent with its changelog.',
    );
  }
  if (item.intent === 'none' || item.intent !== item.changelogBump) {
    throw new Error(
      `Merged commit release intent must match changelog bump ${item.changelogBump}.`,
    );
  }
}
