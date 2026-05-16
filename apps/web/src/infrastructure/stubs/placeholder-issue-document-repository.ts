import type { IssueDocumentRepository } from '@/application/ports/issue-document-repository';

export const placeholderIssueDocumentRepository: IssueDocumentRepository = {
  async listByWorktree() {
    return [];
  }
};
