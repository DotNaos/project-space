import { describe, expect, test } from 'bun:test';

import {
  previewInventoryStatusLine,
  previewInventoryStatusMessage
} from '../src/features/pr-preview-hub/preview-hub-presentation';
import type { PreviewHubInventoryResult } from '../src/shared/pull-request-preview-hub-api';

function inventory(status: PreviewHubInventoryResult['status']): PreviewHubInventoryResult {
  return {
    checkedAt: '2026-08-09T07:16:04.369Z',
    inventoryRevision: status === 'available' ? 'revision' : 'unavailable',
    maxOnline: 3,
    occupiedCount: status === 'available' ? 1 : 0,
    onlineCount: status === 'available' ? 1 : 0,
    previews: [],
    repositoryFullName: 'DotNaos/project-space',
    status
  };
}

describe('Preview hub inventory presentation', () => {
  test('does not claim that zero Previews are online when inventory is unavailable', () => {
    expect(previewInventoryStatusLine(inventory('unavailable'), 16, false))
      .toBe('Preview inventory unavailable');
    expect(previewInventoryStatusMessage('unavailable'))
      .toContain('Deploy, open, and automatic redirect actions are disabled');
  });

  test('shows counts only for a verified available inventory', () => {
    expect(previewInventoryStatusLine(inventory('available'), 1, false))
      .toBe('1 of 3 online · 1 open pull request');
  });
});
