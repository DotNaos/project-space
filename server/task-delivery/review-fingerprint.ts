import { createHash } from 'node:crypto';

export function taskDeliveryReviewRequestFingerprint(input: {
  headCommit: string;
  summary: string;
}) {
  return createHash('sha256').update(JSON.stringify({
    headCommit: input.headCommit.trim().toLowerCase(),
    summary: input.summary.trim()
  })).digest('hex');
}
