import type {
  ConnectorRuntimeMaintenanceRateLimiter,
  ConnectorRuntimeMaintenanceRateLimitResult
} from './connector-runtime-maintenance-service';

interface WindowRecord {
  count: number;
  expiresAt: number;
}

export class ConnectorRuntimeMaintenanceWindowRateLimiter
  implements ConnectorRuntimeMaintenanceRateLimiter {
  private readonly windows = new Map<string, WindowRecord>();

  constructor(
    private readonly maximumRequests = 3,
    private readonly windowMs = 10 * 60_000,
    private readonly maximumEntries = 10_000
  ) {
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 ||
        !Number.isSafeInteger(windowMs) || windowMs < 1 ||
        !Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('Connector runtime rate-limit configuration is invalid.');
    }
  }

  async consume(input: Parameters<ConnectorRuntimeMaintenanceRateLimiter['consume']>[0]):
    Promise<ConnectorRuntimeMaintenanceRateLimitResult> {
    const now = Date.parse(input.requestedAt);
    for (const [key, value] of this.windows) {
      if (value.expiresAt <= now) this.windows.delete(key);
    }
    const key = `${input.userId}\u0000${input.machineId}\u0000${input.operation}`;
    const current = this.windows.get(key);
    if (current && current.expiresAt > now) {
      if (current.count >= this.maximumRequests) {
        return { allowed: false, retryAfterMs: current.expiresAt - now };
      }
      current.count += 1;
      return { allowed: true };
    }
    if (this.windows.size >= this.maximumEntries) {
      return { allowed: false, retryAfterMs: this.windowMs };
    }
    this.windows.set(key, { count: 1, expiresAt: now + this.windowMs });
    return { allowed: true };
  }
}
