import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

describe('managed development server entrypoint', () => {
  test('package scripts cannot bypass project serve', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const docsPackage = JSON.parse(
      await readFile(resolve(root, 'apps/docs/package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };
    for (const name of [
      'dev',
      'dev:connector',
      'dev:direct',
      'dev:prototype',
      'dev:prototype:direct',
      'serve:prototype:desktop',
      'docs:dev'
    ]) {
      expect(packageJson.scripts?.[name]).toBeUndefined();
    }
    expect(docsPackage.scripts?.dev).toBeUndefined();
  });

  test('project configuration leaves runtime binding to project serve', async () => {
    const declaration = await readFile(resolve(root, '.project/scripts.yaml'), 'utf8');
    expect(declaration).toContain('version: 3');
    expect(declaration).not.toContain('VITE_PROJECT_SPACE_API_BASE_URL');
    expect(declaration).not.toContain('PROJECT_SPACE_APIS');
    expect(declaration).not.toContain('PROJECT_SPACE_DATA');
    expect(declaration).not.toContain('PROJECT_SPACE_SIMULATION_STATE');
    expect(declaration).not.toContain('dev:direct');
  });

  test('direct Vite startup fails before binding a port', async () => {
    const environment = { ...process.env };
    delete environment.PROJECT_SPACE_MANAGED_SERVE;
    delete environment.PROJECT_SPACE_SERVE_MODE;
    delete environment.PROJECT_SPACE_APIS;
    delete environment.PROJECT_SPACE_DATA;
    delete environment.PROJECT_SPACE_SIMULATION_STATE;
    const child = Bun.spawn(
      ['bun', 'x', 'vite', '--host', '127.0.0.1', '--port', '45991', '--strictPort'],
      { cwd: root, env: environment, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain('managed by the Project CLI');
  });

  test('docs development config enforces the same managed marker', async () => {
    const nextConfig = await readFile(resolve(root, 'apps/docs/next.config.mjs'), 'utf8');
    expect(nextConfig).toContain('phase === PHASE_DEVELOPMENT_SERVER');
    expect(nextConfig).toContain("process.env.PROJECT_SPACE_MANAGED_SERVE !== '1'");
    expect(nextConfig).toContain('managed by the Project CLI');
  });
});
