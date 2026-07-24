import type {
  CodexAuthorizationConnectorRequest,
  CodexAuthorizationConnectorResult
} from '../../src/shared/codex-authorization-api';
import type { CodexProcessFactory } from '../codex-sessions/contracts';
import { CodexStdioTransport } from '../codex-sessions/stdio-transport';

type AuthorizationAttempt = {
  loginId: string;
  operationId: string;
  result: Extract<CodexAuthorizationConnectorResult, { state: 'pending' }>;
  state: 'failed' | 'pending';
};

type RpcMessage = {
  method?: string;
  params?: unknown;
};

const authorizationDeadlineMs = 15 * 60_000;
const verificationUrl = new URL('https://auth.openai.com/codex/device');

export class CodexAuthorizationConflictError extends Error {
  constructor() {
    super('Another Codex authorization attempt is already active.');
    this.name = 'CodexAuthorizationConflictError';
  }
}

export class CodexDeviceAuthorizationManager {
  private attempt?: AuthorizationAttempt;
  private startPromise?: Promise<CodexStdioTransport>;
  private transport?: CodexStdioTransport;

  constructor(private readonly options: {
    binaryPath?: string;
    codexHome?: string;
    now?: () => number;
    processFactory?: CodexProcessFactory;
  } = {}) {}

  async execute(
    request: CodexAuthorizationConnectorRequest
  ): Promise<CodexAuthorizationConnectorResult> {
    if (request.action === 'start') return this.start(request.operationId);
    if (request.action === 'cancel') return this.cancel(request.operationId);
    return this.status(request.operationId);
  }

  async close() {
    const transport = this.transport;
    this.transport = undefined;
    this.startPromise = undefined;
    await transport?.close();
  }

  private async start(operationId: string): Promise<CodexAuthorizationConnectorResult> {
    if (await this.accountReady()) return { state: 'ready' };
    const current = this.currentAttempt();
    if (current?.operationId === operationId) {
      return current.state === 'pending' ? current.result : { state: 'failed' };
    }
    if (current?.state === 'pending') throw new CodexAuthorizationConflictError();
    const transport = await this.ensureTransport();
    const raw = await transport.call<unknown>(
      'account/login/start',
      { type: 'chatgptDeviceCode' }
    );
    const started = readStartedLogin(raw);
    const deadlineAt = this.now() + authorizationDeadlineMs;
    const result = {
      deadlineAt: new Date(deadlineAt).toISOString(),
      state: 'pending' as const,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl
    };
    this.attempt = {
      loginId: started.loginId,
      operationId,
      result,
      state: 'pending'
    };
    return result;
  }

  private async status(operationId: string): Promise<CodexAuthorizationConnectorResult> {
    if (await this.accountReady()) {
      this.attempt = undefined;
      await this.close();
      return { state: 'ready' };
    }
    const current = this.currentAttempt();
    if (!current || current.operationId !== operationId) {
      return { state: 'authorization-required' };
    }
    return current.state === 'pending' ? current.result : { state: 'failed' };
  }

  private async cancel(operationId: string): Promise<CodexAuthorizationConnectorResult> {
    if (await this.accountReady()) {
      this.attempt = undefined;
      await this.close();
      return { state: 'ready' };
    }
    const current = this.currentAttempt();
    if (!current || current.operationId !== operationId) {
      return { state: 'authorization-required' };
    }
    if (current.state === 'pending') {
      await (await this.ensureTransport()).call(
        'account/login/cancel',
        { loginId: current.loginId }
      );
    }
    this.attempt = undefined;
    await this.close();
    return { state: 'cancelled' };
  }

  private currentAttempt() {
    return this.attempt;
  }

  private async accountReady() {
    const result = await (await this.ensureTransport()).call<unknown>(
      'account/read',
      { refreshToken: false }
    );
    return readAccountReady(result);
  }

  private ensureTransport() {
    if (this.transport?.isOpen) return Promise.resolve(this.transport);
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const transport = CodexStdioTransport.launch({
        binaryPath: this.options.binaryPath,
        codexHome: this.options.codexHome,
        onClose: () => {
          if (this.transport === transport) this.transport = undefined;
          if (this.attempt?.state === 'pending') this.attempt.state = 'failed';
        },
        onMessage: (message) => this.handleMessage(message),
        processFactory: this.options.processFactory
      });
      try {
        await transport.initialize();
        this.transport = transport;
        return transport;
      } catch (error) {
        await transport.close();
        throw error;
      } finally {
        this.startPromise = undefined;
      }
    })();
    return this.startPromise;
  }

  private handleMessage(message: RpcMessage) {
    if (message.method !== 'account/login/completed' || !isRecord(message.params)) return;
    const current = this.attempt;
    if (!current || message.params.loginId !== current.loginId) return;
    if (message.params.success !== true) current.state = 'failed';
  }

  private now() { return (this.options.now ?? Date.now)(); }
}

function readStartedLogin(value: unknown) {
  if (!isRecord(value) ||
      value.type !== 'chatgptDeviceCode' ||
      typeof value.loginId !== 'string' ||
      !validOpaque(value.loginId, 512) ||
      typeof value.verificationUrl !== 'string' ||
      typeof value.userCode !== 'string' ||
      !/^[A-Z0-9][A-Z0-9-]{3,31}$/.test(value.userCode)) {
    throw new Error('Codex returned an invalid device authorization response.');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.verificationUrl);
  } catch {
    throw new Error('Codex returned an invalid device authorization URL.');
  }
  if (
    parsedUrl.protocol !== verificationUrl.protocol ||
    parsedUrl.hostname !== verificationUrl.hostname ||
    parsedUrl.port !== '' ||
    parsedUrl.pathname !== verificationUrl.pathname ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== ''
  ) {
    throw new Error('Codex returned an untrusted device authorization URL.');
  }
  return {
    loginId: value.loginId,
    userCode: value.userCode,
    verificationUrl: parsedUrl.toString()
  };
}

function readAccountReady(value: unknown) {
  return isRecord(value) &&
    typeof value.requiresOpenaiAuth === 'boolean' &&
    (value.requiresOpenaiAuth === false || isRecord(value.account));
}

function validOpaque(value: string, maximum: number) {
  return value.length > 0 && value.length <= maximum && !/[\u0000\r\n]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
