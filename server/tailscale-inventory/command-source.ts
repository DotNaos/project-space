import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { decodeTailscaleStatus } from './status-decoder';
import type {
  TailscaleInventorySource,
  TailscaleInventorySourceErrorCode,
  TailscaleInventorySourceResult
} from './source';

const execFileAsync = promisify(execFile);

export const tailscaleStatusCommand = 'tailscale';
export const tailscaleStatusArgs = ['status', '--json'] as const;
export const tailscaleStatusTimeoutMs = 5_000;
export const tailscaleStatusOutputLimitBytes = 128 * 1024;

export interface TailscaleStatusCommandOptions {
  maxBuffer: number;
  timeout: number;
  windowsHide: boolean;
}

/** The injectable command boundary deliberately exposes stdout only. */
export interface TailscaleStatusCommandRunner {
  run(
    command: typeof tailscaleStatusCommand,
    args: readonly [...typeof tailscaleStatusArgs],
    options: TailscaleStatusCommandOptions
  ): Promise<{ stdout: string }>;
}

export interface CommandTailscaleInventorySourceOptions {
  freshnessSeconds?: number;
  now?: () => Date;
  runner?: TailscaleStatusCommandRunner;
}

export function createCommandTailscaleInventorySource(
  options: CommandTailscaleInventorySourceOptions = {}
): TailscaleInventorySource {
  const now = options.now ?? (() => new Date());
  const runner = options.runner ?? execFileTailscaleStatusRunner;

  return {
    async observe(): Promise<TailscaleInventorySourceResult> {
      let stdout: string;
      try {
        ({ stdout } = await runner.run(tailscaleStatusCommand, tailscaleStatusArgs, {
          maxBuffer: tailscaleStatusOutputLimitBytes,
          timeout: tailscaleStatusTimeoutMs,
          windowsHide: true
        }));
      } catch (error) {
        return unavailable(commandFailureCode(error));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(stdout) as unknown;
      } catch {
        return unavailable('invalid_status');
      }

      try {
        return {
          available: true,
          snapshot: decodeTailscaleStatus(payload, {
            freshnessSeconds: options.freshnessSeconds,
            observedAt: now().toISOString()
          })
        };
      } catch {
        return unavailable('invalid_status');
      }
    }
  };
}

const execFileTailscaleStatusRunner: TailscaleStatusCommandRunner = {
  async run(command, args, options) {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
      windowsHide: options.windowsHide
    });
    return { stdout: String(stdout) };
  }
};

function unavailable(code: TailscaleInventorySourceErrorCode): TailscaleInventorySourceResult {
  return { available: false, error: { code, source: 'command' } };
}

function commandFailureCode(error: unknown): TailscaleInventorySourceErrorCode {
  if (!isCommandError(error)) return 'command_failed';
  if (error.code === 'ENOENT') return 'command_unavailable';
  if (error.code === 'ETIMEDOUT' || error.killed === true || error.signal === 'SIGTERM') {
    return 'command_timed_out';
  }
  return 'command_failed';
}

function isCommandError(value: unknown): value is {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
} {
  return typeof value === 'object' && value !== null;
}
