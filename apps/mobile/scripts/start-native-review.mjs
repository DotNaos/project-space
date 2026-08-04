import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(mobileRoot, '../..');
const projectBinary = join(repositoryRoot, 'bin/project');

function projectJson(args) {
  const output = execFileSync(projectBinary, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output);
}

async function contextMatches(origin, issue) {
  try {
    const response = await fetch(
      `${origin}/api/prototype-review/local-context?pr=${issue}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!response.ok) return false;
    const context = await response.json();
    return (
      context?.checkout?.state === 'available' &&
      context?.codex?.state === 'available'
    );
  } catch {
    return false;
  }
}

async function waitForVerifiedContext(origin, issue, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await contextMatches(origin, issue)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  } while (Date.now() < deadline);
  return false;
}

async function verifiedReviewOrigin(issue) {
  const override = process.env.PROJECT_SPACE_REVIEW_ORIGIN?.trim();
  if (override) return new URL(override).origin;

  let status = projectJson([
    'serve',
    'status',
    repositoryRoot,
    '--script',
    'dev',
    '--format',
    'json',
  ]);
  const runningOrigin = status.publicUrl ?? status.localUrl;
  if (
    status.state === 'running' &&
    runningOrigin &&
    !(await contextMatches(runningOrigin, issue))
  ) {
    projectJson([
      'serve',
      'stop',
      repositoryRoot,
      '--script',
      'dev',
      '--format',
      'json',
    ]);
    status = { state: 'stopped' };
  }
  if (status.state !== 'running') {
    status = projectJson([
      'serve',
      'dev',
      repositoryRoot,
      '--format',
      'json',
    ]);
  }
  const candidate = status.publicUrl ?? status.localUrl;
  if (!candidate || status.state !== 'running') {
    throw new Error(
      'Project Space could not start the local Review server for Expo Go.'
    );
  }
  return new URL(candidate).origin;
}

const claim = projectJson(['worktree', 'check', '--format', 'json']);
if (
  claim.status !== 'ready' ||
  !Number.isSafeInteger(claim.issue) ||
  claim.issue < 1 ||
  typeof claim.ownerThreadId !== 'string' ||
  !claim.ownerThreadId
) {
  throw new Error(
    'Expo Go Review requires a ready issue-owned Project worktree.'
  );
}

process.env.CODEX_THREAD_ID = claim.ownerThreadId;
const reviewOrigin = await verifiedReviewOrigin(claim.issue);
if (!(await waitForVerifiedContext(reviewOrigin, claim.issue))) {
  throw new Error(
    'The Review server could not verify this worktree and Codex task.'
  );
}
const child = spawn(
  process.platform === 'win32' ? 'bunx.exe' : 'bunx',
  ['expo', 'start', '--host', 'lan', ...process.argv.slice(2)],
  {
    cwd: mobileRoot,
    env: {
      ...process.env,
      EXPO_PUBLIC_PROJECT_SPACE_PROTOTYPE: '1',
      EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN: reviewOrigin,
      EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: String(claim.issue),
    },
    stdio: 'inherit',
  }
);

child.once('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
