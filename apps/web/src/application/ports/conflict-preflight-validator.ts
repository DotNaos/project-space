import type { Hunk, HunkValidationResult } from '@/domain';

export interface ConflictPreflightValidator {
  validateHunks(
    targetWorktreeId: string,
    hunks: Hunk[]
  ): Promise<HunkValidationResult[]>;
}
