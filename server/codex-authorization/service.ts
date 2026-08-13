import type {
  CodexAuthorizationAction,
  CodexAuthorizationRequest,
  CodexAuthorizationResult
} from '../../src/shared/codex-authorization-api';
import { CODEX_AUTHORIZATION_API_VERSION } from '../../src/shared/codex-authorization-api';

export class CodexAuthorizationServiceError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'unauthorized',
    message: string
  ) {
    super(message);
    this.name = 'CodexAuthorizationServiceError';
  }
}

/**
 * Kept as a small service seam for callers that still construct the old
 * authorization runtime. It deliberately has no inventory, generation, or
 * dispatch dependency: the Connector authorization protocol is retired.
 */
export interface CodexAuthorizationServiceOptions {
  dispatch?(input: {
    action: CodexAuthorizationAction;
    connectorId: string;
    generation: number;
    operationId: string;
    userId: string;
  }): Promise<unknown>;
  generationFor?(connectorId: string): number | undefined;
  inventory?(userId: string): Promise<unknown>;
}

export function createCodexAuthorizationService(
  _options: CodexAuthorizationServiceOptions = {}
) {
  return {
    async authorize(
      actor: { userId: string },
      request: CodexAuthorizationRequest
    ): Promise<CodexAuthorizationResult> {
      if (!actor.userId) {
        throw new CodexAuthorizationServiceError(
          'unauthorized',
          'Authentication is required.'
        );
      }
      return {
        apiVersion: CODEX_AUTHORIZATION_API_VERSION,
        message: 'Codex authorization requires the canonical Environment and Workspace Runtime.',
        operationId: request.operationId,
        state: 'unsupported'
      };
    }
  };
}
