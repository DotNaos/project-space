import type { IncomingMessage, ServerResponse } from 'node:http';

import { writeJson } from '../project-space-http-response';
import type { ConnectorRetirementService } from './service';
import { waitForConnectorCompatibilityWrites } from './configured-runtime';

export const connectorRetirementReportRoute = '/api/connector-retirement/report';

export function createConnectorRetirementHttpApi(options: {
  loadService(): Promise<ConnectorRetirementService | null>;
  resolveOwnerUserId(
    request: IncomingMessage,
    authenticatedOwnerUserId?: string
  ): Promise<string | undefined>;
}) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    authenticatedOwnerUserId?: string
  ) => {
    if (url.pathname !== connectorRetirementReportRoute) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method !== 'GET' || [...url.searchParams.keys()].length > 0) {
      writeJson(response, 405, { error: 'Connector retirement report requires one exact GET request.' });
      return true;
    }
    const ownerUserId = await options.resolveOwnerUserId(request, authenticatedOwnerUserId);
    if (!ownerUserId) {
      writeJson(response, 403, { error: 'Owner authentication is required.' });
      return true;
    }
    const service = await options.loadService();
    if (!service) {
      writeJson(response, 503, { error: 'Connector retirement evidence requires the account database.' });
      return true;
    }
    await waitForConnectorCompatibilityWrites(ownerUserId);
    await service.checkpoint(ownerUserId);
    writeJson(response, 200, await service.report(ownerUserId));
    return true;
  };
}
