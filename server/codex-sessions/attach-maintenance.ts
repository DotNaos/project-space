import type {
  ConnectorRuntimeMaintenanceAdmission,
  ConnectorRuntimeMaintenanceLease
} from '../connector-runtime-maintenance-safety';

const maintenanceMessage = 'Connector runtime maintenance is in progress.';
const readOnlyOrCompletionMethods = new Set([
  'account/read',
  'initialize',
  'initialized',
  'model/list',
  'permissionProfile/list',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'turn/interrupt'
]);

type RpcId = number | string;
type AttachMaintenanceManager = {
  invalidateMaintenanceState(): void;
  reconcileMaintenanceState(): Promise<void>;
};

export type CodexAttachInputDecision =
  | { kind: 'forward' }
  | { kind: 'reject'; response: string }
  | { kind: 'invalid' };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parse(message: string) {
  try { return record(JSON.parse(message)); }
  catch { return undefined; }
}

function rpcId(value: unknown): RpcId | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

function rpcKey(id: RpcId) {
  return `${typeof id}:${id}`;
}

function rejectionResponse(message: Record<string, unknown>, id: RpcId) {
  return JSON.stringify({
    ...(message.jsonrpc === '2.0' ? { jsonrpc: '2.0' } : {}),
    error: { code: -32_000, message: maintenanceMessage },
    id
  });
}

export class CodexAttachMaintenanceGate {
  private readonly pending = new Map<string, ConnectorRuntimeMaintenanceLease>();

  constructor(
    private readonly admission: ConnectorRuntimeMaintenanceAdmission,
    private readonly manager: AttachMaintenanceManager
  ) {}

  acceptInput(message: string): CodexAttachInputDecision {
    const parsed = parse(message);
    if (!parsed) return { kind: 'invalid' };
    const method = typeof parsed.method === 'string' ? parsed.method : undefined;
    if (!method || readOnlyOrCompletionMethods.has(method)) return { kind: 'forward' };
    const id = rpcId(parsed.id);
    if (id === undefined) return { kind: 'invalid' };
    const key = rpcKey(id);
    if (this.pending.has(key)) return { kind: 'invalid' };
    const lease = this.admission.tryBeginActivity('codex');
    if (!lease) return { kind: 'reject', response: rejectionResponse(parsed, id) };
    this.manager.invalidateMaintenanceState();
    this.pending.set(key, lease);
    return { kind: 'forward' };
  }

  observeOutput(message: string) {
    const parsed = parse(message);
    if (!parsed || typeof parsed.method === 'string') return;
    const id = rpcId(parsed.id);
    if (id === undefined) return;
    const lease = this.pending.get(rpcKey(id));
    if (!lease) return;
    this.pending.delete(rpcKey(id));
    void this.manager.reconcileMaintenanceState()
      .catch(() => undefined)
      .finally(() => lease.release());
  }

  close() {
    for (const lease of this.pending.values()) lease.release();
    this.pending.clear();
  }
}
