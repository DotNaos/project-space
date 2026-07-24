import { isAbsolute } from 'node:path';

import { createCodexRuntimeReadinessProbe } from '../../server/codex-sessions/readiness-probe';

const binaryPath = process.argv[2];
if (!binaryPath || !isAbsolute(binaryPath)) {
  throw new Error('Usage: bun smoke-codex-runtime.ts <absolute-codex-path>');
}

const readiness = await createCodexRuntimeReadinessProbe({
  cacheMs: 0,
  resolveBinary: () => binaryPath,
  timeoutMs: 15_000
})();
if (readiness !== 'ready' && readiness !== 'authorization-required') {
  throw new Error('The pinned Codex App Server did not initialize with a structured account state.');
}

console.log(`Pinned Codex App Server smoke passed (${readiness}).`);
