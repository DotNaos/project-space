import type { PreviewHubInventoryResult } from '../../shared/pull-request-preview-hub-api';

export function previewInventoryStatusLine(
  result: PreviewHubInventoryResult | undefined,
  openPullRequestCount: number,
  loading: boolean
) {
  if (loading && !result) return 'Checking capacity…';
  if (!result) return 'Capacity unknown';
  if (result.status !== 'available') return 'Preview inventory unavailable';
  return `${result.onlineCount} of ${result.maxOnline} online · ${openPullRequestCount} open pull request${openPullRequestCount === 1 ? '' : 's'}`;
}

export function previewInventoryStatusMessage(status: PreviewHubInventoryResult['status'] | undefined) {
  if (status === 'unauthorized') return 'This repository is not linked, or you do not have access to its trusted Preview inventory.';
  return 'Preview status could not be verified. Deploy, open, and automatic redirect actions are disabled until trusted inventory is available again.';
}
