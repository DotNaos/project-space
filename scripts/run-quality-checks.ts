#!/usr/bin/env bun

import {
  preCommitCheckIds,
  qualityCheckIds,
  resolveQualityCheck,
  type QualityCheckId,
} from './quality-checks';

type Options = {
  ids: QualityCheckId[];
  staged: boolean;
};

async function main() {
  const options = parseOptions(process.argv.slice(2));
  for (const id of options.ids) {
    const check = resolveQualityCheck(id, {
      diffRange: process.env.CI_CHECK_DIFF_RANGE,
      staged: options.staged,
    });
    const display = check.command.join(' ');
    console.error(`[ci:check] ${check.id}: ${display}`);
    const child = Bun.spawn(check.command, {
      cwd: check.cwd ?? '.',
      env: process.env,
      stderr: 'inherit',
      stdout: 'inherit',
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exit(exitCode);
  }
}

function parseOptions(args: string[]): Options {
  const available = new Set(qualityCheckIds());
  const ids: QualityCheckId[] = [];
  let staged = false;
  for (const argument of args) {
    if (argument === '--') continue;
    if (argument === '--pre-commit') {
      ids.push(...preCommitCheckIds);
      staged = true;
      continue;
    }
    if (argument === '--staged') {
      staged = true;
      continue;
    }
    if (!available.has(argument as QualityCheckId)) usage(`Unknown quality check: ${argument}`);
    ids.push(argument as QualityCheckId);
  }
  if (ids.length === 0) usage('At least one quality check is required.');
  return { ids: [...new Set(ids)], staged };
}

function usage(message: string): never {
  throw new Error(
    `${message}\nUsage: bun run ci:check -- [--staged | --pre-commit] <check>...\nAvailable checks: ${qualityCheckIds().join(', ')}`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
