import {
  createCodexSessionsHttpApi,
  CodexSessionsHttpError,
  type CodexSessionsHttpHandler,
  type CodexSessionsHttpService,
  type CodexSessionsRequestContext
} from '../codex-sessions-http';
import type { CodexSessionsStore } from '../codex-sessions-store';
import {
  getCurrentAuthSession,
  isProjectSpaceAuthRequired
} from '../local-auth-store';
import {
  CodexSessionsAccessError,
  CodexSessionsConflictError,
  CodexTransportUncertainError,
  CodexTransportUnavailableError,
  createCodexSessionsService,
  type CodexSessionsActor,
  type CodexSessionsTransport
} from './service';

export interface CodexSessionsRuntime {
  handleRequest: CodexSessionsHttpHandler;
  service: ReturnType<typeof createCodexSessionsService>;
}

export function createCodexSessionsRuntime(options: {
  authorize(actor: CodexSessionsActor, machineId: string): Promise<void>;
  monotonicNow?: () => number;
  now?: () => Date;
  resolveContext?: () => CodexSessionsRequestContext | undefined;
  store: CodexSessionsStore;
  transport: CodexSessionsTransport;
}): CodexSessionsRuntime {
  const service = createCodexSessionsService(options);
  const resolveContext = options.resolveContext ?? (() => {
    const session = getCurrentAuthSession();
    return session ? { userId: session.userId } : undefined;
  });
  const authorize = async (context: CodexSessionsRequestContext, machineId: string) => {
    await withHttpErrors(() => options.authorize(context, machineId));
  };
  const httpService = wrapHttpService(service);
  const handleRequest = createCodexSessionsHttpApi(
    httpService,
    async () => {
      const context = resolveContext();
      if (context) return context;
      if (!isProjectSpaceAuthRequired()) return { userId: 'local-development-user' };
      throw new CodexSessionsHttpError(401, 'login_required', 'Login required.');
    },
    authorize
  );
  return { handleRequest, service };
}

function wrapHttpService(
  service: ReturnType<typeof createCodexSessionsService>
): CodexSessionsHttpService {
  return {
    approve: (actor, request) => withHttpErrors(() => service.approve(actor, request)),
    continue: (actor, request) => withHttpErrors(() => service.continue(actor, request)),
    inspect: (actor, request) => withHttpErrors(() => service.inspect(actor, request)),
    interrupt: (actor, request) => withHttpErrors(() => service.interrupt(actor, request)),
    list: (actor, request) => withHttpErrors(() => service.list(actor, request)),
    read: (actor, request) => withHttpErrors(() => service.read(actor, request)),
    respondToUserInput: (actor, request) => withHttpErrors(
      () => service.respondToUserInput(actor, request)
    ),
    stream: (actor, request, emit, signal) => withHttpErrors(async () => {
      await Promise.all([
        service.stream(actor, request, emit, signal),
        service.transportStream(actor, request, signal)
      ]);
    })
  };
}

async function withHttpErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CodexSessionsHttpError) throw error;
    if (error instanceof CodexSessionsConflictError) {
      throw new CodexSessionsHttpError(
        409,
        'operation_conflict',
        'The operation ID was already used for different input.'
      );
    }
    if (error instanceof CodexSessionsAccessError) {
      throw new CodexSessionsHttpError(
        403,
        'machine_access_denied',
        'You do not have access to this machine.'
      );
    }
    if (error instanceof CodexTransportUnavailableError) {
      throw new CodexSessionsHttpError(
        503,
        'connector_unavailable',
        'The owning machine is offline or unavailable.'
      );
    }
    if (error instanceof CodexTransportUncertainError) {
      throw new CodexSessionsHttpError(
        502,
        'task_identity_unverified',
        'The current Codex task identity could not be verified.'
      );
    }
    if (error instanceof TypeError) {
      throw new CodexSessionsHttpError(400, 'invalid_request', 'The request is invalid.');
    }
    throw error;
  }
}
