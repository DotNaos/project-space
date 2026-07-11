import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createMachineConnectionBackend,
  type MachineConnectionBackendOptions
} from './machine-connection-backend';

const defaultCleanupIntervalMs = 60 * 60 * 1_000;

interface MachineConnectionRuntimeScheduler {
  clearInterval(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
}

export interface MachineConnectionRuntimeOptions extends MachineConnectionBackendOptions {
  cleanupIntervalMs?: number;
  onMaintenanceError?(message: string): void;
  scheduler?: MachineConnectionRuntimeScheduler;
}

export interface MachineConnectionRuntime {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<boolean>;
  runMaintenance(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

const nodeScheduler: MachineConnectionRuntimeScheduler = {
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return timer;
  }
};

export function createMachineConnectionRuntime(
  options: MachineConnectionRuntimeOptions
): MachineConnectionRuntime {
  const backend = createMachineConnectionBackend(options);
  const scheduler = options.scheduler ?? nodeScheduler;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? defaultCleanupIntervalMs;
  if (!Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs < 1_000) {
    throw new Error('Machine connection cleanup interval must be at least one second.');
  }

  let cleanupTimer: unknown;
  let maintenance: Promise<void> | null = null;
  let started = false;

  function reportMaintenanceError() {
    const message = 'Machine connection maintenance failed.';
    if (options.onMaintenanceError) {
      options.onMaintenanceError(message);
      return;
    }
    console.error(message);
  }

  function runMaintenance() {
    if (maintenance) {
      return maintenance;
    }

    maintenance = Promise.allSettled([
      backend.cleanupExpiredRequests(),
      backend.cleanupRateLimitEvents()
    ])
      .then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          reportMaintenanceError();
        }
      })
      .finally(() => {
        maintenance = null;
      });
    return maintenance;
  }

  return {
    handleRequest: backend.handleRequest,
    runMaintenance,
    start() {
      if (started) {
        return;
      }
      void runMaintenance();
      cleanupTimer = scheduler.setInterval(() => {
        void runMaintenance();
      }, cleanupIntervalMs);
      started = true;
    },
    async stop() {
      if (started) {
        scheduler.clearInterval(cleanupTimer);
        cleanupTimer = undefined;
        started = false;
      }
      await maintenance;
    }
  };
}
