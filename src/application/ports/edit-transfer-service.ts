import type { EditTransfer } from '@/domain';

export interface EditTransferService {
  listTransfers(worktreeId: string): Promise<EditTransfer[]>;
}
