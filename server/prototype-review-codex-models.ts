import type { IncomingMessage, ServerResponse } from 'node:http';

import { getCodexModels } from './local-codex-client';
import { writeJson } from './project-space-http-response';

export type PrototypeReviewCodexModelsHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean>;

export function createPrototypeReviewCodexModelsHandler(options: {
  authorize(): Promise<void>;
  cwd: string;
  machineId: string;
}): PrototypeReviewCodexModelsHandler {
  return async (request, response, url) => {
    if (url.pathname !== '/api/prototype-review/codex-models') return false;
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'Method not allowed.' });
      return true;
    }
    await options.authorize();
    writeJson(response, 200, await getCodexModels({
      cwd: options.cwd,
      machineId: options.machineId
    }));
    return true;
  };
}
