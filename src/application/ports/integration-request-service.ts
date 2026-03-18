import type { IntegrationRequest } from '@/domain';

export interface IntegrationRequestService {
  listRequests(worktreeId: string): Promise<IntegrationRequest[]>;
}
