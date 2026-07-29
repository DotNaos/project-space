import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const mobileRoot = resolve(repositoryRoot, 'apps/mobile');

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a port for the mobile prototype.');
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
  return address.port;
}

function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function run() {
  if (
    !process.env.PORTLESS_URL &&
    process.env.PROJECT_SPACE_ALLOW_DIRECT_DEV !== '1'
  ) {
    throw new Error(
      'Prototype dev servers must run through Portless. Use `bun run dev:prototype`, or `bun run dev:prototype:direct` only for exceptional local debugging.'
    );
  }

  const desktopPort = Number(process.env.PORT ?? 5180);
  if (!Number.isInteger(desktopPort) || desktopPort < 1 || desktopPort > 65_535) {
    throw new Error('PORT must be a valid TCP port.');
  }

  const mobilePort = await availablePort();
  const sharedEnvironment = { ...process.env };

  const mobile = spawn(
    resolve(mobileRoot, 'node_modules/.bin/expo'),
    ['start', '--web', '--port', String(mobilePort)],
    {
      cwd: mobileRoot,
      detached: process.platform !== 'win32',
      env: {
        ...sharedEnvironment,
        BROWSER: 'none',
        EXPO_PUBLIC_PROJECT_SPACE_PROTOTYPE: '1'
      },
      stdio: 'inherit'
    }
  );
  const desktop = spawn(
    resolve(repositoryRoot, 'node_modules/.bin/vite'),
    [
      '--config',
      'apps/prototype/vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(desktopPort),
      '--strictPort'
    ],
    {
      cwd: repositoryRoot,
      detached: process.platform !== 'win32',
      env: {
        ...sharedEnvironment,
        PORT: String(desktopPort),
        PROJECT_SPACE_PROTOTYPE_MOBILE_ORIGIN: `http://127.0.0.1:${mobilePort}`
      },
      stdio: 'inherit'
    }
  );

  const children = [desktop, mobile];
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) terminate(child, signal);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));

  const result = await Promise.race(
    children.map(
      (child) =>
        new Promise<{ code: number; signal: NodeJS.Signals | null }>(
          (resolveExit, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => {
              resolveExit({ code: code ?? (signal ? 1 : 0), signal });
            });
          }
        )
    )
  );
  shutdown(result.signal ?? 'SIGTERM');
  await Promise.allSettled(
    children.map(
      (child) =>
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveExit();
            return;
          }
          child.once('exit', () => resolveExit());
        })
    )
  );
  process.exitCode = result.code;
}

await run();
