import type { IntegrationRequestService } from '@/application/ports/integration-request-service';

export const placeholderIntegrationRequestService: IntegrationRequestService = {
  async listRequests() {
    return [];
  }
};
