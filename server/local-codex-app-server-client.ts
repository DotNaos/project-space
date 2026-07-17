import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  CodexChatRequest,
  CodexChatResult,
  CodexChatStreamEvent,
  CodexModelCatalogueResult,
  CodexModelRecord
} from '../src/shared/project-space-api';

interface CodexRpcMessage {
  error?: { message?: string };
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface CodexTurnCollector {
  completedText: string;
  delta: string;
  threadId: string;
  turnId: string;
}

export interface CodexChatRuntime {
  args: string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type CodexChatStreamEmitter = (event: CodexChatStreamEvent) => void;

function readRpcParamString(params: unknown, key: string) {
  if (!params || typeof params !== 'object' || !(key in params)) {
    return '';
  }

  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function readThreadId(result: unknown) {
  if (!result || typeof result !== 'object' || !('thread' in result)) {
    return '';
  }

  const thread = (result as { thread?: { id?: unknown } }).thread;
  return typeof thread?.id === 'string' ? thread.id : '';
}

function readTurnId(result: unknown) {
  if (!result || typeof result !== 'object' || !('turn' in result)) {
    return '';
  }

  const turn = (result as { turn?: { id?: unknown } }).turn;
  return typeof turn?.id === 'string' ? turn.id : '';
}

export function readCodexModelPage(result: unknown) {
  if (!result || typeof result !== 'object') {
    return { models: [] as CodexModelRecord[] };
  }

  const page = result as { data?: unknown; nextCursor?: unknown };
  const models = Array.isArray(page.data)
    ? page.data.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        const model = entry as Record<string, unknown>;
        if (
          model.hidden === true ||
          typeof model.id !== 'string' ||
          typeof model.model !== 'string' ||
          typeof model.displayName !== 'string'
        ) {
          return [];
        }

        const defaultReasoningEffort = catalogIdentifier(model.defaultReasoningEffort);
        const defaultServiceTier = model.defaultServiceTier === null
          ? null
          : catalogIdentifier(model.defaultServiceTier);
        return [{
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
          ...(defaultServiceTier !== undefined ? { defaultServiceTier } : {}),
          description: typeof model.description === 'string' ? model.description : '',
          displayName: model.displayName,
          id: model.id,
          isDefault: model.isDefault === true,
          model: model.model,
          serviceTiers: readServiceTiers(model.serviceTiers),
          supportedReasoningEfforts: readReasoningEfforts(model.supportedReasoningEfforts)
        }];
      })
    : [];

  return {
    models,
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : undefined
  };
}

function catalogIdentifier(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function readReasoningEfforts(value: unknown) {
  return Array.isArray(value) ? value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const option = entry as Record<string, unknown>;
    const reasoningEffort = catalogIdentifier(option.reasoningEffort);
    if (!reasoningEffort) return [];
    return [{
      description: typeof option.description === 'string' ? option.description : '',
      reasoningEffort
    }];
  }) : [];
}

function readServiceTiers(value: unknown) {
  return Array.isArray(value) ? value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const tier = entry as Record<string, unknown>;
    const id = catalogIdentifier(tier.id);
    if (!id || typeof tier.name !== 'string') return [];
    return [{
      description: typeof tier.description === 'string' ? tier.description : '',
      id,
      name: tier.name
    }];
  }) : [];
}

function handleCodexTurnMessage(
  collector: CodexTurnCollector,
  message: CodexRpcMessage,
  emit?: CodexChatStreamEmitter
) {
  if (message.method === 'item/agentMessage/delta') {
    const threadId = readRpcParamString(message.params, 'threadId');
    const turnId = readRpcParamString(message.params, 'turnId');
    const delta = readRpcParamString(message.params, 'delta');

    if (threadId === collector.threadId && turnId === collector.turnId && delta) {
      collector.delta += delta;
      emit?.({ delta, type: 'delta' });
    }

    return false;
  }

  if (message.method === 'item/completed') {
    const params = message.params as
      | {
          item?: {
            text?: unknown;
            type?: unknown;
          };
          threadId?: unknown;
          turnId?: unknown;
        }
      | undefined;

    if (
      params?.threadId === collector.threadId &&
      params.turnId === collector.turnId &&
      params.item?.type === 'agentMessage' &&
      typeof params.item.text === 'string'
    ) {
      collector.completedText = params.item.text;
    }

    return false;
  }

  if (message.method === 'turn/completed') {
    const params = message.params as
      | {
          threadId?: unknown;
          turn?: { id?: unknown };
        }
      | undefined;

    return params?.threadId === collector.threadId && params.turn?.id === collector.turnId;
  }

  if (message.method === 'error') {
    const params = message.params as
      | {
          error?: { message?: unknown };
          threadId?: unknown;
          turnId?: unknown;
        }
      | undefined;

    if (
      params?.threadId === collector.threadId &&
      (params.turnId === undefined || params.turnId === '' || params.turnId === collector.turnId)
    ) {
      throw new Error(
        typeof params.error?.message === 'string' ? params.error.message : 'Codex turn failed.'
      );
    }
  }

  return false;
}

class CodexAppServerClient {
  private backlog: CodexRpcMessage[] = [];
  private nextId = 1;
  private readonly messages: CodexRpcMessage[] = [];
  private readError?: Error;
  private readonly stderr: string[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        this.messages.push(JSON.parse(trimmed) as CodexRpcMessage);
        this.notifyWaiters();
      } catch {
        // Ignore non-protocol output.
      }
    });
    stdout.on('close', () => {
      this.readError ??= new Error('Codex app-server closed.');
      this.notifyWaiters();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderr.join('').length < 64_000) {
        this.stderr.push(chunk.toString('utf-8'));
      }
    });
    child.on('error', (error) => {
      this.readError = error;
      this.notifyWaiters();
    });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolveClose();
      };
      const timeout = setTimeout(() => {
        this.child.kill('SIGKILL');
        setTimeout(finish, 1_000);
      }, 1_000);

      this.child.once('close', finish);
      if (!this.child.kill('SIGTERM')) {
        finish();
      }
    });
  }

  async initialize() {
    await this.call('initialize', {
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
        requestAttestation: false
      },
      clientInfo: {
        name: 'project-space',
        title: 'Project Space',
        version: '0.1.0'
      }
    });
    await this.notify('initialized', null);
  }

  async listModels() {
    const models: CodexModelRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const result = await this.call('model/list', {
        cursor,
        includeHidden: false
      });
      const page = readCodexModelPage(result);
      models.push(...page.models);
      cursor = page.nextCursor;

      if (cursor && seenCursors.has(cursor)) {
        throw new Error('Codex returned a repeated model catalogue cursor.');
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
    } while (cursor);

    return models;
  }

  async startThread(cwd: string, systemPrompt?: string, selectedModel?: string) {
    const params: Record<string, unknown> = {
      approvalPolicy: 'never',
      baseInstructions:
        systemPrompt ??
        'You are helping inside Project Space. Answer plainly. Use tools only when the user asks you to inspect or change local files.',
      cwd,
      ephemeral: true,
      sandbox: 'read-only'
    };
    const model =
      selectedModel?.trim() ||
      process.env.PROJECT_SPACE_CODEX_MODEL?.trim() ||
      process.env.CODEX_MODEL?.trim();

    if (model) {
      params.model = model;
    }

    const result = await this.call('thread/start', params);
    const threadId = readThreadId(result);

    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id.');
    }

    return threadId;
  }

  async runTurn(threadId: string, prompt: string, emit?: CodexChatStreamEmitter) {
    const result = await this.call('turn/start', {
      input: [
        {
          text: prompt,
          text_elements: [],
          type: 'text'
        }
      ],
      threadId
    });
    const turnId = readTurnId(result);

    if (!turnId) {
      throw new Error('Codex app-server did not return a turn id.');
    }

    const collector: CodexTurnCollector = {
      completedText: '',
      delta: '',
      threadId,
      turnId
    };

    for (;;) {
      const message = await this.nextMessage();
      if (handleCodexTurnMessage(collector, message, emit)) {
        const text = (collector.completedText || collector.delta).trim();

        if (!text) {
          throw new Error('Codex completed without a visible response.');
        }

        return text;
      }
    }
  }

  private async call(method: string, params: unknown) {
    const id = this.nextId++;
    await this.write({ id, method, params });
    const deferred: CodexRpcMessage[] = [];

    try {
      for (;;) {
        const message = await this.nextMessage();

        if (message.id !== id) {
          deferred.push(message);
          continue;
        }

        if (message.error) {
          throw new Error(message.error.message ?? `${method} failed.`);
        }

        return message.result;
      }
    } finally {
      this.backlog.unshift(...deferred);
    }
  }

  private async notify(method: string, params: unknown) {
    await this.write({ method, params });
  }

  private async nextMessage() {
    const startedAt = Date.now();
    const timeoutMs = 120_000;

    for (;;) {
      const message = this.backlog.shift() ?? this.messages.shift();
      if (message) {
        return message;
      }

      if (this.readError) {
        const stderr = this.stderr.join('').trim();
        throw new Error(stderr ? `${this.readError.message}: ${stderr}` : this.readError.message);
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Codex app-server timed out.');
      }

      await new Promise<void>((resolveWaiter) => {
        const timeout = setTimeout(resolveWaiter, 250);
        this.waiters.push(() => {
          clearTimeout(timeout);
          resolveWaiter();
        });
      });
    }
  }

  private notifyWaiters() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async write(message: CodexRpcMessage) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function chatPrompt(request: CodexChatRequest) {
  const history = request.messages
    .slice(-12)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n');

  return history ? `${history}\n\nUser: ${request.prompt}` : request.prompt;
}

export async function runCodexAppServerChat({
  codexCliPath,
  codexHome,
  emit,
  request,
  runtime,
  signal
}: {
  codexCliPath?: string;
  codexHome: string;
  emit?: CodexChatStreamEmitter;
  request: CodexChatRequest;
  runtime?: CodexChatRuntime;
  signal?: AbortSignal;
}): Promise<CodexChatResult> {
  const cwd = resolve(request.cwd);
  const child = spawn(
    runtime?.command ?? codexCliPath!,
    runtime?.args ?? ['app-server', '--listen', 'stdio://'],
    {
      cwd: runtime?.cwd ?? cwd,
      env: {
        ...process.env,
        ...(runtime?.env ?? {}),
        CODEX_HOME: runtime?.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? codexHome
      },
      stdio: 'pipe',
      windowsHide: true
    }
  );
  const client = new CodexAppServerClient(child);
  const abort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });

  try {
    if (signal?.aborted) {
      abort();
      return { message: 'Codex chat was cancelled.', status: 'error' };
    }
    await client.initialize();
    const threadId = await client.startThread(cwd, request.systemPrompt, request.model);
    const response = await client.runTurn(threadId, chatPrompt(request), emit);

    return {
      response,
      status: 'success'
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Codex chat failed.',
      status: 'error'
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.close();
  }
}

export async function loadCodexAppServerModels({
  codexCliPath,
  codexHome,
  cwd,
  runtime
}: {
  codexCliPath?: string;
  codexHome: string;
  cwd: string;
  runtime?: CodexChatRuntime;
}): Promise<CodexModelCatalogueResult> {
  const child = spawn(
    runtime?.command ?? codexCliPath!,
    runtime?.args ?? ['app-server', '--listen', 'stdio://'],
    {
      cwd: runtime?.cwd ?? resolve(cwd),
      env: {
        ...process.env,
        ...(runtime?.env ?? {}),
        CODEX_HOME: runtime?.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? codexHome
      },
      stdio: 'pipe',
      windowsHide: true
    }
  );
  const client = new CodexAppServerClient(child);

  try {
    await client.initialize();
    const models = await client.listModels();
    return models.length > 0
      ? { models, status: 'success' }
      : { message: 'Codex returned no available models.', models: [], status: 'error' };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Could not load Codex models.',
      models: [],
      status: 'error'
    };
  } finally {
    await client.close();
  }
}
