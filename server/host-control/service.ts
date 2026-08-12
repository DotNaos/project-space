import { createHash, randomUUID } from 'node:crypto';

import {
  hostControlSchemaVersion,
  type HostConsoleInput,
  type HostControlOperationRequest,
  type HostControlRisk
} from '../../src/shared/host-control-api';
import {
  HostControlError,
  type HostControlActor,
  type HostControlBinding,
  type HostControlInventory,
  type HostControlOperationStore,
  type HostControlPolicy,
  type HostControlProvider
} from './contracts';

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const selectorPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,31}$/;
const risks = new Set<HostControlRisk>([
  'standard', 'boot', 'disk', 'firmware', 'installer', 'recovery', 'secure_boot'
]);
const bootKeys = new Set(['DELETE', 'F2', 'F8', 'F9', 'F10', 'F11', 'F12']);

export function createHostControlService(options: {
  bindings(): Promise<HostControlBinding[]>;
  inventory: HostControlInventory;
  operations: HostControlOperationStore;
  policy: HostControlPolicy;
  provider: HostControlProvider;
  now?: () => Date;
  rateLimit?: number;
}) {
  const now = options.now ?? (() => new Date());
  const recent = new Map<string, number[]>();

  async function target(actor: HostControlActor, selector: string) {
    if (!actor.userId) throw new HostControlError('unauthorized', 'Authentication is required.');
    if (!selectorPattern.test(selector)) throw invalid();
    const host = await options.inventory.resolve(actor.userId, selector);
    if (host.resolution !== 'resolved') {
      throw new HostControlError('host_conflict', 'One exact resolved Host is required.');
    }
    const bindings = (await options.bindings()).filter((entry) =>
      entry.ownerUserId === actor.userId && entry.capabilities.hostId === host.id
    );
    if (bindings.length !== 1) {
      throw new HostControlError('capability_unavailable',
        bindings.length ? 'Host control binding is ambiguous.' : 'Host has no control binding.');
    }
    return { binding: bindings[0]!, host };
  }

  async function authorize(
    actor: HostControlActor,
    hostId: string,
    capability: string,
    risk: HostControlRisk,
    approvalId?: string
  ) {
    if (risk !== 'standard' && !approvalId) {
      throw new HostControlError('approval_required', 'This Host action requires explicit approval.');
    }
    if (!await options.policy.authorize({ actor, approvalId, capability, hostId, risk })) {
      throw new HostControlError('unauthorized', 'Host control policy denied this action.');
    }
  }

  function rateLimit(actor: HostControlActor, hostId: string) {
    const key = `${actor.userId}\0${hostId}`;
    const cutoff = now().getTime() - 60_000;
    const entries = (recent.get(key) ?? []).filter((time) => time > cutoff);
    if (entries.length >= (options.rateLimit ?? 30)) {
      throw new HostControlError('rate_limited', 'Host console input rate limit exceeded.');
    }
    entries.push(now().getTime());
    recent.set(key, entries);
  }

  return {
    async status(actor: HostControlActor, selector: string) {
      const { binding } = await target(actor, selector);
      await authorize(actor, binding.capabilities.hostId, 'host.status', 'standard');
      const status = await options.provider.status(binding);
      if (!validStatus(status, binding)) {
        throw new HostControlError('provider_unavailable', 'Host status evidence is invalid.');
      }
      return status;
    },

    async screenshot(actor: HostControlActor, selector: string) {
      const { binding } = await target(actor, selector);
      await authorize(actor, binding.capabilities.hostId, 'host.console.screenshot', 'standard');
      const frame = await options.provider.screenshot(binding);
      if (!validFrame(frame, now())) throw new HostControlError('provider_unavailable', 'Console frame is invalid.');
      return frame;
    },

    async operate(actor: HostControlActor, selector: string, request: HostControlOperationRequest) {
      validateRequest(request);
      const { binding } = await target(actor, selector);
      const hostId = binding.capabilities.hostId;
      const capability = request.input ? `host.console.${request.input.kind}` : `host.power.${request.powerState}`;
      if ((request.input && !binding.capabilities.console.includes(request.input.kind)) ||
        (request.powerState && !binding.capabilities.power.includes(request.powerState))) {
        throw new HostControlError('capability_unavailable', 'Host capability is not configured.');
      }
      const risk = inferredRisk(request.input, request.powerState, request.risk);
      await authorize(actor, hostId, capability, risk, request.approvalId);
      if (request.input) rateLimit(actor, hostId);
      const fingerprint = operationFingerprint(hostId, request, risk);
      const reserved = await options.operations.reserve({
        actor, fingerprint, hostId, operationId: request.operationId
      });
      if (reserved === 'conflict') throw new HostControlError('replay_conflict', 'Operation replay changed.');
      if (reserved !== 'new') return { ...reserved, replayed: true };

      if (request.input && 'frameId' in request.input) {
        const frame = await options.provider.screenshot(binding);
        if (!validFrame(frame, now()) || frame.frameId !== request.input.frameId) {
          throw new HostControlError('stale_frame', 'Console frame is stale.');
        }
        if (request.input.x < 0 || request.input.y < 0 ||
          request.input.x >= frame.width || request.input.y >= frame.height) throw invalid();
      }
      const result = {
        auditId: randomUUID(), completedAt: now().toISOString(), hostId,
        operationId: request.operationId, provider: binding.capabilities.provider,
        replayed: false, schemaVersion: hostControlSchemaVersion,
        state: 'completed' as const
      };
      try {
        if (request.input) await options.provider.input(binding, request.input);
        else await options.provider.power(binding, request.powerState!);
        await options.operations.finish({ actor, fingerprint, result });
        return result;
      } catch (error) {
        const uncertain = { ...result, state: 'uncertain' as const };
        await options.operations.finish({ actor, fingerprint, result: uncertain }).catch(() => undefined);
        if (error instanceof HostControlError) throw error;
        return uncertain;
      }
    }
  };
}

function inferredRisk(
  input: HostConsoleInput | undefined,
  powerState: 'on' | 'off' | undefined,
  requested: HostControlRisk
) {
  if (powerState === 'off') return 'boot' as const;
  if (!input) return requested;
  if (input.kind === 'key' && bootKeys.has(input.key.toUpperCase()) ||
    input.kind === 'chord' && input.keys.some((key) => bootKeys.has(key.toUpperCase()))) {
    return 'boot' as const;
  }
  return requested;
}

function operationFingerprint(
  hostId: string,
  request: HostControlOperationRequest,
  risk: HostControlRisk
) {
  const input = request.input;
  const canonicalInput = !input ? null
    : input.kind === 'key' ? ['key', input.key]
      : input.kind === 'chord' ? ['chord', ...input.keys]
        : input.kind === 'text' ? ['text', input.text]
          : input.kind === 'mouse_move'
            ? ['mouse_move', input.frameId, input.x, input.y]
            : ['mouse_click', input.frameId, input.x, input.y, input.button];
  return createHash('sha256').update(JSON.stringify([
    hostId, canonicalInput, request.powerState ?? null, risk, request.approvalId ?? null
  ])).digest('hex');
}

function validateRequest(request: HostControlOperationRequest) {
  if (!request || typeof request !== 'object' ||
    Object.keys(request).some((key) => !['approvalId', 'input', 'operationId', 'powerState', 'risk'].includes(key)) ||
    !operationIdPattern.test(request.operationId) || !risks.has(request.risk) ||
    request.approvalId !== undefined && !operationIdPattern.test(request.approvalId) ||
    Number(Boolean(request.input)) + Number(Boolean(request.powerState)) !== 1) throw invalid();
  if (request.powerState && request.powerState !== 'on' && request.powerState !== 'off') throw invalid();
  if (!request.input) return;
  const allowed = request.input.kind === 'key' ? ['key', 'kind']
    : request.input.kind === 'chord' ? ['keys', 'kind']
      : request.input.kind === 'text' ? ['kind', 'text']
        : request.input.kind === 'mouse_move' ? ['frameId', 'kind', 'x', 'y']
          : request.input.kind === 'mouse_click' ? ['button', 'frameId', 'kind', 'x', 'y'] : [];
  if (!allowed.length || Object.keys(request.input).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !(key in request.input!))) throw invalid();
  if (request.input.kind === 'key' && !keyPattern.test(request.input.key) ||
    request.input.kind === 'chord' && (request.input.keys.length < 2 ||
      request.input.keys.length > 8 || request.input.keys.some((key) => !keyPattern.test(key))) ||
    request.input.kind === 'text' && (!request.input.text || request.input.text.length > 4096 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.input.text)) ||
    'frameId' in request.input && (!operationIdPattern.test(request.input.frameId) ||
      !Number.isSafeInteger(request.input.x) || !Number.isSafeInteger(request.input.y)) ||
    request.input.kind === 'mouse_click' && !['left', 'middle', 'right'].includes(request.input.button)) {
    throw invalid();
  }
}

function validFrame(frame: {
  capturedAt: string; frameId: string; height: number; png: Uint8Array; staleAfter: string; width: number;
}, now: Date) {
  const capturedAt = Date.parse(frame.capturedAt);
  const staleAfter = Date.parse(frame.staleAfter);
  return operationIdPattern.test(frame.frameId) &&
    Number.isSafeInteger(frame.width) && Number.isSafeInteger(frame.height) &&
    frame.width > 0 && frame.width <= 7680 && frame.height > 0 && frame.height <= 4320 &&
    frame.png.length >= 8 && frame.png.length <= 16 * 1024 * 1024 &&
    Buffer.from(frame.png.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    Number.isFinite(capturedAt) && Number.isFinite(staleAfter) &&
    capturedAt <= now.getTime() && capturedAt < staleAfter && staleAfter > now.getTime();
}

function validStatus(
  status: Awaited<ReturnType<HostControlProvider['status']>>,
  binding: HostControlBinding
) {
  const expected = binding.capabilities;
  return status.schemaVersion === hostControlSchemaVersion && status.hostId === expected.hostId &&
    status.provider.kind === 'jetkvm' && status.provider.id === expected.provider.id &&
    status.available === expected.available && ['on', 'off', 'unknown'].includes(status.powerState) &&
    status.power.every((capability) => expected.power.includes(capability)) &&
    status.console.every((capability) => expected.console.includes(capability));
}

function invalid() { return new HostControlError('invalid_request', 'Host control request is invalid.'); }

export class MemoryHostControlOperationStore implements HostControlOperationStore {
  private readonly values = new Map<string, {
    fingerprint: string;
    result?: HostControlOperationResult;
  }>();
  async reserve(input: { actor: HostControlActor; fingerprint: string; hostId: string; operationId: string }) {
    const key = `${input.actor.userId}\0${input.operationId}`;
    const prior = this.values.get(key);
    if (!prior) { this.values.set(key, { fingerprint: input.fingerprint }); return 'new' as const; }
    if (prior.fingerprint !== input.fingerprint) return 'conflict' as const;
    return prior.result && prior.result !== 'new' && prior.result !== 'conflict'
      ? prior.result : 'conflict' as const;
  }
  async finish(input: { actor: HostControlActor; fingerprint: string; result: HostControlOperationResult }) {
    this.values.set(`${input.actor.userId}\0${input.result.operationId}`, {
      fingerprint: input.fingerprint, result: input.result
    });
  }
}
