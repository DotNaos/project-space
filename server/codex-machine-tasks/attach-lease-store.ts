import { createHash, randomBytes } from 'node:crypto';

export interface CodexAttachLease {
  callerMachineId: string;
  connectorId: string;
  expiresAt: number;
  generation: number;
  operationId: string;
  threadId: string;
  userId: string;
}

export class CodexAttachLeaseStore {
  private readonly leases = new Map<string, CodexAttachLease>();

  issue(input: Omit<CodexAttachLease, 'expiresAt'>, now = Date.now()) {
    this.prune(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + 60_000;
    this.leases.set(digest(token), { ...input, expiresAt });
    return {
      endpointPath: `/api/codex/tasks/${encodeURIComponent(input.threadId)}/attach/socket`,
      expiresAt: new Date(expiresAt).toISOString(),
      token
    };
  }

  consume(token: string, threadId: string, now = Date.now()) {
    this.prune(now);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const key = digest(token);
    const lease = this.leases.get(key);
    this.leases.delete(key);
    if (!lease || lease.expiresAt <= now || lease.threadId !== threadId) return undefined;
    return lease;
  }

  clear() {
    this.leases.clear();
  }

  private prune(now: number) {
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(key);
    }
  }
}

function digest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
