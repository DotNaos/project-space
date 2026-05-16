import type { IssueDocument } from '@/domain';

export interface IssueDocumentRepository {
  listByWorktree(worktreeId: string): Promise<IssueDocument[]>;
}
