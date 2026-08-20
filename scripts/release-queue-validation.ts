import { basename } from 'node:path';
import {
  isReleaseIntentFileName,
  releaseIntentDirectory,
  type ReleaseIntent,
} from '../apps/docs/lib/releases/release-intent';
import { connectorReleaseSensitivePaths } from
  '../packaging/release/connector-release-paths';

export interface MergedIntentOnlyQueueItem {
  allIntentChanges: readonly string[];
  intent: ReleaseIntent;
  intentPaths: readonly string[];
  productPaths: readonly string[];
}

export const releaseIntentEnforcementAdoptionCommit =
  '299a6d583ce2d13aa0a44c9f0e3cada64c765826';

export interface ReleaseIntentEnforcementChange {
  alreadyEnforced: boolean;
  commit: string;
  enforcementCommit: string | undefined;
  markerAdded: boolean;
  markerChanged: boolean;
  markerMatches: boolean;
}

export function validateReleaseIntentEnforcementChange(
  change: ReleaseIntentEnforcementChange,
) {
  const isAdoptionCommit = !change.alreadyEnforced &&
    change.commit === releaseIntentEnforcementAdoptionCommit &&
    change.commit === change.enforcementCommit &&
    change.markerAdded &&
    change.markerMatches;
  if (change.markerChanged && !isAdoptionCommit) {
    throw new Error(
      `Merged commit ${change.commit} changes the immutable release-intent enforcement marker.`,
    );
  }
  return isAdoptionCommit;
}

export function validateMergedIntentOnlyQueueItem(
  item: MergedIntentOnlyQueueItem,
) {
  const intentPath = item.intentPaths[0] ?? '';
  const intentFileName = basename(intentPath);
  const expectedDirectChild = `${releaseIntentDirectory}/${intentFileName}`;
  if (
    item.intentPaths.length !== 1 ||
    item.allIntentChanges.length !== 1 ||
    item.allIntentChanges[0] !== intentPath ||
    intentPath !== expectedDirectChild ||
    !isReleaseIntentFileName(intentFileName)
  ) {
    throw new Error(
      'Merged commit must add exactly one lowercase-UUID release intent without a changelog.',
    );
  }
  if (item.intent !== 'none') {
    throw new Error(
      'Merged commit without a changelog must declare intent none.',
    );
  }
  const sensitive = connectorReleaseSensitivePaths(item.productPaths);
  if (sensitive.length > 0) {
    throw new Error(
      `Merged commit intent none cannot change release-sensitive paths: ${sensitive.join(', ')}.`,
    );
  }
}
