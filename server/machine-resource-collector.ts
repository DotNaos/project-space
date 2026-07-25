import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, totalmem, type CpuInfo } from 'node:os';
import { promisify } from 'node:util';

import {
  MACHINE_RESOURCES_API_VERSION,
  type MachineResourceMetric,
  type MachineResourceSnapshot
} from '../src/shared/machine-resources-api';

const execute = promisify(execFile);
const cpuSampleDelayMs = 150;

interface MachineResourceCollectorOptions {
  cpuInfo?(): CpuInfo[];
  executeFile?(file: string, args: string[]): Promise<{ stdout: string }>;
  freeMemory?(): number;
  homeDirectory?(): string;
  pause?(milliseconds: number): Promise<void>;
  statFileSystem?(path: string): Promise<{
    bavail: number;
    blocks: number;
    bsize: number;
  }>;
  totalMemory?(): number;
}

function failed(message: string): MachineResourceMetric {
  return { message, state: 'failed' };
}

function unsupported(message: string): MachineResourceMetric {
  return { message, state: 'unsupported' };
}

function percentage(used: number, total: number) {
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function cpuTotals(values: CpuInfo[]) {
  return values.reduce(
    (result, cpu) => {
      const times = Object.values(cpu.times);
      result.idle += cpu.times.idle;
      result.total += times.reduce((sum, value) => sum + value, 0);
      return result;
    },
    { idle: 0, total: 0 }
  );
}

async function collectCpu(options: MachineResourceCollectorOptions): Promise<MachineResourceMetric> {
  const readCpu = options.cpuInfo ?? cpus;
  const pause = options.pause ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  try {
    const before = cpuTotals(readCpu());
    await pause(cpuSampleDelayMs);
    const after = cpuTotals(readCpu());
    const total = after.total - before.total;
    const idle = after.idle - before.idle;
    if (total <= 0 || idle < 0 || idle > total) {
      return failed('CPU utilization could not be sampled.');
    }
    return {
      state: 'available',
      utilizationPercent: percentage(total - idle, total)
    };
  } catch {
    return failed('CPU utilization could not be sampled.');
  }
}

function collectMemory(options: MachineResourceCollectorOptions): MachineResourceMetric {
  try {
    const totalBytes = (options.totalMemory ?? totalmem)();
    const freeBytes = (options.freeMemory ?? freemem)();
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isSafeInteger(freeBytes) ||
      freeBytes < 0 ||
      freeBytes > totalBytes
    ) {
      return failed('Memory utilization could not be sampled.');
    }
    const usedBytes = totalBytes - freeBytes;
    return {
      state: 'available',
      totalBytes,
      usedBytes,
      utilizationPercent: percentage(usedBytes, totalBytes)
    };
  } catch {
    return failed('Memory utilization could not be sampled.');
  }
}

async function collectDisk(
  options: MachineResourceCollectorOptions
): Promise<MachineResourceMetric> {
  try {
    const stats = await (options.statFileSystem ?? statfs)(
      (options.homeDirectory ?? homedir)()
    );
    const totalBytes = Math.round(stats.blocks * stats.bsize);
    const availableBytes = Math.round(stats.bavail * stats.bsize);
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isSafeInteger(availableBytes) ||
      availableBytes < 0 ||
      availableBytes > totalBytes
    ) {
      return failed('Disk utilization could not be sampled.');
    }
    const usedBytes = totalBytes - availableBytes;
    return {
      state: 'available',
      totalBytes,
      usedBytes,
      utilizationPercent: percentage(usedBytes, totalBytes)
    };
  } catch {
    return failed('Disk utilization could not be sampled.');
  }
}

function gpuRows(stdout: string) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => row.split(',').map((value) => Number(value.trim())));
}

async function collectGpu(options: MachineResourceCollectorOptions): Promise<MachineResourceMetric> {
  const run = options.executeFile ?? (async (file, args) => {
    const result = await execute(file, args, { maxBuffer: 64 * 1024, timeout: 1_500 });
    return { stdout: result.stdout };
  });
  try {
    const result = await run('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits'
    ]);
    const rows = gpuRows(result.stdout);
    if (
      rows.length === 0 ||
      rows.some(
        ([utilization, usedMib, totalMib]) =>
          !Number.isFinite(utilization) ||
          !Number.isFinite(usedMib) ||
          !Number.isFinite(totalMib) ||
          utilization! < 0 ||
          utilization! > 100 ||
          usedMib! < 0 ||
          totalMib! <= 0 ||
          usedMib! > totalMib!
      )
    ) {
      return failed('NVIDIA GPU utilization returned invalid data.');
    }
    const totalMib = rows.reduce((sum, row) => sum + row[2]!, 0);
    const usedMib = rows.reduce((sum, row) => sum + row[1]!, 0);
    const weightedUtilization = rows.reduce(
      (sum, row) => sum + row[0]! * row[2]!,
      0
    ) / totalMib;
    return {
      state: 'available',
      totalBytes: Math.round(totalMib * 1024 * 1024),
      usedBytes: Math.round(usedMib * 1024 * 1024),
      utilizationPercent: Math.min(100, Math.max(0, weightedUtilization))
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return code === 'ENOENT'
      ? unsupported('GPU utilization is not supported on this machine.')
      : failed('NVIDIA GPU utilization could not be sampled.');
  }
}

export function createMachineResourceCollector(
  options: MachineResourceCollectorOptions = {}
) {
  return async function collect(connectorId: string): Promise<MachineResourceSnapshot> {
    const [cpu, disk, gpu] = await Promise.all([
      collectCpu(options),
      collectDisk(options),
      collectGpu(options)
    ]);
    return {
      apiVersion: MACHINE_RESOURCES_API_VERSION,
      connectorId,
      metrics: {
        cpu,
        disk,
        gpu,
        memory: collectMemory(options)
      },
      sampledAt: new Date().toISOString()
    };
  };
}
