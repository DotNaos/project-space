import type { ConflictPreflightValidator } from '@/application/ports/conflict-preflight-validator';

export const placeholderConflictPreflightValidator: ConflictPreflightValidator = {
  async validateHunks(_targetWorktreeId, hunks) {
    return hunks.map((hunk) => ({
      hunkId: hunk.id,
      valid: true,
      message: 'Conflict preflight placeholder.',
      conflicts: []
    }));
  }
};
