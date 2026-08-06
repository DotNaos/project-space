#!/usr/bin/env bun

import { runCodespaceAgent } from '../server/codespace-agent-runner';

try {
  const exitCode = await runCodespaceAgent(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Codespace agent runner failed: ${message}`);
  process.exitCode = 1;
}
