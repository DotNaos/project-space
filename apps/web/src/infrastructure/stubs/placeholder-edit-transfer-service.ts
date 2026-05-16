import type { EditTransferService } from '@/application/ports/edit-transfer-service';

export const placeholderEditTransferService: EditTransferService = {
  async listTransfers() {
    return [];
  }
};
