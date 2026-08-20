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
