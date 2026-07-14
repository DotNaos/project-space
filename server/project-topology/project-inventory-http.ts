import type { IncomingMessage, ServerResponse } from 'node:http';

import { getCurrentAuthSession } from '../local-auth-store';
import { writeJson } from '../project-space-http-response';
import type { createProjectTopologyInventoryService } from './project-inventory-service';

type ProjectTopologyInventoryService = ReturnType<
  typeof createProjectTopologyInventoryService
>;

export type ProjectTopologyInventoryHttpHandler = ReturnType<
  typeof createProjectTopologyInventoryHttpHandler
>;

export function createProjectTopologyInventoryHttpHandler(
  service: ProjectTopologyInventoryService
) {
  return async function handleProjectTopologyInventory(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== '/api/project-topology/inventory') return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method !== 'GET' || url.searchParams.size > 0) {
      writeJson(response, 400, {
        error: 'Topology project inventory accepts only an unparameterized GET request.'
      });
      return true;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(
      new Error('Topology inventory request disconnected before completion.')
    );
    const cancelOnClose = () => {
      if (!response.writableEnded) cancel();
    };
    request.once('aborted', cancel);
    response.once('close', cancelOnClose);
    try {
      const snapshot = await service.load({
        scopeKey: getCurrentAuthSession()?.userId ?? 'local-development-user',
        signal: controller.signal
      });
      if (!response.destroyed) writeJson(response, 200, snapshot);
    } catch (error) {
      if (!controller.signal.aborted || !response.destroyed) throw error;
    } finally {
      request.off('aborted', cancel);
      response.off('close', cancelOnClose);
    }
    return true;
  };
}
