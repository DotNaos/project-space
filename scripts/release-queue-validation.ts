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

export const releaseIntentEnforcementAdoptionSourceCommit =
  '299a6d583ce2d13aa0a44c9f0e3cada64c765826';
export const releaseIntentEnforcementAdoptionMergeCommit =
  '781e04f0c662965ec2a62f1cf74f3ad6eced17a8';
export const releaseIntentEnforcementAdoptionIntentPath =
  `${releaseIntentDirectory}/019fdc71-e8da-7723-89f6-77e3c6ab91f4.json`;

export interface ReleaseIntentEnforcementChange {
  alreadyEnforced: boolean;
  commit: string;
  containsAdoptionSource: boolean;
  enforcementCommit: string | undefined;
  markerAdded: boolean;
  markerChanged: boolean;
  markerMatches: boolean;
}

export function validateReleaseIntentEnforcementChange(
  change: ReleaseIntentEnforcementChange,
) {
  const isAdoptionCommit = !change.alreadyEnforced &&
    change.commit === releaseIntentEnforcementAdoptionMergeCommit &&
    change.commit === change.enforcementCommit &&
    change.containsAdoptionSource &&
    change.markerAdded &&
    change.markerMatches;
  if (change.markerChanged && !isAdoptionCommit) {
    throw new Error(
      `Merged commit ${change.commit} changes the immutable release-intent enforcement marker.`,
    );
  }
  return isAdoptionCommit;
}

export function validateMergedIntentQueueItem(
  item: MergedIntentOnlyQueueItem & {
    commit: string;
    isAdoptionCommit: boolean;
  },
) {
  if (!item.isAdoptionCommit) {
    validateMergedIntentOnlyQueueItem(item);
    return;
  }
  if (
    item.commit !== releaseIntentEnforcementAdoptionMergeCommit ||
    item.intent !== 'patch' ||
    item.intentPaths.length !== 1 ||
    item.intentPaths[0] !== releaseIntentEnforcementAdoptionIntentPath ||
    item.allIntentChanges.length !== 1 ||
    item.allIntentChanges[0] !== releaseIntentEnforcementAdoptionIntentPath
  ) {
    throw new Error(
      'Historical release-intent enforcement adoption does not match its canonical patch queue item.',
    );
  }
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
