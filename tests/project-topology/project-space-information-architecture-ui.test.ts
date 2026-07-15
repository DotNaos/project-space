import { describe, expect, test } from 'bun:test';

describe('Project Space command-center composition', () => {
  test('passes the isolated server-render checks', async () => {
    const child = Bun.spawn([
      'bun',
      'test',
      './tests/project-topology/project-space-information-architecture-ui.isolated.tsx'
    ], {
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe'
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text()
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain('3 pass');
  });
});
