#!/usr/bin/env bun

import { runWorkspaceRuntimeCodexHost } from './process';

declare const __PROJECT_SPACE_VERSION__: string | undefined;

const [flag, bootstrapPath, ...extra] = process.argv.slice(2);

if (flag === '--version' || flag === '-v') {
  console.log(typeof __PROJECT_SPACE_VERSION__ === 'undefined'
    ? 'development'
    : __PROJECT_SPACE_VERSION__);
  process.exit(0);
}

if (flag === '--help' || flag === '-h') {
  console.log(`Project Workspace Runtime Codex Host

Usage:
  project-codex-host --bootstrap <protected-bootstrap-path>
`);
  process.exit(0);
}

if (flag !== '--bootstrap' || !bootstrapPath || extra.length > 0) {
  throw new Error('The Workspace Runtime Codex host arguments are invalid.');
}

await runWorkspaceRuntimeCodexHost(bootstrapPath);
