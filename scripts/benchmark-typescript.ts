#!/usr/bin/env bun

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dir, '..');
const buildInfoFiles = [
  resolve(root, 'node_modules/.tmp/tsconfig.app.tsbuildinfo'),
  resolve(root, 'node_modules/.tmp/tsconfig.node.tsbuildinfo'),
];
const defaultRuns = 3;

type CompilerId = 'typescript-5.9.3' | 'typescript-7.0.2';
type SampleKind = 'cold' | 'incremental';

type Compiler = {
  id: CompilerId;
  command: string[];
};

type Sample = {
  compiler: CompilerId;
  elapsedMs: number;
  exitCode: number;
  kind: SampleKind;
  peakRssBytes: number | null;
};

const compilers: Compiler[] = [
  {
    id: 'typescript-5.9.3',
    command: [Bun.which('bun') ?? 'bun', 'x', '--package', 'typescript@5.9.3', 'tsc'],
  },
  {
    id: 'typescript-7.0.2',
    command: [resolve(root, 'node_modules/.bin/tsc')],
  },
];

const runs = parseRuns(process.argv.slice(2));
const samples: Sample[] = [];
const versions = Object.fromEntries(
  await Promise.all(compilers.map(async (compiler) => [compiler.id, await compilerVersion(compiler)])),
);

for (const compiler of compilers) {
  for (const kind of ['cold', 'incremental'] as const) {
    for (let run = 0; run < runs; run += 1) {
      if (kind === 'cold') clearBuildInfo();
      else {
        clearBuildInfo();
        const warmup = await runCompiler(compiler);
        if (warmup.exitCode !== 0) {
          throw new Error(`${compiler.id} incremental warmup failed:\n${warmup.output}`);
        }
      }

      const result = await runCompiler(compiler);
      const sample = {
        compiler: compiler.id,
        elapsedMs: result.elapsedMs,
        exitCode: result.exitCode,
        kind,
        peakRssBytes: result.peakRssBytes,
      } satisfies Sample;
      samples.push(sample);

      if (result.exitCode !== 0) {
        throw new Error(`${compiler.id} ${kind} run failed:\n${result.output}`);
      }
    }
  }
}

const summary = Object.fromEntries(
  compilers.flatMap((compiler) => (['cold', 'incremental'] as const).map((kind) => {
    const matching = samples.filter((sample) => sample.compiler === compiler.id && sample.kind === kind);
    const elapsed = matching.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
    const rss = matching
      .map((sample) => sample.peakRssBytes)
      .filter((value): value is number => value !== null);
    return [`${compiler.id}:${kind}`, {
      count: matching.length,
      meanElapsedMs: round(mean(elapsed)),
      medianElapsedMs: round(median(elapsed)),
      meanPeakRssBytes: rss.length > 0 ? Math.round(mean(rss)) : null,
      successful: matching.every((sample) => sample.exitCode === 0),
    }];
  })),
);

console.log(JSON.stringify({
  command: 'bun run benchmark:typescript',
  compilerCommands: Object.fromEntries(compilers.map((compiler) => [compiler.id, compiler.command])),
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  runs,
  samples,
  summary,
  versions,
  runtime: `Bun ${Bun.version}; Node ${process.version}`,
}, null, 2));

function parseRuns(args: string[]) {
  if (args.length === 0) return defaultRuns;
  if (args.length !== 2 || args[0] !== '--runs') usage();
  const value = Number(args[1]);
  if (!Number.isInteger(value) || value < 1 || value > 10) usage();
  return value;
}

function usage(): never {
  throw new Error('Usage: bun scripts/benchmark-typescript.ts [--runs <1-10>]');
}

function mean(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function clearBuildInfo() {
  for (const path of buildInfoFiles) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

async function runCompiler(compiler: Compiler) {
  const timeCommand = process.platform === 'darwin'
    ? ['/usr/bin/time', '-l', ...compiler.command]
    : ['/usr/bin/time', '-v', ...compiler.command];
  const started = performance.now();
  const child = Bun.spawn([...timeCommand, '-b', '--pretty', 'false'], {
    cwd: root,
    env: process.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;

  return {
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    exitCode,
    output: `${stdout}${stderr}`,
    peakRssBytes: parsePeakRss(stderr),
  };
}

async function compilerVersion(compiler: Compiler) {
  const child = Bun.spawn([...compiler.command, '--version'], {
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${compiler.id} version check failed:\n${stdout}${stderr}`);
  }
  return `${stdout}${stderr}`.trim();
}

function parsePeakRss(stderr: string) {
  const macMatch = stderr.match(/(\d+)\s+maximum resident set size/i);
  if (macMatch) return Number(macMatch[1]);
  const linuxMatch = stderr.match(/Maximum resident set size \(kbytes\):\s+(\d+)/i);
  return linuxMatch ? Number(linuxMatch[1]) * 1024 : null;
}
